import fs from 'fs';
import path from 'path';

/**
 * Foreground indexing pass. Reads configuration straight from the environment
 * so `index` works without an MCP_API_KEY (which only the HTTP transport needs).
 */
export async function indexCommand(
  options: { force: boolean },
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const packagesDir = env.D365_PACKAGES_DIR;
  const dbPath = env.D365_INDEX_DB_PATH ?? './d365_index.db';

  if (!packagesDir) {
    console.error('D365_PACKAGES_DIR is not set. Run `d365-fno-mcp-server setup` first.');
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
    console.error(`Cannot open the index: ${String(err)}. Back up or move the damaged database before rebuilding; --force never deletes it.`);
    return 1;
  }
  try {
    console.log(`Indexing ${packagesDir} -> ${dbPath}${options.force ? ' (force)' : ''}`);
    const stats = await buildIndex(db, packagesDir, options.force);
    const summary = getIndexStats(db);

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
  } catch (err) {
    console.error(`Indexing failed: ${String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}
