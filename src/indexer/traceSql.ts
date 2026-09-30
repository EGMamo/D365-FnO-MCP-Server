import type * as Sql from 'mssql';
import { z } from 'zod';
import { loadMssql, toOdbcConnectionString, usesWindowsAuthentication } from './xrefSql.js';

/**
 * Reads a Trace Parser (AxTrace) database into compact per-session aggregates.
 * Schema and anti-pattern thresholds follow Microsoft's Dynamics 365 FastTrack
 * "Trace Parser" views (MIT, Copyright (c) Microsoft Corporation).
 */

const num = z.coerce.number().finite().default(0);
const id = z.preprocess((v) => (typeof v === 'number' || typeof v === 'bigint' ? String(v) : v), z.string().min(1));
const optionalText = z.preprocess((v) => (v === null || v === undefined ? undefined : String(v)), z.string().optional());

export const traceSessionSchema = z.object({
  session_id: id,
  trace_name: optionalText,
  session_name: optionalText,
  user_name: optionalText,
  started_at: optionalText,
  ended_at: optionalText,
  total_ms: num,
  db_ms: num,
  db_calls: num,
  rows_fetched: num,
});

export const traceMethodSchema = z.object({
  session_id: id,
  method_name: z.string().min(1),
  calls: num,
  inclusive_ms: num,
  exclusive_ms: num,
  db_ms: num,
  db_calls: num,
  rows_fetched: num,
  worst_line_db_calls: num,
  worst_line_db_ms: num,
});

export const traceStatementSchema = z.object({
  session_id: id,
  statement: z.string().min(1),
  table_names: optionalText,
  method_name: optionalText,
  executions: num,
  total_ms: num,
  max_ms: num,
  rows_fetched: num,
});

export const traceSnapshotSchema = z.object({
  sessions: z.array(traceSessionSchema),
  methods: z.array(traceMethodSchema).default([]),
  statements: z.array(traceStatementSchema).default([]),
});

export type TraceSession = z.infer<typeof traceSessionSchema>;
export type TraceMethod = z.infer<typeof traceMethodSchema>;
export type TraceStatement = z.infer<typeof traceStatementSchema>;
export type TraceSnapshot = z.infer<typeof traceSnapshotSchema>;

/** Columns the aggregate queries read; probed up front so a wrong database fails clearly. */
export const REQUIRED_TRACE_COLUMNS: Record<string, string[]> = {
  Traces: ['TraceId', 'TraceName', 'TimeStampBegin', 'TimeStampEnd'],
  UserSessions: ['SessionId', 'TraceId', 'SessionName', 'UserId'],
  Users: ['UserId', 'UserName'],
  UserSessionProcessThreads: ['UserSessionProcessThreadId', 'SessionId', 'TraceId'],
  TraceLines: [
    'UserSessionProcessThreadId', 'ParentSequence', 'MethodHash', 'InclusiveDurationNano',
    'ExclusiveDurationNano', 'DatabaseDurationNano', 'DatabaseCalls', 'RowFetchCount',
    'QueryStatementHash', 'QueryTableHash',
  ],
  MethodNames: ['MethodHash', 'Name'],
  QueryStatements: ['QueryStatementHash', 'Statement'],
  QueryTables: ['QueryTableHash', 'TableNames'],
};

export function missingTraceColumns(columns: { table_name: string; column_name: string }[]): string[] {
  const present = new Set(columns.map((c) => `${c.table_name.toLowerCase()}.${c.column_name.toLowerCase()}`));
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(REQUIRED_TRACE_COLUMNS)) {
    for (const col of cols) {
      if (!present.has(`${table.toLowerCase()}.${col.toLowerCase()}`)) missing.push(`${table}.${col}`);
    }
  }
  return missing;
}

const LINES = `
  FROM dbo.TraceLines tl
  JOIN dbo.UserSessionProcessThreads p ON p.UserSessionProcessThreadId = tl.UserSessionProcessThreadId
  JOIN dbo.Traces t ON t.TraceId = p.TraceId
  WHERE (@trace IS NULL OR t.TraceName = @trace)`;

export const TRACE_SESSIONS_QUERY = `
SELECT us.SessionId AS session_id, t.TraceName AS trace_name, us.SessionName AS session_name,
  u.UserName AS user_name, CONVERT(varchar(33), t.TimeStampBegin, 126) AS started_at,
  CONVERT(varchar(33), t.TimeStampEnd, 126) AS ended_at,
  CAST(SUM(CASE WHEN tl.ParentSequence IS NULL THEN CAST(tl.InclusiveDurationNano AS float) ELSE 0 END) / 1000000.0 AS float) AS total_ms,
  CAST(SUM(CAST(tl.DatabaseDurationNano AS float)) / 1000000.0 AS float) AS db_ms,
  SUM(CAST(tl.DatabaseCalls AS bigint)) AS db_calls,
  SUM(CAST(tl.RowFetchCount AS bigint)) AS rows_fetched
FROM dbo.UserSessions us
JOIN dbo.Traces t ON t.TraceId = us.TraceId
LEFT JOIN dbo.Users u ON u.UserId = us.UserId
LEFT JOIN dbo.UserSessionProcessThreads p ON p.SessionId = us.SessionId AND p.TraceId = us.TraceId
LEFT JOIN dbo.TraceLines tl ON tl.UserSessionProcessThreadId = p.UserSessionProcessThreadId
WHERE (@trace IS NULL OR t.TraceName = @trace)
GROUP BY us.SessionId, t.TraceName, us.SessionName, u.UserName, t.TimeStampBegin, t.TimeStampEnd`;

/** Per (session, method) totals plus the single line with the most database calls (FastTrack's N+1 unit). */
export const TRACE_METHODS_QUERY = `
WITH lines AS (
  SELECT p.SessionId, tl.MethodHash, tl.InclusiveDurationNano, tl.ExclusiveDurationNano,
    tl.DatabaseDurationNano, tl.DatabaseCalls, tl.RowFetchCount,
    ROW_NUMBER() OVER (PARTITION BY p.SessionId, tl.MethodHash
      ORDER BY tl.DatabaseCalls DESC, tl.DatabaseDurationNano DESC) AS rn
  ${LINES} AND tl.MethodHash IS NOT NULL
), agg AS (
  SELECT SessionId, MethodHash, COUNT_BIG(*) AS calls,
    SUM(CAST(InclusiveDurationNano AS float)) / 1000000.0 AS inclusive_ms,
    SUM(CAST(ExclusiveDurationNano AS float)) / 1000000.0 AS exclusive_ms,
    SUM(CAST(DatabaseDurationNano AS float)) / 1000000.0 AS db_ms,
    SUM(CAST(DatabaseCalls AS bigint)) AS db_calls,
    SUM(CAST(RowFetchCount AS bigint)) AS rows_fetched,
    ROW_NUMBER() OVER (PARTITION BY SessionId ORDER BY SUM(CAST(InclusiveDurationNano AS float)) DESC) AS r
  FROM lines GROUP BY SessionId, MethodHash
)
SELECT a.SessionId AS session_id, mn.Name AS method_name, a.calls, a.inclusive_ms, a.exclusive_ms,
  a.db_ms, a.db_calls, a.rows_fetched, w.DatabaseCalls AS worst_line_db_calls,
  CAST(w.DatabaseDurationNano AS float) / 1000000.0 AS worst_line_db_ms
FROM agg a
JOIN lines w ON w.SessionId = a.SessionId AND w.MethodHash = a.MethodHash AND w.rn = 1
JOIN dbo.MethodNames mn ON mn.MethodHash = a.MethodHash
WHERE a.r <= @limit`;

/** Per (session, statement) totals, with the method and tables of its slowest execution. */
export const TRACE_STATEMENTS_QUERY = `
WITH lines AS (
  SELECT p.SessionId, tl.QueryStatementHash, tl.QueryTableHash, tl.MethodHash,
    tl.DatabaseDurationNano, tl.RowFetchCount,
    ROW_NUMBER() OVER (PARTITION BY p.SessionId, tl.QueryStatementHash
      ORDER BY tl.DatabaseDurationNano DESC) AS rn
  ${LINES} AND tl.QueryStatementHash IS NOT NULL
), agg AS (
  SELECT SessionId, QueryStatementHash, COUNT_BIG(*) AS executions,
    SUM(CAST(DatabaseDurationNano AS float)) / 1000000.0 AS total_ms,
    MAX(CAST(DatabaseDurationNano AS float)) / 1000000.0 AS max_ms,
    SUM(CAST(RowFetchCount AS bigint)) AS rows_fetched,
    ROW_NUMBER() OVER (PARTITION BY SessionId ORDER BY SUM(CAST(DatabaseDurationNano AS float)) DESC) AS r
  FROM lines GROUP BY SessionId, QueryStatementHash
)
SELECT a.SessionId AS session_id, qs.Statement AS statement, qt.TableNames AS table_names,
  mn.Name AS method_name, a.executions, a.total_ms, a.max_ms, a.rows_fetched
FROM agg a
JOIN lines w ON w.SessionId = a.SessionId AND w.QueryStatementHash = a.QueryStatementHash AND w.rn = 1
JOIN dbo.QueryStatements qs ON qs.QueryStatementHash = a.QueryStatementHash
LEFT JOIN dbo.QueryTables qt ON qt.QueryTableHash = w.QueryTableHash
LEFT JOIN dbo.MethodNames mn ON mn.MethodHash = w.MethodHash
WHERE a.r <= @limit`;

export interface TraceReadOptions {
  /** Only this TraceName; all traces when omitted. */
  trace?: string;
  /** Per-session cap for methods and statements, ranked by time. */
  maxRows?: number;
  signal?: AbortSignal;
}

export const DEFAULT_TRACE_MAX_ROWS = 1000;

/**
 * Trace databases are written once by Trace Parser and then only read, so the
 * aggregates run under the default isolation without a long-lived transaction.
 */
export async function readTraceSnapshotFromSql(
  connectionString: string,
  options: TraceReadOptions = {}
): Promise<TraceSnapshot> {
  const windowsAuthentication = usesWindowsAuthentication(connectionString);
  const { default: sql } = await loadMssql(windowsAuthentication);
  const pool = windowsAuthentication
    ? new sql.ConnectionPool({ connectionString: toOdbcConnectionString(connectionString) } as unknown as Sql.config)
    : new sql.ConnectionPool(connectionString);

  async function query<T>(text: string): Promise<T[]> {
    options.signal?.throwIfAborted();
    const request = new sql.Request(pool);
    request.input('trace', sql.NVarChar, options.trace ?? null);
    request.input('limit', sql.Int, options.maxRows ?? DEFAULT_TRACE_MAX_ROWS);
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
    const columns = await query<{ table_name: string; column_name: string }>(`
      SELECT t.name AS table_name, c.name AS column_name
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id WHERE s.name = 'dbo'`);
    const missing = missingTraceColumns(columns);
    if (missing.length) {
      throw new Error(`Not a Trace Parser database; missing ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}.`);
    }
    return traceSnapshotSchema.parse({
      sessions: await query(TRACE_SESSIONS_QUERY),
      methods: await query(TRACE_METHODS_QUERY),
      statements: await query(TRACE_STATEMENTS_QUERY),
    });
  } finally {
    await pool.close();
  }
}

/** Offline source: the same snake_case rows the SQL queries return, as `{ sessions, methods, statements }`. */
export function parseTraceSnapshotJson(text: string): TraceSnapshot {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Trace JSON is not valid JSON: ${(err as Error).message}`);
  }
  const result = traceSnapshotSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Trace JSON does not match the expected shape at ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  return result.data;
}
