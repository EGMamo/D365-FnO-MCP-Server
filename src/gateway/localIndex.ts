import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildIndex, type IndexStats } from '../indexer/buildIndex.js';
import { openDb, prune, type Database } from '../indexer/db.js';
import { setSourceFileReads } from '../indexer/sourceFiles.js';
import { logger } from '../utils/logger.js';
import type { LocalIndex, LocalIndexStatus } from './types.js';

/** Quiet period a burst of file changes must leave before a refresh runs (one save fires several events). */
const DEFAULT_DEBOUNCE_MS = 1000;

/** A burst that never goes quiet (a build writing under the watched tree) delays a refresh by at most this many debounce periods. */
const MAX_SETTLE_PERIODS = 5;

/** Same limit buildIndex applies: above this share of failed files a scan is not trusted to justify dropping rows. */
const MAX_ERROR_RATIO = 0.5;

/** The in-memory database SQLite knows by this name; it has no file and no folder. */
const IN_MEMORY_DB = ':memory:';

/**
 * The folder is a developer's working tree: a branch or ISV repository checked out into it may hold links.
 * A file whose real path leaves the folder is not indexed, so no other file of the machine ends up in the index.
 */
const SCAN_OPTIONS = { confined: true } as const;

const optionsSchema = z.object({
  customDir: z.string().min(1),
  dbPath: z.string().min(1),
  ttlMs: z.number().int().nonnegative(),
  debounceMs: z.number().int().nonnegative().default(DEFAULT_DEBOUNCE_MS),
});

export interface LocalIndexOptions {
  /** Root of the developer's custom models: <customDir>/<Package>/<Model>/Ax<Type>/*.xml. */
  customDir: string;
  /** SQLite file of the local index. Must not be the hosted or main index. */
  dbPath: string;
  /** Longest an index is served without a refresh, whether or not a change was seen (0 refreshes on every call). */
  ttlMs: number;
  /** Quiet period before a refresh after a change; 0 disables the wait. Default 1000. */
  debounceMs?: number;
}

/** Whether a watcher event can change what the scanner reads (AOT XML, label files, or a directory moved or removed). */
function affectsIndex(filename: string | null): boolean {
  if (!filename) return true;
  const base = path.basename(filename).toLowerCase();
  const ext = path.extname(base);
  return ext === '' || ext === '.xml' || base.endsWith('.label.txt');
}

/**
 * Opens (creating it when missing) the separate SQLite index of the custom models
 * and brings it up to date before resolving. The returned index refreshes itself
 * lazily: callers await `ensureFresh()` before reading `db`.
 */
export async function openLocalIndex(opts: LocalIndexOptions): Promise<LocalIndex> {
  const options = optionsSchema.parse(opts);
  const customDir = path.resolve(options.customDir);
  const inMemory = options.dbPath === IN_MEMORY_DB;
  // ':memory:' is not a file name: resolved, it would become a database file in the working directory.
  const dbPath = inMemory ? IN_MEMORY_DB : path.resolve(options.dbPath);
  const { ttlMs, debounceMs } = options;

  if (!inMemory) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db: Database = openDb(dbPath);
  // get_element_xml / get_method_source fall back to the files when no raw XML is stored.
  setSourceFileReads(true, customDir);

  // Errors reach the agent through local_index_status, so they must not carry local paths.
  const hidden: (readonly [string, string])[] = [[customDir, '<customDir>']];
  if (!inMemory) hidden.push([path.dirname(dbPath), '<dbDir>']);
  const hiddenPaths = hidden
    .flatMap(([dir, label]) =>
      [...new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\//g, '\\')])].map((variant) => [variant, label] as const)
    )
    .sort((a, b) => b[0].length - a[0].length);
  const describeError = (err: unknown): string => {
    let text = err instanceof Error ? err.message : String(err);
    for (const [dir, label] of hiddenPaths) text = text.split(dir).join(label);
    return text;
  };

  let closed = false;
  // Never refreshed counts as dirty, so the first call always builds.
  let dirty = true;
  let dirtySince = 0;
  let lastDirtyAt = 0;
  let building = false;
  let running: Promise<void> | null = null;
  let followUp: Promise<void> | null = null;
  let lastAttemptAt: number | null = null;
  let lastRefreshAt: string | null = null;
  let lastError: string | null = null;
  let counts = { objects: 0, labels: 0 };

  let watcher: fs.FSWatcher | null = null;
  let watcherState: LocalIndexStatus['watcher'] = 'inactive';
  let watcherError: string | null = null;

  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;

  const countRows = (table: 'ax_objects' | 'ax_labels'): number =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

  const readCounts = () => {
    if (db.isOpen) {
      try {
        counts = { objects: countRows('ax_objects'), labels: countRows('ax_labels') };
      } catch {
        // Keep the last known counts; status must never throw.
      }
    }
    return counts;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        timer = null;
        wake = null;
        resolve();
      }, ms);
      timer.unref();
    });

  /** Waits until changes have stopped for debounceMs, or for the cap on a burst that does not stop. */
  async function settle(): Promise<void> {
    const giveUpAt = dirtySince + debounceMs * MAX_SETTLE_PERIODS;
    for (;;) {
      const wait = Math.min(lastDirtyAt + debounceMs, giveUpAt) - Date.now();
      if (wait <= 0 || closed) return;
      await sleep(wait);
    }
  }

  async function assertDirReadable(): Promise<void> {
    const info = await fsp.stat(customDir).catch((err: NodeJS.ErrnoException) => {
      throw new Error(`Custom metadata directory is not accessible (${err.code ?? 'unknown error'})`);
    });
    if (!info.isDirectory()) throw new Error('Custom metadata path is not a directory');
  }

  /**
   * buildIndex only prunes when the scan overlaps at least half of the indexed
   * objects, so after a branch switch or a mass delete rows of files that no
   * longer exist can stay. Every surviving object row belongs to a scanned object
   * file (label files own no object rows), hence more rows than scanned object
   * files proves such stale rows exist.
   */
  function staleRowsRemain(stats: IndexStats): boolean {
    if (stats.deleted > 0 || stats.total === 0 || stats.errors > stats.total * MAX_ERROR_RATIO) return false;
    return countRows('ax_objects') > stats.objectFiles;
  }

  async function runBuild(): Promise<void> {
    const stats = await buildIndex(db, customDir, false, SCAN_OPTIONS);
    if (staleRowsRemain(stats)) {
      logger.warn('Local index holds objects whose files are gone and the prune guard kept them; rebuilding from scratch', {
        scannedFiles: stats.total,
      });
      // Emptied in place rather than recreating the file: tool handlers keep using this connection.
      prune(db, new Set(), new Set());
      db.exec('DELETE FROM ax_labels; DELETE FROM ax_label_sources;');
      await buildIndex(db, customDir, true, SCAN_OPTIONS);
    }
  }

  async function refresh(): Promise<void> {
    try {
      if (debounceMs > 0) await settle();
      if (closed) return;
      // Changes from here on are not covered by this pass.
      dirty = false;
      building = true;
      await assertDirReadable();
      await runBuild();
      lastRefreshAt = new Date().toISOString();
      lastError = null;
    } catch (err) {
      // Keep serving the previous index. The next attempt is the TTL or the next change.
      lastError = describeError(err);
      logger.error('Local index refresh failed; serving the previous index', { error: lastError });
    } finally {
      building = false;
      lastAttemptAt = Date.now();
      readCounts();
    }
  }

  const isStale = () => dirty || lastAttemptAt === null || Date.now() - lastAttemptAt >= ttlMs;

  function ensureFresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) {
      if (!(building && dirty)) return running;
      // A change arrived after the scan began: callers share one more pass.
      followUp ??= running.then(() => {
        followUp = null;
        return ensureFresh();
      });
      return followUp;
    }
    if (!isStale()) return Promise.resolve();
    running = refresh().finally(() => {
      running = null;
    });
    return running;
  }

  function markDirty(): void {
    if (closed) return;
    const now = Date.now();
    if (!dirty) dirtySince = now;
    dirty = true;
    lastDirtyAt = now;
  }

  function stopWatcher(): void {
    const current = watcher;
    watcher = null;
    try {
      current?.close();
    } catch {
      // Already closed.
    }
  }

  function failWatcher(err: unknown): void {
    stopWatcher();
    watcherState = 'error';
    watcherError = describeError(err);
    logger.warn('Local index file watcher failed; relying on the periodic refresh', { error: watcherError });
  }

  function startWatcher(): void {
    if (closed || watcher) return;
    try {
      const created = fs.watch(customDir, { recursive: true }, (_event, filename) => {
        if (affectsIndex(filename)) markDirty();
      });
      created.on('error', failWatcher);
      created.unref();
      watcher = created;
      watcherState = 'active';
      watcherError = null;
    } catch (err) {
      failWatcher(err);
    }
  }

  function status(): LocalIndexStatus {
    const { objects, labels } = readCounts();
    return {
      customDirName: path.basename(customDir) || 'custom-metadata',
      objects,
      labels,
      lastRefreshAt,
      dirty,
      watcher: watcherState,
      watcherError,
      lastError,
    };
  }

  function close(): void {
    if (closed) return;
    closed = true;
    stopWatcher();
    watcherState = 'inactive';
    if (timer) clearTimeout(timer);
    timer = null;
    wake?.();
    wake = null;
    readCounts();
    // A pass in flight is on this connection; closing under it would fail halfway through a transaction.
    const release = () => {
      if (db.isOpen) db.close();
    };
    if (running) void running.finally(release);
    else release();
  }

  const index: LocalIndex = { db, customDir, ensureFresh, markDirty, status, startWatcher, close };
  await index.ensureFresh();
  return index;
}
