import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../src/indexer/db.js';
import { openDb } from '../src/indexer/db.js';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { checkXppMethods, extensionTarget } from '../src/xpp/bestPractices.js';
import { extractMethodSources, findLoops, findSelects, maskXpp } from '../src/xpp/scanner.js';
import { findFieldAccess } from '../src/xpp/fieldAccess.js';
import { parseBpLog, parseBpPath, modelFromFileName, publishBpFindings } from '../src/indexer/bpFindings.js';
import { registerCodeQualityTools } from '../src/tools/codeQuality.js';
import { indexBpCommand } from '../src/cli/index-bp-command.js';
import type { ToolResult } from './helpers/toolHarness.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const rulesOf = (src: string, name = 'm', opts = {}) =>
  checkXppMethods([{ name, source: src }], opts).map((f) => f.rule);

function axClass(name: string, declaration: string, methods: Record<string, string> = {}): string {
  const m = Object.entries(methods)
    .map(([n, src]) => `<Method><Name>${n}</Name><Source><![CDATA[\n${src}\n]]></Source></Method>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name>
<SourceCode><Declaration><![CDATA[\n${declaration}\n]]></Declaration><Methods>${m}</Methods></SourceCode></AxClass>`;
}

function axTable(name: string, fields: string[], methods: Record<string, string> = {}): string {
  const m = Object.entries(methods)
    .map(([n, src]) => `<Method><Name>${n}</Name><Source><![CDATA[\n${src}\n]]></Source></Method>`)
    .join('');
  const f = fields.map((x) => `<AxTableField i:type="AxTableFieldString"><Name>${x}</Name></AxTableField>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name>
<SourceCode><Declaration><![CDATA[\npublic class ${name} extends common\n{\n}\n]]></Declaration><Methods>${m}</Methods></SourceCode>
<Fields>${f}</Fields></AxTable>`;
}

describe('X++ scanner', () => {
  it('masks comments and strings but keeps offsets and lines', () => {
    const src = 'x = "ttsbegin"; // ttsbegin\n/* a\nb */ y = 1;';
    const { code, comments } = maskXpp(src);
    expect(code.length).toBe(src.length);
    expect(code).not.toMatch(/ttsbegin/);
    expect(code.split('\n')).toHaveLength(3);
    expect(comments.map((c) => c.line)).toEqual([1, 2]);
  });

  it('finds while select loops with bodies', () => {
    const { code } = maskXpp('while select t where t.A == 1\n{\n    t.insert();\n}');
    const loops = findLoops(code);
    expect(loops[0].kind).toBe('whileSelect');
    expect(code.slice(loops[0].bodyStart, loops[0].bodyEnd)).toContain('insert');
  });

  it('extracts declaration and methods from AOT XML', () => {
    const methods = extractMethodSources(axClass('A', 'class A {}', { run: 'void run() {}' }));
    expect(methods.map((m) => m.name)).toEqual(['classDeclaration', 'run']);
  });
});

describe('X++ scanning of hostile input', () => {
  // Both inputs used to block the event loop for tens of seconds.
  it('checks a 500 KB method with a finding on every line quickly', () => {
    const started = Date.now();
    const findings = checkXppMethods([{ name: 'm', source: '==true\n'.repeat(71_428) }]);
    expect(findings.at(-1)?.line).toBe(71_428);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('extracts methods from XML full of unterminated methods quickly', () => {
    const started = Date.now();
    expect(extractMethodSources('<Method><Name>a</Name><Source><![CDATA['.repeat(20_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('scans 500 KB of repeated selects in linear time', () => {
    const source = 'select firstonly custTable;\n'.repeat(18_000);
    const started = Date.now();
    expect(findSelects(source)).toHaveLength(18_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('X++ best-practice rules', () => {
  it('flags unbalanced tts, breakpoint and direct SQL', () => {
    const rules = rulesOf('void m()\n{\n    ttsbegin;\n    breakpoint;\n    stmt.executeUpdate(sql);\n}');
    expect(rules).toEqual(expect.arrayContaining(['BalancedTtsStatement', 'Breakpoint', 'DirectSQL']));
  });

  it('ignores keywords in comments and strings', () => {
    expect(rulesOf('void m()\n{\n    // ttsbegin; breakpoint;\n    str s = "ttsbegin";\n}')).toEqual([]);
  });

  it('flags insert in loop, nested search and delete-from candidates', () => {
    const src = 'void m()\n{\n    MyTable t; Other o;\n    while select t\n    {\n        while select o where o.Id == t.Id\n        {\n            t.insert();\n        }\n    }\n    while select forupdate t\n    {\n        t.delete();\n    }\n}';
    const rules = rulesOf(src);
    expect(rules).toContain('InsertInLoop');
    expect(rules).toContain('NestedSearch');
    expect(rules).toContain('DeleteFromNotUsed');
    expect(rules).not.toContain('SelectForUpdateAbsent');
  });

  it('flags forupdate without update, missing firstonly, boolean literals, empty catch and TODO', () => {
    const src = 'void m()\n{\n    MyTable t;\n    select forupdate t where t.A == true;\n    try { } catch { }\n    // TODO: fix\n}';
    const rules = rulesOf(src);
    expect(rules).toEqual(expect.arrayContaining([
      'SelectForUpdateAbsent', 'SelectUsingFirstOnly', 'BooleanExpressionWithLiteral', 'CatchAllWithEmptyHandlers', 'TODOComments',
    ]));
    expect(rulesOf('void m()\n{\n    MyTable t;\n    select firstonly t where t.A == 1;\n}')).toEqual([]);
  });

  it('flags public methods without documentation', () => {
    expect(rulesOf('public void m()\n{\n}')).toEqual(['MissingMethodDocumentation']);
    expect(rulesOf('/// <summary>x</summary>\npublic void m()\n{\n}')).toEqual([]);
  });

  it('checks Chain of Command next calls only for wrapped methods', () => {
    const wrapped = new Set(['validatewrite']);
    expect(rulesOf('boolean validateWrite()\n{\n    return true;\n}', 'validateWrite', { wrappedMethods: wrapped })).toContain('CallsNext');
    expect(rulesOf('boolean validateWrite()\n{\n    return next validateWrite();\n}', 'validateWrite', { wrappedMethods: wrapped })).toEqual([]);
    expect(rulesOf('void helper()\n{\n}', 'helper', { wrappedMethods: wrapped })).toEqual([]);
  });

  it('reads the ExtensionOf target', () => {
    expect(extensionTarget('[ExtensionOf(tableStr(CustTable))]\nfinal class CustTable_Extension {}')).toEqual({ type: 'Table', name: 'CustTable' });
    expect(extensionTarget('class Plain {}')).toBeNull();
  });
});

describe('field access classification', () => {
  const ctx = { table: 'MyTable', field: 'Qty', thisIsTable: false };
  const kinds = (src: string, c = ctx) => findFieldAccess({ name: 'm', source: src }, c).map((a) => `${a.access}:${a.confidence}`);

  it('classifies assignments as writes and comparisons as reads', () => {
    expect(kinds('void m()\n{\n    MyTable t;\n    t.Qty = 1;\n    t.Qty += 2;\n    if (t.Qty == 3) {}\n    x = t.Qty;\n}'))
      .toEqual(['Write:declared', 'Write:declared', 'Read:declared', 'Read:declared']);
  });

  it('skips buffers of other tables and handles setField/fieldNum and set-based statements', () => {
    const src = 'void m()\n{\n    Other o; MyTable t;\n    o.Qty = 1;\n    t.setField(fieldNum(MyTable, Qty), 5);\n    update_recordset t setting Qty = 0 where t.Id == 1;\n    insert_recordset t (Id, Qty) select Id, Qty from o;\n}';
    expect(kinds(src)).toEqual(['Write:fieldNum', 'Write:set-based', 'Write:set-based']);
  });

  it('honours this only in table context', () => {
    const src = 'void m()\n{\n    this.Qty = 1;\n}';
    expect(kinds(src)).toEqual([]);
    expect(kinds(src, { ...ctx, thisIsTable: true })).toEqual(['Write:this']);
  });
});

describe('xppbp log import', () => {
  const LOG = `<?xml version="1.0"?><Diagnostics><Items>
<Diagnostic><DiagnosticType>BestPractices</DiagnosticType><Moniker>BPErrorLabelIsText</Moniker><Severity>Error</Severity>
<Path>dynamics://Table/MyTable/Field/Qty</Path><Message>Label is text</Message><Line>0</Line><Column>0</Column></Diagnostic>
<Diagnostic><Moniker>BPUpgradeCodeToday</Moniker><Severity>Warning</Severity>
<Path>dynamics://Class/MyClass/Method/run</Path><Message>Use DateTimeUtil</Message><Line>12</Line><Column>5</Column></Diagnostic>
</Items></Diagnostics>`;

  it('parses paths, model names and diagnostics', () => {
    expect(parseBpPath('dynamics://Class/MyClass/Method/run')).toMatchObject({ elementType: 'Class', elementName: 'MyClass', method: 'run' });
    expect(modelFromFileName('C:\\x\\Dynamics.AX.MyModel.xppbp.xml')).toBe('MyModel');
    const rows = parseBpLog(LOG, 'Dynamics.AX.MyModel.xppbp.xml');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ model: 'MyModel', severity: 'Warning', moniker: 'BPUpgradeCodeToday', elementName: 'MyClass', line: 12 });
  });

  it('imports through the CLI and rejects empty logs unless allowed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-cli-'));
    const log = path.join(dir, 'Dynamics.AX.MyModel.xppbp.xml');
    const empty = path.join(dir, 'empty.xml');
    fs.writeFileSync(log, LOG);
    fs.writeFileSync(empty, '<Diagnostics/>');
    const dbPath = path.join(dir, 'idx.db');
    const quiet = { log: console.log, error: console.error };
    console.log = () => {};
    console.error = () => {};
    try {
      expect(await indexBpCommand({ files: [log], dbPath })).toBe(0);
      expect(await indexBpCommand({ files: [empty], dbPath })).toBe(1);
      expect(await indexBpCommand({ files: [], dbPath })).toBe(1);
    } finally {
      Object.assign(console, quiet);
    }
    const db = openDb(dbPath);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ax_bp_findings').get() as { n: number }).n).toBe(2);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('code quality tools', () => {
  let dir: string;
  let db: Database;
  const handlers = new Map<string, Handler>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handlers.get(name)!(args);
    return { res, json: res.isError ? null : JSON.parse(res.content[0].text) };
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-quality-'));
    const root = path.join(dir, 'packages');
    const model = path.join(root, 'TestPackage', 'TestModel');
    fs.mkdirSync(path.join(model, 'AxClass'), { recursive: true });
    fs.mkdirSync(path.join(model, 'AxTable'), { recursive: true });
    fs.writeFileSync(path.join(model, 'AxTable', 'MyTable.xml'), axTable('MyTable', ['Id', 'Qty'], {
      validateWrite: 'public boolean validateWrite()\n{\n    return true;\n}',
      initValue: 'public void initValue()\n{\n    this.Qty = 1;\n}',
    }));
    fs.writeFileSync(path.join(model, 'AxClass', 'MyTable_Extension.xml'), axClass('MyTable_Extension',
      '[ExtensionOf(tableStr(MyTable))]\nfinal class MyTable_Extension\n{\n}', {
        validateWrite: 'public boolean validateWrite()\n{\n    return true;\n}',
      }));
    fs.writeFileSync(path.join(model, 'AxClass', 'MyJob.xml'), axClass('MyJob', 'class MyJob\n{\n    MyTable member;\n}', {
      run: 'void run()\n{\n    MyTable t;\n    ttsbegin;\n    while select forupdate t\n    {\n        t.Qty = t.Qty + 1;\n        t.update();\n    }\n    member.Qty = 0;\n}',
    }));
    db = openDb(path.join(dir, 'idx.db'));
    await buildIndex(db, root, true);
    const server = { tool: (name: string, _d: string, _s: unknown, h: Handler) => handlers.set(name, h) } as unknown as McpServer;
    registerCodeQualityTools(server, db);
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('check_xpp_best_practices reviews an indexed class', async () => {
    const { json } = await call('check_xpp_best_practices', { objectName: 'MyJob' });
    expect(json.target).toEqual({ type: 'Class', name: 'MyJob' });
    expect(json.findings.map((f: { rule: string }) => f.rule)).toContain('BalancedTtsStatement');
    expect(json.summary.Error).toBeGreaterThan(0);
    expect(json.attribution).toContain('AppChecker');
  });

  it('check_xpp_best_practices checks CoC next against the indexed target', async () => {
    const { json } = await call('check_xpp_best_practices', { objectName: 'MyTable_Extension', minSeverity: 'Error' });
    expect(json.target.extensionOf).toEqual({ type: 'Table', name: 'MyTable' });
    expect(json.findings.map((f: { rule: string }) => f.rule)).toEqual(['CallsNext']);
  });

  it('check_xpp_best_practices accepts pasted X++ and validates input', async () => {
    const { json } = await call('check_xpp_best_practices', { source: 'void m()\n{\n    breakpoint;\n}', rules: ['Breakpoint'] });
    expect(json.findings).toHaveLength(1);
    expect((await call('check_xpp_best_practices', {})).res.isError).toBe(true);
    expect((await call('check_xpp_best_practices', { objectName: 'Nope' })).res.isError).toBe(true);
  });

  it('find_field_access reports reads and writes across objects', async () => {
    const { json } = await call('find_field_access', { table: 'MyTable', field: 'Qty' });
    expect(json.fieldIndexed).toBe(true);
    const where = json.accesses.map((a: { object: string; method: string; access: string; confidence: string }) =>
      `${a.object}.${a.method}:${a.access}:${a.confidence}`);
    expect(where).toEqual(expect.arrayContaining([
      'MyJob.run:Write:declared', 'MyJob.run:Read:declared', 'MyTable.initValue:Write:this',
    ]));
    expect(where.filter((w: string) => w.startsWith('MyJob.run:Write'))).toHaveLength(2);
    const writesOnly = await call('find_field_access', { table: 'MyTable', field: 'Qty', access: 'Write' });
    expect(writesOnly.json.summary.reads).toBe(0);
  });

  it('get_bp_findings reports status before import and filters after', async () => {
    const before = await call('get_bp_findings', {});
    expect(before.json.status.status).toBe('not-imported');
    publishBpFindings(db, parseBpLog(`<Diagnostics><Diagnostic><Moniker>BPErrorX</Moniker><Severity>Error</Severity>
      <Path>dynamics://Class/MyJob/Method/run</Path><Message>m</Message></Diagnostic></Diagnostics>`, 'Dynamics.AX.TestModel.xppbp.xml'), ['x']);
    const after = await call('get_bp_findings', { element: 'MyJob' });
    expect(after.json.total).toBe(1);
    const review = await call('check_xpp_best_practices', { objectName: 'MyJob' });
    expect(review.json.compilerBestPractice.importedFindings).toBe(1);
  });
});
