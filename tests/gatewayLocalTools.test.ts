import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import type { GatewayWorkspaceConfig, LocalIndex, LocalIndexStatus } from '../src/gateway/types.js';
import { registerMetadataTools } from '../src/tools/metadata.js';
import { registerLabelsTools } from '../src/tools/labels.js';
import { registerSecurityTools } from '../src/tools/security.js';
import { registerEntityTools } from '../src/tools/entities.js';
import { registerCodeQualityTools } from '../src/tools/codeQuality.js';
import { registerGeneratorTools } from '../src/tools/generators.js';
import { registerWorkspaceTools } from '../src/tools/workspace.js';
import { seedDb } from './helpers/toolHarness.js';

const CUSTOM_DIR = '/home/dev/secret-project/CustomModels';

const unconfigured: GatewayWorkspaceConfig = {
  workspaceDir: '',
  customMetadataDir: CUSTOM_DIR,
  targetProject: '',
  targetPackage: '',
  targetModel: '',
  targetSolution: '',
  writableModels: [],
};

function seed() {
  return seedDb(
    [
      {
        type: 'Table',
        name: 'ContosoCustTable',
        fields: [{ name: 'AccountNum', type: 'AxTableFieldString', edt: 'CustAccount' }],
      },
      { type: 'Class', name: 'ContosoCustHelper', methods: [{ name: 'run', accessModifier: 'Public', returnType: 'void' }] },
    ],
    [{ labelId: 'Contoso1', value: 'Hello from Contoso', language: 'en-us' }]
  );
}

function fakeLocalIndex(overrides: Partial<LocalIndexStatus> = {}): LocalIndex {
  const status: LocalIndexStatus = {
    customDirName: 'CustomModels',
    objects: 2,
    labels: 1,
    lastRefreshAt: '2026-01-01T00:00:00.000Z',
    dirty: false,
    watcher: 'active',
    watcherError: null,
    lastError: null,
    ...overrides,
  };
  return {
    db: seed(),
    customDir: CUSTOM_DIR,
    ensureFresh: async () => {},
    markDirty: () => {},
    status: () => status,
    startWatcher: () => {},
    close: () => {},
  };
}

function setup(workspace: GatewayWorkspaceConfig = unconfigured) {
  const db = seed();
  const localIndex = fakeLocalIndex();
  return { db, localIndex, tools: captureLocalTools(db, localIndex, workspace) };
}

const textOf = (result: CallToolResult): string => {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected a text item.');
  return first.text;
};

describe('captureLocalTools', () => {
  it('applies zod defaults that a captured handler would otherwise miss', async () => {
    const { tools } = setup();
    expect(tools.parseArgs('search_symbols', { query: 'Contoso' })).toEqual({
      query: 'Contoso',
      limit: 20,
      explain: false,
    });

    const result = await tools.call('search_symbols', { query: 'ContosoCust' });
    expect(result.isError).toBeFalsy();
    const rows = JSON.parse(textOf(result)) as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(['ContosoCustTable', 'ContosoCustHelper']));
  });

  it('strips unknown keys and applies the schema transforms', () => {
    const { tools } = setup();
    expect(tools.parseArgs('search_symbols', { query: '  Contoso  ', bogus: true })).toEqual({
      query: 'Contoso',
      limit: 20,
      explain: false,
    });
  });

  it('turns invalid arguments into an isError result instead of throwing', async () => {
    const { tools } = setup();

    const missing = await tools.call('search_symbols', {});
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('search_symbols');

    const outOfRange = await tools.call('search_symbols', { query: 'Cust', limit: 1000 });
    expect(outOfRange.isError).toBe(true);
    expect(textOf(outOfRange)).toContain('limit');

    const blank = await tools.call('search_symbols', { query: '   ' });
    expect(blank.isError).toBe(true);
    expect(textOf(blank)).toContain('Enter a name or search term.');
  });

  it('parseArgs throws a ZodError for invalid arguments', () => {
    const { tools } = setup();
    expect(() => tools.parseArgs('search_symbols', { query: 'x', limit: 0 })).toThrow(z.ZodError);
  });

  it('reports an unknown tool without throwing', async () => {
    const { tools } = setup();
    expect(tools.has('no_such_tool')).toBe(false);
    expect(tools.shapeKeys('no_such_tool')).toBeNull();
    expect(() => tools.parseArgs('no_such_tool', {})).toThrow('no_such_tool');

    const result = await tools.call('no_such_tool', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no_such_tool');
  });

  it('turns a failing handler into an isError result', async () => {
    const db = seed();
    const tools = captureLocalTools(db, fakeLocalIndex(), unconfigured);
    db.close();

    const result = await tools.call('search_symbols', { query: 'Contoso' });
    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeGreaterThan(0);
  });

  it('serves the read-only local tools and none of the hosted-only or write tools', () => {
    const { tools } = setup();
    for (const name of [
      'search_symbols',
      'get_table_schema',
      'get_class_hierarchy',
      'find_field_access',
      'get_method_source',
      'check_xpp_best_practices',
      'resolve_label',
      'search_labels_fts',
      'get_security_object',
      'check_entity_odata_readiness',
      'create_coc_extension',
      'get_visual_studio_workspace',
      'local_index_status',
    ]) {
      expect(tools.has(name), name).toBe(true);
    }
    for (const name of [
      'list_trace_sessions',
      'find_slow_sql',
      'generate_kql_query',
      'search_release_plans',
      'check_feature_impact',
      'write_table_extension',
      'apply_table_extension_change',
      'get_task_guidance',
    ]) {
      expect(tools.has(name), name).toBe(false);
    }
  });

  it('answers from the local database', async () => {
    const { tools } = setup();

    const schema = await tools.call('get_table_schema', { tableName: 'ContosoCustTable' });
    expect(schema.isError).toBeFalsy();
    expect(textOf(schema)).toContain('AccountNum');

    const label = await tools.call('resolve_label', { labelId: 'Contoso1' });
    expect(textOf(label)).toBe('Hello from Contoso');
  });
});

describe('definitions and shapeKeys', () => {
  it('carries JSON schemas with the expected property names', () => {
    const { tools } = setup();
    const byName = new Map(tools.definitions().map((definition) => [definition.name, definition]));

    const search = byName.get('search_symbols');
    expect(search?.description).toContain('Search indexed AOT metadata');
    expect(search?.inputSchema.type).toBe('object');
    expect(Object.keys(search?.inputSchema.properties ?? {})).toEqual(['query', 'type', 'limit', 'explain']);
    expect(search?.inputSchema.required).toEqual(['query']);

    expect(Object.keys(byName.get('get_visual_studio_workspace')?.inputSchema.properties ?? {})).toEqual([
      'projectName',
      'solutionPath',
    ]);
    expect(byName.get('local_index_status')?.inputSchema).toMatchObject({ type: 'object', properties: {} });
    expect(new Set(tools.definitions().map((definition) => definition.name)).size).toBe(byName.size);
  });

  it('returns copies so callers cannot alter the cached definitions', () => {
    const { tools } = setup();
    tools.definitions()[0].description = 'changed';
    expect(tools.definitions()[0].description).not.toBe('changed');
  });

  it('has shapeKeys equal to the zod keys of every tool', () => {
    const { tools } = setup();
    expect(tools.shapeKeys('search_symbols')).toEqual(['query', 'type', 'limit', 'explain']);
    expect(tools.shapeKeys('get_table_schema')).toEqual(['tableName', 'xrefLimit', 'maxItems']);
    expect(tools.shapeKeys('local_index_status')).toEqual([]);
    for (const definition of tools.definitions()) {
      expect(tools.shapeKeys(definition.name), definition.name).toEqual(Object.keys(definition.inputSchema.properties ?? {}));
    }
  });

  it('matches what a real McpServer lists for the same registrations', async () => {
    const { db, tools } = setup();
    const server = new McpServer({ name: 'parity', version: '0.0.0' });
    registerMetadataTools(server, db, { sourceFilesAvailable: true });
    registerLabelsTools(server, db);
    registerSecurityTools(server, db);
    registerEntityTools(server, db);
    registerCodeQualityTools(server, db);
    registerGeneratorTools(server, db);
    registerWorkspaceTools(server, { ...unconfigured, writableModels: [], enableWriteTools: false });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'parity-client', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = (await client.listTools()).tools;
      const local = new Map(tools.definitions().map((definition) => [definition.name, definition]));
      expect(local.size).toBe(listed.length + 1);
      for (const tool of listed) {
        expect(local.get(tool.name), tool.name).toEqual({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
        });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('local_index_status', () => {
  it('reports the index status and the extras without an absolute path', async () => {
    const { tools } = setup();
    tools.setStatusExtras(() => ({ hosted: { reachable: true, version: '1.2.3' }, skewedTools: ['list_objects'] }));

    const result = await tools.call('local_index_status', {});
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(JSON.parse(text)).toEqual({
      localIndex: expect.objectContaining({ customDirName: 'CustomModels', objects: 2, labels: 1, watcher: 'active' }),
      hosted: { reachable: true, version: '1.2.3' },
      skewedTools: ['list_objects'],
    });
    expect(text).not.toContain(CUSTOM_DIR);
    expect(text).not.toContain('/home/dev');
    expect(text).not.toMatch(/(^|[^\w])\/[\w.-]+\/[\w.-]+/);
  });

  it('works before any extras are set and ignores arguments', async () => {
    const { tools } = setup();
    const result = await tools.call('local_index_status', { unexpected: 1 });
    expect(Object.keys(JSON.parse(textOf(result)))).toEqual(['localIndex']);
  });

  it('keeps the custom directory out of free-form extras on any platform', async () => {
    const windowsDir = 'C:\\Users\\dev\\CustomModels';
    const index: LocalIndex = { ...fakeLocalIndex(), customDir: windowsDir };
    const tools = captureLocalTools(seed(), index, unconfigured);
    tools.setStatusExtras(() => ({
      warnings: [`failed under ${windowsDir}\\Pkg`, `failed under ${windowsDir.replace(/\\/g, '/')}/Pkg`],
    }));

    const text = textOf(await tools.call('local_index_status', {}));
    expect(text).not.toContain('Users');
    expect(JSON.parse(text).warnings).toEqual(['failed under <customDir>\\Pkg', 'failed under <customDir>/Pkg']);
  });

  it('reads the current extras on every call', async () => {
    const { tools } = setup();
    let version = 'a';
    tools.setStatusExtras(() => ({ version }));
    expect(JSON.parse(textOf(await tools.call('local_index_status', {}))).version).toBe('a');
    version = 'b';
    expect(JSON.parse(textOf(await tools.call('local_index_status', {}))).version).toBe('b');
  });
});

describe('get_visual_studio_workspace', () => {
  it('answers for an unconfigured workspace with write tools off', async () => {
    const { tools } = setup();
    const result = await tools.call('get_visual_studio_workspace', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({
      state: 'unconfigured',
      error: expect.stringContaining('D365_VISUAL_STUDIO_WORKSPACE_DIR'),
      writeToolsEnabled: false,
    });
  });

  it('accepts its optional arguments', async () => {
    const { tools } = setup();
    expect(tools.parseArgs('get_visual_studio_workspace', {})).toEqual({});
    const result = await tools.call('get_visual_studio_workspace', { projectName: 'Missing' });
    expect(JSON.parse(textOf(result)).state).toBe('unconfigured');
  });
});
