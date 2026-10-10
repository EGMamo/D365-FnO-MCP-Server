import { loadObjectXml } from '../indexer/sourceFiles.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import { parseAxTableKeys } from '../indexer/parser.js';
import { parseTraceMethodName, parseTraceTableNames } from '../indexer/traces.js';
import { fail, ok, type ToolResult } from './generators.js';

/*
 * Default thresholds follow Microsoft's Dynamics 365 FastTrack Trace Parser
 * views (vw_NPlusOnePatterns, vw_SlowQueries), MIT licensed,
 * Copyright (c) Microsoft Corporation.
 */
export const N_PLUS_ONE_MIN_CALLS = 100;
export const N_PLUS_ONE_MAX_AVG_MS = 5;
export const SLOW_SQL_MIN_MS = 5000;

const NO_TRACES =
  'No trace data imported. Run `d365-fno-mcp index-trace --connection-string "<AxTrace database>"` ' +
  '(or --from-json <file>) against a Trace Parser database first.';

/** AOT types a trace frame can belong to, most likely first. */
const CODE_TYPES = ['Class', 'Table', 'Form', 'DataEntityView', 'View', 'Query', 'Map'];

interface Scope {
  source?: string;
  sessionId?: string;
}

const scopeShape = {
  source: z.string().optional().describe('Import label (see list_trace_sessions); all imports when omitted.'),
  sessionId: z.string().optional().describe('Only this trace session.'),
};

function scopeWhere(scope: Scope, alias: string): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (scope.source) {
    clauses.push(`${alias}.source = ?`);
    params.push(scope.source);
  }
  if (scope.sessionId) {
    clauses.push(`${alias}.session_id = ?`);
    params.push(scope.sessionId);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
}

function hasTraces(db: Database): boolean {
  return db.prepare('SELECT 1 FROM ax_trace_imports LIMIT 1').get() !== undefined;
}

const round = (n: number) => Math.round(n * 100) / 100;

export interface AotMethodMatch {
  type: string;
  name: string;
  package: string;
  method: string;
  /** False when the object is indexed but the method is not declared on it (inherited, kernel or extension). */
  methodIndexed: boolean;
}

/** Maps a trace frame to an indexed AOT object + method, or null for kernel/CLR frames and unindexed code. */
export function resolveTraceMethod(db: Database, raw: string | null | undefined): AotMethodMatch | null {
  if (!raw) return null;
  const ref = parseTraceMethodName(raw);
  if (!ref) return null;
  const objects = db
    .prepare(`SELECT id, type, name, package FROM ax_objects WHERE name = ? COLLATE NOCASE AND type IN (${CODE_TYPES.map(() => '?').join(',')})`)
    .all(ref.className, ...CODE_TYPES) as { id: number; type: string; name: string; package: string }[];
  if (objects.length === 0) return null;
  objects.sort((a, b) => CODE_TYPES.indexOf(a.type) - CODE_TYPES.indexOf(b.type));
  const hasMethod = db.prepare('SELECT name FROM ax_methods WHERE object_id = ? AND name = ? COLLATE NOCASE LIMIT 1');
  for (const obj of objects) {
    const m = hasMethod.get(obj.id, ref.methodName) as { name: string } | undefined;
    if (m) return { type: obj.type, name: obj.name, package: obj.package, method: m.name, methodIndexed: true };
  }
  const first = objects[0];
  return { type: first.type, name: first.name, package: first.package, method: ref.methodName, methodIndexed: false };
}

export interface AotTableMatch {
  sqlName: string;
  table: string | null;
  package?: string;
  tableGroup?: string;
  indexes?: { name: string; fields: string[]; unique: boolean; enabled: boolean }[];
}

async function resolveTables(
  db: Database,
  tableNames: string | null | undefined,
  cache: Map<string, AotTableMatch>
): Promise<AotTableMatch[]> {
  const out: AotTableMatch[] = [];
  for (const sqlName of parseTraceTableNames(tableNames)) {
    let match = cache.get(sqlName);
    if (!match) {
      const row = db
        .prepare(`SELECT name, package, file_path, raw_xml FROM ax_objects WHERE type = 'Table' AND name = ? COLLATE NOCASE`)
        .get(sqlName) as { name: string; package: string; file_path: string; raw_xml: string | null } | undefined;
      match = { sqlName, table: row?.name ?? null };
      if (row) {
        match.package = row.package;
        const xml = await loadObjectXml(row);
        if (xml) {
          try {
            const keys = parseAxTableKeys(xml);
            match.tableGroup = keys.tableGroup || undefined;
            match.indexes = keys.indexes.map((i) => ({
              name: i.name, fields: i.fields, unique: !i.allowDuplicates, enabled: i.enabled,
            }));
          } catch {
            // Unparseable XML: report the table without index detail.
          }
        }
      }
      cache.set(sqlName, match);
    }
    out.push(match);
  }
  return out;
}

interface SessionRow {
  source: string; session_id: string; trace_name: string | null; session_name: string | null;
  user_name: string | null; started_at: string | null; ended_at: string | null;
  total_ms: number; db_ms: number; db_calls: number; rows_fetched: number;
}

export function listTraceSessions(db: Database, source?: string, limit = 50): ToolResult {
  if (!hasTraces(db)) return fail(NO_TRACES);
  const imports = db.prepare('SELECT * FROM ax_trace_imports ORDER BY imported_at DESC').all();
  const where = scopeWhere({ source }, 's');
  const sessions = db
    .prepare(`SELECT * FROM ax_trace_sessions s WHERE ${where.sql} ORDER BY total_ms DESC LIMIT ?`)
    .all(...where.params, limit) as unknown as SessionRow[];
  return ok(JSON.stringify({
    imports,
    sessions: sessions.map((s) => ({
      ...s,
      total_ms: round(s.total_ms),
      db_ms: round(s.db_ms),
      db_share_pct: s.total_ms > 0 ? round((100 * s.db_ms) / s.total_ms) : null,
    })),
  }));
}

interface MethodRow {
  source: string; session_id: string; method_name: string; calls: number; inclusive_ms: number;
  exclusive_ms: number; db_ms: number; db_calls: number; rows_fetched: number;
  worst_line_db_calls: number; worst_line_db_ms: number;
}

export function findNPlusOne(
  db: Database,
  scope: Scope & { minCalls?: number; maxAvgMs?: number; limit?: number }
): ToolResult {
  if (!hasTraces(db)) return fail(NO_TRACES);
  const minCalls = scope.minCalls ?? N_PLUS_ONE_MIN_CALLS;
  const maxAvgMs = scope.maxAvgMs ?? N_PLUS_ONE_MAX_AVG_MS;
  const where = scopeWhere(scope, 'm');
  const rows = db.prepare(`
    SELECT * FROM ax_trace_methods m
    WHERE ${where.sql} AND m.worst_line_db_calls >= ?
      AND m.worst_line_db_ms / m.worst_line_db_calls < ?
    ORDER BY m.worst_line_db_calls DESC LIMIT ?`)
    .all(...where.params, minCalls, maxAvgMs, scope.limit ?? 25) as unknown as MethodRow[];
  const findings = rows.map((m) => ({
    source: m.source,
    sessionId: m.session_id,
    method: m.method_name,
    aot: resolveTraceMethod(db, m.method_name),
    dbCallsInOneCall: m.worst_line_db_calls,
    dbMsInOneCall: round(m.worst_line_db_ms),
    avgMsPerDbCall: round(m.worst_line_db_ms / m.worst_line_db_calls),
    methodCalls: m.calls,
    totalDbCalls: m.db_calls,
  }));
  return ok(JSON.stringify({
    thresholds: { minCalls, maxAvgMs },
    hint: 'Many cheap round-trips from one method call usually mean a select or find() inside a loop. ' +
      'Consider a join, exists join, set-based operation (insert_recordset/update_recordset/delete_from) or caching; ' +
      'use get_method_source on the aot match to confirm.',
    findings,
  }));
}

interface SqlRow {
  source: string; session_id: string; statement: string; table_names: string | null;
  method_name: string | null; executions: number; total_ms: number; max_ms: number; rows_fetched: number;
}

export async function findSlowSql(
  db: Database,
  scope: Scope & { minMs?: number; metric?: 'max' | 'total'; limit?: number }
): Promise<ToolResult> {
  if (!hasTraces(db)) return fail(NO_TRACES);
  const minMs = scope.minMs ?? SLOW_SQL_MIN_MS;
  const column = scope.metric === 'total' ? 'total_ms' : 'max_ms';
  const where = scopeWhere(scope, 'q');
  const rows = db.prepare(`
    SELECT * FROM ax_trace_sql q WHERE ${where.sql} AND q.${column} >= ?
    ORDER BY q.${column} DESC LIMIT ?`)
    .all(...where.params, minMs, scope.limit ?? 25) as unknown as SqlRow[];
  const cache = new Map<string, AotTableMatch>();
  const findings = [];
  for (const q of rows) {
    findings.push({
      source: q.source,
      sessionId: q.session_id,
      statement: q.statement.length > 4000 ? `${q.statement.slice(0, 4000)} …` : q.statement,
      executions: q.executions,
      maxMs: round(q.max_ms),
      totalMs: round(q.total_ms),
      rowsFetched: q.rows_fetched,
      calledFrom: q.method_name,
      aot: resolveTraceMethod(db, q.method_name),
      tables: await resolveTables(db, q.table_names, cache),
    });
  }
  return ok(JSON.stringify({
    thresholds: { minMs, metric: scope.metric ?? 'max' },
    hint: 'Compare the WHERE/JOIN/ORDER BY columns with each table\'s indexes. Missing index coverage, ' +
      'a filter on a non-leading index field, or a large rowsFetched are the usual causes. Validate with the ' +
      'query plan (LCS/Query Store) before adding an index.',
    findings,
  }));
}

export function getTopMethods(
  db: Database,
  scope: Scope & { orderBy?: 'inclusive' | 'exclusive' | 'db'; limit?: number }
): ToolResult {
  if (!hasTraces(db)) return fail(NO_TRACES);
  const column = { inclusive: 'inclusive_ms', exclusive: 'exclusive_ms', db: 'db_ms' }[scope.orderBy ?? 'exclusive'];
  const where = scopeWhere(scope, 'm');
  const rows = db.prepare(`SELECT * FROM ax_trace_methods m WHERE ${where.sql} ORDER BY m.${column} DESC LIMIT ?`)
    .all(...where.params, scope.limit ?? 25) as unknown as MethodRow[];
  return ok(JSON.stringify({
    orderBy: scope.orderBy ?? 'exclusive',
    note: 'inclusiveMs sums every call, so recursive methods are counted more than once.',
    methods: rows.map((m) => ({
      source: m.source,
      sessionId: m.session_id,
      method: m.method_name,
      aot: resolveTraceMethod(db, m.method_name),
      calls: m.calls,
      inclusiveMs: round(m.inclusive_ms),
      exclusiveMs: round(m.exclusive_ms),
      dbMs: round(m.db_ms),
      dbCalls: m.db_calls,
      rowsFetched: m.rows_fetched,
    })),
  }));
}

export function searchTrace(db: Database, scope: Scope & { keyword: string; limit?: number }): ToolResult {
  if (!hasTraces(db)) return fail(NO_TRACES);
  const keyword = scope.keyword.trim();
  if (!keyword) return fail('keyword must not be empty.');
  const like = `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const limit = scope.limit ?? 25;
  const mw = scopeWhere(scope, 'm');
  const methods = db.prepare(`
    SELECT * FROM ax_trace_methods m WHERE ${mw.sql} AND m.method_name LIKE ? ESCAPE '\\'
    ORDER BY m.inclusive_ms DESC LIMIT ?`).all(...mw.params, like, limit) as unknown as MethodRow[];
  const qw = scopeWhere(scope, 'q');
  const statements = db.prepare(`
    SELECT * FROM ax_trace_sql q
    WHERE ${qw.sql} AND (q.statement LIKE ? ESCAPE '\\' OR q.table_names LIKE ? ESCAPE '\\' OR q.method_name LIKE ? ESCAPE '\\')
    ORDER BY q.total_ms DESC LIMIT ?`).all(...qw.params, like, like, like, limit) as unknown as SqlRow[];
  return ok(JSON.stringify({
    keyword,
    methods: methods.map((m) => ({
      source: m.source, sessionId: m.session_id, method: m.method_name, calls: m.calls,
      inclusiveMs: round(m.inclusive_ms), dbMs: round(m.db_ms), dbCalls: m.db_calls,
    })),
    statements: statements.map((q) => ({
      source: q.source, sessionId: q.session_id,
      statement: q.statement.length > 1000 ? `${q.statement.slice(0, 1000)} …` : q.statement,
      tables: q.table_names, calledFrom: q.method_name, executions: q.executions,
      totalMs: round(q.total_ms), maxMs: round(q.max_ms),
    })),
  }));
}

export function registerTraceTools(server: McpServer, db: Database): void {
  const limit = z.number().int().min(1).max(200).default(25);

  server.tool(
    'list_trace_sessions',
    'List imported Trace Parser (AxTrace) captures and their sessions, slowest first, with total/database time and call counts. Start here before the other trace tools.',
    { source: scopeShape.source, limit: z.number().int().min(1).max(500).default(50) },
    async ({ source, limit }) => listTraceSessions(db, source, limit)
  );

  server.tool(
    'find_n_plus_one',
    `Find N+1 query patterns in imported traces: a single call of a method that issued many cheap database round-trips (defaults: >= ${N_PLUS_ONE_MIN_CALLS} calls averaging < ${N_PLUS_ONE_MAX_AVG_MS} ms, as in the FastTrack Trace Parser views). Each finding is mapped to the indexed AOT class/table method.`,
    {
      ...scopeShape,
      minCalls: z.number().int().min(1).default(N_PLUS_ONE_MIN_CALLS),
      maxAvgMs: z.number().positive().default(N_PLUS_ONE_MAX_AVG_MS),
      limit,
    },
    async (args) => findNPlusOne(db, args)
  );

  server.tool(
    'find_slow_sql',
    `Find slow SQL statements in imported traces (default: an execution >= ${SLOW_SQL_MIN_MS} ms; metric=total ranks by summed time instead). Each statement comes with the X++ method that issued it and the AOT tables it touches, including their indexes, so missing index coverage can be checked.`,
    {
      ...scopeShape,
      minMs: z.number().min(0).default(SLOW_SQL_MIN_MS),
      metric: z.enum(['max', 'total']).default('max'),
      limit,
    },
    async (args) => findSlowSql(db, args)
  );

  server.tool(
    'get_top_methods',
    'Rank X++ methods in imported traces by exclusive (own) time, inclusive time or database time, mapped to indexed AOT objects.',
    { ...scopeShape, orderBy: z.enum(['exclusive', 'inclusive', 'db']).default('exclusive'), limit },
    async (args) => getTopMethods(db, args)
  );

  server.tool(
    'search_trace',
    'Search imported traces for a method name, table name or SQL fragment (case-insensitive substring).',
    { ...scopeShape, keyword: z.string().min(1), limit },
    async (args) => searchTrace(db, args)
  );
}
