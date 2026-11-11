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
