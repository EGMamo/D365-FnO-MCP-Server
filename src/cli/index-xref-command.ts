import path from 'node:path';
import { openDb } from '../indexer/db.js';
import { clearUsageRefs, insertUsageRefs, normalizeUsageRow, type UsageRef } from '../indexer/xrefUsage.js';

export interface XrefSqlClient {
  listTables(): Promise<string[]>;
  query(table: string, offset?: number, limit?: number): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const TABLES = ['References', 'SysXRefTableReferences', 'SysXRefClassReferences', 'SysXRefMethodReferences',
  'SysXRefVariableReferences', 'SysXRefLabelReferences'];

/** Imports a complete compiler snapshot; xref generation is wholesale, not incremental. */
export async function importXrefSnapshot(dbPath: string, client: XrefSqlClient): Promise<number> {
  const available = new Set(await client.listTables());
  const names = new Map<string, string>();
  if (available.has('Names')) {
    for (let offset = 0; ; offset += 5000) {
      const rows = await client.query('Names', offset, 5000);
      for (const row of rows) {
        const id = String(row.Id ?? row.id ?? '');
        const p = String(row.Path ?? row.path ?? '');
        if (id && p) names.set(id, p);
      }
      if (rows.length < 5000) break;
    }
  }
  const db = openDb(dbPath);
  clearUsageRefs(db);
  let imported = 0;
  const sourceTables = available.has('References')
    ? ['References']
    : TABLES.filter((table) => table !== 'References');
  for (const table of sourceTables) {
    if (!available.has(table)) continue;
    for (let offset = 0; ; offset += 5000) {
      const rows = await client.query(table, offset, 5000);
      if (rows.length === 0) break;
      const refs: UsageRef[] = [];
      for (const row of rows) {
        const ref = normalizeUsageRow(row, table, names);
        if (ref) refs.push(ref);
      }
      insertUsageRefs(db, refs);
      imported += refs.length;
      if (rows.length < 5000) break;
    }
  }
  db.close();
  return imported;
}

async function createMssqlClient(connectionString: string): Promise<XrefSqlClient> {
  const mod = await import('mssql');
  const mssql = mod.default ?? mod;
  const pool = await mssql.connect(connectionString);
  return {
    async listTables() {
      const result = await pool.request().query(
        "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'"
      );
      return result.recordset.map((row: { name: string }) => row.name);
    },
    async query(table: string, offset = 0, limit = 5000) {
      if (!TABLES.includes(table) && table !== 'Names') throw new Error(`Unsupported xref table: ${table}`);
      const request = pool.request().input('offset', mssql.Int, offset).input('limit', mssql.Int, limit);
      const result = await request.query(
        `SELECT * FROM [dbo].[${table.replace(/]/g, ']]')} ORDER BY [Id] OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`
      );
      return result.recordset as Record<string, unknown>[];
    },
    async close() { await pool.close(); },
  };
}

export async function indexXrefCommand(
  options: { connectionString?: string; dbPath?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const connectionString = options.connectionString ?? env.D365_XREF_CONNECTION_STRING;
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';
  if (!connectionString) {
    console.error('Set D365_XREF_CONNECTION_STRING or pass --connection-string.');
    return 1;
  }
  let client: XrefSqlClient | undefined;
  try {
    client = await createMssqlClient(connectionString);
    const count = await importXrefSnapshot(path.resolve(dbPath), client);
    console.log(`Imported ${count} compiler cross-reference rows into ${dbPath}.`);
    return 0;
  } catch (err) {
    console.error(`Cross-reference import failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    if (client) await client.close();
  }
}
