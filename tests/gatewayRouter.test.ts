import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import { errorResult, jsonResult, parsePayload, warningsOf } from '../src/gateway/merge.js';
import {
  LOCAL_ONLY_TOOL_NAMES,
  MERGE_TOOL_NAMES,
  OWNER_ROUTED_TOOL_NAMES,
  computeSkewedTools,
  executeToolCall,
  routeFor,
} from '../src/gateway/router.js';
import type { GatewayWorkspaceConfig, LocalIndex, LocalTools, RouteContext, UpstreamPort } from '../src/gateway/types.js';
import { seedDb } from './helpers/toolHarness.js';

// The merge strategies are written and tested elsewhere; the router is exercised against stand-ins.
const strategies = vi.hoisted(() => ({
  search_symbols: vi.fn(),
  list_objects: vi.fn(),
  list_packages: vi.fn(),
  list_models: vi.fn(),
  search_labels: vi.fn(),
  search_labels_fts: vi.fn(),
  resolve_label: vi.fn(),
  resolve_label_by_language: vi.fn(),
  get_table_schema: vi.fn(),
  get_class_hierarchy: vi.fn(),
  find_field_access: vi.fn(),
  find_references: vi.fn(),
  analyze_impact: vi.fn(),
  find_usages: vi.fn(),
}));

vi.mock('../src/gateway/strategies/search.js', () => ({
  searchStrategies: {
    search_symbols: strategies.search_symbols,
    list_objects: strategies.list_objects,
    list_packages: strategies.list_packages,
    list_models: strategies.list_models,
    search_labels: strategies.search_labels,
    search_labels_fts: strategies.search_labels_fts,
    resolve_label: strategies.resolve_label,
    resolve_label_by_language: strategies.resolve_label_by_language,
  },
}));
vi.mock('../src/gateway/strategies/objects.js', () => ({
  objectStrategies: {
    get_table_schema: strategies.get_table_schema,
    get_class_hierarchy: strategies.get_class_hierarchy,
    find_field_access: strategies.find_field_access,
  },
}));
vi.mock('../src/gateway/strategies/xrefs.js', () => ({
  xrefStrategies: {
    find_references: strategies.find_references,
    analyze_impact: strategies.analyze_impact,
    find_usages: strategies.find_usages,
  },
}));

const CUSTOM_DIR = '/home/dev/secret-project/CustomModels';

const workspace: GatewayWorkspaceConfig = {
  workspaceDir: '',
  customMetadataDir: CUSTOM_DIR,
  targetProject: '',
  targetPackage: '',
  targetModel: '',
  targetSolution: '',
};

/** AOT XML with one method, so source lookups on a local object succeed. */
const withMethod = (root: string, name: string, method: string) =>
  `<${root}><Name>${name}</Name><SourceCode><Methods><Method><Name>${method}</Name><Source><![CDATA[public void ${method}() { }]]></Source></Method></Methods></SourceCode></${root}>`;

function seed() {
  return seedDb(
    [
      {
        type: 'Table',
        name: 'ContosoCustTable',
        fields: [{ name: 'AccountNum', type: 'AxTableFieldString', edt: 'CustAccount' }],
        raw_xml: withMethod('AxTable', 'ContosoCustTable', 'x'),
      },
      {
        type: 'Class',
        name: 'ContosoCustHelper',
        methods: [{ name: 'run', accessModifier: 'Public', returnType: 'void' }],
        raw_xml: withMethod('AxClass', 'ContosoCustHelper', 'run'),
      },
      { type: 'Enum', name: 'ContosoStatus' },
      { type: 'Edt', name: 'ContosoAmount' },
      { type: 'Form', name: 'ContosoCustForm' },
      { type: 'Query', name: 'ContosoCustQuery' },
      { type: 'DataEntity', name: 'ContosoCustEntity' },
      { type: 'SecurityRole', name: 'ContosoRole' },
      { type: 'SecurityDuty', name: 'ContosoDuty' },
      { type: 'SecurityPrivilege', name: 'ContosoPrivilege' },
    ],
    [{ labelId: 'Contoso1', value: 'Hello from Contoso', language: 'en-us' }]
  );
}

type FakeUpstream = UpstreamPort & { callTool: Mock<UpstreamPort['callTool']>; isAvailable: Mock<UpstreamPort['isAvailable']> };

const HOSTED_ANSWER: CallToolResult = {
  content: [
    { type: 'text', text: '{"hosted":true}' },
    { type: 'text', text: '{"knowledge":{"hints":["from the hosted knowledge filter"]}}' },
  ],
};

function fakeUpstream(): FakeUpstream {
  return {
    isAvailable: vi.fn(() => true),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => HOSTED_ANSWER),
    serverVersion: '1.0.0',
  };
}

function setup(overrides: Partial<RouteContext> = {}) {
  const db = seed();
  const ensureFresh = vi.fn(async () => {});
  const localIndex: LocalIndex = {
    db,
    customDir: CUSTOM_DIR,
    ensureFresh,
    markDirty: () => {},
    status: () => ({
      customDirName: 'CustomModels',
      objects: 10,
      labels: 1,
      lastRefreshAt: '2026-01-01T00:00:00.000Z',
      dirty: false,
      watcher: 'active',
      watcherError: null,
      lastError: null,
    }),
    startWatcher: () => {},
    close: () => {},
  };
  const local = captureLocalTools(db, localIndex, workspace);
  const upstream = fakeUpstream();
  const ctx: RouteContext = {
    local,
    localIndex,
    upstream,
    hostedTools: new Map(),
    privatePrefixes: [],
    skewedTools: new Set(),
    ...overrides,
  };
  return { ctx, upstream, ensureFresh, localCall: vi.spyOn(local, 'call') };
}

const textOf = (result: CallToolResult): string => {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected a text item.');
  return first.text;
};

beforeEach(() => {
  for (const strategy of Object.values(strategies)) strategy.mockReset();
});

describe('route table', () => {
  it('classifies every tool of the design', () => {
    expect(LOCAL_ONLY_TOOL_NAMES).toEqual(['local_index_status', 'get_visual_studio_workspace']);
    expect([...MERGE_TOOL_NAMES].sort()).toEqual(
      [
        'analyze_impact',
        'find_field_access',
        'find_references',
        'find_usages',
        'get_class_hierarchy',
        'get_table_schema',
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
    expect([...OWNER_ROUTED_TOOL_NAMES].sort()).toEqual(
      [
        'check_xpp_best_practices',
        'create_class_extension',
        'create_coc_extension',
        'create_event_handler',
        'create_form_event_handler',
        'create_table_extension',
        'get_data_entity_details',
        'get_edt_details',
        'get_element_xml',
        'get_enum_values',
        'get_form_datasources',
        'get_method_signature',
        'get_method_source',
        'get_query_datasources',
        'get_security_object',
      ].sort()
    );
  });

  it('keeps the three lists apart and routes by kind', () => {
    const all = [...LOCAL_ONLY_TOOL_NAMES, ...MERGE_TOOL_NAMES, ...OWNER_ROUTED_TOOL_NAMES];
    expect(new Set(all).size).toBe(all.length);
    for (const name of LOCAL_ONLY_TOOL_NAMES) expect(routeFor(name)).toBe('local');
    for (const name of MERGE_TOOL_NAMES) expect(routeFor(name)).toBe('merge');
    for (const name of OWNER_ROUTED_TOOL_NAMES) expect(routeFor(name)).toBe('owner');
    for (const name of ['get_index_stats', 'get_index_staleness', 'generate_xpp_class', 'list_trace_sessions', 'constructor', '__proto__', '']) {
      expect(routeFor(name), name).toBe('forward');
    }
  });

  it('only routes tools the local handlers can answer', () => {
    const { ctx } = setup();
    for (const name of [...LOCAL_ONLY_TOOL_NAMES, ...MERGE_TOOL_NAMES, ...OWNER_ROUTED_TOOL_NAMES]) {
      expect(ctx.local.has(name), name).toBe(true);
    }
  });
});

describe('local-only tools', () => {
  it('answers local_index_status locally, after refreshing, and never calls upstream', async () => {
    const { ctx, upstream, ensureFresh } = setup();
    const result = await executeToolCall('local_index_status', {}, ctx);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).localIndex).toMatchObject({ customDirName: 'CustomModels', objects: 10 });
    expect(textOf(result)).not.toContain(CUSTOM_DIR);
    expect(ensureFresh).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(upstream.isAvailable).not.toHaveBeenCalled();
  });

  it('answers get_visual_studio_workspace locally even when the hosted server is down or private prefixes are set', async () => {
    const { ctx, upstream } = setup({ privatePrefixes: ['Contoso'] });
    upstream.isAvailable.mockReturnValue(false);
    const result = await executeToolCall('get_visual_studio_workspace', { projectName: 'ContosoProject' }, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(result.content.length).toBeGreaterThan(0);
    expect(warningsOf(result)).toEqual([]);
  });

  it('reports invalid arguments instead of throwing or going upstream', async () => {
    const { ctx, upstream } = setup();
    const result = await executeToolCall('get_visual_studio_workspace', { projectName: 42 }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('get_visual_studio_workspace');
    expect(upstream.callTool).not.toHaveBeenCalled();
  });
});

describe('owner-routed tools', () => {
  // [tool, args naming an object in the local index, args naming one only the hosted server has]
  const OWNED: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['get_enum_values', { enumName: 'ContosoStatus' }, { enumName: 'NoYes' }],
    ['get_edt_details', { edtName: 'ContosoAmount' }, { edtName: 'AccountNum' }],
    ['get_form_datasources', { formName: 'ContosoCustForm' }, { formName: 'CustTable' }],
    ['get_query_datasources', { queryName: 'ContosoCustQuery' }, { queryName: 'CustQuery' }],
    ['get_data_entity_details', { entityName: 'ContosoCustEntity' }, { entityName: 'CustCustomerV3Entity' }],
    ['get_method_signature', { className: 'ContosoCustHelper', methodName: 'run' }, { className: 'CustTable', methodName: 'find' }],
    ['get_method_source', { objectName: 'ContosoCustHelper', methodName: 'run' }, { objectName: 'CustTable', methodName: 'find' }],
    ['get_method_source', { objectName: 'ContosoCustTable', objectType: 'Table', methodName: 'x' }, { objectName: 'CustTable', objectType: 'Table', methodName: 'find' }],
    ['get_element_xml', { name: 'ContosoCustTable', type: 'Table' }, { name: 'CustTable', type: 'Table' }],
    ['get_security_object', { type: 'Role', name: 'ContosoRole' }, { type: 'Role', name: 'SystemAdministrator' }],
    ['get_security_object', { type: 'Duty', name: 'ContosoDuty' }, { type: 'Duty', name: 'CustTableMaintain' }],
    ['get_security_object', { type: 'Privilege', name: 'ContosoPrivilege' }, { type: 'Privilege', name: 'CustTableView' }],
    ['check_xpp_best_practices', { objectName: 'ContosoCustHelper' }, { objectName: 'CustTable' }],
    [
      'create_coc_extension',
      { targetClass: 'ContosoCustHelper', extensionName: 'ContosoCustHelper_Extension', methods: [{ name: 'run' }] },
      { targetClass: 'CustTable', extensionName: 'CustTable_Extension', methods: [{ name: 'validateWrite' }] },
    ],
    ['create_class_extension', { targetClass: 'ContosoCustHelper', extensionName: 'ContosoCustHelper_Extension' }, { targetClass: 'SalesFormLetter', extensionName: 'SalesFormLetter_Extension' }],
    ['create_table_extension', { targetTable: 'ContosoCustTable', extensionName: 'ContosoCustTableExt' }, { targetTable: 'CustTable', extensionName: 'CustTableExt' }],
    [
      'create_event_handler',
      { handlerClass: 'ContosoHandler', kind: 'data', targetType: 'Table', targetName: 'ContosoCustTable', event: 'Inserted' },
      { handlerClass: 'MyHandler', kind: 'data', targetType: 'Table', targetName: 'CustTable', event: 'Inserted' },
    ],
    [
      'create_form_event_handler',
      { handlerClass: 'ContosoFormHandler', formName: 'ContosoCustForm', scope: 'form', event: 'PostRun' },
      { handlerClass: 'MyFormHandler', formName: 'SalesTable', scope: 'form', event: 'PostRun' },
    ],
  ];

  it.each(OWNED)('%s answers from the local index when it owns the object and sends nothing upstream', async (tool, owned) => {
    const { ctx, upstream, ensureFresh } = setup({ privatePrefixes: ['Contoso'] });
    const result = await executeToolCall(tool, owned, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(ensureFresh).toHaveBeenCalled();
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(warningsOf(result)).toEqual([]);
    // The hosted-only twin of this case gets the local "not found" text, so this is the object itself.
    expect(textOf(result)).not.toMatch(/not found/i);
  });

  it.each(OWNED)('%s forwards the raw arguments upstream when the object is not local', async (tool, _owned, hostedOnly) => {
    const { ctx, upstream, localCall } = setup();
    const result = await executeToolCall(tool, hostedOnly, ctx);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).toHaveBeenCalledWith(tool, hostedOnly);
    expect(localCall).not.toHaveBeenCalled();
    // The hosted result comes back untouched, extra content items included.
    expect(result).toBe(HOSTED_ANSWER);
    expect(parsePayload(result).extras).toHaveLength(1);
  });

  it('matches the owner case-insensitively and sends the original casing nowhere', async () => {
    const { ctx, upstream } = setup();
    const result = await executeToolCall('get_enum_values', { enumName: 'contosostatus' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('ContosoStatus');
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('does not send defaults upstream: it forwards the arguments as the caller wrote them', async () => {
    const { ctx, upstream } = setup();
    await executeToolCall('get_enum_values', { enumName: 'NoYes', unknownKey: 1 }, ctx);
    expect(upstream.callTool).toHaveBeenCalledWith('get_enum_values', { enumName: 'NoYes', unknownKey: 1 });
  });

  it('looks for a method source in the object type that was asked for', async () => {
    const { ctx, upstream } = setup();
    // ContosoCustHelper is a Class; asking for a Table of that name is a miss.
    await executeToolCall('get_method_source', { objectName: 'ContosoCustHelper', objectType: 'Table', methodName: 'run' }, ctx);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
  });

  it('looks for a Chain of Command target among classes, tables and forms', async () => {
    const { ctx, upstream } = setup();
    const args = { targetClass: 'ContosoCustForm', extensionName: 'ContosoCustForm_Extension', methods: [{ name: 'init' }] };
    await executeToolCall('create_coc_extension', args, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('resolves a security object by its AOT type', async () => {
    const { ctx, upstream } = setup();
    // ContosoRole is a SecurityRole; asking for a Duty of that name is a miss.
    await executeToolCall('get_security_object', { type: 'Duty', name: 'ContosoRole' }, ctx);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
  });

  it('refuses a miss with a private name: nothing is sent, the local answer carries a warning', async () => {
    const { ctx, upstream } = setup({ privatePrefixes: ['Contoso'] });
    const result = await executeToolCall('get_enum_values', { enumName: 'ContosoMissing' }, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(upstream.isAvailable).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('not found');
    expect(warningsOf(result)).toEqual([expect.stringContaining('private prefix')]);
  });

  it('refuses a miss when a private name sits in another argument', async () => {
    const { ctx, upstream } = setup({ privatePrefixes: ['Contoso'] });
    const result = await executeToolCall(
      'create_table_extension',
      { targetTable: 'CustTable', extensionName: 'ContosoCustTableExt' },
      ctx
    );
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(warningsOf(result)).toHaveLength(1);
  });

  it('still forwards a miss whose names are not private', async () => {
    const { ctx, upstream } = setup({ privatePrefixes: ['Contoso'] });
    await executeToolCall('get_enum_values', { enumName: 'NoYes' }, ctx);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
  });

  it('degrades a miss to the local answer plus a warning when the hosted server is down', async () => {
    const { ctx, upstream } = setup();
    upstream.isAvailable.mockReturnValue(false);
    const result = await executeToolCall('get_enum_values', { enumName: 'NoYes' }, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('NoYes not found');
    expect(warningsOf(result)).toEqual([expect.stringMatching(/^hosted unavailable: /)]);
  });

  it('degrades the same way when the call throws, without leaking the reason verbatim', async () => {
    const { ctx, upstream } = setup();
    upstream.callTool.mockRejectedValue(
      new Error("connect ECONNREFUSED https://hosted.example.com/mcp, X-API-Key: sk-1234567890abcdef, file '/home/dev/secret/x.xml'")
    );
    const result = await executeToolCall('get_edt_details', { edtName: 'AccountNum' }, ctx);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toContain('AccountNum not found');
    const [warning] = warningsOf(result);
    expect(warning).toMatch(/^hosted unavailable: /);
    expect(warning).toContain('ECONNREFUSED');
    expect(warning).not.toMatch(/hosted\.example|sk-1234|\/home\/dev/);
  });

  it('checks inline source locally: it never leaves the machine, whatever object it names', async () => {
    // No private prefix and a source without a private name: only the source itself keeps the call at home.
    // (The object is not in the local index, so an owner lookup by name would go to the hosted server.)
    const { ctx, upstream } = setup();
    const result = await executeToolCall(
      'check_xpp_best_practices',
      { objectName: 'CustTable', source: 'class PricingJob { void run() { info("x"); } }' },
      ctx
    );
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).target).toEqual({ source: 'inline X++' });
  });

  it('answers check_xpp_best_practices locally when neither source nor object is given', async () => {
    const { ctx, upstream } = setup();
    const result = await executeToolCall('check_xpp_best_practices', {}, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('objectName');
  });

  it('turns invalid arguments into an error result before anything else happens', async () => {
    const { ctx, upstream, ensureFresh } = setup();
    const result = await executeToolCall('get_enum_values', { enumName: 7 }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid arguments for tool get_enum_values');
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(ensureFresh).not.toHaveBeenCalled();

    const missing = await executeToolCall('get_security_object', { type: 'Group', name: 'X' }, ctx);
    expect(missing.isError).toBe(true);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });
});

describe('merge tools', () => {
  const VALID_ARGS: Record<string, Record<string, unknown>> = {
    search_symbols: { query: 'Cust' },
    list_objects: {},
    list_packages: {},
    list_models: {},
    search_labels: { query: 'Hello' },
    search_labels_fts: { query: 'Hello' },
    resolve_label: { labelId: 'Contoso1' },
    resolve_label_by_language: { labelId: 'Contoso1' },
    get_table_schema: { tableName: 'CustTable' },
    get_class_hierarchy: { className: 'RunBase' },
    find_field_access: { table: 'CustTable', field: 'AccountNum' },
    find_references: { name: 'CustTable' },
    analyze_impact: { name: 'CustTable', type: 'Table' },
    find_usages: { name: 'CustTable' },
  };

  it.each(MERGE_TOOL_NAMES.map((name) => [name]))('%s is dispatched to its strategy', async (name) => {
    const { ctx } = setup();
    const answer = jsonResult([{ name: 'merged' }]);
    strategies[name as keyof typeof strategies].mockResolvedValue(answer);
    const result = await executeToolCall(name, VALID_ARGS[name], ctx);
    expect(result).toBe(answer);
    expect(strategies[name as keyof typeof strategies]).toHaveBeenCalledTimes(1);
  });

  it('passes the strategy parsed arguments, the context and the raw arguments, after refreshing the index', async () => {
    const { ctx, ensureFresh } = setup();
    const order: string[] = [];
    ensureFresh.mockImplementation(async () => {
      order.push('refresh');
    });
    strategies.search_symbols.mockImplementation(async () => {
      order.push('strategy');
      return jsonResult([]);
    });
    const raw = { query: '  Cust  ' };
    await executeToolCall('search_symbols', raw, ctx);

    expect(order).toEqual(['refresh', 'strategy']);
    const [args, strategyCtx, rawArgs] = strategies.search_symbols.mock.calls[0];
    expect(args).toEqual({ query: 'Cust', limit: 20, explain: false });
    expect(rawArgs).toBe(raw);
    expect(strategyCtx.local).toBe(ctx.local);
    expect(strategyCtx.localIndex).toBe(ctx.localIndex);
    expect(strategyCtx.privatePrefixes).toBe(ctx.privatePrefixes);
  });

  it('lets the strategy reach the hosted server with the raw arguments and keeps its extras', async () => {
    const { ctx, upstream } = setup();
    strategies.search_symbols.mockImplementation(async (_args, strategyCtx, raw) => {
      expect(strategyCtx.upstream.isAvailable()).toBe(true);
      const hosted = await strategyCtx.upstream.callTool('search_symbols', raw);
      const { extras } = parsePayload(hosted);
      return jsonResult([{ name: 'merged' }], extras);
    });
    const result = await executeToolCall('search_symbols', { query: 'Cust' }, ctx);
    expect(upstream.callTool).toHaveBeenCalledWith('search_symbols', { query: 'Cust' });
    expect(result.content).toHaveLength(2);
    expect(textOf(result)).toBe('[{"name":"merged"}]');
    expect(result.content[1]).toEqual(HOSTED_ANSWER.content[1]);
    expect(warningsOf(result)).toEqual([]);
  });

  it('rejects invalid arguments without running the strategy or going upstream', async () => {
    const { ctx, upstream, ensureFresh } = setup();
    const result = await executeToolCall('search_symbols', { limit: 1000 }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid arguments for tool search_symbols');
    expect(strategies.search_symbols).not.toHaveBeenCalled();
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(ensureFresh).not.toHaveBeenCalled();
  });

  describe('when the hosted server is unavailable', () => {
    it('shows the strategy a hosted side that is down and adds the warning', async () => {
      const { ctx, upstream } = setup();
      upstream.isAvailable.mockReturnValue(false);
      strategies.search_symbols.mockImplementation(async (_args, strategyCtx) => {
        expect(strategyCtx.upstream.isAvailable()).toBe(false);
        return jsonResult([{ name: 'ContosoCustTable', source: 'local' }]);
      });
      const result = await executeToolCall('search_symbols', { query: 'Contoso' }, ctx);
      expect(upstream.callTool).not.toHaveBeenCalled();
      expect(JSON.parse(textOf(result))).toEqual([{ name: 'ContosoCustTable', source: 'local' }]);
      expect(warningsOf(result)).toEqual([expect.stringMatching(/^hosted unavailable: /)]);
    });

    it('falls back to the plain local answer when the strategy tries the hosted server anyway', async () => {
      const { ctx, upstream } = setup();
      upstream.isAvailable.mockReturnValue(false);
      strategies.search_symbols.mockImplementation(async (_args, strategyCtx, raw) => strategyCtx.upstream.callTool('search_symbols', raw));
      const result = await executeToolCall('search_symbols', { query: 'ContosoCust' }, ctx);
      expect(upstream.callTool).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect((JSON.parse(textOf(result)) as { name: string }[]).map((row) => row.name)).toContain('ContosoCustTable');
      expect(warningsOf(result)).toEqual([expect.stringMatching(/^hosted unavailable: /)]);
    });

    it('falls back to the local answer when the hosted call throws, with a sanitized reason', async () => {
      const { ctx, upstream } = setup();
      upstream.callTool.mockRejectedValue(new Error("timeout talking to https://hosted.example.com/mcp with Bearer abc.def, '/home/dev/x'"));
      strategies.get_table_schema.mockImplementation(async (_args, strategyCtx, raw) => strategyCtx.upstream.callTool('get_table_schema', raw));
      const result = await executeToolCall('get_table_schema', { tableName: 'ContosoCustTable' }, ctx);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('AccountNum');
      const [warning] = warningsOf(result);
      expect(warning).toMatch(/^hosted unavailable: timeout talking to/);
      expect(warning).not.toMatch(/hosted\.example|abc\.def|\/home\/dev/);
    });

    it('answers a standard object that is not local with the local no-match text and a warning', async () => {
      const { ctx, upstream } = setup();
      upstream.isAvailable.mockReturnValue(false);
      strategies.get_table_schema.mockImplementation(async (_args, strategyCtx, raw) => strategyCtx.upstream.callTool('get_table_schema', raw));
      const result = await executeToolCall('get_table_schema', { tableName: 'CustTable' }, ctx);
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('Table CustTable not found');
      expect(warningsOf(result)).toHaveLength(1);
    });

    it('notices a failure the strategy swallowed', async () => {
      const { ctx, upstream } = setup();
      upstream.callTool.mockRejectedValue(new Error('socket hang up'));
      strategies.search_symbols.mockImplementation(async (_args, strategyCtx, raw) => {
        await strategyCtx.upstream.callTool('search_symbols', raw).catch(() => undefined);
        return jsonResult([{ name: 'local only' }]);
      });
      const result = await executeToolCall('search_symbols', { query: 'x' }, ctx);
      expect(textOf(result)).toBe('[{"name":"local only"}]');
      expect(warningsOf(result)).toEqual(['hosted unavailable: socket hang up']);
    });

    it('does not repeat a warning the strategy already gave', async () => {
      const { ctx, upstream } = setup();
      upstream.isAvailable.mockReturnValue(false);
      strategies.search_symbols.mockResolvedValue(jsonResult([], [], ['hosted unavailable: the strategy said so']));
      const result = await executeToolCall('search_symbols', { query: 'x' }, ctx);
      expect(warningsOf(result)).toEqual(['hosted unavailable: the strategy said so']);
      expect(result.content).toHaveLength(2);
    });

    it('stops calling the hosted server after its first failure', async () => {
      const { ctx, upstream } = setup();
      upstream.callTool.mockRejectedValue(new Error('timed out'));
      strategies.search_symbols.mockImplementation(async (_args, strategyCtx) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await strategyCtx.upstream.callTool('search_symbols', { query: 'x' }).catch(() => undefined);
        }
        return jsonResult([]);
      });
      await executeToolCall('search_symbols', { query: 'x' }, ctx);
      expect(upstream.callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('private names', () => {
    it('never sends anything upstream when the arguments carry a private name, and says so', async () => {
      const { ctx, upstream } = setup({ privatePrefixes: ['Contoso'] });
      strategies.search_symbols.mockImplementation(async (_args, strategyCtx, raw) => {
        expect(strategyCtx.upstream.isAvailable()).toBe(false);
        await expect(strategyCtx.upstream.callTool('search_symbols', raw)).rejects.toThrow();
        return jsonResult([{ name: 'ContosoCustTable', source: 'local' }]);
      });
      const result = await executeToolCall('search_symbols', { query: 'ContosoCust' }, ctx);
      expect(upstream.callTool).not.toHaveBeenCalled();
      expect(JSON.parse(textOf(result))).toEqual([{ name: 'ContosoCustTable', source: 'local' }]);
      expect(warningsOf(result)).toEqual([expect.stringContaining('private prefix')]);
    });

    it('returns the plain local results with the warning when the strategy cannot cope', async () => {
      const { ctx, upstream } = setup({ privatePrefixes: ['contoso'] });
      strategies.search_symbols.mockImplementation(async (_args, strategyCtx, raw) => strategyCtx.upstream.callTool('search_symbols', raw));
      const result = await executeToolCall('search_symbols', { query: 'ContosoCust' }, ctx);
      expect(upstream.callTool).not.toHaveBeenCalled();
      expect(result.isError).toBeFalsy();
      expect((JSON.parse(textOf(result)) as { name: string }[]).map((row) => row.name)).toContain('ContosoCustTable');
      expect(warningsOf(result)).toEqual([expect.stringContaining('private prefix')]);
    });

    it('also withholds a hosted call whose own arguments carry a private name, but allows clean ones', async () => {
      const { ctx, upstream } = setup({ privatePrefixes: ['Contoso'] });
      strategies.find_references.mockImplementation(async (_args, strategyCtx) => {
        await expect(strategyCtx.upstream.callTool('find_references', { name: 'ContosoCustTable' })).rejects.toThrow();
        const hosted = await strategyCtx.upstream.callTool('find_references', { name: 'CustTable' });
        return jsonResult({ hosted: parsePayload(hosted).json });
      });
      const result = await executeToolCall('find_references', { name: 'CustTable' }, ctx);
      expect(upstream.callTool).toHaveBeenCalledTimes(1);
      expect(upstream.callTool).toHaveBeenCalledWith('find_references', { name: 'CustTable' });
      expect(JSON.parse(textOf(result))).toEqual({ hosted: { hosted: true } });
      expect(warningsOf(result)).toEqual([expect.stringContaining('private prefix')]);
    });

    it('does not warn when no hosted call was withheld', async () => {
      const { ctx } = setup({ privatePrefixes: ['Contoso'] });
      strategies.search_symbols.mockResolvedValue(jsonResult([]));
      const result = await executeToolCall('search_symbols', { query: 'CustTable' }, ctx);
      expect(warningsOf(result)).toEqual([]);
    });
  });

  it('turns a failing strategy into the local answer with a merge warning', async () => {
    const { ctx, upstream } = setup();
    strategies.search_labels.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'rows') at /repo/src/x.ts:1"));
    const result = await executeToolCall('search_labels', { query: 'Hello' }, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Hello from Contoso');
    const [warning] = warningsOf(result);
    expect(warning).toMatch(/^merge failed: Cannot read properties/);
    expect(warning).not.toContain('/repo/src');
  });

  describe('version skew', () => {
    it('forwards a skewed merge tool as received and adds a warning', async () => {
      const { ctx, upstream, localCall } = setup({ skewedTools: new Set(['search_symbols']) });
      const raw = { query: 'Cust', newHostedOnlyOption: true };
      const result = await executeToolCall('search_symbols', raw, ctx);
      expect(upstream.callTool).toHaveBeenCalledWith('search_symbols', raw);
      expect(strategies.search_symbols).not.toHaveBeenCalled();
      expect(localCall).not.toHaveBeenCalled();
      expect(result.content.slice(0, 2)).toEqual(HOSTED_ANSWER.content);
      expect(warningsOf(result)).toEqual([expect.stringContaining('search_symbols')]);
    });

    it('treats a skewed tool as forward-only: no hosted server, an error; private name, an error', async () => {
      const { ctx, upstream } = setup({ skewedTools: new Set(['search_symbols']), privatePrefixes: ['Contoso'] });
      const blocked = await executeToolCall('search_symbols', { query: 'ContosoCust' }, ctx);
      expect(blocked.isError).toBe(true);
      expect(upstream.callTool).not.toHaveBeenCalled();

      upstream.isAvailable.mockReturnValue(false);
      const down = await executeToolCall('search_symbols', { query: 'Cust' }, ctx);
      expect(down.isError).toBe(true);
      expect(textOf(down)).toMatch(/^hosted server unavailable: /);
      expect(warningsOf(down)).toEqual([]);
      expect(strategies.search_symbols).not.toHaveBeenCalled();
    });

    it('leaves the other merge tools merged', async () => {
      const { ctx } = setup({ skewedTools: new Set(['search_symbols']) });
      strategies.list_models.mockResolvedValue(jsonResult([]));
      await executeToolCall('list_models', {}, ctx);
      expect(strategies.list_models).toHaveBeenCalledTimes(1);
    });
  });
});

describe('forward-only tools', () => {
  it('forwards unchanged and returns the hosted result as it is', async () => {
    const { ctx, upstream, ensureFresh, localCall } = setup();
    const raw = { anything: ['goes', { here: 1 }] };
    const result = await executeToolCall('get_index_stats', raw, ctx);
    expect(upstream.callTool).toHaveBeenCalledWith('get_index_stats', raw);
    expect(result).toBe(HOSTED_ANSWER);
    expect(ensureFresh).not.toHaveBeenCalled();
    expect(localCall).not.toHaveBeenCalled();
  });

  it('forwards a call without arguments as an empty object', async () => {
    const { ctx, upstream } = setup();
    await executeToolCall('get_index_stats', undefined, ctx);
    expect(upstream.callTool).toHaveBeenCalledWith('get_index_stats', {});
  });

  it('forwards tools nobody here knows, even ones named like Object members', async () => {
    const { ctx, upstream } = setup();
    for (const name of ['list_trace_sessions', 'constructor', '__proto__', 'toString']) {
      await executeToolCall(name, {}, ctx);
      expect(upstream.callTool).toHaveBeenLastCalledWith(name, {});
    }
    expect(upstream.callTool).toHaveBeenCalledTimes(4);
  });

  it('refuses to send a private name, in any argument, and says why', async () => {
    const { ctx, upstream } = setup({ privatePrefixes: ['Contoso', 'ZZ'] });
    for (const args of [{ className: 'ContosoFoo' }, { nested: { list: [{ x: 'see zz_helper' }] } }]) {
      const result = await executeToolCall('generate_xpp_class', args, ctx);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('D365_GATEWAY_PRIVATE_PREFIXES');
      expect(textOf(result)).not.toContain('ContosoFoo');
    }
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(upstream.isAvailable).not.toHaveBeenCalled();
  });

  it('returns an error when the hosted server is unavailable, without calling it', async () => {
    const { ctx, upstream } = setup();
    upstream.isAvailable.mockReturnValue(false);
    const result = await executeToolCall('get_index_stats', {}, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^hosted server unavailable: /);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('returns a sanitized error when the call throws', async () => {
    const { ctx, upstream } = setup();
    upstream.callTool.mockRejectedValue(new Error("fetch failed: https://hosted.example.com/mcp?key=secret at '/home/dev/x/y.js'"));
    const result = await executeToolCall('get_index_stats', {}, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^hosted server unavailable: fetch failed/);
    expect(textOf(result)).not.toMatch(/hosted\.example|secret|\/home\/dev/);
  });

  it('says a refused call was refused, not that the server is down', async () => {
    const { ctx, upstream } = setup();
    upstream.callTool.mockRejectedValue(new McpError(ErrorCode.InvalidParams, 'Tool nope not found'));
    const refused = await executeToolCall('nope', {}, ctx);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe('hosted server rejected the call: Tool nope not found');

    upstream.callTool.mockRejectedValue(new McpError(ErrorCode.RequestTimeout, 'Request timed out'));
    const timedOut = await executeToolCall('get_index_stats', {}, ctx);
    expect(textOf(timedOut)).toMatch(/^hosted server unavailable: /);
  });

  it('passes an error result of the hosted tool through untouched', async () => {
    const { ctx, upstream } = setup();
    const failed = errorResult('Input validation error: bad');
    upstream.callTool.mockResolvedValue(failed);
    expect(await executeToolCall('get_index_stats', {}, ctx)).toBe(failed);
  });
});

describe('never throws', () => {
  it('turns a failing index refresh into a short error result', async () => {
    const { ctx, upstream, ensureFresh } = setup();
    ensureFresh.mockRejectedValue(new Error('EACCES: permission denied, open /home/dev/secret-project/CustomModels/x.db'));
    for (const [name, args] of [
      ['local_index_status', {}],
      ['get_enum_values', { enumName: 'ContosoStatus' }],
      ['search_symbols', { query: 'x' }],
    ] as const) {
      const result = await executeToolCall(name, args, ctx);
      expect(result.isError, name).toBe(true);
      expect(textOf(result)).toContain('could not complete');
      expect(textOf(result)).not.toContain('/home/dev');
    }
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('turns a throwing local handler into an error result', async () => {
    const { ctx, localCall } = setup();
    localCall.mockRejectedValue(new Error('database is closed'));
    const result = await executeToolCall('get_enum_values', { enumName: 'ContosoStatus' }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('database is closed');
  });

  it('survives arguments that are not an object', async () => {
    const { ctx, upstream } = setup();
    const result = await executeToolCall('get_index_stats', 'oops' as unknown as Record<string, unknown>, ctx);
    expect(result).toBe(HOSTED_ANSWER);
    expect(upstream.callTool).toHaveBeenCalledWith('get_index_stats', {});
  });
});

describe('computeSkewedTools', () => {
  const hostedTool = (name: string, properties: Record<string, object>): Tool => ({
    name,
    inputSchema: { type: 'object', properties },
  });

  /** The properties the gateway itself advertises for a tool, which a hosted server of the same version advertises too. */
  const localProperties = (local: LocalTools, name: string): Record<string, object> =>
    (local.definitions().find((definition) => definition.name === name)?.inputSchema.properties ?? {}) as Record<string, object>;

  it('is empty when the hosted schemas have the same keys as the local ones', () => {
    const { ctx } = setup();
    const hosted = new Map(ctx.local.definitions().map((definition) => [definition.name, definition as Tool]));
    expect(computeSkewedTools(hosted, ctx.local, [...MERGE_TOOL_NAMES])).toEqual(new Set());
  });

  it('flags a tool whose hosted schema has an extra, missing or renamed property', () => {
    const { ctx } = setup();
    const hosted = new Map<string, Tool>([
      ['search_symbols', hostedTool('search_symbols', { query: {}, type: {}, limit: {}, explain: {}, scope: {} })],
      ['search_labels', hostedTool('search_labels', { query: {}, language: {} })],
      ['resolve_label', hostedTool('resolve_label', { id: {} })],
      ['list_models', hostedTool('list_models', {})],
    ]);
    expect(computeSkewedTools(hosted, ctx.local, ['search_symbols', 'search_labels', 'resolve_label', 'list_models'])).toEqual(
      new Set(['search_symbols', 'search_labels', 'resolve_label'])
    );
  });

  it('ignores key order, a hosted tool without properties, tools the hosted server lacks and tools unknown locally', () => {
    const { ctx } = setup();
    const properties = localProperties(ctx.local, 'search_symbols');
    const hosted = new Map<string, Tool>([
      ['search_symbols', hostedTool('search_symbols', Object.fromEntries(Object.entries(properties).reverse()))],
      ['list_packages', { name: 'list_packages', inputSchema: { type: 'object' } }],
      ['no_such_local_tool', hostedTool('no_such_local_tool', { a: {} })],
    ]);
    const names = ['search_symbols', 'list_packages', 'get_table_schema', 'no_such_local_tool'];
    expect(computeSkewedTools(hosted, ctx.local, names)).toEqual(new Set());
    expect(computeSkewedTools(new Map(), ctx.local, names)).toEqual(new Set());
  });

  it('flags a tool whose hosted property accepts other enum members or another numeric range', () => {
    const { ctx } = setup();
    const properties = localProperties(ctx.local, 'search_symbols') as Record<string, { enum: string[]; maximum: number; minimum: number }>;
    const skewedBy = (change: Record<string, object>) =>
      computeSkewedTools(new Map([['search_symbols', hostedTool('search_symbols', { ...properties, ...change })]]), ctx.local, ['search_symbols']);

    // A hosted server of the same version that added an object type: the gateway would reject it before asking.
    expect(skewedBy({ type: { ...properties.type, enum: [...properties.type.enum, 'NewObjectType'] } })).toEqual(new Set(['search_symbols']));
    expect(skewedBy({ type: { ...properties.type, enum: properties.type.enum.slice(1) } })).toEqual(new Set(['search_symbols']));
    expect(skewedBy({ type: { type: 'string' } })).toEqual(new Set(['search_symbols']));
    expect(skewedBy({ limit: { ...properties.limit, maximum: properties.limit.maximum + 100 } })).toEqual(new Set(['search_symbols']));
    expect(skewedBy({ limit: { ...properties.limit, minimum: 0 } })).toEqual(new Set(['search_symbols']));
    // Wording, defaults and the order of the members are not part of what the tool accepts.
    expect(skewedBy({ type: { ...properties.type, description: 'Other words.', enum: [...properties.type.enum].reverse() } })).toEqual(new Set());
    expect(skewedBy({ limit: { ...properties.limit, default: 50, description: 'Other words.' } })).toEqual(new Set());
  });
});
