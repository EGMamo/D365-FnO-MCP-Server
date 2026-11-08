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
