import { describe, it, expect, vi, type Mock } from 'vitest';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from '../src/indexer/db.js';
import { getTableExtensions } from '../src/indexer/db.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import { parsePayload, warningsOf, type ContentItem } from '../src/gateway/merge.js';
import { objectStrategies } from '../src/gateway/strategies/objects.js';
import type { GatewayWorkspaceConfig, LocalIndex, RouteContext, UpstreamPort } from '../src/gateway/types.js';
import { seedDb, type SeedObject } from './helpers/toolHarness.js';

const workspace: GatewayWorkspaceConfig = {
  workspaceDir: '',
  customMetadataDir: '/dev/null/CustomModels',
  targetProject: '',
  targetPackage: '',
  targetModel: '',
  targetSolution: '',
};

const KNOWLEDGE: ContentItem = { type: 'text', text: '{"knowledge":{"hints":["use find_usages for call sites"]}}' };

type FakeUpstream = UpstreamPort & { callTool: Mock<UpstreamPort['callTool']> };

function localIndexOf(db: Database): LocalIndex {
  return {
    db,
    customDir: workspace.customMetadataDir,
    ensureFresh: async () => {},
    markDirty: () => {},
    status: () => ({
      customDirName: 'CustomModels',
      objects: 0,
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
}

/**
 * The hosted server: the real tool handlers over a database of standard objects, so the canned answers have
 * exactly the shapes the original tools print. `extras` are appended like the hosted knowledge filter does.
 */
function hostedServer(db: Database, extras: ContentItem[] = []): FakeUpstream {
  const tools = captureLocalTools(db, localIndexOf(db), workspace);
  return {
    isAvailable: () => true,
    listTools: async () => [],
    serverVersion: '1.0.0',
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => {
      const result = await tools.call(name, args);
      return extras.length > 0 ? { ...result, content: [...result.content, ...extras] } : result;
    }),
  };
}

/** A hosted server that answers every call with the given result, or fails it. */
function cannedUpstream(answer: CallToolResult | Error): FakeUpstream {
  return {
    isAvailable: () => true,
    listTools: async () => [],
    serverVersion: '1.0.0',
    callTool: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
}

const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });

const timeout = () => new McpError(ErrorCode.RequestTimeout, 'Request timed out');

function contextFor(localDb: Database, upstream: UpstreamPort): RouteContext {
  const localIndex = localIndexOf(localDb);
  return {
    local: captureLocalTools(localDb, localIndex, workspace),
    localIndex,
    upstream,
    hostedTools: new Map(),
    privatePrefixes: [],
    skewedTools: new Set(),
  };
}

/** Runs a strategy the way the router does: parsed args with defaults for the strategy, the caller's raw args for upstream. */
function run(tool: string, raw: Record<string, unknown>, ctx: RouteContext): Promise<CallToolResult> {
  return objectStrategies[tool](ctx.local.parseArgs(tool, raw), ctx, raw);
}

/** The result's JSON payload, loosely typed: the assertions below spell out the parts they look at. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

const payloadOf = (result: CallToolResult): Payload => {
  const { json } = parsePayload(result);
  if (typeof json !== 'object' || json === null) throw new Error(`Expected a JSON object, got: ${parsePayload(result).text}`);
  return json as Payload;
};

const textOf = (result: CallToolResult): string => parsePayload(result).text;

function addXrefs(db: Database, rows: [fromType: string, fromName: string, toType: string, toName: string, kind: string][]) {
  const insert = db.prepare('INSERT INTO ax_xref (from_type, from_name, to_type, to_name, xref_kind) VALUES (?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(...row);
}

const method = (name: string, source: string) => `<Method><Name>${name}</Name><Source><![CDATA[\n${source}\n]]></Source></Method>`;

function axClass(name: string, methods: Record<string, string>): string {
  const body = Object.entries(methods)
    .map(([methodName, source]) => method(methodName, source))
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name>
<SourceCode><Declaration><![CDATA[\nclass ${name}\n{\n}\n]]></Declaration><Methods>${body}</Methods></SourceCode></AxClass>`;
}

const repeat = (count: number, line: string) => Array.from({ length: count }, () => line).join('\n    ');

const standardField = (name: string) => ({ name, type: 'AxTableFieldString', edt: name });

/** Standard objects as the hosted server indexes them. */
function hostedDb(extra: SeedObject[] = []): Database {
  const db = seedDb([
    {
      type: 'Table',
      name: 'CustTable',
      package: 'ApplicationSuite',
      model: 'Application Suite',
      fields: [standardField('AccountNum'), standardField('CreditMax'), standardField('Name')],
      methods: [{ name: 'find', accessModifier: 'Public', returnType: 'CustTable', isStatic: true }],
    },
    { type: 'Class', name: 'SalesFormLetter', package: 'ApplicationSuite', methods: [{ name: 'run', accessModifier: 'Public', returnType: 'void' }] },
    { type: 'Class', name: 'SalesFormLetterConfirm', package: 'ApplicationSuite' },
    { type: 'Class', name: 'SalesFormLetterInvoice', package: 'ApplicationSuite' },
    { type: 'Form', name: 'CustTableForm', package: 'ApplicationSuite' },
    { type: 'Query', name: 'CustTransQuery', package: 'ApplicationSuite' },
    {
      type: 'Class',
      name: 'CustPost',
      package: 'ApplicationSuite',
      raw_xml: axClass('CustPost', {
        post: 'void post()\n{\n    CustTable custTable;\n    custTable.CreditMax = 0;\n    if (custTable.CreditMax > 10)\n    {\n        info("big");\n    }\n}',
      }),
    },
    ...extra,
  ]);
  addXrefs(db, [
    ['Form', 'CustTableForm', 'Table', 'CustTable', 'datasource'],
    ['Query', 'CustTransQuery', 'Table', 'CustTable', 'datasource'],
    ['Class', 'SalesFormLetterConfirm', 'Class', 'SalesFormLetter', 'extends'],
    ['Class', 'SalesFormLetterInvoice', 'Class', 'SalesFormLetter', 'extends'],
  ]);
  return db;
}

/** Custom models: extensions of a standard table, a subclass of a standard class, a custom table and class tree, custom X++. */
function localDb(extra: SeedObject[] = []): Database {
  const db = seedDb([
    {
      type: 'TableExtension',
      name: 'CustTable.Contoso',
      package: 'ContosoExt',
      model: 'ContosoModel',
      fields: [standardField('ContosoRating'), { name: 'ContosoFlag', type: 'AxTableFieldEnum', edt: 'NoYesId' }],
    },
    { type: 'TableExtension', name: 'CustTable.Fabrikam', package: 'FabrikamExt', model: 'FabrikamModel', fields: [standardField('FabrikamNote')] },
    { type: 'TableExtension', name: 'SalesTable.Contoso', package: 'ContosoExt', model: 'ContosoModel', fields: [standardField('SalesNote')] },
    { type: 'TableExtension', name: 'CustTableX.Contoso', package: 'ContosoExt', model: 'ContosoModel', fields: [standardField('NotMine')] },
    { type: 'Table', name: 'ContosoCustTable', package: 'ContosoExt', model: 'ContosoModel', fields: [standardField('ContosoAccount')] },
    { type: 'Class', name: 'ContosoBase', package: 'ContosoExt', model: 'ContosoModel' },
    { type: 'Class', name: 'ContosoChild', package: 'ContosoExt', model: 'ContosoModel' },
    { type: 'Class', name: 'ContosoSalesLetter', package: 'ContosoExt', model: 'ContosoModel' },
    {
      type: 'Class',
      name: 'ContosoCustJob',
      package: 'ContosoExt',
      model: 'ContosoModel',
      raw_xml: axClass('ContosoCustJob', {
        run: "void run()\n{\n    CustTable custTable;\n    custTable.CreditMax = 500;\n    info(strFmt('%1', custTable.CreditMax));\n    custTable.ContosoRating = 'A';\n}",
      }),
    },
    ...extra,
  ]);
  addXrefs(db, [
    ['TableExtension', 'CustTable.Contoso', 'Table', 'CustTable', 'extends'],
    ['TableExtension', 'CustTable.Fabrikam', 'Table', 'CustTable', 'extends'],
    ['Form', 'ContosoCustForm', 'Table', 'CustTable', 'datasource'],
    ['Class', 'ContosoSalesLetter', 'Class', 'SalesFormLetter', 'extends'],
    ['Class', 'ContosoChild', 'Class', 'ContosoBase', 'extends'],
  ]);
  return db;
}

/** A local index whose objects were stored without their XML (D365_INDEX_STORE_RAW_XML=false), so no source can be searched. */
function withoutRawXml(db: Database): Database {
  db.exec('UPDATE ax_objects SET raw_xml = NULL');
  return db;
}

describe('getTableExtensions', () => {
  it('lists the extensions of one table with package, model and fields, and nothing from similar names', () => {
    const extensions = getTableExtensions(localDb(), 'custtable');
    expect(extensions.map((extension) => extension.name)).toEqual(['CustTable.Contoso', 'CustTable.Fabrikam']);
    expect(extensions[0]).toMatchObject({ package: 'ContosoExt', model: 'ContosoModel' });
    expect(extensions[0].fields.map((field) => field.name)).toEqual(['ContosoRating', 'ContosoFlag']);
    expect(getTableExtensions(localDb(), 'Cust_able')).toEqual([]);
    expect(getTableExtensions(localDb(), 'NoSuchTable')).toEqual([]);
  });
});

describe('get_table_schema', () => {
  it('adds local table extensions and local references to the hosted table, tagged by side', async () => {
    const upstream = hostedServer(hostedDb(), [KNOWLEDGE]);
    const ctx = contextFor(localDb(), upstream);
    // lower case on purpose: the hosted server resolves the name, and the strategy uses the name it answers with
    const result = await run('get_table_schema', { tableName: 'custtable' }, ctx);
    const table = payloadOf(result);

    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).toHaveBeenCalledWith('get_table_schema', { tableName: 'custtable' });
    expect(table).toMatchObject({ type: 'Table', name: 'CustTable', package: 'ApplicationSuite' });
    expect(table.fields.map((field: { name: string }) => field.name)).toEqual(['AccountNum', 'CreditMax', 'Name']);
    expect(table.methods.map((m: { name: string }) => m.name)).toEqual(['find']);

    expect(table.localExtensions.map((extension: { name: string }) => extension.name)).toEqual(['CustTable.Contoso', 'CustTable.Fabrikam']);
    const [contoso] = table.localExtensions;
    expect(contoso).toMatchObject({ package: 'ContosoExt', model: 'ContosoModel', source: 'local' });
    expect(contoso.fields.map((field: { name: string }) => field.name)).toEqual(['ContosoRating', 'ContosoFlag']);
    expect(contoso.fields[0]).toMatchObject({ type: 'AxTableFieldString', edt: 'ContosoRating' });
    expect(contoso.fields[0]).not.toHaveProperty('id');
    expect(contoso.fields[0]).not.toHaveProperty('object_id');

    const bySource = (source: string) => table.xrefs.filter((row: { source: string }) => row.source === source).map((row: { from_name: string }) => row.from_name);
    // within a side the rows keep the order the index gave them
    expect(bySource('hosted')).toEqual(['CustTableForm', 'CustTransQuery']);
    expect(bySource('local').sort()).toEqual(['ContosoCustForm', 'CustTable.Contoso', 'CustTable.Fabrikam']);
    expect(table.xrefs.map((row: { source: string }) => row.source)).toEqual(['hosted', 'hosted', 'local', 'local', 'local']);
    expect(table.xrefs.filter((row: { source: string }) => row.source === 'local').every((row: object) => !('id' in row))).toBe(true);
    expect(table.xrefs.filter((row: { source: string }) => row.source === 'hosted').every((row: object) => 'id' in row)).toBe(true);
    expect(table.truncated).toBeUndefined();

    expect(result.content[1]).toEqual(KNOWLEDGE);
    expect(warningsOf(result)).toEqual([]);
  });

  it('removes a hosted reference that a local one repeats and says the local row hides it', async () => {
    const hosted = hostedDb();
    addXrefs(hosted, [['Form', 'ContosoCustForm', 'Table', 'CustTable', 'datasource']]);
    const result = await run('get_table_schema', { tableName: 'CustTable' }, contextFor(localDb(), hostedServer(hosted)));
    const same = payloadOf(result).xrefs.filter((row: { from_name: string }) => row.from_name === 'ContosoCustForm');
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ source: 'local', shadowedHosted: true });
  });

  it('keeps the identical references the hosted index holds several times', async () => {
    // Two data sources of one form on the same table: two `datasource` rows, as the original tool lists them.
    const hosted = hostedDb();
    addXrefs(hosted, [['Form', 'CustTableForm', 'Table', 'CustTable', 'datasource']]);
    const result = await run('get_table_schema', { tableName: 'CustTable' }, contextFor(seedDb([]), hostedServer(hosted)));
    const forms = payloadOf(result).xrefs.filter((row: { from_name: string }) => row.from_name === 'CustTableForm');
    expect(forms).toHaveLength(2);
    expect(forms.every((row: { source: string }) => row.source === 'hosted')).toBe(true);
  });

  it('keeps local rows when xrefLimit cuts the list and reports only the maxItems cut under truncated', async () => {
    const hosted = hostedDb();
    addXrefs(hosted, Array.from({ length: 28 }, (_, i): [string, string, string, string, string] => ['Form', `HostedForm${i}`, 'Table', 'CustTable', 'datasource']));
    const customForms = Array.from({ length: 12 }, (_, i): [string, string, string, string, string] => ['Form', `ContosoForm${i}`, 'Table', 'CustTable', 'datasource']);
    const local = localDb();
    addXrefs(local, customForms);

    // xrefLimit is a silent query limit in the original tool: 5 rows, local ones first in line to stay
    const limited = payloadOf(await run('get_table_schema', { tableName: 'CustTable', xrefLimit: 5 }, contextFor(local, hostedServer(hosted))));
    expect(limited.xrefs).toHaveLength(5);
    expect(limited.xrefs.every((row: { source: string }) => row.source === 'local')).toBe(true);
    expect(limited.truncated).toBeUndefined();

    // hosted cut its own list at maxItems=10 (30 refs -> 10, truncated.xrefs 10 of 30); the merged list is cut again
    const capped = payloadOf(await run('get_table_schema', { tableName: 'CustTable', maxItems: 10 }, contextFor(local, hostedServer(hosted))));
    expect(capped.xrefs).toHaveLength(10);
    expect(capped.xrefs.every((row: { source: string }) => row.source === 'local')).toBe(true);
    // 30 hosted + 3 local extensions/forms + 12 custom forms, limited to xrefLimit 100
    expect(capped.truncated.xrefs).toEqual({ returned: 10, total: 45 });
    // truncation the hosted server reported for other lists stays
    expect(capped.truncated.fields).toBeUndefined();
    expect(capped.localExtensions).toHaveLength(2);
  });

  it('keeps what the hosted server clipped from other lists', async () => {
    const hosted = hostedDb();
    hosted.exec(`INSERT INTO ax_fields (object_id, name) SELECT id, 'F' || n FROM ax_objects, (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 12) SELECT n FROM c) WHERE type = 'Table' AND name = 'CustTable'`);
    const table = payloadOf(await run('get_table_schema', { tableName: 'CustTable', maxItems: 10 }, contextFor(localDb(), hostedServer(hosted))));
    expect(table.truncated).toEqual({ fields: { returned: 10, total: 15 } });
    expect(table.fields).toHaveLength(10);
  });

  it('answers a table of the local index locally and sends nothing upstream', async () => {
    const upstream = hostedServer(hostedDb());
    const ctx = contextFor(localDb(), upstream);
    const result = await run('get_table_schema', { tableName: 'contosocusttable' }, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(payloadOf(result)).toMatchObject({ type: 'Table', name: 'ContosoCustTable' });
    expect(result).toEqual(await ctx.local.call('get_table_schema', { tableName: 'contosocusttable' }));
    expect(payloadOf(result).localExtensions).toBeUndefined();
  });

  it('returns the hosted not-found text when neither side knows the table', async () => {
    const upstream = hostedServer(hostedDb());
    const result = await run('get_table_schema', { tableName: 'NoSuchTable' }, contextFor(localDb(), upstream));
    expect(textOf(result)).toMatch(/^Table NoSuchTable not found\./);
    expect(result.isError).toBeUndefined();
    expect(warningsOf(result)).toEqual([]);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);
  });

  it('passes a hosted tool error through when there is nothing local to add', async () => {
    const error = textResult('Input validation error: Invalid arguments for tool get_table_schema', true);
    const result = await run('get_table_schema', { tableName: 'NoSuchTable' }, contextFor(localDb(), cannedUpstream(error)));
    expect(result).toEqual(error);
  });

  it('shows only the local extensions and references when the hosted server does not know the table', async () => {
    const hosted = hostedServer(seedDb([]), [KNOWLEDGE]);
    const result = await run('get_table_schema', { tableName: 'CustTable' }, contextFor(localDb(), hosted));
    const table = payloadOf(result);
    expect(table).toMatchObject({ name: 'CustTable', type: 'Table' });
    expect(table.notes[0]).toContain('not available from the hosted server');
    expect(table.fields).toBeUndefined();
    expect(table.localExtensions.map((extension: { name: string }) => extension.name)).toEqual(['CustTable.Contoso', 'CustTable.Fabrikam']);
    expect(table.xrefs.map((row: { from_name: string }) => row.from_name).sort()).toEqual(['ContosoCustForm', 'CustTable.Contoso', 'CustTable.Fabrikam']);
    // "not found" is an answer, not a failure; the hosted extras only follow a payload that came from the hosted side
    expect(warningsOf(result)).toEqual([]);
  });

  it('gives the local extensions and a warning when the hosted server is down', async () => {
    const result = await run('get_table_schema', { tableName: 'CustTable' }, contextFor(localDb(), cannedUpstream(timeout())));
    const table = payloadOf(result);
    expect(table.localExtensions).toHaveLength(2);
    expect(table.xrefs.every((row: { source: string }) => row.source === 'local')).toBe(true);
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });

  it('gives the local not-found answer and a warning when the hosted server is down and nothing local matches', async () => {
    const result = await run('get_table_schema', { tableName: 'ContosoCustTabel' }, contextFor(localDb(), cannedUpstream(timeout())));
    expect(textOf(result)).toContain('Table ContosoCustTabel not found.');
    expect(textOf(result)).toContain('ContosoCustTable');
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });

  it('keeps a withheld-call warning of the router as it is', async () => {
    const withheld = 'hosted lookup skipped: the arguments contain a name with a private prefix (D365_GATEWAY_PRIVATE_PREFIXES), so nothing was sent to the hosted server; these are local results only';
    const result = await run('get_table_schema', { tableName: 'CustTable' }, contextFor(localDb(), cannedUpstream(new Error(withheld))));
    expect(warningsOf(result)).toEqual([withheld]);
  });

  it('reports a hosted tool error as a warning when local data is added', async () => {
    const error = textResult('Internal error while reading the index', true);
    const result = await run('get_table_schema', { tableName: 'CustTable' }, contextFor(localDb(), cannedUpstream(error)));
    expect(payloadOf(result).localExtensions).toHaveLength(2);
    expect(warningsOf(result)).toEqual(['hosted unavailable: Internal error while reading the index']);
  });

  it('adds an empty localExtensions list for a standard table without custom extensions', async () => {
    const table = payloadOf(await run('get_table_schema', { tableName: 'CustTable' }, contextFor(seedDb([]), hostedServer(hostedDb()))));
    expect(table.localExtensions).toEqual([]);
    expect(table.xrefs).toHaveLength(2);
  });
});

describe('get_class_hierarchy', () => {
  it('appends the local subclasses to the hosted ones, tagged by side', async () => {
    const upstream = hostedServer(hostedDb(), [KNOWLEDGE]);
    const result = await run('get_class_hierarchy', { className: 'salesformletter' }, contextFor(localDb(), upstream));
    const hierarchy = payloadOf(result);
    expect(upstream.callTool).toHaveBeenCalledWith('get_class_hierarchy', { className: 'salesformletter' });
    expect(hierarchy.class).toBe('SalesFormLetter');
    expect(hierarchy.children.map((row: { from_name: string; source: string }) => `${row.source}:${row.from_name}`)).toEqual([
      'hosted:SalesFormLetterConfirm',
      'hosted:SalesFormLetterInvoice',
      'local:ContosoSalesLetter',
    ]);
    expect(hierarchy.children[2]).not.toHaveProperty('id');
    expect(hierarchy.children[0]).toHaveProperty('id');
    expect(result.content[1]).toEqual(KNOWLEDGE);
    expect(warningsOf(result)).toEqual([]);
  });

  it('removes a repeated subclass, keeping the local row', async () => {
    const hosted = hostedDb();
    addXrefs(hosted, [['Class', 'ContosoSalesLetter', 'Class', 'SalesFormLetter', 'extends']]);
    const children = payloadOf(await run('get_class_hierarchy', { className: 'SalesFormLetter' }, contextFor(localDb(), hostedServer(hosted)))).children;
    const same = children.filter((row: { from_name: string }) => row.from_name === 'ContosoSalesLetter');
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ source: 'local', shadowedHosted: true });
    expect(children).toHaveLength(3);
  });

  it('limits to childLimit but keeps the local subclasses', async () => {
    const local = localDb();
    addXrefs(local, [['Class', 'ContosoOtherLetter', 'Class', 'SalesFormLetter', 'extends']]);
    const result = await run('get_class_hierarchy', { className: 'SalesFormLetter', childLimit: 3 }, contextFor(local, hostedServer(hostedDb())));
    // the hosted server returns 3 (its own limit), 2 local ones follow: the hosted tail makes room
    expect(payloadOf(result).children.map((row: { from_name: string }) => row.from_name)).toEqual([
      'SalesFormLetterConfirm',
      'ContosoSalesLetter',
      'ContosoOtherLetter',
    ]);
    const single = await run('get_class_hierarchy', { className: 'SalesFormLetter', childLimit: 1 }, contextFor(local, hostedServer(hostedDb())));
    expect(payloadOf(single).children).toHaveLength(1);
    expect(payloadOf(single).children[0].source).toBe('local');
  });

  it('answers a class of the local index locally and sends nothing upstream', async () => {
    const upstream = hostedServer(hostedDb());
    const ctx = contextFor(localDb(), upstream);
    const result = await run('get_class_hierarchy', { className: 'ContosoBase' }, ctx);
    expect(upstream.callTool).not.toHaveBeenCalled();
    expect(payloadOf(result)).toMatchObject({ class: 'ContosoBase', children: [{ from_name: 'ContosoChild' }] });
    expect(result).toEqual(await ctx.local.call('get_class_hierarchy', { className: 'ContosoBase' }));
  });

  it('returns the hosted not-found text when neither side knows the class', async () => {
    const result = await run('get_class_hierarchy', { className: 'NoSuchClass' }, contextFor(localDb(), hostedServer(hostedDb())));
    expect(textOf(result)).toMatch(/^Class NoSuchClass not found\./);
    expect(warningsOf(result)).toEqual([]);
  });

  it('shows the local subclasses of a class the hosted server does not know', async () => {
    const result = await run('get_class_hierarchy', { className: 'SalesFormLetter' }, contextFor(localDb(), hostedServer(seedDb([]))));
    const hierarchy = payloadOf(result);
    expect(hierarchy.class).toBe('SalesFormLetter');
    expect(hierarchy.children).toMatchObject([{ from_name: 'ContosoSalesLetter', source: 'local' }]);
    expect(hierarchy.notes[0]).toContain('not available from the hosted server');
  });

  it('gives the local subclasses and a warning when the hosted server is down', async () => {
    const result = await run('get_class_hierarchy', { className: 'SalesFormLetter' }, contextFor(localDb(), cannedUpstream(timeout())));
    expect(payloadOf(result).children).toMatchObject([{ from_name: 'ContosoSalesLetter', source: 'local' }]);
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });

  it('gives the local not-found answer and a warning when the hosted server is down and nothing local matches', async () => {
    const result = await run('get_class_hierarchy', { className: 'SalesFormLetterX' }, contextFor(localDb(), cannedUpstream(timeout())));
    expect(textOf(result)).toContain('Class SalesFormLetterX not found.');
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });
});

describe('find_field_access', () => {
  const args = { table: 'CustTable', field: 'CreditMax' };

  it('joins the hosted and local scans: counts, methods, accesses and notes', async () => {
    const upstream = hostedServer(hostedDb(), [KNOWLEDGE]);
    const result = await run('find_field_access', args, contextFor(localDb(), upstream));
    const report = payloadOf(result);

    expect(upstream.callTool).toHaveBeenCalledTimes(1);
    expect(upstream.callTool).toHaveBeenCalledWith('find_field_access', args);
    expect(report).toMatchObject({
      table: 'CustTable',
      field: 'CreditMax',
      fieldIndexed: true,
      scannedObjects: 2,
      narrowedByUsageSnapshot: false,
      summary: { writes: 2, reads: 2, methods: 2 },
    });
    expect(report.attribution).toContain('TRUDUtilsD365');

    // local first, then hosted; each access says where it came from
    expect(report.accesses.map((a: { source: string; object: string; method: string; access: string }) => `${a.source}:${a.object}.${a.method}:${a.access}`)).toEqual([
      'local:ContosoCustJob.run:Write',
      'local:ContosoCustJob.run:Read',
      'hosted:CustPost.post:Write',
      'hosted:CustPost.post:Read',
    ]);
    expect(report.byMethod).toEqual([
      { objectType: 'Class', object: 'ContosoCustJob', method: 'run', reads: 1, writes: 1, source: 'local' },
      { objectType: 'Class', object: 'CustPost', method: 'post', reads: 1, writes: 1, source: 'hosted' },
    ]);

    // the local scan alone would say the (standard) table is not indexed; the hosted index knows it
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toContain('Static text heuristic');
    expect(result.content[1]).toEqual(KNOWLEDGE);
    expect(warningsOf(result)).toEqual([]);
  });

  it('applies the access filter to both scans', async () => {
    const report = payloadOf(await run('find_field_access', { ...args, access: 'Write' }, contextFor(localDb(), hostedServer(hostedDb()))));
    expect(report.summary).toEqual({ writes: 2, reads: 0, methods: 2 });
    expect(report.accesses.every((a: { access: string }) => a.access === 'Write')).toBe(true);
  });

  it('keeps the original display rule over both sides: up to 50 writes and 20 reads of more than 100', async () => {
    const bulk = axClass('ContosoBulk', {
      run: `void run()\n{\n    CustTable c;\n    ${repeat(60, 'c.CreditMax = 1;')}\n    ${repeat(60, 'info(strFmt("%1", c.CreditMax));')}\n}`,
    });
    const local = seedDb([{ type: 'Class', name: 'ContosoBulk', raw_xml: bulk }]);
    const report = payloadOf(await run('find_field_access', args, contextFor(local, hostedServer(hostedDb()))));

    // totals count every access, not the listed ones: 60 + 1 writes and 60 + 1 reads
    expect(report.summary).toEqual({ writes: 61, reads: 61, methods: 2 });
    const writes = report.accesses.filter((a: { access: string }) => a.access === 'Write');
    const reads = report.accesses.filter((a: { access: string }) => a.access === 'Read');
    expect(writes).toHaveLength(50);
    expect(reads).toHaveLength(20);
    expect(writes.every((a: { source: string }) => a.source === 'local')).toBe(true);
    expect(report.byMethod.map((row: { object: string }) => row.object)).toEqual(['ContosoBulk', 'CustPost']);
    // one note, with the merged count, instead of each side's own
    const cut = report.notes.filter((note: string) => note.startsWith('Showing up to'));
    expect(cut).toEqual(['Showing up to 50 writes and 20 reads of 122 accesses; see byMethod for the full distribution.']);
  });

  it('shows every access up to 100 and leaves the cut note out', async () => {
    const report = payloadOf(await run('find_field_access', args, contextFor(localDb(), hostedServer(hostedDb()))));
    expect(report.notes.some((note: string) => note.startsWith('Showing up to'))).toBe(false);
    expect(report.accesses).toHaveLength(4);
  });

  it('counts a field that a local table extension adds as indexed', async () => {
    const report = payloadOf(await run('find_field_access', { table: 'CustTable', field: 'ContosoRating' }, contextFor(localDb(), hostedServer(hostedDb()))));
    expect(report.fieldIndexed).toBe(true);
    expect(report.summary).toEqual({ writes: 1, reads: 0, methods: 1 });
    expect(report.accesses).toMatchObject([{ source: 'local', object: 'ContosoCustJob', access: 'Write' }]);
    expect(report.notes.filter((note: string) => note.includes('is not'))).toEqual([]);
  });

  it('says the field is unknown when no index and no extension has it', async () => {
    const report = payloadOf(await run('find_field_access', { table: 'CustTable', field: 'NoSuchField' }, contextFor(localDb(), hostedServer(hostedDb()))));
    expect(report.fieldIndexed).toBe(false);
    expect(report.notes).toContain('NoSuchField is not a field of CustTable in the index (it may come from a table extension).');
    expect(report.notes.some((note: string) => note.includes('not indexed'))).toBe(false);
  });

  it('says the table is not indexed when neither side has it', async () => {
    const report = payloadOf(await run('find_field_access', { table: 'GhostTable', field: 'CreditMax' }, contextFor(localDb(), hostedServer(hostedDb()))));
    expect(report.notes.filter((note: string) => note.includes('is not indexed'))).toEqual(['Table GhostTable is not indexed; scanning by name only.']);
  });

  it('tells which side hit the scan cap', async () => {
    const local = localDb([{ type: 'Class', name: 'ContosoSecondJob', raw_xml: axClass('ContosoSecondJob', { run: 'void run()\n{\n    CustTable c;\n    c.CreditMax = 1;\n}' }) }]);
    const report = payloadOf(await run('find_field_access', { ...args, maxObjects: 1 }, contextFor(local, hostedServer(hostedDb()))));
    expect(report.notes.filter((note: string) => note.includes('objects mention'))).toHaveLength(1);
    expect(report.notes.find((note: string) => note.includes('objects mention'))).toMatch(/^\(local index\) 2 objects mention "CreditMax"; scanned the first 1 by name\./);
    expect(report.scannedObjects).toBe(2);
  });

  it('keeps unknown keys of the hosted report', async () => {
    const hosted = hostedServer(hostedDb());
    const original = hosted.callTool.getMockImplementation();
    hosted.callTool.mockImplementation(async (name, callArgs) => {
      const result = await original!(name, callArgs);
      return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...JSON.parse(textOf(result)), futureKey: 7 }) }] };
    });
    expect(payloadOf(await run('find_field_access', args, contextFor(localDb(), hosted))).futureKey).toBe(7);
  });

  it('gives the local report and a warning when the hosted server is down', async () => {
    const result = await run('find_field_access', args, contextFor(localDb(), cannedUpstream(timeout())));
    const report = payloadOf(result);
    expect(report.accesses.every((a: { source: string }) => a.source === 'local')).toBe(true);
    expect(report.summary).toEqual({ writes: 1, reads: 1, methods: 1 });
    expect(report.notes).toContain('Table CustTable is not indexed; scanning by name only.');
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });

  it('gives the local report and a warning when the hosted server answers with an error', async () => {
    const error = textResult('The index was built without raw XML, so source cannot be searched.', true);
    const result = await run('find_field_access', args, contextFor(localDb(), cannedUpstream(error)));
    expect(payloadOf(result).summary.writes).toBe(1);
    expect(warningsOf(result)).toEqual(['hosted unavailable: The index was built without raw XML, so source cannot be searched.']);
  });

  it('gives the local report and a warning when the hosted answer is not a report', async () => {
    const result = await run('find_field_access', args, contextFor(localDb(), cannedUpstream(textResult('{"status":"ok"}'))));
    expect(payloadOf(result).summary.writes).toBe(1);
    expect(warningsOf(result)).toEqual(['hosted unavailable: the hosted answer is not a field access report']);
  });

  it('gives the hosted report and a warning when the local index cannot be scanned', async () => {
    const result = await run('find_field_access', args, contextFor(withoutRawXml(localDb()), hostedServer(hostedDb(), [KNOWLEDGE])));
    const report = payloadOf(result);
    expect(report.summary).toEqual({ writes: 1, reads: 1, methods: 1 });
    expect(report.accesses.every((a: { source: string }) => a.source === 'hosted')).toBe(true);
    expect(report.notes.filter((note: string) => note.includes('is not'))).toEqual([]);
    expect(result.content[1]).toEqual(KNOWLEDGE);
    const [warning] = warningsOf(result);
    expect(warning).toMatch(/^local scan skipped: The index was built without raw XML/);
  });

  it('scans nothing and says nothing about the local index when it holds no objects', async () => {
    // A new model, or a folder without AOT objects: no raw XML was left out, there is just nothing to search.
    const result = await run('find_field_access', args, contextFor(seedDb([]), hostedServer(hostedDb(), [KNOWLEDGE])));
    const report = payloadOf(result);
    expect(report.summary).toEqual({ writes: 1, reads: 1, methods: 1 });
    expect(report.accesses.every((a: { source: string }) => a.source === 'hosted')).toBe(true);
    expect(report.scannedObjects).toBe(1);
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual(KNOWLEDGE);
    expect(warningsOf(result)).toEqual([]);
  });

  it('returns the hosted answer when neither side has a report', async () => {
    const error = textResult('The index was built without raw XML, so source cannot be searched.', true);
    const result = await run('find_field_access', args, contextFor(withoutRawXml(localDb()), cannedUpstream(error)));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('The index was built without raw XML, so source cannot be searched.');
    expect(warningsOf(result)[0]).toMatch(/^local scan skipped:/);
  });

  it('returns the hosted answer unchanged when the local index is empty and the hosted server has no report', async () => {
    const error = textResult('The index was built without raw XML, so source cannot be searched.', true);
    const result = await run('find_field_access', args, contextFor(seedDb([]), cannedUpstream(error)));
    expect(result).toEqual(error);
  });

  it('returns the local failure and the hosted warning when neither side has a report and the hosted server is down', async () => {
    const result = await run('find_field_access', args, contextFor(withoutRawXml(localDb()), cannedUpstream(timeout())));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('without raw XML');
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });

  it('reports no custom objects, not a missing raw XML setting, when the local index is empty and the hosted server is down', async () => {
    const result = await run('find_field_access', args, contextFor(seedDb([]), cannedUpstream(timeout())));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no custom objects');
    expect(textOf(result)).not.toContain('raw XML');
    expect(warningsOf(result)).toEqual(['hosted unavailable: Request timed out']);
  });
});
