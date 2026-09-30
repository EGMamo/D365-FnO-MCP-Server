import type * as Sql from 'mssql';

export const XREF_TABLES = [
  'References', 'SysXRefTableReferences', 'SysXRefClassReferences',
  'SysXRefMethodReferences', 'SysXRefVariableReferences', 'SysXRefLabelReferences',
] as const;

export interface XrefTableSchema {
  name: string;
  columns: string[];
  keys: string[][];
}

export interface XrefSource {
  consistency: 'snapshot' | 'serializable';
  tables: XrefTableSchema[];
  expectedRows: number;
}

export interface XrefSqlClient {
  source: XrefSource;
  batches(): AsyncIterable<{ table: string; rows: Record<string, unknown>[] }>;
  close(): Promise<void>;
}

function quote(identifier: string): string {
  return `[${identifier.replace(/]/g, ']]')}]`;
}

function column(table: XrefTableSchema, name: string): string {
  const actual = table.columns.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  if (!actual) throw new Error(`Unsupported xref schema: ${table.name} is missing column ${name}.`);
  return actual;
}

/** Only schemas we can map and page deterministically may replace a usage snapshot. */
export function xrefPageQuery(table: XrefTableSchema, names?: XrefTableSchema): string {
  if (!XREF_TABLES.some((name) => name === table.name)) {
    throw new Error(`Unsupported xref table: ${table.name}`);
  }
  const key = table.keys.find((candidate) => candidate.length > 0 &&
    candidate.every((name) => table.columns.includes(name)));
  if (!key) throw new Error(`Unsupported xref schema: ${table.name} needs an unfiltered unique key for paging.`);

  let projection = 'r.*';
  let joins = '';
  if (table.name === 'References') {
    if (!names || names.name !== 'Names') throw new Error('Unsupported xref schema: References requires dbo.Names.');
    const id = column(names, 'Id');
    if (!names.keys.some((candidate) => candidate.length === 1 && candidate[0] === id)) {
      throw new Error('Unsupported xref schema: Names.Id must be unique.');
    }
    const objectPath = quote(column(names, 'Path'));
    projection += `, src.${objectPath} AS __source_path, tgt.${objectPath} AS __target_path`;
    joins = ` LEFT JOIN [dbo].[Names] src ON src.${quote(id)} = r.${quote(column(table, 'SourceId'))}
      LEFT JOIN [dbo].[Names] tgt ON tgt.${quote(id)} = r.${quote(column(table, 'TargetId'))}`;
  } else {
    // Legacy installations are supported only when they expose explicit paths, not guessed ID mappings.
    projection += `, r.${quote(column(table, 'SourcePath'))} AS __source_path,
      r.${quote(column(table, 'TargetPath'))} AS __target_path`;
  }
  return `SELECT ${projection} FROM [dbo].${quote(table.name)} r${joins}
    ORDER BY ${key.map((name) => `r.${quote(name)}`).join(', ')}
    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
}

/**
 * True for connection strings that sign in as the current Windows user
 * (`Trusted_Connection=yes` or `Integrated Security=SSPI|true`), which the
 * default tedious driver cannot do.
 */
export function usesWindowsAuthentication(connectionString: string): boolean {
  return /(?:^|;)\s*(?:trusted_connection\s*=\s*(?:yes|true)|integrated security\s*=\s*(?:sspi|true|yes))\s*(?:;|$)/i
    .test(connectionString);
}

export const DEFAULT_ODBC_DRIVER = 'ODBC Driver 17 for SQL Server';

/**
 * ODBC connection string for the msnodesqlv8 driver: `Integrated Security`
 * becomes `Trusted_Connection=yes` and a driver is added when none is named.
 */
export function toOdbcConnectionString(connectionString: string): string {
  const parts = connectionString.split(';').map((part) => part.trim()).filter((part) => part.length > 0)
    .map((part) => (/^integrated security\s*=/i.test(part) ? 'Trusted_Connection=yes' : part));
  if (!parts.some((part) => /^driver\s*=/i.test(part))) parts.unshift(`Driver={${DEFAULT_ODBC_DRIVER}}`);
  return `${parts.join(';')};`;
}

/**
 * `mssql` is an optional dependency: the hosted container and `npx` installs
 * omit it because only `index-xref` needs SQL Server access. Windows
 * authentication additionally needs the native `msnodesqlv8` driver.
 */
export async function loadMssql(windowsAuthentication: boolean) {
  if (windowsAuthentication) {
    try {
      return await import('mssql/msnodesqlv8.js');
    } catch (err) {
      throw new Error(
        "Windows authentication (Trusted_Connection=yes) needs the optional 'msnodesqlv8' driver and an ODBC driver for SQL Server. " +
          'Run `npm install msnodesqlv8` where this CLI is installed (add -g for a global install), or use a SQL login instead.',
        { cause: err }
      );
    }
  }
  try {
    return await import('mssql');
  } catch (err) {
    throw new Error(
      "The optional 'mssql' driver is not installed (it is skipped by `npm install --omit=optional`). " +
        'Run `npm install mssql` on the machine that executes index-xref.',
      { cause: err }
    );
  }
}

export async function createMssqlClient(
  connectionString: string,
  options: { allowSourceLocks?: boolean; signal?: AbortSignal } = {}
): Promise<XrefSqlClient> {
  const windowsAuthentication = usesWindowsAuthentication(connectionString);
  const { default: sql } = await loadMssql(windowsAuthentication);
  const pool = windowsAuthentication
    ? new sql.ConnectionPool({ connectionString: toOdbcConnectionString(connectionString) } as unknown as Sql.config)
    : new sql.ConnectionPool(connectionString);
  let transaction: Sql.Transaction | undefined;
  let active = false;

  async function close(): Promise<void> {
    try {
      if (active && transaction) {
        await transaction.rollback();
        active = false;
      }
    } finally {
      await pool.close();
    }
  }

  async function query<T>(text: string, parameters?: { offset: number; limit: number }): Promise<T[]> {
    options.signal?.throwIfAborted();
    const request = transaction ? new sql.Request(transaction) : new sql.Request(pool);
    if (parameters) {
      request.input('offset', sql.BigInt, parameters.offset);
      request.input('limit', sql.Int, parameters.limit);
    }
    const cancel = () => request.cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      return (await request.query<T>(text)).recordset;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
    }
  }

  try {
    await pool.connect();
    const isolation = await query<{ state: number }>(
      'SELECT snapshot_isolation_state AS state FROM sys.databases WHERE database_id = DB_ID()'
    );
    const canSnapshot = isolation[0]?.state === 1;
    if (!canSnapshot && !options.allowSourceLocks) {
      throw new Error('SQL snapshot isolation is not enabled. Ask the DBA to enable it, or explicitly use --allow-source-locks for a serializable read that can delay compiler writes.');
    }
    const consistency = canSnapshot ? 'snapshot' : 'serializable';
    transaction = new sql.Transaction(pool);
    transaction.on('rollback', () => { active = false; });
    await transaction.begin(canSnapshot ? sql.ISOLATION_LEVEL.SNAPSHOT : sql.ISOLATION_LEVEL.SERIALIZABLE);
    active = true;

    const columns = await query<{ table_name: string; column_name: string }>(`
      SELECT t.name AS table_name, c.name AS column_name
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id WHERE s.name = 'dbo'`);
    const keyRows = await query<{ table_name: string; index_id: number; column_name: string }>(`
      SELECT t.name AS table_name, i.index_id, c.name AS column_name
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.indexes i ON i.object_id = t.object_id
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE s.name = 'dbo' AND i.is_unique = 1 AND i.has_filter = 0 AND i.is_disabled = 0
        AND ic.key_ordinal > 0
      ORDER BY t.name, i.is_primary_key DESC, i.index_id, ic.key_ordinal`);

    function schema(name: string): XrefTableSchema {
      const keys = new Map<number, string[]>();
      for (const row of keyRows.filter((row) => row.table_name === name)) {
        const key = keys.get(row.index_id) ?? [];
        key.push(row.column_name);
        keys.set(row.index_id, key);
      }
      return {
        name,
        columns: columns.filter((row) => row.table_name === name).map((row) => row.column_name),
        keys: [...keys.values()],
      };
    }
    const available = new Set(columns.map((row) => row.table_name));
    const tables = (available.has('References') ? ['References'] :
      XREF_TABLES.filter((name) => available.has(name))).map(schema);
    if (tables.length === 0) throw new Error('No supported xref tables found in dbo. Existing SQLite snapshot was not changed.');
    const names = schema('Names');
    const queries = tables.map((table) => ({ table, sql: xrefPageQuery(table, names) }));
    let expectedRows = 0;
    for (const table of tables) {
      const rows = await query<{ n: number | string }>(`SELECT COUNT_BIG(*) AS n FROM [dbo].${quote(table.name)}`);
      const count = Number(rows[0]?.n);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid source row count for ${table.name}.`);
      expectedRows += count;
    }

    return {
      source: { consistency, tables, expectedRows },
      async *batches() {
        for (const { table, sql: text } of queries) {
          for (let offset = 0; ; offset += 5000) {
            const rows = await query<Record<string, unknown>>(text, { offset, limit: 5000 });
            if (rows.length === 0) break;
            yield { table: table.name, rows };
            if (rows.length < 5000) break;
          }
        }
      },
      close,
    };
  } catch (err) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([err, cleanupError], 'SQL source initialization failed, and its connection could not be closed.');
    }
    throw err;
  }
}
