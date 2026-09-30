import fs from 'node:fs/promises';
import path from 'node:path';
import { openDb } from '../indexer/db.js';
import { publishTraceSnapshot } from '../indexer/traces.js';
import {
  DEFAULT_TRACE_MAX_ROWS, parseTraceSnapshotJson, readTraceSnapshotFromSql, type TraceSnapshot,
} from '../indexer/traceSql.js';

export interface IndexTraceOptions {
  connectionString?: string;
  fromJson?: string;
  source?: string;
  trace?: string;
  maxRows?: number;
  dbPath?: string;
  signal?: AbortSignal;
}

/** Default label: the database name from the connection string, else "trace". */
export function defaultTraceSource(connectionString: string): string {
  const match = /(?:^|;)\s*(?:Database|Initial Catalog)\s*=\s*([^;]+)/i.exec(connectionString);
  return match?.[1].trim() || 'trace';
}

function safeError(err: unknown, connectionString?: string): string {
  if (err instanceof Error && 'code' in err && connectionString) {
    return `SQL Server operation failed (${String(err.code)}). Check database permissions, authentication and TLS configuration.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return connectionString ? message.replaceAll(connectionString, '[redacted connection string]') : message;
}

export async function indexTraceCommand(
  options: IndexTraceOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const connectionString = options.fromJson ? undefined : options.connectionString ?? env.D365_TRACE_CONNECTION_STRING;
  if (!options.fromJson && !connectionString) {
    console.error('Set D365_TRACE_CONNECTION_STRING, pass --connection-string, or use --from-json <file>.');
    return 1;
  }
  const maxRows = options.maxRows ?? DEFAULT_TRACE_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    console.error('--max-rows must be a positive integer.');
    return 1;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Trace import cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    let snapshot: TraceSnapshot;
    let source: string;
    if (options.fromJson) {
      snapshot = parseTraceSnapshotJson(await fs.readFile(options.fromJson, 'utf-8'));
      if (options.trace) {
        const keep = new Set(snapshot.sessions.filter((s) => s.trace_name === options.trace).map((s) => s.session_id));
        snapshot = {
          sessions: snapshot.sessions.filter((s) => keep.has(s.session_id)),
          methods: snapshot.methods.filter((m) => keep.has(m.session_id)),
          statements: snapshot.statements.filter((q) => keep.has(q.session_id)),
        };
      }
      source = options.source ?? path.basename(options.fromJson, path.extname(options.fromJson));
    } else {
      snapshot = await readTraceSnapshotFromSql(connectionString!, {
        trace: options.trace, maxRows, signal: options.signal ?? abort.signal,
      });
      source = options.source ?? defaultTraceSource(connectionString!);
    }
    if (snapshot.sessions.length === 0) {
      throw new Error(options.trace ? `No sessions found for trace "${options.trace}".` : 'The trace source contains no sessions.');
    }
    (options.signal ?? abort.signal).throwIfAborted();
    const db = openDb(path.resolve(dbPath));
    try {
      publishTraceSnapshot(db, source, options.fromJson ? 'json' : 'sql', snapshot);
    } finally {
      db.close();
    }
    console.log(
      `Imported trace "${source}": ${snapshot.sessions.length} sessions, ${snapshot.methods.length} methods, ` +
        `${snapshot.statements.length} SQL statements into ${dbPath}.`
    );
    return 0;
  } catch (err) {
    console.error(`Trace import failed: ${safeError(err, connectionString)}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
