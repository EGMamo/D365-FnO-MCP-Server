import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Database } from '../src/indexer/db.js';
import { openDb } from '../src/indexer/db.js';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { parseAxClassSources } from '../src/indexer/parser.js';
import {
  buildKqlQuery, kqlString, KQL_SCENARIO_NAMES, KQL_SCENARIOS, registerTelemetryTools, TELEMETRY_ATTRIBUTION,
} from '../src/tools/telemetry.js';
import { fakeToolServer, type ToolResult } from './helpers/toolHarness.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function axClass(name: string, declaration: string, methods: Record<string, string> = {}): string {
  const m = Object.entries(methods)
    .map(([n, src]) => `<Method><Name>${n}</Name><Source><![CDATA[\n${src}\n]]></Source></Method>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name>
<SourceCode><Declaration><![CDATA[\n${declaration}\n]]></Declaration><Methods>${m}</Methods></SourceCode></AxClass>`;
}

const CLASSES: Record<string, string> = {
  MyBatch: axClass('MyBatch', 'class MyBatch extends RunBaseBatch implements BatchRetryable\n{\n    #define.CurrentVersion(1)\n}', {
    pack: 'public container pack()\n{\n    return [#CurrentVersion];\n}',
    unpack: 'public boolean unpack(container _packed)\n{\n    return true;\n}',
    isRetryable: '[Hookable(false)]\nfinal boolean isRetryable()\n{\n    return true;\n}',
    description: 'public static ClassDescription description()\n{\n    return "My batch";\n}',
    run: 'public void run()\n{\n    MyTable t;\n    while select forupdate t\n    {\n        t.Qty = 1;\n        t.update();\n    }\n    t.insert();\n}',
  }),
  MyChild: axClass('MyChild', 'class MyChild extends MyBatch\n{\n}', {
    run: 'public void run()\n{\n    // info("x");\n    super();\n}',
  }),
  MyRunBase: axClass('MyRunBase', 'class MyRunBase extends RunBase\n{\n}', {
    run: 'public void run()\n{\n}',
  }),
  MyHalfPack: axClass('MyHalfPack', 'class MyHalfPack extends RunBaseBatch\n{\n}', {
    pack: 'public container pack()\n{\n    return conNull();\n}',
  }),
  MyController: axClass('MyController', 'class MyController extends SysOperationServiceController\n{\n}', {
    canGoBatch: 'public boolean canGoBatch()\n{\n    return false;\n}',
  }),
  MyService: axClass('MyService', 'class MyService extends SysOperationServiceBase\n{\n}', {
    process: 'public void process()\n{\n}',
  }),
  MyContract: axClass('MyContract', '[DataContractAttribute]\nclass MyContract\n{\n    ItemId itemId;\n}'),
  PlainClass: axClass('PlainClass', 'class PlainClass\n{\n}'),
};

describe('KQL generation', () => {
  it('escapes KQL string literals', () => {
    expect(kqlString("a'b\\c\nd")).toBe("'a\\'b\\\\c\\nd'");
  });

  it('builds every scenario with header, lets, attribution and a known target', () => {
    for (const scenario of KQL_SCENARIO_NAMES) {
      const q = buildKqlQuery({ scenario });
      expect(q.query).toContain('let _startTime = ago(7d);');
      expect(q.query).toContain('let _endTime = now();');
      expect(q.query).toContain(TELEMETRY_ATTRIBUTION);
      expect(['ApplicationInsights', 'LogAnalytics']).toContain(q.target);
      expect(q.prerequisite.length).toBeGreaterThan(0);
      // Every declared parameter is used and every used parameter is declared.
      for (const p of ['_environmentId', '_batchJobId', '_className', '_computer']) {
        const declared = q.query.includes(`let ${p} =`);
        const used = q.query.split('\n').some((l) => !l.startsWith('let ') && l.includes(p));
        expect(declared, `${scenario} ${p}`).toBe(used);
      }
      const expectedTable = KQL_SCENARIOS[scenario].target === 'LogAnalytics' ? /TimeGenerated/ : /timestamp between/;
      expect(q.query).toMatch(expectedTable);
    }
  });

  it('applies filters and time range', () => {
    const q = buildKqlQuery({
      scenario: 'batch-failures',
      startTime: '2025-01-01T00:00:00Z',
      endTime: '2025-01-02T00:00:00Z',
      environmentId: "env'1",
      batchJobIds: ['5637144576', ' 42 '],
      className: 'MyBatch',
    });
    expect(q.query).toContain('let _startTime = datetime(2025-01-01T00:00:00.000Z);');
    expect(q.query).toContain('let _endTime = datetime(2025-01-02T00:00:00.000Z);');
    expect(q.query).toContain("let _environmentId = 'env\\'1';");
    expect(q.query).toContain('let _batchJobId = dynamic(["5637144576", "42"]);');
    expect(q.query).toContain("let _className = 'MyBatch';");
    expect(q.query).toContain('name == "BatchTaskFailure"');
    expect(q.table).toBe('customEvents');
    expect(q.notes).toEqual([]);
  });

  it('notes ignored filters and rejects bad input', () => {
    const q = buildKqlQuery({ scenario: 'store-heartbeat', className: 'X', computer: 'POS-01', timespan: '24h' });
    expect(q.query).toContain("let _computer = 'POS-01';");
    expect(q.query).toContain('ago(24h)');
    expect(q.query).not.toContain('_className');
    expect(q.notes.join()).toMatch(/className/);
    expect(q.target).toBe('LogAnalytics');
    expect(() => buildKqlQuery({ scenario: 'nope' })).toThrow(/Unknown scenario/);
    expect(() => buildKqlQuery({ scenario: 'slow-sql', timespan: '7 days' })).toThrow(/timespan/);
    expect(() => buildKqlQuery({ scenario: 'slow-sql', startTime: 'yesterday' })).toThrow(/ISO 8601/);
    expect(() => buildKqlQuery({ scenario: 'batch-failures', batchJobIds: ['1 or 1==1'] })).toThrow(/numeric/);
  });

  it('keeps the FastTrack field-name quirks', () => {
    const long = buildKqlQuery({ scenario: 'batch-long-running-tasks' }).query;
    expect(long).toContain('cd.BatchJobTaskId');
    expect(long).toContain('by ActivityId');
    expect(buildKqlQuery({ scenario: 'batch-thread-availability' }).query).toContain('parse_json(tostring(cd.InfoMessage))');
    expect(buildKqlQuery({ scenario: 'batch-exceptions' }).query).toContain('split(outerMessage, "\\\\")');
  });
});

describe('class source parsing', () => {
  it('returns per-method bodies keyed by lower-case name', () => {
    const s = parseAxClassSources(CLASSES.MyBatch);
    expect(s.declaration).toContain('implements BatchRetryable');
    expect(s.methods.get('isretryable')).toContain('return true');
    expect(s.all).toContain('while select');
  });
});

describe('telemetry tools', () => {
  let dir: string;
  let db: Database;
  const handlers = new Map<string, Handler>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handlers.get(name)!(args);
    return { res, json: res.isError ? null : JSON.parse(res.content[0].text) };
  };
  const messages = (json: { findings: { message: string }[] }) => json.findings.map((f) => f.message).join('\n');

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-tools-'));
    const root = path.join(dir, 'packages');
    const classDir = path.join(root, 'TestPackage', 'TestModel', 'AxClass');
    fs.mkdirSync(classDir, { recursive: true });
    for (const [name, xml] of Object.entries(CLASSES)) fs.writeFileSync(path.join(classDir, `${name}.xml`), xml);
    db = openDb(path.join(dir, 'idx.db'));
    await buildIndex(db, root, true);
    registerTelemetryTools(fakeToolServer(handlers), db);
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('generate_kql_query grounds className against the index', async () => {
    const known = await call('generate_kql_query', { scenario: 'batch-failures', className: 'MyBatch' });
    expect(known.json.notes).toEqual([]);
    const unknown = await call('generate_kql_query', { scenario: 'batch-failures', className: 'Missing' });
    expect(unknown.json.notes.join()).toMatch(/not in the index/);
    const bad = await call('generate_kql_query', { scenario: 'batch-failures', timespan: 'x' });
    expect(bad.res.isError).toBe(true);
  });

  it('analyzes a retryable RunBaseBatch class', async () => {
    const { json } = await call('analyze_batch_class', { className: 'MyBatch' });
    expect(json.framework).toBe('RunBaseBatch');
    expect(json.inheritanceChain).toEqual(['MyBatch', 'RunBaseBatch']);
    expect(json.chainLeavesIndex).toBe(true);
    expect(json.implements).toContain('BatchRetryable');
    expect(json.batchCapable).toBe(true);
    expect(json.retryable).toBe(true);
    expect(json.overrides).toMatchObject({ pack: true, unpack: true, isRetryable: true, canGoBatch: false });
    const text = messages(json);
    expect(text).toMatch(/idempotent/);
    expect(text).toMatch(/duplicates/);
    expect(text).toMatch(/update_recordset/);
    expect(text).not.toMatch(/CurrentVersion macro/);
    expect(json.telemetry.failures).toContain("let _className = 'MyBatch';");
    expect(json.telemetry.longRunning).toContain('BatchTaskStart');
  });

  it('follows indexed parents and inherited overrides', async () => {
    const { json } = await call('analyze_batch_class', { className: 'MyChild' });
    expect(json.inheritanceChain).toEqual(['MyChild', 'MyBatch', 'RunBaseBatch']);
    expect(json.framework).toBe('RunBaseBatch');
    expect(json.implements).toContain('BatchRetryable');
    expect(messages(json)).not.toMatch(/pack\(\)\/unpack\(\)/);
  });

  it('flags RunBase, half pack/unpack and non-retryable batch classes', async () => {
    const runBase = (await call('analyze_batch_class', { className: 'MyRunBase' })).json;
    expect(runBase.framework).toBe('RunBase');
    expect(runBase.batchCapable).toBe(false);
    expect(messages(runBase)).toMatch(/not RunBaseBatch/);
    expect(messages(runBase)).toMatch(/not overridden/);

    const half = (await call('analyze_batch_class', { className: 'MyHalfPack' })).json;
    expect(half.findings.some((f: { severity: string; message: string }) => f.severity === 'error' && /Only one/.test(f.message))).toBe(true);
    expect(half.retryable).toBe(false);
    expect(messages(half)).toMatch(/BatchRetryable/);
  });

  it('classifies SysOperation classes', async () => {
    const controller = (await call('analyze_batch_class', { className: 'MyController' })).json;
    expect(controller.framework).toBe('SysOperationController');
    expect(controller.batchCapable).toBe(false);
    expect(messages(controller)).toMatch(/canGoBatch\(\) returns false/);

    expect((await call('analyze_batch_class', { className: 'MyService' })).json.framework).toBe('SysOperationService');
    const contract = (await call('analyze_batch_class', { className: 'MyContract' })).json;
    expect(contract.framework).toBe('SysOperationDataContract');
    expect(messages(contract)).toMatch(/controller/);

    const plain = (await call('analyze_batch_class', { className: 'PlainClass' })).json;
    expect(plain.framework).toBe('Unknown');
    expect(plain.retryable).toBe('unknown');
  });

  it('fails for unknown classes', async () => {
    const { res } = await call('analyze_batch_class', { className: 'Nope' });
    expect(res.isError).toBe(true);
  });
});
