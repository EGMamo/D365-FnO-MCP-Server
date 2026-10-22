import { describe, it, expect, vi, type Mock } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import { parsePayload, warningsOf } from '../src/gateway/merge.js';
import { searchStrategies } from '../src/gateway/strategies/search.js';
import type { GatewayWorkspaceConfig, LocalIndex, RouteContext, UpstreamPort } from '../src/gateway/types.js';
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

const KNOWLEDGE = { type: 'text' as const, text: '{"knowledge":{"hints":["from the hosted knowledge filter"]}}' };

const json = (value: unknown, ...extras: CallToolResult['content']): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }, ...extras],
});
const plain = (text: string, ...extras: CallToolResult['content']): CallToolResult => ({
  content: [{ type: 'text', text }, ...extras],
});

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

/** A strategy run against a seeded local database and a hosted server that always gives `answer`. */
function setup(
  objects: SeedObject[],
  answer: CallToolResult | Error = json([]),
  labels: { labelId: string; value: string; language?: string }[] = []
) {
  const db = seedDb(objects, labels);
  const localIndex: LocalIndex = {
    db,
    customDir: workspace.customMetadataDir,
    attachUri: 'file:test?mode=memory',
    ensureFresh: async () => {},
    markDirty: () => {},
    status: () => ({
      customDirName: 'CustomModels',
      objects: objects.length,
      labels: labels.length,
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
  const upstream = fakeUpstream(answer);
  const ctx: RouteContext = {
    local,
    localIndex,
    upstream,
    hostedTools: new Map(),
    privatePrefixes: [],
    skewedTools: new Set(),
  };
  // The router parses the caller's args with the local zod shape and hands the originals on as `raw`.
  const run = (tool: string, raw: Record<string, unknown>) => searchStrategies[tool](local.parseArgs(tool, raw), ctx, raw);
  return { run, upstream };
}

const rowsOf = (result: CallToolResult): Row[] => {
  const { json: payload } = parsePayload(result);
  if (!Array.isArray(payload)) throw new Error('Expected a JSON list.');
  return payload as Row[];
};
const namesOf = (result: CallToolResult): unknown[] => rowsOf(result).map((row) => row.name);
const textOf = (result: CallToolResult): string => parsePayload(result).text;

describe('searchStrategies', () => {
  it('covers exactly the search, list and label tools', () => {
    expect(Object.keys(searchStrategies).sort()).toEqual(
      [
        'list_models',
        'list_objects',
        'list_packages',
        'resolve_label',
        'resolve_label_by_language',
        'search_labels',
        'search_labels_fts',
        'search_symbols',
      ].sort()
    );
  });
});

describe('search_symbols', () => {
  const hostedHits = [
    { name: 'CustTableAmount', type: 'Edt', package: 'ApplicationSuite', id: 3 },
    { name: 'CustTable', type: 'Table', package: 'ApplicationSuite', id: 5 },
  ];
  const localObjects: SeedObject[] = [
    { type: 'Table', name: 'CustTableCustom', package: 'ContosoPkg' },
    { type: 'Class', name: 'ContosoWidget', package: 'ContosoPkg' },
  ];

  it('merges both sides, tags every row and ranks exact, then local before hosted within a class', async () => {
    const { run } = setup(localObjects, json(hostedHits));
    const result = await run('search_symbols', { query: 'CustTable' });
    expect(rowsOf(result)).toEqual([
      { name: 'CustTable', type: 'Table', package: 'ApplicationSuite', id: 5, source: 'hosted' },
      { name: 'CustTableCustom', type: 'Table', package: 'ContosoPkg', source: 'local' },
      { name: 'CustTableAmount', type: 'Edt', package: 'ApplicationSuite', id: 3, source: 'hosted' },
    ]);
  });

  it('sends the caller\'s raw arguments upstream, without the defaults the local parse added', async () => {
    const { run, upstream } = setup(localObjects, json(hostedHits));
    await run('search_symbols', { query: 'CustTable', type: 'Table' });
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).toHaveBeenCalledWith('search_symbols', { query: 'CustTable', type: 'Table' });
  });

  it('keeps one row per type and name, the local one, and says it hides a hosted twin', async () => {
    const { run } = setup(
      [
        { type: 'Table', name: 'CustTable', package: 'ContosoPkg' },
        { type: 'Class', name: 'CustTable', package: 'ContosoPkg' },
      ],
      json([
        { name: 'custtable', type: 'table', package: 'ApplicationSuite', id: 1 },
        { name: 'CustTable', type: 'Form', package: 'ApplicationSuite', id: 2 },
      ])
    );
    const rows = rowsOf(await run('search_symbols', { query: 'CustTable' }));
    expect(rows).toHaveLength(3);
    const table = rows.find((row) => row.type === 'Table');
    expect(table).toMatchObject({ package: 'ContosoPkg', source: 'local', shadowedHosted: true });
    expect(rows.filter((row) => row.type === 'Class')).toEqual([{ name: 'CustTable', type: 'Class', package: 'ContosoPkg', source: 'local' }]);
    expect(rows.filter((row) => row.type === 'Form')).toEqual([
      { name: 'CustTable', type: 'Form', package: 'ApplicationSuite', id: 2, source: 'hosted' },
    ]);
  });

  it('cuts the merged list to limit after ranking', async () => {
    const { run } = setup(localObjects, json(hostedHits));
    const result = await run('search_symbols', { query: 'CustTable', limit: 2 });
    expect(namesOf(result)).toEqual(['CustTable', 'CustTableCustom']);
  });

  it('applies the default limit of 20 when the caller gave none', async () => {
    const hosted = Array.from({ length: 25 }, (_, index) => ({ name: `CustHosted${index}`, type: 'Table', package: 'ApplicationSuite', id: index }));
    const { run } = setup(localObjects, json(hosted));
    expect(rowsOf(await run('search_symbols', { query: 'CustHosted' }))).toHaveLength(20);
  });

  it('answers with the local rows when the hosted server finds nothing', async () => {
    const { run } = setup(localObjects, json([]));
    const result = await run('search_symbols', { query: 'ContosoWidget' });
    expect(rowsOf(result)).toEqual([{ name: 'ContosoWidget', type: 'Class', package: 'ContosoPkg', source: 'local' }]);
    expect(warningsOf(result)).toEqual([]);
  });

  it('treats a plain-text hosted answer as a miss, without a warning', async () => {
    const { run } = setup(localObjects, plain('Nothing found.'));
    const result = await run('search_symbols', { query: 'ContosoWidget' });
    expect(namesOf(result)).toEqual(['ContosoWidget']);
    expect(warningsOf(result)).toEqual([]);
  });

  it('returns the hosted rows when nothing is local', async () => {
    const { run } = setup([], json(hostedHits));
    const result = await run('search_symbols', { query: 'CustTable' });
    expect(namesOf(result)).toEqual(['CustTable', 'CustTableAmount']);
    expect(rowsOf(result).every((row) => row.source === 'hosted')).toBe(true);
  });

  it('keeps the hosted knowledge item after the payload and puts warnings last', async () => {
    const { run } = setup(localObjects, json(hostedHits, KNOWLEDGE));
    const result = await run('search_symbols', { query: 'CustTable' });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual(KNOWLEDGE);
    expect(warningsOf(result)).toEqual([]);
  });

  it('falls back to the local rows with a warning when the hosted call fails', async () => {
    const { run } = setup(localObjects, new Error('connect ECONNREFUSED https://hosted.example/mcp'));
    const result = await run('search_symbols', { query: 'CustTable' });
    expect(result.isError).toBeUndefined();
    expect(namesOf(result)).toEqual(['CustTableCustom']);
    const [warning] = warningsOf(result);
    expect(warning).toMatch(/^hosted unavailable: /);
    expect(warning).not.toContain('hosted.example');
  });

  it('treats an error result from the hosted server as a failed leg', async () => {
    const { run } = setup(localObjects, { content: [{ type: 'text', text: 'Input validation error: bad limit' }], isError: true });
    const result = await run('search_symbols', { query: 'CustTable' });
    expect(namesOf(result)).toEqual(['CustTableCustom']);
    expect(warningsOf(result)).toEqual(['hosted unavailable: Input validation error: bad limit']);
  });

  it('does not wrap the router\'s own warnings a second time', async () => {
    const skipped = 'hosted lookup skipped: the arguments contain a name with a private prefix';
    const { run } = setup(localObjects, new Error(skipped));
    expect(warningsOf(await run('search_symbols', { query: 'CustTable' }))).toEqual([skipped]);
  });

  describe('explain', () => {
    it('explains local rows the way the tool does and keeps what the hosted rows already say', async () => {
      const hosted = [
        { name: 'CustTable', type: 'Table', package: 'ApplicationSuite', id: 5, match: 'exact', explanation: 'hosted words' },
      ];
      const { run } = setup(localObjects, json(hosted));
      const rows = rowsOf(await run('search_symbols', { query: 'CustTable', explain: true }));
      expect(rows[0]).toMatchObject({ name: 'CustTable', source: 'hosted', match: 'exact', explanation: 'hosted words' });
      expect(rows[1]).toEqual({
        name: 'CustTableCustom',
        type: 'Table',
        package: 'ContosoPkg',
        source: 'local',
        match: 'prefix',
        explanation: 'Name starts with "CustTable"; ranked by full-text relevance.',
      });
    });

    it('explains rows from a hosted server that left the fields out', async () => {
      const { run } = setup([], json([{ name: 'MyCustTable', type: 'Table', package: 'ApplicationSuite', id: 1 }]));
      const rows = rowsOf(await run('search_symbols', { query: 'CustTable', explain: true }));
      expect(rows[0]).toMatchObject({ match: 'substring' });
      expect(rows[0].explanation).toContain('Name contains "CustTable"');
    });

    it('explains the local rows when the hosted server is down', async () => {
      const { run } = setup(localObjects, new Error('timed out'));
      const rows = rowsOf(await run('search_symbols', { query: 'ContosoWidget', explain: true }));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: 'local', match: 'exact' });
    });

    it('adds no match fields when explain is off', async () => {
      const { run } = setup(localObjects, json(hostedHits));
      const rows = rowsOf(await run('search_symbols', { query: 'CustTable' }));
      expect(rows.some((row) => 'match' in row || 'explanation' in row)).toBe(false);
    });
  });
});

describe('list_objects', () => {
  const localObjects: SeedObject[] = [
    { type: 'Class', name: 'ContosoB', package: 'ContosoPkg', model: 'ContosoModel' },
    { type: 'Table', name: 'ContosoA', package: 'ContosoPkg', model: 'ContosoModel' },
    { type: 'Table', name: 'ContosoC', package: 'ContosoPkg', model: 'ContosoModel' },
  ];
  const hostedPage = [
    { id: 1, type: 'Class', name: 'Aaa', package: 'ApplicationSuite', model: 'Application Suite', file_path: '/h/Aaa.xml', file_mtime: 1 },
    { id: 2, type: 'Table', name: 'CustTable', package: 'ApplicationSuite', model: 'Application Suite', file_path: '/h/CustTable.xml', file_mtime: 1 },
  ];

  it('puts the hosted page and the local rows in one list ordered by type and name', async () => {
    const { run, upstream } = setup(localObjects, json(hostedPage));
    const result = await run('list_objects', {});
    expect(rowsOf(result).map((row) => [row.type, row.name, row.source])).toEqual([
      ['Class', 'Aaa', 'hosted'],
      ['Class', 'ContosoB', 'local'],
      ['Table', 'ContosoA', 'local'],
      ['Table', 'ContosoC', 'local'],
      ['Table', 'CustTable', 'hosted'],
    ]);
    expect(rowsOf(result).filter((row) => row.source === 'local').every((row) => !('id' in row))).toBe(true);
    expect(upstream.callTool).toHaveBeenCalledWith('list_objects', {});
  });

  it('pages each side on its own: offset and limit select a local page and go upstream untouched', async () => {
    const { run, upstream } = setup(localObjects, json(hostedPage));
    const raw = { type: 'Table', offset: 1, limit: 1 };
    const result = await run('list_objects', raw);
    // Local Tables are ContosoA, ContosoC; offset 1 / limit 1 leaves ContosoC. The hosted side answers its own page.
    expect(rowsOf(result).filter((row) => row.source === 'local').map((row) => row.name)).toEqual(['ContosoC']);
    expect(upstream.callTool).toHaveBeenCalledWith('list_objects', raw);
  });

  it('may return more than limit rows, one page per side', async () => {
    const { run } = setup(localObjects, json(hostedPage));
    const result = await run('list_objects', { limit: 2 });
    expect(rowsOf(result)).toHaveLength(4);
  });

  it('has no local rows once the local list is used up, so later pages are hosted only', async () => {
    const { run } = setup(localObjects, json(hostedPage));
    const result = await run('list_objects', { offset: 50 });
    expect(rowsOf(result).map((row) => row.source)).toEqual(['hosted', 'hosted']);
  });

  it('answers a package the local index holds locally and sends nothing upstream', async () => {
    const { run, upstream } = setup(localObjects, json(hostedPage));
    const result = await run('list_objects', { package: 'ContosoPkg', type: 'Table' });
    expect(rowsOf(result).map((row) => row.name)).toEqual(['ContosoA', 'ContosoC']);
    expect(rowsOf(result).every((row) => row.source === 'local')).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('still answers a local package at an offset past its objects, without asking upstream', async () => {
    const { run, upstream } = setup(localObjects, json(hostedPage));
    const result = await run('list_objects', { package: 'ContosoPkg', offset: 100 });
    expect(rowsOf(result)).toEqual([]);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('asks the hosted server for any other package and adds no local rows', async () => {
    const { run, upstream } = setup(localObjects, json([hostedPage[1]]));
    const raw = { package: 'ApplicationSuite' };
    const result = await run('list_objects', raw);
    expect(rowsOf(result)).toEqual([{ ...hostedPage[1], source: 'hosted' }]);
    expect(upstream.callTool).toHaveBeenCalledWith('list_objects', raw);
  });

  it('keeps one row for an object both sides list, the local one', async () => {
    const { run } = setup([{ type: 'Table', name: 'CustTable', package: 'ContosoPkg' }], json([hostedPage[1]]));
    const rows = rowsOf(await run('list_objects', { type: 'Table' }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'local', package: 'ContosoPkg', shadowedHosted: true });
  });

  it('keeps the hosted knowledge item', async () => {
    const { run } = setup(localObjects, json(hostedPage, KNOWLEDGE));
    const result = await run('list_objects', {});
    expect(result.content[1]).toEqual(KNOWLEDGE);
  });

  it('treats plain text from the hosted server as a miss', async () => {
    const { run } = setup(localObjects, plain('No objects.'));
    const result = await run('list_objects', {});
    expect(rowsOf(result).map((row) => row.name)).toEqual(['ContosoB', 'ContosoA', 'ContosoC']);
    expect(warningsOf(result)).toEqual([]);
  });

  it('gives the local page and a warning when the hosted server is down', async () => {
    const { run } = setup(localObjects, new Error('socket hang up'));
    const result = await run('list_objects', { type: 'Table' });
    expect(rowsOf(result).map((row) => row.name)).toEqual(['ContosoA', 'ContosoC']);
    expect(warningsOf(result)).toEqual(['hosted unavailable: socket hang up']);
  });
});

describe('list_packages and list_models', () => {
  const localObjects: SeedObject[] = [
    { type: 'Table', name: 'ContosoA', package: 'ContosoPkg', model: 'ContosoModel' },
    { type: 'Table', name: 'ContosoB', package: 'ContosoPkg', model: 'ContosoModel' },
    { type: 'Class', name: 'ExtraC', package: 'ApplicationSuite', model: 'Application Suite' },
  ];

  it('unions the packages, sums the counts of a shared one and marks where each came from', async () => {
    const { run } = setup(
      localObjects,
      json([
        { package: 'ApplicationSuite', objectCount: 1200 },
        { package: 'ApplicationPlatform', objectCount: 900 },
      ])
    );
    const result = await run('list_packages', {});
    expect(rowsOf(result)).toEqual([
      { package: 'ApplicationPlatform', objectCount: 900, source: 'hosted' },
      { package: 'ApplicationSuite', objectCount: 1201, source: 'both' },
      { package: 'ContosoPkg', objectCount: 2, source: 'local' },
    ]);
  });

  it('unions the models the same way', async () => {
    const { run } = setup(
      localObjects,
      json([
        { model: 'Application Suite', objectCount: 1200 },
        { model: 'Directory', objectCount: 40 },
      ])
    );
    const result = await run('list_models', {});
    expect(rowsOf(result)).toEqual([
      { model: 'Application Suite', objectCount: 1201, source: 'both' },
      { model: 'ContosoModel', objectCount: 2, source: 'local' },
      { model: 'Directory', objectCount: 40, source: 'hosted' },
    ]);
  });

  it('sends no arguments upstream, so no custom name leaves the machine', async () => {
    const { run, upstream } = setup(localObjects, json([]));
    await run('list_packages', {});
    expect(upstream.callTool).toHaveBeenCalledWith('list_packages', {});
  });

  it('lists the local entries only, tagged, when the hosted answer is plain text', async () => {
    const { run } = setup(localObjects, plain('nothing'));
    const result = await run('list_packages', {});
    expect(rowsOf(result)).toEqual([
      { package: 'ApplicationSuite', objectCount: 1, source: 'local' },
      { package: 'ContosoPkg', objectCount: 2, source: 'local' },
    ]);
    expect(warningsOf(result)).toEqual([]);
  });

  it('lists only the hosted entries when nothing is local', async () => {
    const { run } = setup([], json([{ model: 'Directory', objectCount: 40 }]));
    expect(rowsOf(await run('list_models', {}))).toEqual([{ model: 'Directory', objectCount: 40, source: 'hosted' }]);
  });

  it('skips hosted rows without a usable name and counts a missing objectCount as 0', async () => {
    const { run } = setup([], json([{ objectCount: 5 }, { package: '', objectCount: 3 }, 'junk', null, { package: 'Directory' }]));
    expect(rowsOf(await run('list_packages', {}))).toEqual([{ package: 'Directory', objectCount: 0, source: 'hosted' }]);
  });

  it('keeps the hosted knowledge item', async () => {
    const { run } = setup(localObjects, json([], KNOWLEDGE));
    expect((await run('list_models', {})).content[1]).toEqual(KNOWLEDGE);
  });

  it('gives the local entries and a warning when the hosted server is down', async () => {
    const { run } = setup(localObjects, new Error('timed out after 15000ms'));
    const packages = await run('list_packages', {});
    expect(rowsOf(packages).every((row) => row.source === 'local')).toBe(true);
    expect(warningsOf(packages)).toEqual(['hosted unavailable: timed out after 15000ms']);
    const models = await run('list_models', {});
    expect(rowsOf(models).map((row) => row.model)).toEqual(['Application Suite', 'ContosoModel']);
    expect(warningsOf(models)).toHaveLength(1);
  });
});

describe('label searches', () => {
  const labels = [
    { labelId: 'Contoso1', value: 'Hello from Contoso', language: 'en-us' },
    { labelId: 'Contoso2', value: 'Hello again', language: 'de' },
  ];
  const hostedLabels = [
    { label_id: 'Contoso1', language: 'en-US', value: 'Hosted hello' },
    { label_id: 'SYS1', language: 'en-US', value: 'Hello world' },
  ];

  describe.each(['search_labels', 'search_labels_fts'])('%s', (tool) => {
    it('puts local labels first and keeps one row per label id and language, the local one', async () => {
      const { run } = setup([], json(hostedLabels), labels);
      const rows = rowsOf(await run(tool, { query: 'Hello' }));
      // The local rows keep the order of the local tool (full-text rank for search_labels_fts).
      expect(rows.slice(0, 2)).toEqual(
        expect.arrayContaining([
          { label_id: 'Contoso1', language: 'en-us', value: 'Hello from Contoso', source: 'local', shadowedHosted: true },
          { label_id: 'Contoso2', language: 'de', value: 'Hello again', source: 'local' },
        ])
      );
      expect(rows[2]).toEqual({ label_id: 'SYS1', language: 'en-US', value: 'Hello world', source: 'hosted' });
      expect(rows).toHaveLength(3);
    });

    it('sends the raw arguments upstream', async () => {
      const { run, upstream } = setup([], json(hostedLabels), labels);
      await run(tool, { query: 'Hello', language: 'en-US' });
      expect(upstream.callTool).toHaveBeenCalledWith(tool, { query: 'Hello', language: 'en-US' });
    });

    it('cuts the merged list to limit', async () => {
      const { run } = setup([], json(hostedLabels), labels);
      const result = await run(tool, { query: 'Hello', limit: 2 });
      expect(rowsOf(result).map((row) => row.source)).toEqual(['local', 'local']);
    });

    it('applies the default limit of 20', async () => {
      const many = Array.from({ length: 30 }, (_, index) => ({ label_id: `SYS${index}`, language: 'en-US', value: `Hello ${index}` }));
      const { run } = setup([], json(many), labels);
      expect(rowsOf(await run(tool, { query: 'Hello' }))).toHaveLength(20);
    });

    it('returns the hosted rows when no local label matches', async () => {
      const { run } = setup([], json(hostedLabels), labels);
      const result = await run(tool, { query: 'nothing local says this' });
      expect(rowsOf(result)).toEqual(hostedLabels.map((row) => ({ ...row, source: 'hosted' })));
    });

    it('treats a plain-text hosted answer as a miss', async () => {
      const { run } = setup([], plain('No labels found.'), labels);
      const result = await run(tool, { query: 'Hello' });
      expect(rowsOf(result).map((row) => row.source)).toEqual(['local', 'local']);
      expect(warningsOf(result)).toEqual([]);
    });

    it('answers a local-only label without finding anything upstream', async () => {
      const { run } = setup([], json([]), labels);
      const result = await run(tool, { query: 'Contoso' });
      expect(rowsOf(result)).toEqual([{ label_id: 'Contoso1', language: 'en-us', value: 'Hello from Contoso', source: 'local' }]);
    });

    it('keeps the hosted knowledge item', async () => {
      const { run } = setup([], json(hostedLabels, KNOWLEDGE), labels);
      const result = await run(tool, { query: 'Hello' });
      expect(result.content[1]).toEqual(KNOWLEDGE);
    });

    it('gives the local labels and a warning when the hosted server is down', async () => {
      const { run } = setup([], new Error('connect ECONNREFUSED'), labels);
      const result = await run(tool, { query: 'Hello' });
      expect(rowsOf(result).map((row) => row.label_id).sort()).toEqual(['Contoso1', 'Contoso2']);
      expect(rowsOf(result).every((row) => row.source === 'local')).toBe(true);
      expect(warningsOf(result)).toEqual(['hosted unavailable: connect ECONNREFUSED']);
    });
  });
});

describe('label resolution', () => {
  const labels = [{ labelId: 'Contoso1', value: 'Hello from Contoso', language: 'en-us' }];

  describe('resolve_label', () => {
    it('answers a local label without calling upstream', async () => {
      const { run, upstream } = setup([], plain('hosted value'), labels);
      const result = await run('resolve_label', { labelId: '@Contoso1' });
      expect(textOf(result)).toBe('Hello from Contoso');
      expect(upstream.callTool).not.toHaveBeenCalled();
    });

    it('asks the hosted server about a label the local index lacks and returns its answer as it came', async () => {
      const { run, upstream } = setup([], plain('Customer', KNOWLEDGE), labels);
      const result = await run('resolve_label', { labelId: '@SYS1' });
      expect(result.content).toEqual([{ type: 'text', text: 'Customer' }, KNOWLEDGE]);
      expect(upstream.callTool).toHaveBeenCalledWith('resolve_label', { labelId: '@SYS1' });
    });

    it('says "Label not found" when neither side knows the label', async () => {
      const { run } = setup([], plain('Label not found'), labels);
      const result = await run('resolve_label', { labelId: '@SYS999' });
      expect(textOf(result)).toBe('Label not found');
      expect(warningsOf(result)).toEqual([]);
    });

    it('gives the local miss and a warning when the hosted server is down', async () => {
      const { run } = setup([], new Error('connect ECONNREFUSED'), labels);
      const result = await run('resolve_label', { labelId: '@SYS1' });
      expect(textOf(result)).toBe('Label not found');
      expect(warningsOf(result)).toEqual(['hosted unavailable: connect ECONNREFUSED']);
    });

    it('treats an error from the hosted server as a failed leg', async () => {
      const { run } = setup([], { content: [{ type: 'text', text: 'internal error' }], isError: true }, labels);
      const result = await run('resolve_label', { labelId: '@SYS1' });
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toBe('Label not found');
      expect(warningsOf(result)).toEqual(['hosted unavailable: internal error']);
    });
  });

  describe('resolve_label_by_language', () => {
    it('answers a local label in the default language without calling upstream', async () => {
      const { run, upstream } = setup([], plain('hosted value'), labels);
      const result = await run('resolve_label_by_language', { labelId: 'Contoso1' });
      expect(textOf(result)).toBe('Hello from Contoso');
      expect(upstream.callTool).not.toHaveBeenCalled();
    });

    it('goes upstream when the local label has no text in that language', async () => {
      const { run, upstream } = setup([], plain('Hallo von Contoso'), labels);
      const raw = { labelId: 'Contoso1', language: 'de' };
      const result = await run('resolve_label_by_language', raw);
      expect(textOf(result)).toBe('Hallo von Contoso');
      expect(upstream.callTool).toHaveBeenCalledWith('resolve_label_by_language', raw);
    });

    it('says "not found" when neither side knows the label', async () => {
      const { run } = setup([], plain('not found'), labels);
      const result = await run('resolve_label_by_language', { labelId: 'SYS999' });
      expect(textOf(result)).toBe('not found');
      expect(warningsOf(result)).toEqual([]);
    });

    it('gives the local miss and a warning when the hosted server is down', async () => {
      const { run } = setup([], new Error('timed out'), labels);
      const result = await run('resolve_label_by_language', { labelId: 'SYS1' });
      expect(textOf(result)).toBe('not found');
      expect(warningsOf(result)).toEqual(['hosted unavailable: timed out']);
    });
  });
});
