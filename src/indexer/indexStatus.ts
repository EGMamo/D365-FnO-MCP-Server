import fs from 'node:fs';
import { getIndexStats } from './buildIndex.js';
import { openDb } from './db.js';
import { scanPackagesDir } from './scanner.js';

/**
 * Answers "is the served index still current?" for the packages folder on
 * this machine, without building anything:
 *
 *   local-index  The local index is what the server serves (same build time)
 *                or newer. Every scanned file is compared with the path and
 *                modification time the index recorded, the same rule the
 *                incremental indexer uses, so added, changed and removed
 *                files are all found.
 *   timestamp    There is no usable local index (none, or older than the
 *                server's, e.g. someone else uploaded). Files modified after
 *                the server index was built count as changed; removals cannot
 *                be seen this way.
 */

export type StatusBasis = 'local-index' | 'timestamp';

export interface ServedIndex {
  builtAt: string | null;
  version: string | null;
  source: string | null;
  objects: number | null;
  xrefImportedAt: string | null;
}

export interface LocalIndex {
  builtAt: string | null;
  objects: number;
  xrefImportedAt: string | null;
}

export interface ChangedFile {
  path: string;
  kind: 'added' | 'changed' | 'removed';
  model: string;
}

export interface IndexStatus {
  /** True when nothing needs to be indexed or uploaded. */
  upToDate: boolean;
  basis: StatusBasis;
  /** Plain-language reasons the index is out of date; empty when it is current. */
  reasons: string[];
  server: ServedIndex | null;
  local: LocalIndex | null;
  /** The local index was built after the served one, so it only needs uploading. */
  localNewerThanServer: boolean;
  scannedFiles: number;
  added: number;
  changed: number;
  /** Null on the timestamp basis, which cannot see removals. */
  removed: number | null;
  /** Changed files per model, most first. */
  models: { model: string; files: number }[];
  /** The first `listLimit` changed files, for the log. */
  files: ChangedFile[];
  scanMs: number;
}

export interface IndexStatusOptions {
  packagesDir: string;
  /** The local index; a missing file means there is none. */
  dbPath?: string;
  /** What `GET /admin/index` reported, or null when no server was asked. */
  server?: ServedIndex | null;
  listLimit?: number;
}

/** Reads the `index` part of a `GET /admin/index` response. */
export function servedIndexFromInfo(info: Record<string, unknown>): ServedIndex {
  const index = (info.index ?? {}) as Record<string, unknown>;
  const usage = (index.usageSnapshot ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null);
  return {
    builtAt: text(index.builtAt),
    version: text(index.version),
    source: text(index.source),
    objects: typeof index.objects === 'number' ? index.objects : null,
    xrefImportedAt: usage.status === 'imported' ? text(usage.importedAt) : null,
  };
}

/** The model folder of a scanned file: <packages>/<package>/<model>/<AxType>/<file>. */
function modelOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts.length >= 3 ? parts[parts.length - 3] : '';
}

function toTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

interface RecordedFiles {
  local: LocalIndex;
  /** file path -> recorded mtime, objects and label files together. */
  mtimes: Map<string, number>;
  /** `type|name` of every indexed object, to ignore files that lose a name collision. */
  keys: Set<string>;
}

function readLocalIndex(dbPath: string): RecordedFiles | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = openDb(dbPath);
  try {
    const stats = getIndexStats(db);
    const mtimes = new Map<string, number>();
    const keys = new Set<string>();
    const objects = db.prepare('SELECT type, name, file_path, file_mtime FROM ax_objects').all() as {
      type: string; name: string; file_path: string; file_mtime: number;
    }[];
    for (const row of objects) {
      mtimes.set(row.file_path, Number(row.file_mtime));
      keys.add(`${row.type}|${row.name}`);
    }
    const labels = db.prepare('SELECT source_file, file_mtime FROM ax_label_sources').all() as { source_file: string; file_mtime: number }[];
    for (const row of labels) mtimes.set(row.source_file, Number(row.file_mtime));
    return {
      local: {
        builtAt: stats.builtAt,
        objects: stats.totalObjects,
        xrefImportedAt: stats.usageSnapshot.status === 'imported' ? stats.usageSnapshot.importedAt : null,
      },
      mtimes,
      keys,
    };
  } finally {
    db.close();
  }
}

export async function checkIndexStatus(options: IndexStatusOptions): Promise<IndexStatus> {
  const server = options.server ?? null;
  const listLimit = options.listLimit ?? 20;
  const recorded = options.dbPath ? readLocalIndex(options.dbPath) : null;
  const serverTime = toTime(server?.builtAt);
  const localTime = toTime(recorded?.local.builtAt);

  let basis: StatusBasis;
  if (recorded && localTime !== null && (server === null || serverTime === null || localTime >= serverTime)) {
    basis = 'local-index';
  } else if (serverTime !== null) {
    basis = 'timestamp';
  } else if (server) {
    throw new Error('The server did not report when its index was built, and there is no local index to compare with.');
  } else {
    throw new Error(
      recorded ? 'The local index has no build time; run `index` once, then check again.' : 'There is no local index and no server to compare with.'
    );
  }

  const started = Date.now();
  const counts = { added: 0, changed: 0, removed: 0 };
  const perModel = new Map<string, number>();
  const files: ChangedFile[] = [];
  const note = (file: ChangedFile) => {
    counts[file.kind]++;
    perModel.set(file.model, (perModel.get(file.model) ?? 0) + 1);
    if (files.length < listLimit) files.push(file);
  };

  let scannedFiles = 0;
  const seen = new Set<string>();
  for await (const file of scanPackagesDir(options.packagesDir)) {
    scannedFiles++;
    if (basis === 'timestamp') {
      if (file.mtime > serverTime!) note({ path: file.filePath, kind: 'changed', model: file.model });
      continue;
    }
    seen.add(file.filePath);
    const mtime = recorded!.mtimes.get(file.filePath);
    if (mtime === undefined) {
      // A second file with an indexed type and name loses the collision; the indexer skips it too.
      if (file.type === 'Label' || !recorded!.keys.has(`${file.type}|${file.name}`)) {
        note({ path: file.filePath, kind: 'added', model: file.model });
      }
    } else if (file.mtime > mtime) {
      note({ path: file.filePath, kind: 'changed', model: file.model });
    }
  }
  if (basis === 'local-index') {
    for (const filePath of recorded!.mtimes.keys()) {
      if (!seen.has(filePath)) note({ path: filePath, kind: 'removed', model: modelOf(filePath) });
    }
  }

  const localNewerThanServer = basis === 'local-index' && serverTime !== null && localTime! > serverTime;
  const fileChanges = counts.added + counts.changed + counts.removed;
  const reasons: string[] = [];
  if (fileChanges > 0) {
    const since = basis === 'local-index' ? 'since the local index was built' : 'since the server index was built';
    reasons.push(`${fileChanges} file(s) in ${perModel.size} model(s) changed ${since}.`);
  }
  if (localNewerThanServer) reasons.push('The local index is newer than the one the server serves and has not been uploaded.');
  if (scannedFiles === 0) reasons.push(`No metadata files were found under ${options.packagesDir}; is it the right folder?`);

  return {
    upToDate: reasons.length === 0,
    basis,
    reasons,
    server,
    local: recorded?.local ?? null,
    localNewerThanServer,
    scannedFiles,
    added: counts.added,
    changed: counts.changed,
    removed: basis === 'local-index' ? counts.removed : null,
    models: [...perModel].map(([model, count]) => ({ model, files: count })).sort((a, b) => b.files - a.files || a.model.localeCompare(b.model)),
    files,
    scanMs: Date.now() - started,
  };
}
