import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Database } from '../src/indexer/db.js';
import { openDb } from '../src/indexer/db.js';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { parseTraceMethodName, parseTraceTableNames, publishTraceSnapshot } from '../src/indexer/traces.js';
import {
  missingTraceColumns, parseTraceSnapshotJson, REQUIRED_TRACE_COLUMNS, type TraceSnapshot,
} from '../src/indexer/traceSql.js';
import { registerTraceTools, resolveTraceMethod } from '../src/tools/traces.js';
import { defaultTraceSource, indexTraceCommand } from '../src/cli/index-trace-command.js';
import { snapshotIndex } from '../src/indexer/indexSnapshot.js';
import { fakeToolServer, type ToolResult } from './helpers/toolHarness.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const NS = 'xmlns:i="http://www.w3.org/2001/XMLSchema-instance"';
const SALES_TABLE = `<?xml version="1.0" encoding="utf-8"?><AxTable ${NS}><Name>SampleSalesLine</Name>
<TableGroup>WorksheetLine</TableGroup>
<Fields><AxTableField i:type="AxTableFieldString"><Name>SalesId</Name></AxTableField><AxTableField i:type="AxTableFieldString"><Name>ItemId</Name></AxTableField></Fields>
<Indexes><AxTableIndex><Name>SalesIdx</Name><Fields><AxTableIndexField><DataField>SalesId</DataField></AxTableIndexField></Fields></AxTableIndex></Indexes>
</AxTable>`;

const SNAPSHOT: TraceSnapshot = {
  sessions: [
    { session_id: '1', trace_name: 'PostInvoice', session_name: 'Session 1', user_name: 'admin',
      started_at: '2025-01-01T10:00:00', ended_at: '2025-01-01T10:01:00', total_ms: 60000, db_ms: 30000, db_calls: 900, rows_fetched: 5000 },
    { session_id: '2', trace_name: 'Other', total_ms: 1000, db_ms: 10, db_calls: 3, rows_fetched: 3 },
  ],
  methods: [
    { session_id: '1', method_name: 'Dynamics.AX.Application.SampleClass::buildMessage', calls: 2, inclusive_ms: 20000,
      exclusive_ms: 500, db_ms: 1500, db_calls: 800, rows_fetched: 800, worst_line_db_calls: 400, worst_line_db_ms: 800 },
    { session_id: '1', method_name: 'SampleClass.construct', calls: 1, inclusive_ms: 100,
      exclusive_ms: 3000, db_ms: 50, db_calls: 150, rows_fetched: 10, worst_line_db_calls: 150, worst_line_db_ms: 1500 },
    { session_id: '1', method_name: 'xRecord::insert', calls: 5, inclusive_ms: 10, exclusive_ms: 10,
      db_ms: 5, db_calls: 5, rows_fetched: 0, worst_line_db_calls: 1, worst_line_db_ms: 1 },
  ],
  statements: [
    { session_id: '1', statement: 'SELECT T1.ITEMID FROM SAMPLESALESLINE T1 WHERE T1.ITEMID=@P1', table_names: 'SAMPLESALESLINE,UNKNOWNTABLE',
      method_name: 'SampleClass::buildMessage', executions: 3, total_ms: 9000, max_ms: 6000, rows_fetched: 30000 },
    { session_id: '1', statement: 'SELECT 1 FROM FAST', table_names: 'FAST', method_name: undefined, executions: 200,
      total_ms: 7000, max_ms: 40, rows_fetched: 200 },
  ],
};

describe('trace name parsing', () => {
  it('splits class and method from trace frames', () => {
    expect(parseTraceMethodName('SalesFormLetter::run')).toMatchObject({ className: 'SalesFormLetter', methodName: 'run' });
    expect(parseTraceMethodName('SalesLine.insert')).toMatchObject({ className: 'SalesLine', methodName: 'insert' });
    expect(parseTraceMethodName('Dynamics.AX.Application.SalesFormLetter::run(Args)')).toMatchObject({
      className: 'SalesFormLetter', methodName: 'run',
    });
    expect(parseTraceMethodName('main')).toBeNull();
    expect(parseTraceMethodName('SQL: select')).toBeNull();
  });

  it('normalizes SQL table name lists', () => {
    expect(parseTraceTableNames('SALESLINE, [dbo].[InventTrans];SALESLINE')).toEqual(['SALESLINE', 'INVENTTRANS']);
    expect(parseTraceTableNames(null)).toEqual([]);
  });
});

describe('trace source validation', () => {
  it('reports missing AxTrace columns', () => {
    const all = Object.entries(REQUIRED_TRACE_COLUMNS).flatMap(([t, cols]) =>
      cols.map((c) => ({ table_name: t.toUpperCase(), column_name: c })));
    expect(missingTraceColumns(all)).toEqual([]);
    expect(missingTraceColumns(all.filter((c) => c.column_name !== 'MethodHash'))).toEqual(['TraceLines.MethodHash', 'MethodNames.MethodHash']);
  });

  it('parses JSON snapshots and coerces numbers', () => {
    const parsed = parseTraceSnapshotJson(JSON.stringify({ sessions: [{ session_id: 7, total_ms: '12.5' }] }));
    expect(parsed.sessions[0]).toMatchObject({ session_id: '7', total_ms: 12.5, db_calls: 0 });
    expect(parsed.methods).toEqual([]);
    expect(() => parseTraceSnapshotJson('{')).toThrow('not valid JSON');
    expect(() => parseTraceSnapshotJson('{"sessions":[{}]}')).toThrow('sessions.0.session_id');
  });

  it('derives a source label from the connection string', () => {
    expect(defaultTraceSource('Server=x;Database=AxTrace_Invoice;Trusted_Connection=yes')).toBe('AxTrace_Invoice');
    expect(defaultTraceSource('Server=x')).toBe('trace');
  });
});

describe('trace storage', () => {
  let dir: string;
  let db: Database;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-store-'));
    db = openDb(path.join(dir, 'idx.db'));
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a source atomically and rejects inconsistent snapshots', () => {
    publishTraceSnapshot(db, 'a', 'json', SNAPSHOT);
    publishTraceSnapshot(db, 'b', 'json', SNAPSHOT);
    publishTraceSnapshot(db, 'a', 'json', { sessions: [SNAPSHOT.sessions[1]], methods: [], statements: [] });
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    expect(count(`SELECT COUNT(*) AS n FROM ax_trace_sessions WHERE source = 'a'`)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM ax_trace_methods WHERE source = 'a'`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM ax_trace_methods WHERE source = 'b'`)).toBe(3);

    expect(() => publishTraceSnapshot(db, 'b', 'json', { ...SNAPSHOT, sessions: [SNAPSHOT.sessions[1]] }))
      .toThrow('unknown session_id 1');
    expect(count(`SELECT COUNT(*) AS n FROM ax_trace_methods WHERE source = 'b'`)).toBe(3);
  });
});

describe('trace tools', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  const handlers = new Map<string, Handler>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handlers.get(name)!(args);
    return { res, json: res.isError ? null : JSON.parse(res.content[0].text) };
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-tools-'));
    const root = path.join(dir, 'packages');
    for (const [typeDir, name, xml] of [
      ['AxClass', 'SampleClass', fs.readFileSync(path.join(testDir, 'fixtures', 'AxClassSample.xml'), 'utf-8')],
      ['AxTable', 'SampleSalesLine', SALES_TABLE],
    ]) {
      fs.mkdirSync(path.join(root, 'TestPackage', 'TestModel', typeDir), { recursive: true });
      fs.writeFileSync(path.join(root, 'TestPackage', 'TestModel', typeDir, `${name}.xml`), xml);
    }
    dbPath = path.join(dir, 'idx.db');
    db = openDb(dbPath);
    await buildIndex(db, root, true);
    registerTraceTools(fakeToolServer(handlers), db);
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('explains how to import when no traces exist', async () => {
    const { res } = await call('find_n_plus_one', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('index-trace');
  });

  it('imports a JSON snapshot through the CLI', async () => {
    const file = path.join(dir, 'invoice.json');
    fs.writeFileSync(file, JSON.stringify(SNAPSHOT));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const missing = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await indexTraceCommand({ fromJson: file, dbPath }, {})).toBe(0);
      expect(await indexTraceCommand({ fromJson: file, dbPath, trace: 'Missing' }, {})).toBe(1);
      expect(missing).toHaveBeenCalledWith(expect.stringContaining('No sessions found for trace "Missing"'));
    } finally {
      log.mockRestore();
      missing.mockRestore();
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await indexTraceCommand({ dbPath }, {})).toBe(1);
    } finally {
      error.mockRestore();
    }
  });

  it('lists sessions slowest first with database share', async () => {
    const { json } = await call('list_trace_sessions', { limit: 50 });
    expect(json.imports[0]).toMatchObject({ source: 'invoice', origin: 'json', session_count: 2 });
    expect(json.sessions.map((s: { session_id: string }) => s.session_id)).toEqual(['1', '2']);
    expect(json.sessions[0].db_share_pct).toBe(50);
  });

  it('maps trace frames to indexed AOT methods', () => {
    expect(resolveTraceMethod(db, 'Dynamics.AX.Application.SampleClass::buildMessage')).toMatchObject({
      type: 'Class', name: 'SampleClass', method: 'buildMessage', methodIndexed: true,
    });
    expect(resolveTraceMethod(db, 'sampleclass.notThere')).toMatchObject({ name: 'SampleClass', methodIndexed: false });
    expect(resolveTraceMethod(db, 'xRecord::insert')).toBeNull();
  });

  it('finds N+1 patterns with FastTrack default thresholds', async () => {
    const { json } = await call('find_n_plus_one', { minCalls: 100, maxAvgMs: 5, limit: 25 });
    expect(json.thresholds).toEqual({ minCalls: 100, maxAvgMs: 5 });
    // construct averages 10 ms per call, so only buildMessage (2 ms per call) qualifies.
    expect(json.findings).toHaveLength(1);
    expect(json.findings[0]).toMatchObject({
      dbCallsInOneCall: 400, avgMsPerDbCall: 2, aot: { name: 'SampleClass', method: 'buildMessage' },
    });
    const looser = await call('find_n_plus_one', { minCalls: 100, maxAvgMs: 20, limit: 25 });
    expect(looser.json.findings).toHaveLength(2);
  });

  it('finds slow SQL with the issuing method and table indexes', async () => {
    const { json } = await call('find_slow_sql', { minMs: 5000, metric: 'max', limit: 25 });
    expect(json.findings).toHaveLength(1);
    const [finding] = json.findings;
    expect(finding.aot).toMatchObject({ name: 'SampleClass', method: 'buildMessage' });
    expect(finding.tables).toEqual([
      { sqlName: 'SAMPLESALESLINE', table: 'SampleSalesLine', package: 'TestPackage', tableGroup: 'WorksheetLine',
        indexes: [{ name: 'SalesIdx', fields: ['SalesId'], unique: true, enabled: true }] },
      { sqlName: 'UNKNOWNTABLE', table: null },
    ]);
    const total = await call('find_slow_sql', { minMs: 5000, metric: 'total', limit: 25 });
    expect(total.json.findings).toHaveLength(2);
  });

  it('ranks methods and searches traces', async () => {
    const top = await call('get_top_methods', { orderBy: 'exclusive', limit: 1 });
    expect(top.json.methods[0]).toMatchObject({ method: 'SampleClass.construct', exclusiveMs: 3000 });
    const hits = await call('search_trace', { keyword: 'samplesalesline', limit: 25 });
    expect(hits.json.methods).toEqual([]);
    expect(hits.json.statements).toHaveLength(1);
    const scoped = await call('search_trace', { keyword: 'SampleClass', sessionId: '2', limit: 25 });
    expect(scoped.json.methods).toEqual([]);
    const literal = await call('search_trace', { keyword: '%', limit: 25 });
    expect(literal.json.methods).toEqual([]);
  });

  it('never publishes trace data with the index', () => {
    const copy = path.join(dir, 'published.db');
    snapshotIndex(dbPath, copy);
    const published = openDb(copy);
    try {
      expect((published.prepare('SELECT COUNT(*) AS n FROM ax_trace_sessions').get() as { n: number }).n).toBe(0);
      expect((published.prepare('SELECT COUNT(*) AS n FROM ax_trace_imports').get() as { n: number }).n).toBe(0);
    } finally {
      published.close();
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM ax_trace_sessions').get() as { n: number }).n).toBe(2);
  }, 15_000);
});
