import fs from 'fs';
import path from 'path';
import type { IndexProgress, IndexStats, IndexStatsSummary } from '../indexer/buildIndex.js';

export interface IndexPassResult {
  stats: IndexStats;
  summary: IndexStatsSummary;
}

/**
 * Opens (or creates) the index at `dbPath` and runs one indexing pass over
 * `packagesDir`. Shared by `index` and `prepare-bundle`; a failure is thrown
 * with a message fit to print as is. It never writes to the terminal itself:
 * `prepare-bundle` keeps stdout for one JSON line, so a caller that wants a
 * progress display passes `onProgress`.
 */
export async function runIndexPass(
  packagesDir: string,
  dbPath: string,
  force: boolean,
  onProgress?: (progress: IndexProgress) => void
): Promise<IndexPassResult> {
  const dbDir = path.resolve(path.dirname(dbPath));
  if (dbPath !== ':memory:' && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const { openDb } = await import('../indexer/db.js');
  const { buildIndex, getIndexStats } = await import('../indexer/buildIndex.js');

  let db: ReturnType<typeof openDb>;
  try {
    db = openDb(dbPath);
  } catch (err) {
    throw new Error(`Cannot open the index: ${String(err)}. Back up or move the damaged database before rebuilding; --force never deletes it.`);
  }
  try {
    const stats = await buildIndex(db, packagesDir, force, onProgress ? { onProgress } : {});
    return { stats, summary: getIndexStats(db) };
  } catch (err) {
    throw new Error(`Indexing failed: ${String(err)}`);
  } finally {
    db.close();
  }
}

/** Where the progress line is drawn: stdout, or a stand-in with the same two members. */
export type ProgressOutput = { isTTY?: boolean; write(chunk: string): unknown };

/** Back to column 0 and erase the line. */
const CLEAR_LINE = '\r\x1b[2K';

/** The least time between two repaints of the counter. */
const PAINT_INTERVAL_MS = 100;

/**
 * A one-line "Scanned N files" counter drawn in place. The total is not known
 * while the scan streams, so it shows a count and no percentage. It never
 * throws: a failing write turns the display off for good. Structured log lines
 * that reach the same terminal while the counter is up (a file that fails to
 * parse, a name collision) land on its line until the next repaint.
 */
export function createProgressLine(
  output: ProgressOutput,
  enabled: boolean
): { update(progress: IndexProgress): void; finish(): void } {
  let lineOpen = false;
  let finished = false;
  let broken = false;
  let lastPaintAt = 0;

  const write = (text: string) => {
    try {
      output.write(text);
    } catch {
      broken = true;
    }
  };

  return {
    update(progress) {
      if (!enabled || finished || broken) return;
      const now = Date.now();
      const elapsed = now - lastPaintAt;
      // The first call always paints. A clock that stepped backwards does not freeze the counter.
      if (lineOpen && !progress.done && elapsed >= 0 && elapsed < PAINT_INTERVAL_MS) return;
      lastPaintAt = now;
      if (progress.done) {
        // What is left (pruning, the search rebuild) reports nothing. The newline
        // keeps the log lines it writes to stderr off this line.
        lineOpen = false;
        write(`${CLEAR_LINE}Scanned ${progress.files} files, finishing up...\n`);
      } else {
        lineOpen = true;
        write(`${CLEAR_LINE}Scanned ${progress.files} files`);
      }
    },
    /** Erases a counter that is still open. Safe to call again, and before any message that follows it. */
    finish() {
      if (finished) return;
      finished = true;
      if (lineOpen && !broken) write(CLEAR_LINE);
      lineOpen = false;
    },
  };
}

/**
 * Foreground indexing pass. Reads configuration straight from the environment
 * so `index` works without an MCP_API_KEY. On a terminal it shows a running
 * count of scanned files; piped or redirected output stays free of it.
 */
export async function indexCommand(
  options: { force: boolean; packagesDir?: string; dbPath?: string },
  env: NodeJS.ProcessEnv = process.env,
  output: ProgressOutput = process.stdout
): Promise<number> {
  const packagesDir = options.packagesDir ?? env.D365_PACKAGES_DIR;
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';

  if (!packagesDir) {
    console.error('D365_PACKAGES_DIR is not set. Pass --packages-dir or run `d365-fno-mcp-server setup` first.');
    return 1;
  }
  if (!fs.existsSync(packagesDir)) {
    console.error(`D365_PACKAGES_DIR "${packagesDir}" does not exist.`);
    return 1;
  }
  if (!fs.statSync(packagesDir).isDirectory()) {
    console.error(`D365_PACKAGES_DIR "${packagesDir}" is not a directory.`);
    return 1;
  }

  console.log(`Indexing ${packagesDir} -> ${dbPath}${options.force ? ' (force)' : ''}`);
  // isTTY is undefined, not false, on a pipe or file; a dumb terminal would show the escape codes as text.
  const showProgress = output.isTTY === true && env.TERM !== 'dumb';
  const progress = createProgressLine(output, showProgress);
  let result: IndexPassResult;
  try {
    result = await runIndexPass(packagesDir, dbPath, options.force, showProgress ? progress.update : undefined);
  } catch (err) {
    progress.finish();
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    progress.finish();
  }
  const { stats, summary } = result;

  console.log('\nIndexing complete:');
  console.log(`  files scanned : ${stats.total}`);
  console.log(`  added         : ${stats.added}`);
  console.log(`  updated       : ${stats.updated}`);
  console.log(`  skipped       : ${stats.skipped}`);
  console.log(`  deleted       : ${stats.deleted}`);
  console.log(`  collisions    : ${stats.collisions}`);
  console.log(`  errors        : ${stats.errors}`);
  console.log(`  duration      : ${stats.durationMs}ms`);
  console.log(`  objects in db : ${summary.totalObjects}`);
  console.log(`  labels in db  : ${summary.totalLabels}`);
  for (const [type, count] of Object.entries(summary.byType)) {
    console.log(`    ${type}: ${count}`);
  }

  return 0;
}
