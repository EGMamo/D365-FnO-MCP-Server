import path from 'node:path';
import { openDb } from '../indexer/db.js';
import { importXrefSnapshotInto, safeError, type XrefImportOptions } from '../indexer/xrefSnapshotImport.js';
import { createMssqlClient, type XrefSqlClient } from '../indexer/xrefSql.js';

export { importXrefSnapshotInto, safeError, type XrefImportOptions } from '../indexer/xrefSnapshotImport.js';
export type { XrefSqlClient } from '../indexer/xrefSql.js';

/** Publishes only a complete, coherent import. All failures retain the previous snapshot. */
export async function importXrefSnapshot(
  dbPath: string,
  client: XrefSqlClient,
  options: XrefImportOptions = {}
): Promise<number> {
  options.signal?.throwIfAborted();
  const db = openDb(dbPath);
  try {
    return await importXrefSnapshotInto(db, client, options);
  } finally {
    db.close();
  }
}

export async function indexXrefCommand(
  options: { connectionString?: string; dbPath?: string; allowSourceLocks?: boolean } & XrefImportOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const connectionString = options.connectionString ?? env.D365_XREF_CONNECTION_STRING;
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';
  if (!connectionString) {
    console.error('Set D365_XREF_CONNECTION_STRING or pass --connection-string.');
    return 1;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Cross-reference import cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let client: XrefSqlClient | undefined;
  let code = 0;
  try {
    client = await createMssqlClient(connectionString, { ...options, signal: options.signal ?? abort.signal });
    const count = await importXrefSnapshot(path.resolve(dbPath), client, {
      ...options, signal: options.signal ?? abort.signal,
    });
    console.log(`Imported ${count} compiler cross-reference rows into ${dbPath}.`);
  } catch (err) {
    console.error(`Cross-reference import failed: ${safeError(err, connectionString)}`);
    code = 1;
  } finally {
    try {
      await client?.close();
    } catch (err) {
      console.error(`Cross-reference source cleanup failed: ${safeError(err, connectionString)}`);
      code = 1;
    }
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
  return code;
}
