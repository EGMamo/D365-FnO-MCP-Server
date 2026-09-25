import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb } from '../indexer/db.js';
import {
  normalizeUsageRow, publishUsageSnapshot, stageUsageBatch, stageUsageSnapshot,
  usageSnapshotVersion, type UsageRef,
} from '../indexer/xrefUsage.js';
import { createMssqlClient, type XrefSqlClient } from '../indexer/xrefSql.js';

export type { XrefSqlClient } from '../indexer/xrefSql.js';

export interface XrefImportOptions {
  allowEmpty?: boolean;
  storeRaw?: boolean;
  signal?: AbortSignal;
}

/** Publishes only a complete, coherent import. All failures retain the previous snapshot. */
export async function importXrefSnapshot(
  dbPath: string,
  client: XrefSqlClient,
  options: XrefImportOptions = {}
): Promise<number> {
  options.signal?.throwIfAborted();
  const db = openDb(dbPath);
  try {
    const expectedVersion = usageSnapshotVersion(db);
    stageUsageSnapshot(db);
    let imported = 0;
    for await (const { table, rows } of client.batches()) {
      options.signal?.throwIfAborted();
      const refs: UsageRef[] = [];
      for (const row of rows) {
        const ref = normalizeUsageRow({
          ...row, SourcePath: row.__source_path, TargetPath: row.__target_path,
        }, table);
        if (!ref) {
          throw new Error(`Unresolved compiler reference in ${table} at row ${imported + refs.length + 1}; refusing a partial snapshot.`);
        }
        if (!options.storeRaw) ref.raw = {};
        refs.push(ref);
      }
      stageUsageBatch(db, refs);
      imported += refs.length;
    }
    if (imported !== client.source.expectedRows) {
      throw new Error(`Xref row count mismatch: expected ${client.source.expectedRows}, received ${imported}. Existing snapshot retained.`);
    }
    if (imported === 0 && !options.allowEmpty) {
      throw new Error('Source contains no cross-references. Use --allow-empty only to intentionally replace the previous snapshot with an empty one.');
    }
    options.signal?.throwIfAborted();
    publishUsageSnapshot(db, expectedVersion, randomUUID(), imported, client.source);
    return imported;
  } finally {
    db.close();
  }
}

function safeError(err: unknown, connectionString: string): string {
  if (err instanceof Error && 'code' in err) {
    return `SQL Server operation failed (${String(err.code)}). Check database permissions, authentication and TLS configuration.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.replaceAll(connectionString, '[redacted connection string]');
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
