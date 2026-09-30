import type { Database } from './db.js';
import type { TraceSnapshot } from './traceSql.js';

export function createTraceSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ax_trace_imports (
      source TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      session_count INTEGER NOT NULL,
      method_count INTEGER NOT NULL,
      statement_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ax_trace_sessions (
      source TEXT NOT NULL REFERENCES ax_trace_imports(source) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      trace_name TEXT, session_name TEXT, user_name TEXT, started_at TEXT, ended_at TEXT,
      total_ms REAL NOT NULL, db_ms REAL NOT NULL, db_calls INTEGER NOT NULL, rows_fetched INTEGER NOT NULL,
      PRIMARY KEY (source, session_id)
    );
    CREATE TABLE IF NOT EXISTS ax_trace_methods (
      source TEXT NOT NULL REFERENCES ax_trace_imports(source) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      method_name TEXT NOT NULL,
      calls INTEGER NOT NULL, inclusive_ms REAL NOT NULL, exclusive_ms REAL NOT NULL,
      db_ms REAL NOT NULL, db_calls INTEGER NOT NULL, rows_fetched INTEGER NOT NULL,
      worst_line_db_calls INTEGER NOT NULL, worst_line_db_ms REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ax_trace_methods_session ON ax_trace_methods(source, session_id);
    CREATE TABLE IF NOT EXISTS ax_trace_sql (
      source TEXT NOT NULL REFERENCES ax_trace_imports(source) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      statement TEXT NOT NULL,
      table_names TEXT, method_name TEXT,
      executions INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL, rows_fetched INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ax_trace_sql_session ON ax_trace_sql(source, session_id);
  `);
}

/** Replaces everything previously imported under `source` in one transaction. */
export function publishTraceSnapshot(
  db: Database,
  source: string,
  origin: 'sql' | 'json',
  snapshot: TraceSnapshot
): void {
  const sessionIds = new Set(snapshot.sessions.map((s) => s.session_id));
  if (sessionIds.size !== snapshot.sessions.length) {
    throw new Error('Trace snapshot has duplicate session_id values.');
  }
  for (const row of [...snapshot.methods, ...snapshot.statements]) {
    if (!sessionIds.has(row.session_id)) {
      throw new Error(`Trace snapshot references unknown session_id ${row.session_id}.`);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM ax_trace_imports WHERE source = ?').run(source);
    db.prepare('INSERT INTO ax_trace_imports VALUES (?, ?, ?, ?, ?, ?)').run(
      source, origin, new Date().toISOString(),
      snapshot.sessions.length, snapshot.methods.length, snapshot.statements.length
    );
    const session = db.prepare('INSERT INTO ax_trace_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of snapshot.sessions) {
      session.run(source, s.session_id, s.trace_name ?? null, s.session_name ?? null, s.user_name ?? null,
        s.started_at ?? null, s.ended_at ?? null, s.total_ms, s.db_ms, s.db_calls, s.rows_fetched);
    }
    const method = db.prepare('INSERT INTO ax_trace_methods VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const m of snapshot.methods) {
      method.run(source, m.session_id, m.method_name, m.calls, m.inclusive_ms, m.exclusive_ms,
        m.db_ms, m.db_calls, m.rows_fetched, m.worst_line_db_calls, m.worst_line_db_ms);
    }
    const statement = db.prepare('INSERT INTO ax_trace_sql VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const q of snapshot.statements) {
      statement.run(source, q.session_id, q.statement, q.table_names ?? null, q.method_name ?? null,
        q.executions, q.total_ms, q.max_ms, q.rows_fetched);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface TraceMethodRef {
  /** As recorded in the trace. */
  raw: string;
  className: string;
  methodName: string;
}

/**
 * Trace method names look like `SalesFormLetter::run`, `SalesLine.insert` or
 * `Dynamics.AX.Application.SalesFormLetter::run(...)`. Kernel/CLR frames that
 * don't split into class + method return null.
 */
export function parseTraceMethodName(raw: string): TraceMethodRef | null {
  let name = raw.trim().replace(/\(.*\)\s*$/, '').replace(/^Dynamics\.AX\.Application\./i, '');
  name = name.replace(/`\d+$/, '');
  let split = name.lastIndexOf('::');
  let width = 2;
  if (split < 0) {
    split = name.lastIndexOf('.');
    width = 1;
  }
  if (split <= 0) return null;
  const className = name.slice(0, split).split('.').pop() ?? '';
  const methodName = name.slice(split + width);
  if (!/^\w+$/.test(className) || !/^\w+$/.test(methodName)) return null;
  return { raw, className, methodName };
}

/** SQL table names recorded by the trace, e.g. `SALESLINE,INVENTTRANS` or `[dbo].[SALESLINE]`. */
export function parseTraceTableNames(value: string | null | undefined): string[] {
  if (!value) return [];
  const names = value
    .split(/[,;\s]+/)
    .map((n) => n.replace(/[[\]"]/g, '').split('.').pop() ?? '')
    .filter((n) => /^\w+$/.test(n));
  return [...new Set(names.map((n) => n.toUpperCase()))];
}
