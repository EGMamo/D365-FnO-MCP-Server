import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import {
  normalizeUsageRow, publishUsageSnapshot, stageUsageBatch, stageUsageSnapshot,
  usageSnapshotVersion, type UsageRef,
} from './xrefUsage.js';
import type { XrefSqlClient } from './xrefSql.js';

export interface XrefImportOptions {
  allowEmpty?: boolean;
  storeRaw?: boolean;
  signal?: AbortSignal;
  /** Keeps only the references this returns true for (the whole source is still read and counted). */
  keep?: (ref: UsageRef) => boolean;
}

/**
 * The import on an open connection, so the hybrid gateway can import into its custom index (which may be an
 * in-memory database only that connection sees). Returns the number of references published.
 */
export async function importXrefSnapshotInto(
  db: Database,
  client: XrefSqlClient,
  options: XrefImportOptions = {}
): Promise<number> {
  options.signal?.throwIfAborted();
  // The staging table is private to the connection; a long-lived connection may hold one from an earlier run.
  db.exec('DROP TABLE IF EXISTS temp.ax_usage_staging');
  try {
    const expectedVersion = usageSnapshotVersion(db);
    stageUsageSnapshot(db);
    let received = 0;
    let kept = 0;
    for await (const { table, rows } of client.batches()) {
      options.signal?.throwIfAborted();
      const refs: UsageRef[] = [];
      for (const row of rows) {
        const ref = normalizeUsageRow({
          ...row, SourcePath: row.__source_path, TargetPath: row.__target_path,
        }, table);
        if (!ref) {
          throw new Error(`Unresolved compiler reference in ${table} at row ${received + 1}; refusing a partial snapshot.`);
        }
        received++;
        if (options.keep && !options.keep(ref)) continue;
        if (!options.storeRaw) ref.raw = {};
        refs.push(ref);
      }
      stageUsageBatch(db, refs);
      kept += refs.length;
    }
    if (received !== client.source.expectedRows) {
      throw new Error(`Xref row count mismatch: expected ${client.source.expectedRows}, received ${received}. Existing snapshot retained.`);
    }
    if (kept === 0 && !options.allowEmpty) {
      throw new Error('Source contains no cross-references. Use --allow-empty only to intentionally replace the previous snapshot with an empty one.');
    }
    options.signal?.throwIfAborted();
    publishUsageSnapshot(db, expectedVersion, randomUUID(), kept, client.source);
    return kept;
  } finally {
    db.exec('DROP TABLE IF EXISTS temp.ax_usage_staging');
  }
}

export function safeError(err: unknown, connectionString: string): string {
  if (err instanceof Error && 'code' in err) {
    return `SQL Server operation failed (${String(err.code)}). Check database permissions, authentication and TLS configuration.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.replaceAll(connectionString, '[redacted connection string]');
}
