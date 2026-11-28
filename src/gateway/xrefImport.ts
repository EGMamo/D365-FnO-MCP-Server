import { importXrefSnapshotInto, safeError } from '../indexer/xrefSnapshotImport.js';
import type { Database } from '../indexer/db.js';
import type { UsageRef } from '../indexer/xrefUsage.js';
import { createMssqlClient, type XrefSqlClient } from '../indexer/xrefSql.js';
import { logger } from '../utils/logger.js';

type Connect = (connectionString: string, options: { allowSourceLocks?: boolean; signal?: AbortSignal }) => Promise<XrefSqlClient>;

/** Lower-cased names of every object in the custom index. */
function customObjectNames(db: Database): Set<string> {
  const rows = db.prepare('SELECT DISTINCT name FROM ax_objects').all() as { name: string }[];
  return new Set(rows.map((row) => row.name.toLowerCase()));
}

/** A reference is kept when it starts or ends in a custom object; the rest of the application stays hosted. */
export function touchesCustomObject(names: ReadonlySet<string>): (ref: UsageRef) => boolean {
  return (ref) => names.has(ref.sourceName.toLowerCase()) || names.has(ref.targetName.toLowerCase());
}

/**
 * Imports, from the compiler's cross-reference database, the references whose source or target is an object of
 * the custom index, into that index's usage snapshot. find_usages then lists call sites in custom code locally,
 * ahead of the hosted ones. The whole source is read (the row count check guards against a partial read) but only
 * the references that touch custom objects are kept. A failure keeps the previous snapshot.
 *
 * The read is serializable when the database has no snapshot isolation (a UDE's LocalDB usually has none), which
 * can hold a compile's writes to it until the read finishes; that is why the import is a setting the developer turns on.
 */
export async function importCustomXrefs(
  db: Database,
  connectionString: string,
  options: { signal?: AbortSignal; connect?: Connect } = {}
): Promise<number> {
  const names = customObjectNames(db);
  if (names.size === 0) return 0;
  const connect = options.connect ?? createMssqlClient;
  const client = await connect(connectionString, { allowSourceLocks: true, signal: options.signal });
  try {
    return await importXrefSnapshotInto(db, client, { keep: touchesCustomObject(names), allowEmpty: true, signal: options.signal });
  } finally {
    await client.close();
  }
}

/** Runs the import in the background and logs the outcome; the connection string never reaches the log. */
export function startCustomXrefImport(db: Database, connectionString: string, signal: AbortSignal, connect?: Connect): Promise<void> {
  logger.info('Importing compiler cross-references for the custom models');
  return importCustomXrefs(db, connectionString, { signal, connect }).then(
    (count) => logger.info('Compiler cross-references for the custom models imported', { references: count }),
    (error: unknown) => {
      if (signal.aborted) return;
      logger.warn('Could not import compiler cross-references; find_usages stays hosted-only for custom code', {
        reason: safeError(error, connectionString),
      });
    }
  );
}
