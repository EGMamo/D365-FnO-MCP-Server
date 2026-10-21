import { describe, it, expect, vi, type Mock } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from '../src/indexer/db.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import { parsePayload, warningsOf } from '../src/gateway/merge.js';
import { xrefStrategies } from '../src/gateway/strategies/xrefs.js';
import type { GatewayWorkspaceConfig, LocalIndex, RouteContext, UpstreamPort } from '../src/gateway/types.js';
import { analyzeImpact } from '../src/tools/impact.js';
import { seedDb, type SeedObject } from './helpers/toolHarness.js';

const workspace: GatewayWorkspaceConfig = {
  workspaceDir: '',
  customMetadataDir: '/home/dev/CustomModels',
  targetProject: '',
  targetPackage: '',
  targetModel: '',
  targetSolution: '',
  writableModels: [],
};

type Row = Record<string, unknown>;
type FakeUpstream = UpstreamPort & { callTool: Mock<UpstreamPort['callTool']> };

/** from_type, from_name, to_type, to_name, xref_kind */
type XrefSeed = [string, string, string, string, string];

const KNOWLEDGE = { type: 'text' as const, text: '{"knowledge":{"hints":["from the hosted knowledge filter"]}}' };

const json = (value: unknown, ...extras: CallToolResult['content']): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }, ...extras],
});
const plain = (text: string, ...extras: CallToolResult['content']): CallToolResult => ({
  content: [{ type: 'text', text }, ...extras],
});
const failed = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

function fakeUpstream(answer: CallToolResult | Error): FakeUpstream {
  return {
    isAvailable: () => true,
    listTools: async () => [],
    callTool: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    serverVersion: '1.0.0',
  };
}

function addXrefs(db: Database, xrefs: XrefSeed[]) {
  const insert = db.prepare('INSERT INTO ax_xref (from_type, from_name, to_type, to_name, xref_kind) VALUES (?, ?, ?, ?, ?)');
  for (const xref of xrefs) insert.run(...xref);
}

interface UsageSeed {
  sourceType: string;
  sourceName: string;
  sourceMethod?: string;
  targetType: string;
  targetName: string;
  targetMethod?: string;
  line: number;
}

/** Rows as a local XRef snapshot import would leave them. */
function addUsages(db: Database, usages: UsageSeed[]) {
  const insert = db.prepare(`INSERT INTO ax_usage_refs
    (source_type, source_name, source_method, target_type, target_name, target_method, reference_kind, source_line, source_column, occurrence_count, source_table, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, 'MethodCall', ?, 1, NULL, 'References', '{}')`);
  for (const u of usages) {
    insert.run(u.sourceType, u.sourceName, u.sourceMethod ?? null, u.targetType, u.targetName, u.targetMethod ?? null, u.line);
  }
}

interface Scenario {
  objects?: SeedObject[];
  xrefs?: XrefSeed[];
  usages?: UsageSeed[];
  /** What the hosted server answers to every call. */
  hosted?: CallToolResult | Error;
}

/** A strategy run against a seeded local database and a hosted server that always gives the same answer. */
function setup({ objects = [], xrefs = [], usages = [], hosted = json([]) }: Scenario = {}) {
  const db = seedDb(objects);
  addXrefs(db, xrefs);
  addUsages(db, usages);
  const localIndex: LocalIndex = {
    db,
    customDir: workspace.customMetadataDir,
    ensureFresh: async () => {},
    markDirty: () => {},
    status: () => ({
      customDirName: 'CustomModels',
      objects: objects.length,
      labels: 0,
      lastRefreshAt: null,
      dirty: false,
      watcher: 'inactive',
      watcherError: null,
      lastError: null,
    }),
    startWatcher: () => {},
    close: () => {},
  };
  const local = captureLocalTools(db, localIndex, workspace);
  const upstream = fakeUpstream(hosted);
  const ctx: RouteContext = {
    local,
    localIndex,
    upstream,
    hostedTools: new Map(),
    privatePrefixes: [],
    skewedTools: new Set(),
  };
  // The router parses the caller's args with the local zod shape and hands the originals on as `raw`.
  const run = (tool: string, raw: Record<string, unknown>) => xrefStrategies[tool](local.parseArgs(tool, raw), ctx, raw);
  return { run, upstream, db };
}

const payloadOf = (result: CallToolResult): unknown => parsePayload(result).json;
const rowsOf = (result: CallToolResult): Row[] => {
  const payload = payloadOf(result);
  if (!Array.isArray(payload)) throw new Error('Expected a JSON list.');
  return payload as Row[];
};
const impactOf = (result: CallToolResult) => payloadOf(result) as {
  root: Row;
  maxDepth: number;
  levels: { depth: number; items: Row[] }[];
  totals: { objects: number; byType: Record<string, number> };
  truncated: boolean;
  caveat: string;
  [key: string]: unknown;
};
const textOf = (result: CallToolResult): string => parsePayload(result).text;
const namesOf = (rows: Row[]): unknown[] => rows.map((row) => row.name);

describe('xrefStrategies', () => {
  it('covers exactly the reference, impact and usage tools', () => {
    expect(Object.keys(xrefStrategies).sort()).toEqual(['analyze_impact', 'find_references', 'find_usages']);
  });
});

describe('find_references', () => {
  const objects: SeedObject[] = [
    { type: 'TableExtension', name: 'CustTable.Contoso' },
    { type: 'Class', name: 'ContosoCustHelper' },
    { type: 'Form', name: 'ContosoCustForm' },
  ];
  const xrefs: XrefSeed[] = [
    ['TableExtension', 'CustTable.Contoso', 'Table', 'CustTable', 'extends'],
    ['Class', 'ContosoCustHelper', 'Table', 'CustTable', 'uses'],
    ['Form', 'ContosoCustForm', 'Table', 'CustTable', 'datasource'],
    ['Class', 'ContosoCustHelper', 'Class', 'ContosoBase', 'extends'],
  ];
  const hostedRows = [
    { id: 11, from_type: 'Form', from_name: 'CustTableListPage', to_type: 'Table', to_name: 'CustTable', xref_kind: 'datasource' },
    { id: 12, from_type: 'Class', from_name: 'CustTableController', to_type: 'Table', to_name: 'CustTable', xref_kind: 'uses' },
  ];

  it('lists the custom references first, then the hosted ones, each row tagged with its side', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedRows) });
    const rows = rowsOf(await run('find_references', { name: 'CustTable' }));
    expect(rows.map((row) => row.source)).toEqual(['local', 'local', 'local', 'hosted', 'hosted']);
    // The local rows come in index order; local ids are dropped, hosted rows keep theirs.
    expect(rows.slice(0, 3)).toEqual(
      expect.arrayContaining([
        { from_type: 'Class', from_name: 'ContosoCustHelper', to_type: 'Table', to_name: 'CustTable', xref_kind: 'uses', source: 'local' },
        { from_type: 'TableExtension', from_name: 'CustTable.Contoso', to_type: 'Table', to_name: 'CustTable', xref_kind: 'extends', source: 'local' },
        { from_type: 'Form', from_name: 'ContosoCustForm', to_type: 'Table', to_name: 'CustTable', xref_kind: 'datasource', source: 'local' },
      ])
    );
    expect(rows.slice(3)).toEqual([
      { ...hostedRows[0], source: 'hosted' },
      { ...hostedRows[1], source: 'hosted' },
    ]);
  });

  it('sends the caller\'s raw arguments upstream in a single call', async () => {
    const { run, upstream } = setup({ objects, xrefs, hosted: json(hostedRows) });
    await run('find_references', { name: 'CustTable', type: 'Table' });
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).toHaveBeenCalledWith('find_references', { name: 'CustTable', type: 'Table' });
  });

  it('keeps the hosted knowledge item after the payload', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedRows, KNOWLEDGE) });
    const result = await run('find_references', { name: 'CustTable' });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual(KNOWLEDGE);
    expect(warningsOf(result)).toEqual([]);
  });

  it('lists a reference both sides report once, the local one, and says it hides a hosted twin', async () => {
    const twin = { id: 3, from_type: 'class', from_name: 'contosocusthelper', to_type: 'TABLE', to_name: 'custtable', xref_kind: 'USES' };
    const { run } = setup({ objects, xrefs, hosted: json([twin, hostedRows[0]]) });
    const rows = rowsOf(await run('find_references', { name: 'CustTable' }));
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.from_name === 'ContosoCustHelper')).toEqual([
      {
        from_type: 'Class',
        from_name: 'ContosoCustHelper',
        to_type: 'Table',
        to_name: 'CustTable',
        xref_kind: 'uses',
        source: 'local',
        shadowedHosted: true,
      },
    ]);
    expect(rows.some((row) => row.from_name === 'contosocusthelper')).toBe(false);
  });

  it('keeps the identical rows one side lists several times, as the original tool does', async () => {
    // Three fields of a table with the same EDT give three `uses` rows; the index has no uniqueness constraint.
    const repeated = { from_type: 'Table', from_name: 'CustTrans', to_type: 'Edt', to_name: 'AmountMST', xref_kind: 'uses' };
    const hosted = [1, 2, 3].map((id) => ({ id, ...repeated }));
    const { run } = setup({ hosted: json(hosted) });
    const rows = rowsOf(await run('find_references', { name: 'AmountMST', type: 'Edt' }));
    expect(rows).toEqual(hosted.map((row) => ({ ...row, source: 'hosted' })));

    // The same holds for the custom side, and a row both sides report is still listed once.
    const local = setup({
      objects: [{ type: 'Table', name: 'CustTrans' }],
      xrefs: [
        ['Table', 'CustTrans', 'Edt', 'AmountMST', 'uses'],
        ['Table', 'CustTrans', 'Edt', 'AmountMST', 'uses'],
      ],
      hosted: json(hosted),
    });
    const merged = rowsOf(await local.run('find_references', { name: 'AmountMST', type: 'Edt' }));
    expect(merged.map((row) => row.source)).toEqual(['local', 'local']);
    expect(merged.every((row) => row.shadowedHosted === true)).toBe(true);
  });

  it('keeps references that differ only in their kind', async () => {
    const { run } = setup({
      objects,
      xrefs: [['Class', 'ContosoCustHelper', 'Table', 'CustTable', 'uses']],
      hosted: json([{ id: 1, from_type: 'Class', from_name: 'ContosoCustHelper', to_type: 'Table', to_name: 'CustTable', xref_kind: 'extends' }]),
    });
    const rows = rowsOf(await run('find_references', { name: 'CustTable' }));
    expect(rows.map((row) => row.xref_kind)).toEqual(['uses', 'extends']);
  });

  it('cuts the merged list to limit and keeps the custom references', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedRows) });
    const rows = rowsOf(await run('find_references', { name: 'CustTable', limit: 2 }));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.source === 'local')).toBe(true);

    const all = rowsOf(await run('find_references', { name: 'CustTable', limit: 4 }));
    expect(all.map((row) => row.source)).toEqual(['local', 'local', 'local', 'hosted']);
  });

  it('walks the types in the tool\'s order against the local index, with what is left of the limit', async () => {
    const { run } = setup({
      xrefs: [
        ['Class', 'A', 'Class', 'Shared', 'uses'],
        ['Class', 'B', 'Class', 'Shared', 'uses'],
        ['Form', 'C', 'Table', 'Shared', 'datasource'],
        ['Form', 'D', 'Table', 'Shared', 'datasource'],
        ['Form', 'E', 'Form', 'Shared', 'uses'],
      ],
    });
    // Table first (2 rows), then Class gets the one place that is left.
    const limited = rowsOf(await run('find_references', { name: 'Shared', limit: 3 }));
    expect(limited.map((row) => row.to_type)).toEqual(['Table', 'Table', 'Class']);
    expect(limited.map((row) => row.from_name).slice(0, 2).sort()).toEqual(['C', 'D']);

    const everything = rowsOf(await run('find_references', { name: 'Shared' }));
    expect(everything.map((row) => row.to_type)).toEqual(['Table', 'Table', 'Class', 'Class', 'Form']);

    expect(rowsOf(await run('find_references', { name: 'Shared', type: 'Form' })).map((row) => row.from_name)).toEqual(['E']);
    const classes = rowsOf(await run('find_references', { name: 'Shared', type: 'Class' }));
    expect(classes.map((row) => row.from_name).sort()).toEqual(['A', 'B']);
  });

  it('answers with the local references when the hosted server says the object is unknown in plain text', async () => {
    const { run } = setup({ objects, xrefs, hosted: plain('Object CustTable not found.') });
    const result = await run('find_references', { name: 'CustTable' });
    expect(rowsOf(result)).toHaveLength(3);
    expect(warningsOf(result)).toEqual([]);
  });

  it('treats a hosted JSON answer that is not a list as having no rows', async () => {
    const { run } = setup({ objects, xrefs, hosted: json({ unexpected: true }) });
    const result = await run('find_references', { name: 'CustTable' });
    expect(rowsOf(result).every((row) => row.source === 'local')).toBe(true);
  });

  it('lists only the hosted rows when the local index has no reference to the object', async () => {
    const { run } = setup({ hosted: json(hostedRows) });
    const rows = rowsOf(await run('find_references', { name: 'CustTable' }));
    expect(rows).toEqual([
      { ...hostedRows[0], source: 'hosted' },
      { ...hostedRows[1], source: 'hosted' },
    ]);
  });

  it('answers a custom-only object from the local index while the hosted server has no rows', async () => {
    const { run } = setup({ objects, xrefs, hosted: json([]) });
    const rows = rowsOf(await run('find_references', { name: 'ContosoBase' }));
    expect(rows).toEqual([
      { from_type: 'Class', from_name: 'ContosoCustHelper', to_type: 'Class', to_name: 'ContosoBase', xref_kind: 'extends', source: 'local' },
    ]);
  });

  it('gives the local references and a warning when the hosted server cannot be reached', async () => {
    const { run } = setup({ objects, xrefs, hosted: new Error('MCP error -32000: Connection closed') });
    const result = await run('find_references', { name: 'CustTable' });
    expect(rowsOf(result)).toHaveLength(3);
    expect(warningsOf(result)).toEqual(['hosted unavailable: Connection closed']);
  });

  it('turns a hosted tool error into a warning and keeps the local references', async () => {
    const { run } = setup({ objects, xrefs, hosted: failed('hosted is on fire') });
    const result = await run('find_references', { name: 'CustTable' });
    expect(rowsOf(result)).toHaveLength(3);
    expect(warningsOf(result)).toEqual(['hosted unavailable: hosted is on fire']);
  });

  it('passes the router\'s own withheld-call warning through unchanged', async () => {
    const warning = 'hosted lookup skipped: the arguments contain a name with a private prefix';
    const { run } = setup({ objects, xrefs, hosted: new Error(warning) });
    const result = await run('find_references', { name: 'CustTable' });
    expect(warningsOf(result)).toEqual([warning]);
  });
});

describe('find_usages', () => {
  const hostedRow = {
    sourceType: 'Class',
    sourceName: 'SalesFormLetter',
    sourceMethod: 'update',
    targetType: 'Class',
    targetName: 'SalesTable',
    targetMethod: 'confirm',
    referenceKind: 'MethodCall',
    sourceLine: 5,
    sourceColumn: 3,
    sourceTable: 'References',
    raw: { Kind: 1 },
  };
  const usages: UsageSeed[] = [
    { sourceType: 'Class', sourceName: 'ContosoCaller', sourceMethod: 'run', targetType: 'Class', targetName: 'SalesTable', targetMethod: 'confirm', line: 10 },
    { sourceType: 'Class', sourceName: 'ContosoCaller', sourceMethod: 'run', targetType: 'Class', targetName: 'SalesTable', targetMethod: 'post', line: 20 },
  ];

  it('lists the local call sites first and tags every row', async () => {
    const { run } = setup({ usages, hosted: json([hostedRow]) });
    const rows = rowsOf(await run('find_usages', { name: 'SalesTable', type: 'Class' }));
    expect(rows.map((row) => [row.sourceName, row.sourceLine, row.source])).toEqual([
      ['ContosoCaller', 10, 'local'],
      ['ContosoCaller', 20, 'local'],
      ['SalesFormLetter', 5, 'hosted'],
    ]);
    expect(rows[0]).toMatchObject({ referenceKind: 'MethodCall', sourceTable: 'References', targetMethod: 'confirm' });
    expect(rows[0]).not.toHaveProperty('id');
    expect(rows[2]).toEqual({ ...hostedRow, source: 'hosted' });
  });

  it('sends the raw arguments upstream and passes type and method filters to the local rows', async () => {
    const { run, upstream } = setup({ usages, hosted: json([hostedRow]) });
    const rows = rowsOf(await run('find_usages', { name: 'SalesTable', type: 'Class', method: 'POST' }));
    expect(rows.filter((row) => row.source === 'local').map((row) => row.sourceLine)).toEqual([20]);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).toHaveBeenCalledWith('find_usages', { name: 'SalesTable', type: 'Class', method: 'POST' });

    const other = rowsOf(await run('find_usages', { name: 'SalesTable', type: 'Table' }));
    expect(other.filter((row) => row.source === 'local')).toEqual([]);
  });

  it('is the hosted answer alone when no local XRef snapshot was imported', async () => {
    const { run } = setup({ hosted: json([hostedRow], KNOWLEDGE) });
    const result = await run('find_usages', { name: 'SalesTable' });
    expect(rowsOf(result)).toEqual([{ ...hostedRow, source: 'hosted' }]);
    expect(result.content[1]).toEqual(KNOWLEDGE);
  });

  it('lists a call site both sides report once, the local one, and keeps call sites on other lines', async () => {
    const twin = { ...hostedRow, sourceName: 'contosocaller', sourceMethod: 'RUN', sourceLine: 10, sourceColumn: 1 };
    const sameMethodElsewhere = { ...twin, sourceLine: 11 };
    const { run } = setup({ usages, hosted: json([twin, sameMethodElsewhere]) });
    const rows = rowsOf(await run('find_usages', { name: 'SalesTable', type: 'Class' }));
    expect(rows.map((row) => [row.sourceLine, row.source])).toEqual([
      [10, 'local'],
      [20, 'local'],
      [11, 'hosted'],
    ]);
    expect(rows[0].shadowedHosted).toBe(true);
    expect(rows[1].shadowedHosted).toBeUndefined();
  });

  it('cuts the merged list to limit', async () => {
    const { run } = setup({ usages, hosted: json([hostedRow]) });
    const rows = rowsOf(await run('find_usages', { name: 'SalesTable', limit: 2 }));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.source === 'local')).toBe(true);
    expect(rowsOf(await run('find_usages', { name: 'SalesTable', limit: 3 }))).toHaveLength(3);
  });

  it('answers with the local call sites when the hosted server replies in plain text', async () => {
    const { run } = setup({ usages, hosted: plain('No usages found.') });
    const result = await run('find_usages', { name: 'SalesTable' });
    expect(rowsOf(result)).toHaveLength(2);
    expect(warningsOf(result)).toEqual([]);
  });

  it('gives the local call sites and a warning when the hosted server is down', async () => {
    const { run } = setup({ usages, hosted: new Error('MCP error -32001: Request timed out') });
    const result = await run('find_usages', { name: 'SalesTable' });
    expect(rowsOf(result)).toHaveLength(2);
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });

  it('is an empty list with a warning when neither side has call sites and the hosted server is down', async () => {
    const { run } = setup({ hosted: new Error('connection refused') });
    const result = await run('find_usages', { name: 'SalesTable' });
    expect(rowsOf(result)).toEqual([]);
    expect(warningsOf(result)).toEqual(['hosted unavailable: connection refused']);
  });
});

describe('analyze_impact', () => {
  const HOSTED_CAVEAT =
    'Dependents come from declared structural references (extends, implements, data sources, EDT use, ' +
    'extensions, security grants), not compiler call sites. Use find_usages for imported call-site usage.';
  const hostedImpact = {
    root: { type: 'Table', name: 'CustTable' },
    maxDepth: 2,
    levels: [
      {
        depth: 1,
        items: [
          { type: 'Form', name: 'CustTableListPage', via: 'datasource', dependsOn: 'Table:CustTable' },
          { type: 'Class', name: 'CustTableController', via: 'uses', dependsOn: 'Table:CustTable' },
        ],
      },
      {
        depth: 2,
        items: [{ type: 'MenuItemDisplay', name: 'CustTableListPage', via: 'uses', dependsOn: 'Form:CustTableListPage' }],
      },
    ],
    totals: { objects: 3, byType: { Form: 1, Class: 1, MenuItemDisplay: 1 } },
    truncated: false,
    caveat: HOSTED_CAVEAT,
  };
  const objects: SeedObject[] = [
    { type: 'TableExtension', name: 'CustTable.Contoso' },
    { type: 'Class', name: 'ContosoCustService' },
    { type: 'Class', name: 'ContosoListHelper' },
    { type: 'Form', name: 'ContosoCustForm' },
    { type: 'Class', name: 'ContosoDeep' },
  ];
  const xrefs: XrefSeed[] = [
    // custom objects that reference the standard root
    ['TableExtension', 'CustTable.Contoso', 'Table', 'CustTable', 'extends'],
    ['Class', 'ContosoCustService', 'Table', 'CustTable', 'uses'],
    // a custom object that references a hosted dependent
    ['Class', 'ContosoListHelper', 'Form', 'CustTableListPage', 'uses'],
    // custom chain: standard root <- local class <- local form <- local class
    ['Form', 'ContosoCustForm', 'Class', 'ContosoCustService', 'uses'],
    ['Class', 'ContosoDeep', 'Form', 'ContosoCustForm', 'uses'],
  ];
  const args = { name: 'CustTable', type: 'Table' };

  const levelNames = (result: CallToolResult) => impactOf(result).levels.map((level) => [level.depth, namesOf(level.items)]);

  it('adds the custom dependents of the root and of every hosted node, local ones first inside a level', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedImpact) });
    const result = impactOf(await run('analyze_impact', args));
    expect(result.root).toEqual({ type: 'Table', name: 'CustTable' });
    expect(result.maxDepth).toBe(2);
    expect(result.levels).toEqual([
      {
        depth: 1,
        items: [
          { type: 'TableExtension', name: 'CustTable.Contoso', via: 'extends', dependsOn: 'Table:CustTable', source: 'local' },
          { type: 'Class', name: 'ContosoCustService', via: 'uses', dependsOn: 'Table:CustTable', source: 'local' },
          { ...hostedImpact.levels[0].items[0], source: 'hosted' },
          { ...hostedImpact.levels[0].items[1], source: 'hosted' },
        ],
      },
      {
        depth: 2,
        items: [
          { type: 'Form', name: 'ContosoCustForm', via: 'uses', dependsOn: 'Class:ContosoCustService', source: 'local' },
          { type: 'Class', name: 'ContosoListHelper', via: 'uses', dependsOn: 'Form:CustTableListPage', source: 'local' },
          { ...hostedImpact.levels[1].items[0], source: 'hosted' },
        ],
      },
    ]);
  });

  it('recomputes the totals over both sides and keeps the result shape of the tool', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedImpact) });
    const result = impactOf(await run('analyze_impact', args));
    expect(result.totals).toEqual({
      objects: 7,
      byType: { TableExtension: 1, Class: 3, Form: 2, MenuItemDisplay: 1 },
    });
    expect(result.truncated).toBe(false);
    expect(Object.keys(result)).toEqual(['root', 'maxDepth', 'levels', 'totals', 'truncated', 'caveat']);
  });

  it('extends the hosted caveat with the merge and the under-reporting of long chains', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedImpact) });
    const { caveat } = impactOf(await run('analyze_impact', args));
    expect(caveat.startsWith(HOSTED_CAVEAT)).toBe(true);
    expect(caveat).toContain('Custom (local) dependents');
    expect(caveat).toContain('merged');
    expect(caveat).toContain('standard to standard to custom beyond maxDepth can be under-reported');
  });

  it('sends the raw arguments upstream in a single call and keeps the hosted knowledge item last', async () => {
    const { run, upstream } = setup({ objects, xrefs, hosted: json(hostedImpact, KNOWLEDGE) });
    const result = await run('analyze_impact', args);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).toHaveBeenCalledWith('analyze_impact', args);
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual(KNOWLEDGE);
  });

  it('keeps keys the hosted result has beyond the tool\'s own', async () => {
    const { run } = setup({ objects, xrefs, hosted: json({ ...hostedImpact, generatedBy: 'hosted-2.0' }) });
    expect(impactOf(await run('analyze_impact', args)).generatedBy).toBe('hosted-2.0');
  });

  it('honours maxDepth: local dependents of nodes at the last level are not followed', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedImpact) });
    const one = await run('analyze_impact', { ...args, maxDepth: 1 });
    expect(levelNames(one)).toEqual([[1, ['CustTable.Contoso', 'ContosoCustService', 'CustTableListPage', 'CustTableController']]]);
    expect(impactOf(one).maxDepth).toBe(1);
    expect(impactOf(one).totals.objects).toBe(4);
  });

  it('walks custom chains deeper than the hosted levels when maxDepth allows it', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedImpact) });
    const result = impactOf(await run('analyze_impact', { ...args, maxDepth: 3 }));
    expect(result.levels.map((level) => level.depth)).toEqual([1, 2, 3]);
    expect(result.levels[2].items).toEqual([
      { type: 'Class', name: 'ContosoDeep', via: 'uses', dependsOn: 'Form:ContosoCustForm', source: 'local' },
    ]);
    expect(result.totals.objects).toBe(8);
  });

  it('cuts at limit inside a level, keeps the custom dependents, drops deeper levels and reports truncated', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedImpact) });
    const result = impactOf(await run('analyze_impact', { ...args, limit: 3 }));
    expect(result.levels.map((level) => [level.depth, namesOf(level.items)])).toEqual([
      [1, ['CustTable.Contoso', 'ContosoCustService', 'CustTableListPage']],
    ]);
    expect(result.totals).toEqual({ objects: 3, byType: { TableExtension: 1, Class: 1, Form: 1 } });
    expect(result.truncated).toBe(true);
  });

  it('does not report truncated when the limit is met exactly', async () => {
    const { run } = setup({ objects, xrefs, hosted: json(hostedImpact) });
    const exact = impactOf(await run('analyze_impact', { ...args, maxDepth: 1, limit: 4 }));
    expect(exact.totals.objects).toBe(4);
    expect(exact.truncated).toBe(false);

    const full = impactOf(await run('analyze_impact', { ...args, limit: 7 }));
    expect(full.totals.objects).toBe(7);
    expect(full.truncated).toBe(false);

    const short = impactOf(await run('analyze_impact', { ...args, limit: 6 }));
    expect(short.totals.objects).toBe(6);
    expect(short.truncated).toBe(true);
  });

  it('keeps truncated true when the hosted result was cut, whatever the local side adds', async () => {
    const { run } = setup({ hosted: json({ ...hostedImpact, truncated: true }) });
    const result = impactOf(await run('analyze_impact', args));
    expect(result.truncated).toBe(true);
    expect(result.totals.objects).toBe(3);
    expect(result.levels.every((level) => level.items.every((item) => item.source === 'hosted'))).toBe(true);
  });

  it('lists an object once, at the shallowest depth, and prefers the local row on the same depth', async () => {
    const { run } = setup({
      xrefs: [
        // same depth as the hosted row, different casing: the local row wins
        ['Form', 'custtablelistpage', 'Table', 'CustTable', 'datasource'],
        // depth 1 locally, depth 2 on the hosted side: the shallower one stays
        ['MenuItemDisplay', 'CustTableListPage', 'Table', 'CustTable', 'uses'],
      ],
      hosted: json(hostedImpact),
    });
    const result = impactOf(await run('analyze_impact', args));
    expect(result.levels.map((level) => level.depth)).toEqual([1]);
    expect(result.levels[0].items).toEqual([
      { type: 'Form', name: 'custtablelistpage', via: 'datasource', dependsOn: 'Table:CustTable', source: 'local', shadowedHosted: true },
      { type: 'MenuItemDisplay', name: 'CustTableListPage', via: 'uses', dependsOn: 'Table:CustTable', source: 'local' },
      { ...hostedImpact.levels[0].items[1], source: 'hosted' },
    ]);
    expect(result.totals.objects).toBe(3);
  });

  it('does not list the root as its own dependent when the custom index has a cycle back to it', async () => {
    const { run } = setup({
      xrefs: [
        ['Class', 'ContosoLoop', 'Table', 'CustTable', 'uses'],
        ['Table', 'CustTable', 'Class', 'ContosoLoop', 'uses'],
      ],
      hosted: json({ ...hostedImpact, levels: [], totals: { objects: 0, byType: {} } }),
    });
    const result = impactOf(await run('analyze_impact', args));
    expect(levelNames(await run('analyze_impact', args))).toEqual([[1, ['ContosoLoop']]]);
    expect(result.totals.objects).toBe(1);
  });

  describe('when the hosted server has nothing to merge', () => {
    const customObjects: SeedObject[] = [
      { type: 'Class', name: 'ContosoThing' },
      { type: 'Class', name: 'ContosoSub' },
      { type: 'Form', name: 'ContosoThingForm' },
    ];
    const customXrefs: XrefSeed[] = [
      ['Class', 'ContosoSub', 'Class', 'ContosoThing', 'extends'],
      ['Form', 'ContosoThingForm', 'Class', 'ContosoSub', 'uses'],
    ];
    const thing = { name: 'contosothing', type: 'Class' };

    it('walks a root of the local index with the tool\'s own function, items tagged local, hosted not-found text dropped', async () => {
      const { run, db } = setup({
        objects: customObjects,
        xrefs: customXrefs,
        hosted: plain('Object (Class) contosothing not found.', KNOWLEDGE),
      });
      const result = await run('analyze_impact', thing);
      const expected = analyzeImpact(db, 'contosothing', 'Class', 2, 200)!;
      expect(impactOf(result)).toEqual({
        ...expected,
        levels: expected.levels.map((level) => ({ ...level, items: level.items.map((item) => ({ ...item, source: 'local' })) })),
      });
      expect(impactOf(result).root.name).toBe('ContosoThing');
      expect(levelNames(result)).toEqual([[1, ['ContosoSub']], [2, ['ContosoThingForm']]]);
      expect(result.content[1]).toEqual(KNOWLEDGE);
      expect(warningsOf(result)).toEqual([]);
    });

    it('does the same with a warning when the hosted server is down', async () => {
      const { run } = setup({ objects: customObjects, xrefs: customXrefs, hosted: new Error('MCP error -32000: Connection closed') });
      const result = await run('analyze_impact', thing);
      expect(levelNames(result)).toEqual([[1, ['ContosoSub']], [2, ['ContosoThingForm']]]);
      expect(impactOf(result).totals.objects).toBe(2);
      expect(warningsOf(result)).toEqual(['hosted unavailable: Connection closed']);
    });

    it('honours maxDepth and limit for a local root', async () => {
      const { run } = setup({ objects: customObjects, xrefs: customXrefs, hosted: plain('Object (Class) ContosoThing not found.') });
      expect(levelNames(await run('analyze_impact', { ...thing, maxDepth: 1 }))).toEqual([[1, ['ContosoSub']]]);
      const capped = impactOf(await run('analyze_impact', { ...thing, limit: 1 }));
      expect(capped.totals.objects).toBe(1);
      expect(capped.truncated).toBe(true);
    });

    it('returns the hosted not-found text as it came when the object is in neither index', async () => {
      const notFound = plain('Object (Table) Nope not found. Did you mean: CustTable? (use search_symbols to browse)', KNOWLEDGE);
      const { run } = setup({ objects: customObjects, xrefs: customXrefs, hosted: notFound });
      const result = await run('analyze_impact', { name: 'Nope', type: 'Table' });
      expect(result).toEqual(notFound);
    });

    it('lists the custom dependents of a standard object the hosted server does not know', async () => {
      const { run } = setup({
        xrefs: [['Class', 'ContosoIsvAdapter', 'Class', 'IsvVendorClass', 'extends']],
        hosted: plain('Object (Class) IsvVendorClass not found.'),
      });
      const result = await run('analyze_impact', { name: 'IsvVendorClass', type: 'Class' });
      expect(impactOf(result)).toMatchObject({
        root: { type: 'Class', name: 'IsvVendorClass' },
        maxDepth: 2,
        levels: [{ depth: 1, items: [{ type: 'Class', name: 'ContosoIsvAdapter', via: 'extends', dependsOn: 'Class:IsvVendorClass', source: 'local' }] }],
        totals: { objects: 1, byType: { Class: 1 } },
        truncated: false,
      });
      expect(impactOf(result).caveat).toContain('standard dependents are missing');
      expect(warningsOf(result)).toEqual([]);
    });

    it('lists the custom dependents of a standard object while the hosted server is down, with a warning', async () => {
      const { run } = setup({
        xrefs: [['Class', 'ContosoCustService', 'Table', 'CustTable', 'uses']],
        hosted: new Error('MCP error -32001: Request timed out'),
      });
      const result = await run('analyze_impact', args);
      expect(levelNames(result)).toEqual([[1, ['ContosoCustService']]]);
      expect(impactOf(result).caveat).toContain('standard dependents are missing');
      expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
    });

    it('is the local not-found text with a warning when the hosted server is down and nothing local depends on the object', async () => {
      const { run } = setup({ objects: customObjects, xrefs: customXrefs, hosted: new Error('connection refused') });
      const result = await run('analyze_impact', { name: 'Nope', type: 'Table' });
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toBe('Object (Table) Nope not found.');
      expect(warningsOf(result)).toEqual(['hosted unavailable: connection refused']);
    });

    it('turns a hosted tool error into a warning and still answers locally', async () => {
      const { run } = setup({ objects: customObjects, xrefs: customXrefs, hosted: failed('hosted is on fire') });
      const result = await run('analyze_impact', thing);
      expect(impactOf(result).totals.objects).toBe(2);
      expect(warningsOf(result)).toEqual(['hosted unavailable: hosted is on fire']);
    });

    it('warns when the hosted answer is JSON but not an impact result', async () => {
      const { run } = setup({ objects: customObjects, xrefs: customXrefs, hosted: json({ error: 'nope' }) });
      const result = await run('analyze_impact', thing);
      expect(impactOf(result).totals.objects).toBe(2);
      expect(warningsOf(result)).toEqual(['hosted unavailable: the hosted answer is not an impact result']);
    });
  });
});
