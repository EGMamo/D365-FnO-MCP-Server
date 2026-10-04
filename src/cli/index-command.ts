import fs from 'fs';
import path from 'path';
import type { IndexStats, IndexStatsSummary } from '../indexer/buildIndex.js';

export interface IndexPassResult {
  stats: IndexStats;
  summary: IndexStatsSummary;
}

/**
 * Opens (or creates) the index at `dbPath` and runs one indexing pass over
 * `packagesDir`. Shared by `index` and `prepare-bundle`; a failure is thrown
 * with a message fit to print as is.
 */
export async function runIndexPass(packagesDir: string, dbPath: string, force: boolean): Promise<IndexPassResult> {
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
    const stats = await buildIndex(db, packagesDir, force);
    return { stats, summary: getIndexStats(db) };
  } catch (err) {
    throw new Error(`Indexing failed: ${String(err)}`);
  } finally {
    db.close();
  }
}

/**
 * Foreground indexing pass. Reads configuration straight from the environment
 * so `index` works without an MCP_API_KEY.
 */
export async function indexCommand(
  options: { force: boolean; packagesDir?: string; dbPath?: string },
  env: NodeJS.ProcessEnv = process.env
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
  let result: IndexPassResult;
  try {
    result = await runIndexPass(packagesDir, dbPath, options.force);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
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
