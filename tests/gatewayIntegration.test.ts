import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolListChangedNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadGatewayConfig } from '../src/gateway/config.js';
import { LOCAL_ONLY_TOOL_NAMES } from '../src/gateway/router.js';
import { gatewayHostHeaders, launchGateway, type RunningGateway } from '../src/gateway/server.js';
import type { Database } from '../src/indexer/db.js';
import { createHttpApp } from '../src/server/httpTransport.js';
import type { ArtifactDescription } from '../src/server/serverStatus.js';
import { registerCodeQualityTools } from '../src/tools/codeQuality.js';
import { registerEntityTools } from '../src/tools/entities.js';
import { registerGeneratorTools } from '../src/tools/generators.js';
import { registerLabelsTools } from '../src/tools/labels.js';
import { registerMetadataTools } from '../src/tools/metadata.js';
import { registerSecurityTools } from '../src/tools/security.js';
import { VERSION } from '../src/version.js';
import { seedDb, type SeedObject } from './helpers/toolHarness.js';
import { descriptorXml } from './workspaceFixtures.js';

// The gateway in front of a stand-in hosted server, both in this process and on ephemeral loopback
// ports. The stand-in serves STANDARD objects only, behind an API key, and records every request body
// that reaches it, so a test can say what the gateway sent upstream (and what it did not).

const HOSTED_KEY = 'hosted-secret-key-0123456789-abcdefghijklmnop';
const OTHER_HOSTED_KEY = 'some-other-hosted-key-9876543210-zyxwvutsrqpo';
const GATEWAY_TOKEN = 'gateway-token-0123456789-abcdefghijklmnopqrstu';
const HOSTED_INSTRUCTIONS = 'Hosted stand-in: standard D365 metadata only.';
const TEST_TIMEOUT_MS = 30_000;

/** Pasted X++ that must stay on the machine: names a private class and carries a marker nothing else contains. */
const PASTED_SOURCE = [
  'public void applyContosoPricing(CustTable _custTable)',
  '{',
  '    // PastedSourceMarker42',
  '    if (_custTable.Blocked == true)',
  '    {',
  '        ttsbegin;',
  '    }',
  '}',
].join('\n');

type Result = CallToolResult;

interface UpstreamRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** The JSON-RPC body as received; '' for requests without one (GET, DELETE). */
  body: string;
}

interface HostedStandIn {
  url: string;
  requests: UpstreamRequest[];
  /** The tools/call messages among the requests from `mark` on. */
  toolCalls(mark?: number): { name: string; arguments: Record<string, unknown> }[];
  /** Everything sent since `mark`, as one string to search. */
  bodies(mark?: number): string;
  /** From now on a request to end a session is read and never answered, like a hosted server behind a dropped VPN. */
  swallowDeletes(): void;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------
// Captured logs. The server logs through process.stderr; the hosted API key must not be in any line.
// ---------------------------------------------------------------------------------------------------

const logLines: string[] = [];
/** Every result, tool list and instruction text any gateway session handed to a client. */
const transcript: string[] = [];

let stderrSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeAll(() => {
  vi.stubEnv('MCP_LOG_LEVEL', 'DEBUG');
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    logLines.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write);
});

afterAll(() => {
  stderrSpy?.mockRestore();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------------------------------
// Fixtures: standard objects (hosted) and custom models (local).
// ---------------------------------------------------------------------------------------------------

function axClass(name: string, declaration: string, methods: Record<string, string> = {}): string {
  const items = Object.entries(methods)
    .map(([method, source]) => `<Method><Name>${method}</Name><Source><![CDATA[\n${source}\n]]></Source></Method>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name>
<SourceCode><Declaration><![CDATA[\n${declaration}\n]]></Declaration><Methods>${items}</Methods></SourceCode></AxClass>`;
}

const tableField = (name: string, edt = ''): string =>
  `<AxTableField i:type="AxTableFieldString"><Name>${name}</Name>${edt ? `<ExtendedDataType>${edt}</ExtendedDataType>` : ''}</AxTableField>`;

function axTable(name: string, fields: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name><Fields>${fields.join('')}</Fields></AxTable>`;
}

function axTableExtension(name: string, fields: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name><Fields>${fields.join('')}</Fields></AxTableExtension>`;
}

function axQuery(name: string, table: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<AxQuery><Name>${name}</Name><DataSources><AxQuerySimpleRootDataSource><Name>${table}</Name><Table>${table}</Table></AxQuerySimpleRootDataSource></DataSources></AxQuery>`;
}

const STANDARD_RUN_SOURCE = 'public void run()\n{\n    info("HostedRunMarker");\n}';

/** The standard side: what Microsoft ships, indexed in the cloud. */
function seedStandardIndex(): Database {
  const standard = (object: SeedObject): SeedObject => ({ package: 'ApplicationSuite', model: 'Foundation', ...object });
  const db = seedDb(
    [
      standard({
        type: 'Table',
        name: 'CustTable',
        fields: [
          { name: 'AccountNum', type: 'AxTableFieldString', edt: 'CustAccount' },
          { name: 'CustGroup', type: 'AxTableFieldString', edt: 'CustGroupId' },
          { name: 'Blocked', type: 'AxTableFieldEnum' },
        ],
        raw_xml: axTable('CustTable', [tableField('AccountNum', 'CustAccount'), tableField('CustGroup'), tableField('Blocked')]),
      }),
      standard({ type: 'Form', name: 'CustTable' }),
      standard({ type: 'Edt', name: 'CustAccount' }),
      standard({
        type: 'Class',
        name: 'SalesFormLetter',
        methods: [{ name: 'run', accessModifier: 'public', returnType: 'void' }],
        raw_xml: axClass('SalesFormLetter', 'class SalesFormLetter\n{\n}', { run: STANDARD_RUN_SOURCE }),
      }),
      standard({ type: 'Class', name: 'SalesFormLetter_Invoice', properties: { extends: 'SalesFormLetter' } }),
    ],
    [
      { labelId: 'SYS1', value: 'Customer account' },
      { labelId: 'SYS2', value: 'Customer group' },
    ]
  );
  const xref = db.prepare('INSERT INTO ax_xref (from_type, from_name, to_type, to_name, xref_kind) VALUES (?, ?, ?, ?, ?)');
  xref.run('Class', 'SalesFormLetter_Invoice', 'Class', 'SalesFormLetter', 'extends');
  xref.run('Form', 'CustTable', 'Table', 'CustTable', 'datasource');
  return db;
}

/** One file of a custom model; paths are relative to <customDir>/ContosoPkg/ContosoModel. */
const CUSTOM_FILES: Record<string, string> = {
  'AxTable/ContosoLoyaltyCard.xml': axTable('ContosoLoyaltyCard', [tableField('CardNum'), tableField('Points'), tableField('CustAccount', 'CustAccount')]),
  'AxTableExtension/CustTable.ContosoExt.xml': axTableExtension('CustTable.ContosoExt', [tableField('ContosoLoyaltyTier')]),
  'AxClass/ContosoLoyaltyService.xml': axClass('ContosoLoyaltyService', 'class ContosoLoyaltyService\n{\n}', {
    tierFor: 'public str tierFor(CustTable _custTable)\n{\n    return _custTable.ContosoLoyaltyTier;\n}',
    blockLapsed: 'public void blockLapsed(CustTable _custTable)\n{\n    _custTable.Blocked = CustVendorBlocked::All;\n    _custTable.update();\n}',
  }),
  'AxClass/ContosoInvoiceLetter.xml': axClass('ContosoInvoiceLetter', 'class ContosoInvoiceLetter extends SalesFormLetter_Invoice\n{\n}', {
    run: 'public void run()\n{\n    super();\n}',
  }),
  'AxQuery/ContosoCustQuery.xml': axQuery('ContosoCustQuery', 'CustTable'),
  'AxLabelFile/LabelResources/en-US/ContosoLabels.en-US.label.txt': 'ContosoTier=Customer loyalty tier\nContosoPoints=Loyalty points\n',
};

const modelDir = (customDir: string): string => path.join(customDir, 'ContosoPkg', 'ContosoModel');

function writeCustomFile(customDir: string, relative: string, content: string): string {
  const file = path.join(modelDir(customDir), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------------------------------
// The hosted stand-in.
// ---------------------------------------------------------------------------------------------------

/** The bundle the hosted stand-in says it was activated from, as a hosted server reports it in get_index_stats. */
const HOSTED_ARTIFACT: ArtifactDescription = {
  source: 'azure-blob',
  bundleId: `sha256:${'cd'.repeat(32)}`,
  pointerRevision: 3,
  createdAt: '2026-10-24T21:40:00.000Z',
  applicationVersion: '10.0.2428.63',
};

/** The real tools, registered against the standard index like the hosted server does. */
function createHostedServer(db: Database): McpServer {
  const server = new McpServer({ name: 'd365-fno-mcp', version: VERSION }, { instructions: HOSTED_INSTRUCTIONS });
  registerMetadataTools(server, db, { configuredApplicationVersion: '10.0.2428.63', artifact: HOSTED_ARTIFACT });
  registerLabelsTools(server, db);
  registerSecurityTools(server, db);
  registerEntityTools(server, db);
  registerCodeQualityTools(server, db);
  registerGeneratorTools(server, db);
  return server;
}

function messagesOf(body: string): { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }[] {
  if (body === '') return [];
  const parsed = JSON.parse(body) as unknown;
  return (Array.isArray(parsed) ? parsed : [parsed]) as ReturnType<typeof messagesOf>;
}

async function startHosted(port = 0): Promise<HostedStandIn> {
  const db = seedStandardIndex();
  const hostedApp = createHttpApp(() => createHostedServer(db), {
    port: 0,
    apiKeys: [{ name: 'gateway-test', key: HOSTED_KEY }],
    version: VERSION,
    rateLimitMaxRequests: 10_000,
    rateLimitWindowMs: 60_000,
    requestTimeoutMs: 30_000,
  });

  // The spy parses the body first; the hosted app's own JSON parser then finds the stream consumed and keeps req.body.
  const requests: UpstreamRequest[] = [];
  let swallowing = false;
  const spy = express();
  spy.use(express.json({ limit: '1mb' }));
  spy.use((req, _res, next) => {
    const body: unknown = req.body;
    requests.push({ method: req.method, path: req.path, headers: req.headers, body: body === undefined ? '' : JSON.stringify(body) });
    if (swallowing && req.method === 'DELETE') return;
    next();
  });
  spy.use(hostedApp);

  const server: HttpServer = createHttpServer(spy);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: boundPort } = server.address() as AddressInfo;

  let stopping: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    requests,
    toolCalls: (mark = 0) =>
      requests
        .slice(mark)
        .flatMap((request) => messagesOf(request.body))
        .filter((message) => message.method === 'tools/call')
        .map((message) => ({ name: String(message.params?.name), arguments: message.params?.arguments ?? {} })),
    bodies: (mark = 0) => requests.slice(mark).map((request) => request.body).join('\n'),
    swallowDeletes() {
      swallowing = true;
    },
    stop() {
      stopping ??= (async () => {
        (hostedApp.locals.closeAllSessions as () => void)();
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
        db.close();
      })();
      return stopping;
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// The gateway stack.
// ---------------------------------------------------------------------------------------------------

interface StackOptions {
  /** D365_GATEWAY_PRIVATE_PREFIXES. */
  privatePrefixes?: string;
  /** The key the gateway presents to the hosted server; the stand-in only accepts HOSTED_KEY. */
  hostedKey?: string;
  /** Stops the hosted server before the gateway starts. */
  hostedDown?: boolean;
  /** D365_GATEWAY_UPSTREAM_TIMEOUT_MS; default 5000. */
  upstreamTimeoutMs?: number;
  /** D365_APP_VERSION: the SDK version the gateway declares to the hosted server when the agent declares none. */
  appVersion?: string;
  /** Writes a ContosoPkg model descriptor and sets D365_TARGET_MODEL and D365_WRITABLE_MODELS for it. */
  targetModel?: boolean;
  /** Writes the hosted stand-in's index to a file and sets it as D365_GATEWAY_STANDARD_INDEX_DB_PATH. */
  standardIndex?: boolean;
}

interface Stack {
  root: string;
  customDir: string;
  hosted: HostedStandIn;
  gateway: RunningGateway;
  /** Calls a tool through the gateway and records the answer in the transcript. */
  call(name: string, args?: Record<string, unknown>): Promise<Result>;
  /** Connects another agent session; `headers` are sent on top of the bearer token. */
  client(headers?: Record<string, string>): Promise<Client>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The gateway needs its port up front (the Host allowlist names it), so a port taken in between is retried. */
async function launch(env: NodeJS.ProcessEnv): Promise<RunningGateway> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchGateway(loadGatewayConfig({ ...env, D365_GATEWAY_PORT: String(await freePort()) }));
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !error.message.includes('already in use')) throw error;
    }
  }
}

async function startStack(options: StackOptions = {}): Promise<Stack> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-e2e-'));
  const customDir = path.join(root, 'custom');
  fs.mkdirSync(customDir);
  for (const [relative, content] of Object.entries(CUSTOM_FILES)) writeCustomFile(customDir, relative, content);
  if (options.targetModel) {
    fs.mkdirSync(path.join(customDir, 'ContosoPkg', 'Descriptor'), { recursive: true });
    fs.writeFileSync(path.join(customDir, 'ContosoPkg', 'Descriptor', 'ContosoModel.xml'), descriptorXml('ContosoModel', 'ContosoPkg'));
  }

  const clients: Client[] = [];
  let hosted: HostedStandIn | undefined;
  let gateway: RunningGateway | undefined;
  const stop = async (): Promise<void> => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await Promise.allSettled([gateway?.stop(), hosted?.stop()]);
    fs.rmSync(root, { recursive: true, force: true });
  };

  try {
    hosted = await startHosted();
    if (options.hostedDown) await hosted.stop();
    const standardIndexDbPath = path.join(root, 'standard', 'd365_index.db');
    if (options.standardIndex) {
      fs.mkdirSync(path.dirname(standardIndexDbPath));
      const standard = seedStandardIndex();
      standard.prepare('VACUUM INTO ?').run(standardIndexDbPath);
      standard.close();
    }
    gateway = await launch({
      D365_HOSTED_MCP_URL: hosted.url,
      D365_HOSTED_API_KEY: options.hostedKey ?? HOSTED_KEY,
      D365_CUSTOM_METADATA_DIR: customDir,
      D365_LOCAL_INDEX_DB_PATH: path.join(root, 'state', 'custom_index.db'),
      D365_INDEX_DB_PATH: path.join(root, 'unused_main_index.db'),
      D365_GATEWAY_TOKEN: GATEWAY_TOKEN,
      D365_GATEWAY_UPSTREAM_TIMEOUT_MS: String(options.upstreamTimeoutMs ?? 5000),
      ...(options.privatePrefixes ? { D365_GATEWAY_PRIVATE_PREFIXES: options.privatePrefixes } : {}),
      ...(options.appVersion ? { D365_APP_VERSION: options.appVersion } : {}),
      ...(options.targetModel ? { D365_TARGET_MODEL: 'ContosoModel', D365_WRITABLE_MODELS: 'ContosoPkg/ContosoModel' } : {}),
      ...(options.standardIndex ? { D365_GATEWAY_STANDARD_INDEX_DB_PATH: standardIndexDbPath } : {}),
    });
  } catch (error) {
    await stop();
    throw error;
  }

  const url = gateway.url;
  const connect = async (headers: Record<string, string> = {}): Promise<Client> => {
    const client = new Client({ name: 'gateway-integration-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}`, ...headers } } })
    );
    transcript.push(client.getInstructions() ?? '');
    return client;
  };
  let primary: Client | undefined;
  return {
    root,
    customDir,
    hosted,
    gateway,
    async call(name, args = {}) {
      primary ??= await connect();
      const result = (await primary.callTool({ name, arguments: args })) as Result;
      transcript.push(JSON.stringify(result));
      return result;
    },
    client: connect,
    stop,
  };
}

/** Starts a stack for one describe block and tears it down after it. */
function useStack(options: StackOptions = {}): () => Stack {
  let stack: Stack | undefined;
  beforeAll(async () => {
    stack = await startStack(options);
  }, TEST_TIMEOUT_MS);
  afterAll(async () => {
    await stack?.stop();
  }, TEST_TIMEOUT_MS);
  return () => {
    if (!stack) throw new Error('The gateway stack did not start.');
    return stack;
  };
}

// ---------------------------------------------------------------------------------------------------
// Reading results.
// ---------------------------------------------------------------------------------------------------

const textsOf = (result: Result): string[] => result.content.map((item) => (item.type === 'text' ? item.text : `<${item.type}>`));

/** The first text item, parsed. */
const payloadOf = <T = unknown>(result: Result): T => JSON.parse(textsOf(result)[0]) as T;

/** The warnings of the trailing {"gateway":{"warnings":[...]}} item; empty when there is none. */
function warningsOf(result: Result): string[] {
  const last = textsOf(result).at(-1);
  if (last === undefined) return [];
  try {
    const parsed = JSON.parse(last) as { gateway?: { warnings?: string[] } };
    return parsed.gateway?.warnings ?? [];
  } catch {
    return [];
  }
}

interface Row {
  name: string;
  type: string;
  source?: string;
  [key: string]: unknown;
}

const find = (rows: Row[], name: string, type?: string): Row | undefined =>
  rows.find((row) => row.name === name && (type === undefined || row.type === type));

interface HttpResponse {
  status: number;
  body: string;
}

/** A plain HTTP request, so a test controls headers (Host, Authorization) the MCP client would set itself. */
function rawRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: init.method ?? 'GET', headers: init.headers },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    request.on('error', reject);
    request.end(init.body);
  });
}

const TOOLS_LIST_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

// ---------------------------------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------------------------------

describe('gateway with the hosted server up', () => {
  const stack = useStack();

  it('lists the hosted tools plus the gateway-only local_index_status, and relays the hosted instructions', async () => {
    const { hosted, call } = stack();
    const hostedClient = new Client({ name: 'direct', version: '1.0.0' });
    await hostedClient.connect(new StreamableHTTPClientTransport(new URL(hosted.url), { requestInit: { headers: { 'X-API-Key': HOSTED_KEY } } }));
    const hostedTools = (await hostedClient.listTools()).tools;
    await hostedClient.close();

    const client = await stack().client();
    const listed = (await client.listTools()).tools;
    transcript.push(JSON.stringify(listed));

    const hostedNames = hostedTools.map((tool) => tool.name);
    const names = listed.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(hostedNames));
    expect(names).toContain('local_index_status');
    // Nothing else is added beyond the tools only the gateway can answer.
    expect(names.filter((name) => !hostedNames.includes(name)).every((name) => LOCAL_ONLY_TOOL_NAMES.includes(name))).toBe(true);
    expect(names.filter((name) => name === 'search_symbols')).toHaveLength(1);
    // A hosted tool is relayed as the hosted server describes it.
    expect(listed.find((tool) => tool.name === 'search_symbols')).toEqual(hostedTools.find((tool) => tool.name === 'search_symbols'));
    // Neither writers nor anything else the hosted server does not offer.
    expect(names).not.toContain('write_table_extension');

    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain(HOSTED_INSTRUCTIONS);
    expect(instructions).toContain('local gateway');

    const status = payloadOf<{ localIndex: Record<string, unknown>; hosted: Record<string, unknown>; skewedTools: string[] }>(await call('local_index_status'));
    expect(status.localIndex).toMatchObject({ customDirName: 'custom', watcher: 'active', lastError: null });
    expect(status.localIndex).toMatchObject({ objects: 5, labels: 2 });
    expect(JSON.stringify(status)).not.toContain(stack().customDir);
    expect(status.hosted).toMatchObject({ reachable: true, version: VERSION, versionNote: null });
    expect(status.skewedTools).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('merges local and hosted rows in search_symbols, tagged by source, exact matches first', async () => {
    const rows = payloadOf<Row[]>(await stack().call('search_symbols', { query: 'CustTable' }));

    expect(find(rows, 'CustTable', 'Table')).toMatchObject({ source: 'hosted' });
    expect(find(rows, 'CustTable', 'Form')).toMatchObject({ source: 'hosted' });
    const extension = find(rows, 'CustTable.ContosoExt', 'TableExtension');
    expect(extension).toMatchObject({ source: 'local', package: 'ContosoPkg' });
    // A local rowid means nothing next to hosted ids.
    expect(extension).not.toHaveProperty('id');
    expect(rows.every((row) => row.source === 'local' || row.source === 'hosted')).toBe(true);
    // Exact name matches rank ahead of the local prefix match.
    expect(rows.indexOf(extension as Row)).toBeGreaterThan(rows.indexOf(find(rows, 'CustTable', 'Table') as Row));
    expect(rows.indexOf(extension as Row)).toBeGreaterThan(rows.indexOf(find(rows, 'CustTable', 'Form') as Row));
  }, TEST_TIMEOUT_MS);

  it('adds the custom fields of table extensions to the hosted get_table_schema as localExtensions', async () => {
    const mark = stack().hosted.requests.length;
    const result = await stack().call('get_table_schema', { tableName: 'CustTable' });
    const schema = payloadOf<{
      name: string;
      fields: { name: string }[];
      xrefs: Row[];
      localExtensions: { name: string; source: string; fields: { name: string }[] }[];
    }>(result);

    // The table itself is the hosted one.
    expect(schema.name).toBe('CustTable');
    expect(schema.fields.map((field) => field.name)).toEqual(['AccountNum', 'CustGroup', 'Blocked']);
    expect(schema.localExtensions).toHaveLength(1);
    expect(schema.localExtensions[0]).toMatchObject({ name: 'CustTable.ContosoExt', source: 'local' });
    expect(schema.localExtensions[0].fields.map((field) => field.name)).toEqual(['ContosoLoyaltyTier']);
    // The custom query that reads the table joins the hosted form in its references.
    const referencing = schema.xrefs.map((xref) => `${xref.source}:${String(xref.from_type)}:${String(xref.from_name)}`);
    expect(referencing).toEqual(expect.arrayContaining(['hosted:Form:CustTable', 'local:Query:ContosoCustQuery']));
    expect(warningsOf(result)).toEqual([]);
    expect(stack().hosted.toolCalls(mark)).toEqual([{ name: 'get_table_schema', arguments: { tableName: 'CustTable' } }]);
  }, TEST_TIMEOUT_MS);

  it('includes custom dependents in find_references and analyze_impact of a standard table', async () => {
    const references = payloadOf<(Row & { from_type: string; from_name: string })[]>(
      await stack().call('find_references', { name: 'CustTable', type: 'Table' })
    );
    const referenceKeys = references.map((row) => `${row.source}:${row.from_type}:${row.from_name}`);
    expect(referenceKeys).toEqual(
      expect.arrayContaining(['hosted:Form:CustTable', 'local:TableExtension:CustTable.ContosoExt', 'local:Query:ContosoCustQuery'])
    );

    const impact = payloadOf<{ levels: { depth: number; items: Row[] }[]; totals: { objects: number }; caveat: string }>(
      await stack().call('analyze_impact', { name: 'CustTable', type: 'Table' })
    );
    const dependents = impact.levels.flatMap((level) => level.items.map((item) => `${item.source}:${item.type}:${item.name}`));
    expect(dependents).toEqual(
      expect.arrayContaining(['hosted:Form:CustTable', 'local:TableExtension:CustTable.ContosoExt', 'local:Query:ContosoCustQuery'])
    );
    expect(impact.totals.objects).toBe(dependents.length);
    expect(impact.caveat).toContain('Custom (local) dependents');
  }, TEST_TIMEOUT_MS);

  it('merges the other lookups that custom code takes part in', async () => {
    const children = payloadOf<{ class: string; children: Row[] }>(await stack().call('get_class_hierarchy', { className: 'SalesFormLetter_Invoice' }));
    expect(children.class).toBe('SalesFormLetter_Invoice');
    expect(children.children.map((child) => `${child.source}:${String(child.from_name)}`)).toEqual(['local:ContosoInvoiceLetter']);

    const labels = payloadOf<Row[]>(await stack().call('search_labels', { query: 'Customer' }));
    const labelIds = labels.map((label) => `${label.source}:${String(label.label_id)}`);
    expect(labelIds).toEqual(expect.arrayContaining(['hosted:SYS1', 'hosted:SYS2', 'local:ContosoLabels:ContosoTier']));

    // A standard label is not local, so the hosted server answers; a custom one never goes upstream.
    const mark = stack().hosted.requests.length;
    expect(textsOf(await stack().call('resolve_label', { labelId: 'ContosoLabels:ContosoTier' }))).toEqual(['Customer loyalty tier']);
    expect(stack().hosted.toolCalls(mark)).toEqual([]);
    expect(textsOf(await stack().call('resolve_label', { labelId: 'SYS1' }))[0]).toBe('Customer account');
    expect(stack().hosted.toolCalls(mark).map((call) => call.name)).toEqual(['resolve_label']);

    const access = payloadOf<{ summary: { writes: number }; accesses: (Row & { object: string; access: string })[] }>(
      await stack().call('find_field_access', { table: 'CustTable', field: 'Blocked' })
    );
    expect(access.accesses).toContainEqual(expect.objectContaining({ source: 'local', object: 'ContosoLoyaltyService', access: 'Write' }));
    expect(access.summary.writes).toBeGreaterThanOrEqual(1);
  }, TEST_TIMEOUT_MS);

  it('forwards the owner-routed tools to the hosted server for a standard object', async () => {
    const mark = stack().hosted.requests.length;
    const source = payloadOf<{ sources: { source: string }[] }>(await stack().call('get_method_source', { objectName: 'SalesFormLetter', methodName: 'run' }));
    expect(source.sources[0].source).toContain('HostedRunMarker');
    // A generator drafting against a standard table is validated by the hosted index.
    const draft = await stack().call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'ContosoDraft',
      fields: [{ name: 'ContosoDraftField', edt: 'CustAccount' }],
    });
    expect(draft.isError).not.toBe(true);
    expect(stack().hosted.toolCalls(mark).map((call) => call.name)).toEqual(['get_method_source', 'create_table_extension']);
  }, TEST_TIMEOUT_MS);

  it('asks the hosted server about a name it does not own when no private prefix is configured', async () => {
    const { call, hosted } = stack();
    const mark = hosted.requests.length;
    const missing = await call('get_enum_values', { enumName: 'ContosoMissingEnum' });
    expect(textsOf(missing)[0]).toContain('not found');
    // The same call a private prefix keeps at home (see below): names the index cannot place are the hosted server's to answer.
    expect(hosted.toolCalls(mark)).toEqual([{ name: 'get_enum_values', arguments: { enumName: 'ContosoMissingEnum' } }]);
    expect(warningsOf(missing)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('answers a custom-only object locally and sends nothing about it upstream', async () => {
    const { hosted, call } = stack();
    const mark = hosted.requests.length;

    const table = payloadOf<{ name: string; fields: { name: string }[] }>(await call('get_table_schema', { tableName: 'ContosoLoyaltyCard' }));
    expect(table.name).toBe('ContosoLoyaltyCard');
    expect(table.fields.map((field) => field.name)).toEqual(['CardNum', 'Points', 'CustAccount']);

    const method = payloadOf<{ object: { name: string }; sources: { source: string }[] }>(
      await call('get_method_source', { objectName: 'ContosoLoyaltyService', methodName: 'tierFor' })
    );
    expect(method.object.name).toBe('ContosoLoyaltyService');
    expect(method.sources[0].source).toContain('_custTable.ContosoLoyaltyTier');

    const review = payloadOf<{ target: { source: string }; byRule: Record<string, number> }>(
      await call('check_xpp_best_practices', { source: PASTED_SOURCE })
    );
    expect(review.target.source).toBe('inline X++');
    expect(Object.keys(review.byRule)).toEqual(expect.arrayContaining(['BooleanExpressionWithLiteral', 'BalancedTtsStatement']));
    // A custom class by name is checked from the local index too.
    const byName = payloadOf<{ target: { name: string } }>(await call('check_xpp_best_practices', { objectName: 'ContosoLoyaltyService' }));
    expect(byName.target.name).toBe('ContosoLoyaltyService');

    // Not one request to the hosted server: no tools/call, and none of the names or the pasted code in any body.
    expect(hosted.toolCalls(mark)).toEqual([]);
    const sent = hosted.bodies(mark).toLowerCase();
    for (const secret of ['contoso', 'pastedsourcemarker42', 'tierfor', 'loyalty']) expect(sent).not.toContain(secret);
  }, TEST_TIMEOUT_MS);

  it('rejects a missing or wrong bearer token with 401 before anything reaches the hosted server', async () => {
    const { gateway, hosted } = stack();
    const mark = hosted.requests.length;
    const attempts: Record<string, string>[] = [
      {},
      { Authorization: 'Bearer not-the-gateway-token-0123456789-abcdefghijk' },
      { 'X-API-Key': 'not-the-gateway-token-0123456789-abcdefghijk' },
      // The hosted key authenticates against the hosted server only.
      { Authorization: `Bearer ${HOSTED_KEY}` },
      { Authorization: `Basic ${Buffer.from(`user:${GATEWAY_TOKEN}`).toString('base64')}` },
    ];
    for (const headers of attempts) {
      const response = await rawRequest(gateway.url, { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: TOOLS_LIST_BODY });
      expect(response.status).toBe(401);
      expect(response.body).not.toContain(GATEWAY_TOKEN);
      expect(response.body).not.toContain(HOSTED_KEY);
    }
    // The right token passes authentication; this request then fails for having no session instead.
    const authenticated = await rawRequest(gateway.url, {
      method: 'POST',
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${GATEWAY_TOKEN}` },
      body: TOOLS_LIST_BODY,
    });
    expect(authenticated.status).toBe(400);
    expect(hosted.requests.length).toBe(mark);
  }, TEST_TIMEOUT_MS);

  it('forwards get_index_stats as the hosted server answers it, with the application version and the bundle', async () => {
    const { call } = stack();

    const stats = payloadOf<Record<string, unknown>>(await call('get_index_stats'));

    expect(stats).toMatchObject({ applicationVersion: '10.0.2428.63', applicationVersionSource: 'configured', artifact: HOSTED_ARTIFACT });
  }, TEST_TIMEOUT_MS);

  it('has no /status of its own: the hosted server describes the hosted index, local_index_status the custom one', async () => {
    const { gateway, hosted } = stack();
    const mark = hosted.requests.length;
    const { port } = new URL(gateway.url);

    const authenticated = await rawRequest(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } });
    const anonymous = await rawRequest(`http://127.0.0.1:${port}/status`);

    expect(authenticated.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(hosted.requests.length).toBe(mark);
  }, TEST_TIMEOUT_MS);

  it('rejects a foreign Host header with 403, health checks included', async () => {
    const { gateway, hosted } = stack();
    const mark = hosted.requests.length;
    const { port } = new URL(gateway.url);
    const bearer = { Authorization: `Bearer ${GATEWAY_TOKEN}` };

    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`, `localhost:${Number(port) + 1}`]) {
      const mcp = await rawRequest(gateway.url, { method: 'POST', headers: { ...JSON_HEADERS, ...bearer, Host: host }, body: TOOLS_LIST_BODY });
      expect(mcp.status, `POST /mcp with Host ${host}`).toBe(403);
      const health = await rawRequest(`http://127.0.0.1:${port}/health`, { headers: { Host: host } });
      expect(health.status, `GET /health with Host ${host}`).toBe(403);
    }
    // The gateway's own host names pass.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const health = await rawRequest(`http://127.0.0.1:${port}/health`, { headers: { Host: host } });
      expect(health.status, `GET /health with Host ${host}`).toBe(200);
    }
    expect(hosted.requests.length).toBe(mark);
  }, TEST_TIMEOUT_MS);
});

describe('gateway generated files', () => {
  const stack = useStack({ targetModel: true });

  interface Payload { generatedFiles: { aotType: string; name: string; target?: { path: string; writable: boolean; projectItem: string } }[] }
  const filesOf = (result: Result): Payload['generatedFiles'] => (JSON.parse(textsOf(result).find((text) => text.startsWith('{"generatedFiles":'))!) as Payload).generatedFiles;

  it('gives a hosted generator result its path in the custom model, and sends no local path upstream', async () => {
    const { hosted, call, customDir } = stack();
    const mark = hosted.requests.length;
    const draft = await call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'ContosoNew',
      fields: [{ name: 'ContosoNewField', edt: 'CustAccount' }],
    });
    expect(hosted.toolCalls(mark).map((c) => c.name)).toEqual(['create_table_extension']);
    const [file] = filesOf(draft);
    expect(file.target).toMatchObject({
      path: path.join(fs.realpathSync(modelDir(customDir)), 'AxTableExtension', 'CustTable.ContosoNew.xml'),
      projectItem: 'AxTableExtension\\CustTable.ContosoNew',
      writable: true,
    });
    expect(hosted.bodies(mark)).not.toContain(path.basename(stack().root));
  }, TEST_TIMEOUT_MS);

  it('gives a locally answered generator result its path as well', async () => {
    const result = await stack().call('create_coc_extension', {
      targetClass: 'ContosoLoyaltyService',
      extensionName: 'ContosoLoyaltyService_Extension',
      methods: [{ name: 'tierFor' }],
    });
    const [file] = filesOf(result);
    expect(file).toMatchObject({ aotType: 'AxClass', name: 'ContosoLoyaltyService_Extension' });
    expect(file.target?.path).toBe(path.join(fs.realpathSync(modelDir(stack().customDir)), 'AxClass', 'ContosoLoyaltyService_Extension.xml'));
  }, TEST_TIMEOUT_MS);
});

describe('gateway listener', () => {
  const stack = useStack();

  it('binds the loopback interface only', () => {
    // Without the host option the listener would take every interface, and only the token and the Host list would protect it.
    expect(stack().gateway.boundAddress).toBe('127.0.0.1');
  });

  it('answers the bare host names too when the port is 80, which clients leave out of the Host header', async () => {
    const app = createHttpApp(() => new McpServer({ name: 'port-80', version: '0.0.0' }), {
      port: 0,
      apiKeys: [{ name: 'gateway-test', key: GATEWAY_TOKEN }],
      version: VERSION,
      rateLimitMaxRequests: 10_000,
      rateLimitWindowMs: 60_000,
      requestTimeoutMs: 30_000,
      allowedHosts: gatewayHostHeaders(80),
    });
    const server = await new Promise<HttpServer>((resolve) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created));
    });
    try {
      const { port } = server.address() as AddressInfo;
      const health = (host: string) => rawRequest(`http://127.0.0.1:${port}/health`, { headers: { Host: host } });
      for (const host of ['127.0.0.1', 'localhost', '127.0.0.1:80', 'localhost:80']) {
        expect((await health(host)).status, `Host ${host}`).toBe(200);
      }
      for (const host of ['evil.example', '127.0.0.1:81', 'localhost:3101']) {
        expect((await health(host)).status, `Host ${host}`).toBe(403);
      }
    } finally {
      (app.locals.closeAllSessions as () => void)();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Any other port is named in full, never bare.
    expect(gatewayHostHeaders(3101)).toEqual(['127.0.0.1:3101', 'localhost:3101']);
  });
});

describe('gateway with private prefixes', () => {
  const stack = useStack({ privatePrefixes: 'Contoso' });

  it('never forwards a name with a private prefix, and says what it withheld', async () => {
    const { call, hosted } = stack();
    const mark = hosted.requests.length;

    // An object the local index does not hold: the hosted server would be asked, so only the prefix keeps it home.
    const missing = await call('get_enum_values', { enumName: 'ContosoMissingEnum' });
    expect(textsOf(missing)[0]).toContain('not found');
    expect(warningsOf(missing)).toEqual([expect.stringContaining('hosted lookup skipped')]);

    // A merge tool answers from the local index alone.
    const search = await call('search_symbols', { query: 'ContosoLoyalty' });
    const rows = payloadOf<Row[]>(search);
    expect(rows.map((row) => row.name).sort()).toEqual(['ContosoLoyaltyCard', 'ContosoLoyaltyService']);
    expect(rows.every((row) => row.source === 'local')).toBe(true);
    expect(warningsOf(search)).toEqual([expect.stringContaining('hosted lookup skipped')]);

    // A tool only the hosted server can answer is refused outright.
    const refused = await call('get_bp_findings', { element: 'ContosoLoyaltyCard' });
    expect(refused.isError).toBe(true);
    expect(textsOf(refused)[0]).toContain('private prefix');

    // The prefix is matched without regard to case, and also in a nested argument.
    const lower = await call('get_enum_values', { enumName: 'contosolowercase' });
    expect(warningsOf(lower)).toEqual([expect.stringContaining('hosted lookup skipped')]);
    const nested = await call('check_xpp_best_practices', { objectName: 'NoSuchClass', rules: ['ContosoRule'] });
    expect(nested.isError).toBe(true);
    expect(warningsOf(nested)).toEqual([expect.stringContaining('hosted lookup skipped')]);

    expect(hosted.toolCalls(mark)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps every custom name out of all requests the hosted server ever saw', async () => {
    const { call, hosted } = stack();
    // Standard lookups still reach the hosted server and still come back merged with the custom side.
    const schema = payloadOf<{ localExtensions: { name: string }[] }>(await call('get_table_schema', { tableName: 'CustTable' }));
    expect(schema.localExtensions.map((extension) => extension.name)).toEqual(['CustTable.ContosoExt']);
    await call('analyze_impact', { name: 'CustTable', type: 'Table' });
    await call('find_references', { name: 'CustTable' });
    await call('get_table_schema', { tableName: 'ContosoLoyaltyCard' });
    await call('get_method_source', { objectName: 'ContosoLoyaltyService', methodName: 'tierFor' });
    await call('check_xpp_best_practices', { source: PASTED_SOURCE });
    await call('resolve_label', { labelId: 'ContosoLabels:ContosoTier' });
    expect(hosted.toolCalls().map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['get_table_schema', 'analyze_impact', 'find_references'])
    );

    const everything = hosted.bodies().toLowerCase();
    for (const secret of ['contoso', 'pastedsourcemarker42', 'tierfor']) expect(everything).not.toContain(secret);
  }, TEST_TIMEOUT_MS);
});

describe('gateway with a standard index', () => {
  const stack = useStack({ privatePrefixes: 'Contoso', standardIndex: true });

  it('runs the otherwise forwarded tools over both indexes and sends them nothing upstream', async () => {
    const { call, hosted } = stack();
    const mark = hosted.requests.length;

    // A generator over a custom table: the hosted server alone could not see its fields.
    const entity = await call('create_data_entity', {
      table: 'ContosoLoyaltyCard',
      entityName: 'ContosoLoyaltyCardEntity',
      keyFields: ['CardNum'],
    });
    expect(entity.isError).toBeFalsy();
    expect(textsOf(entity).join('')).toContain('CardNum');

    // A name with a private prefix is no reason to refuse: nothing would leave the machine anyway.
    const findings = await call('get_bp_findings', { element: 'ContosoLoyaltyCard' });
    expect(findings.isError).toBeFalsy();

    expect(hosted.toolCalls(mark)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('still forwards the tools about the hosted index, and reports the standard index by file name', async () => {
    const { call, hosted, root } = stack();
    const mark = hosted.requests.length;
    await call('get_index_stats');
    expect(hosted.toolCalls(mark).map((entry) => entry.name)).toEqual(['get_index_stats']);

    const status = await call('local_index_status');
    expect(payloadOf<{ standardIndex: Record<string, unknown> }>(status).standardIndex).toMatchObject({
      fileName: 'd365_index.db',
      objects: 5,
    });
    expect(textsOf(status).join('')).not.toContain(root);
  }, TEST_TIMEOUT_MS);
});

describe('gateway when custom files change', () => {
  const stack = useStack();

  it('picks up an edited, an added and a deleted file on the next call', async () => {
    const { customDir, gateway, call, hosted } = stack();
    const before = payloadOf<{ localExtensions: { fields: { name: string }[] }[] }>(await call('get_table_schema', { tableName: 'CustTable' }));
    expect(before.localExtensions[0].fields.map((field) => field.name)).toEqual(['ContosoLoyaltyTier']);
    expect(payloadOf<{ name: string }>(await call('get_table_schema', { tableName: 'ContosoLoyaltyCard' })).name).toBe('ContosoLoyaltyCard');

    // The index serves what it built until the watcher reports a change.
    const extensionFile = writeCustomFile(
      customDir,
      'AxTableExtension/CustTable.ContosoExt.xml',
      axTableExtension('CustTable.ContosoExt', [tableField('ContosoLoyaltyTier'), tableField('ContosoLoyaltyPoints')])
    );
    const addedFile = writeCustomFile(customDir, 'AxTable/ContosoAddedTable.xml', axTable('ContosoAddedTable', [tableField('AddedField')]));
    fs.rmSync(path.join(modelDir(customDir), 'AxTable', 'ContosoLoyaltyCard.xml'));
    // Distinct modification times, whatever the clock resolution.
    const later = new Date(Date.now() + 60_000);
    for (const file of [extensionFile, addedFile]) fs.utimesSync(file, later, later);
    await vi.waitFor(() => expect(gateway.localIndex.status().dirty).toBe(true), { timeout: 10_000, interval: 25 });

    const mark = hosted.requests.length;
    const after = payloadOf<{ localExtensions: { fields: { name: string }[] }[] }>(await call('get_table_schema', { tableName: 'CustTable' }));
    expect(after.localExtensions[0].fields.map((field) => field.name)).toEqual(['ContosoLoyaltyTier', 'ContosoLoyaltyPoints']);
    expect(payloadOf<{ fields: { name: string }[] }>(await call('get_table_schema', { tableName: 'ContosoAddedTable' })).fields.map((field) => field.name)).toEqual([
      'AddedField',
    ]);
    // The deleted table is gone from the local index, so the hosted server is asked about it, and has never heard of it.
    const gone = await call('get_table_schema', { tableName: 'ContosoLoyaltyCard' });
    expect(textsOf(gone)[0]).toContain('not found');
    expect(hosted.toolCalls(mark)).toEqual([
      { name: 'get_table_schema', arguments: { tableName: 'CustTable' } },
      { name: 'get_table_schema', arguments: { tableName: 'ContosoLoyaltyCard' } },
    ]);
    expect(gateway.localIndex.status()).toMatchObject({ objects: 5, dirty: false, lastError: null });
  }, TEST_TIMEOUT_MS);
});

describe('gateway when the hosted server stops', () => {
  const stack = useStack();

  it('degrades to local results with a warning, and fails the tools only the hosted server can answer', async () => {
    const { call, hosted } = stack();
    // Connected and working first, so the loss happens to a live session.
    expect(payloadOf<Row[]>(await call('search_symbols', { query: 'CustTable' })).some((row) => row.source === 'hosted')).toBe(true);
    await hosted.stop();

    // A merge tool: the local rows alone, and the trailing warning item.
    const search = await call('search_symbols', { query: 'CustTable' });
    expect(search.isError).not.toBe(true);
    const rows = payloadOf<Row[]>(search);
    expect(rows.map((row) => `${row.source}:${row.name}`)).toEqual(['local:CustTable.ContosoExt']);
    expect(warningsOf(search)).toEqual([expect.stringMatching(/^hosted unavailable: /)]);

    const schema = await call('get_table_schema', { tableName: 'CustTable' });
    expect(schema.isError).not.toBe(true);
    const body = payloadOf<{ name: string; notes: string[]; localExtensions: { fields: { name: string }[] }[] }>(schema);
    expect(body.notes[0]).toContain('not available from the hosted server');
    expect(body.localExtensions[0].fields.map((field) => field.name)).toEqual(['ContosoLoyaltyTier']);
    expect(warningsOf(schema)).toEqual([expect.stringMatching(/^hosted unavailable: /)]);

    const impact = payloadOf<{ levels: { items: Row[] }[]; caveat: string }>(await call('analyze_impact', { name: 'CustTable', type: 'Table' }));
    expect(impact.levels.flatMap((level) => level.items.map((item) => item.name)).sort()).toEqual(['ContosoCustQuery', 'CustTable.ContosoExt']);
    expect(impact.caveat).toContain('hosted server did not provide this object');

    // A custom object needs no hosted answer. A merge tool still says the hosted side is missing; an owner-routed one has nothing to report.
    const custom = await call('get_table_schema', { tableName: 'ContosoLoyaltyCard' });
    expect(custom.isError).not.toBe(true);
    expect(payloadOf<{ name: string }>(custom).name).toBe('ContosoLoyaltyCard');
    const customSource = await call('get_method_source', { objectName: 'ContosoLoyaltyService', methodName: 'tierFor' });
    expect(customSource.isError).not.toBe(true);
    expect(warningsOf(customSource)).toEqual([]);

    // A standard object is the hosted server's to answer: the local miss says why it is only a miss.
    const standard = await call('get_method_source', { objectName: 'SalesFormLetter', methodName: 'run' });
    expect(standard.isError).toBe(true);
    expect(warningsOf(standard)).toEqual([expect.stringMatching(/^hosted unavailable: /)]);

    // Forward-only tools have nothing local to fall back on.
    const stats = await call('get_index_stats');
    expect(stats.isError).toBe(true);
    expect(textsOf(stats)[0]).toMatch(/^hosted server unavailable: /);

    const status = payloadOf<{ hosted: { reachable: boolean; lastError: string | null } }>(await call('local_index_status'));
    expect(status.hosted.reachable).toBe(false);
    expect(status.hosted.lastError).toContain('unreachable');
  }, TEST_TIMEOUT_MS);
});

describe('gateway when the hosted server comes back', () => {
  const stack = useStack();

  it('asks it again at the first call after the retry pause, without waiting for the tool list refresh', async () => {
    const { call, hosted } = stack();
    expect(payloadOf<Row[]>(await call('search_symbols', { query: 'CustTable' })).some((row) => row.source === 'hosted')).toBe(true);
    await hosted.stop();
    expect((await call('get_index_stats')).isError).toBe(true);

    // The same address, a hosted server that has never seen this session.
    const restarted = await startHosted(Number(new URL(hosted.url).port));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Right after the failure nothing is sent, so a dead hosted server is not asked on every call.
      const mark = restarted.requests.length;
      const paused = await call('get_index_stats');
      expect(paused.isError).toBe(true);
      expect(textsOf(paused)[0]).toContain('not connected');
      expect(restarted.requests.length).toBe(mark);

      vi.setSystemTime(Date.now() + 6_000);
      const stats = await call('get_index_stats');
      expect(stats.isError).not.toBe(true);
      const search = await call('search_symbols', { query: 'CustTable' });
      expect(payloadOf<Row[]>(search).some((row) => row.source === 'hosted')).toBe(true);
      expect(warningsOf(search)).toEqual([]);
      const schema = await call('get_table_schema', { tableName: 'CustTable' });
      expect(payloadOf<{ name: string }>(schema).name).toBe('CustTable');
      expect(warningsOf(schema)).toEqual([]);

      const status = payloadOf<{ hosted: { reachable: boolean; lastError: string | null } }>(await call('local_index_status'));
      expect(status.hosted).toMatchObject({ reachable: true, lastError: null });
    } finally {
      vi.useRealTimers();
      await restarted.stop();
    }
  }, TEST_TIMEOUT_MS);
});

describe('gateway started while the hosted server is down', () => {
  const stack = useStack({ hostedDown: true });

  it('lists the tools the local index can answer, marked unavailable, and answers custom lookups', async () => {
    const client = await stack().client();
    const listed = (await client.listTools()).tools;
    transcript.push(JSON.stringify(listed));
    const names = listed.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining(['local_index_status', 'search_symbols', 'get_table_schema', 'get_method_source']));
    // Tools only the hosted server can answer are not offered.
    expect(names).not.toContain('get_index_stats');
    expect(names).not.toContain('get_bp_findings');
    expect(listed.find((tool) => tool.name === 'search_symbols')?.description).toMatch(/^\[hosted unavailable\] /);
    expect(client.getInstructions()).toContain('were not available');

    const table = payloadOf<{ name: string }>(await stack().call('get_table_schema', { tableName: 'ContosoLoyaltyCard' }));
    expect(table.name).toBe('ContosoLoyaltyCard');
    const forwarded = await stack().call('get_index_stats');
    expect(forwarded.isError).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('gateway sessions', () => {
  const stack = useStack({ appVersion: '10.0.1111.1' });

  it('ends the hosted session of an agent session when that agent ends its own', async () => {
    const { gateway, hosted } = stack();
    const transport = new StreamableHTTPClientTransport(new URL(gateway.url), {
      requestInit: { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } },
    });
    const client = new Client({ name: 'session-end-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      expect((await client.callTool({ name: 'get_index_stats', arguments: {} })) as Result).not.toHaveProperty('isError', true);
      const mark = hosted.requests.length;

      await transport.terminateSession();

      // Otherwise the session stays on the hosted server, against its session cap, until its idle sweep.
      await vi.waitFor(() => expect(hosted.requests.slice(mark).some((request) => request.method === 'DELETE')).toBe(true), {
        timeout: 5_000,
        interval: 25,
      });
    } finally {
      await client.close();
    }
  }, TEST_TIMEOUT_MS);

  it('opens the hosted session with the SDK version the agent declares, else the one configured', async () => {
    const { hosted } = stack();
    /** The version header of the initialize request that a new agent session's first hosted call causes. */
    async function declaredToHosted(headers?: Record<string, string>): Promise<string | string[] | undefined> {
      const mark = hosted.requests.length;
      const client = await stack().client(headers);
      expect(((await client.callTool({ name: 'get_index_stats', arguments: {} })) as Result).isError).not.toBe(true);
      const initialize = hosted.requests.slice(mark).filter((request) => messagesOf(request.body).some((message) => message.method === 'initialize'));
      expect(initialize).toHaveLength(1);
      return initialize[0].headers['x-d365-client-sdk-version'];
    }

    expect(await declaredToHosted({ 'X-D365-Client-Sdk-Version': '10.0.2222.9' })).toBe('10.0.2222.9');
    expect(await declaredToHosted()).toBe('10.0.1111.1');
  }, TEST_TIMEOUT_MS);
});

describe('gateway tool list changes', () => {
  it('tells an agent that listed the local fallback to list again once the hosted tools arrive', async () => {
    const stack = await startStack({ hostedDown: true });
    let restarted: HostedStandIn | undefined;
    try {
      const client = await stack.client();
      let notifications = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        notifications += 1;
      });
      const fallback = (await client.listTools()).tools.map((tool) => tool.name);
      expect(fallback).not.toContain('get_index_stats');
      expect(notifications).toBe(0);

      restarted = await startHosted(Number(new URL(stack.hosted.url).port));
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        // The failed first attempt is not repeated for a few seconds.
        vi.setSystemTime(Date.now() + 6_000);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('get_index_stats');
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(notifications).toBe(1), { timeout: 5_000, interval: 25 });

      // The same list again changes nothing.
      await client.listTools();
      expect(notifications).toBe(1);
    } finally {
      await stack.stop();
      await restarted?.stop();
    }
  }, TEST_TIMEOUT_MS);
});

describe('gateway readiness', () => {
  it('refuses requests with 503 until it has heard from the hosted server, then serves them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ready-'));
    // A hosted server that accepts connections and never answers: the start-up handshake takes its full 1 s budget.
    const sockets = new Set<Socket>();
    const blackhole = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    let gateway: RunningGateway | undefined;
    try {
      const customDir = path.join(root, 'custom');
      fs.mkdirSync(customDir);
      const port = await freePort();
      const config = loadGatewayConfig({
        D365_HOSTED_MCP_URL: `http://127.0.0.1:${(blackhole.address() as AddressInfo).port}/mcp`,
        D365_HOSTED_API_KEY: HOSTED_KEY,
        D365_CUSTOM_METADATA_DIR: customDir,
        D365_LOCAL_INDEX_DB_PATH: path.join(root, 'state', 'custom_index.db'),
        D365_INDEX_DB_PATH: path.join(root, 'unused_main_index.db'),
        D365_GATEWAY_TOKEN: GATEWAY_TOKEN,
        D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000',
        D365_GATEWAY_PORT: String(port),
      });
      const launching = launchGateway(config).then((running) => (gateway = running));

      // The listener comes up before the handshake is over; the first answer must already be the refusal.
      const answers: number[] = [];
      let mcpAnswer: HttpResponse | undefined;
      await vi.waitFor(
        async () => {
          const health = await rawRequest(`http://127.0.0.1:${port}/health`);
          answers.push(health.status);
          mcpAnswer ??= await rawRequest(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: `Bearer ${GATEWAY_TOKEN}` },
            body: TOOLS_LIST_BODY,
          });
        },
        { timeout: 10_000, interval: 10 }
      );
      expect(answers[0]).toBe(503);
      expect(mcpAnswer?.status).toBe(503);

      await launching;
      expect((await rawRequest(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    } finally {
      await gateway?.stop();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});

describe('gateway shutdown', () => {
  it('finishes within the shutdown deadline, local index closed, when the hosted server never answers the session end', async () => {
    // A request budget of 20 s: waiting for the hosted server's answer would outlast the 10 s deadline of the process.
    const stack = await startStack({ upstreamTimeoutMs: 20_000 });
    try {
      expect((await stack.call('get_index_stats')).isError).not.toBe(true);
      stack.hosted.swallowDeletes();

      const mark = stack.hosted.requests.length;
      const startedAt = Date.now();
      await stack.gateway.stop();

      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(stack.gateway.localIndex.db.isOpen).toBe(false);
      // The hosted session was asked to end; the answer is simply not waited for.
      expect(stack.hosted.requests.slice(mark).some((request) => request.method === 'DELETE')).toBe(true);
    } finally {
      await stack.stop();
    }
  }, TEST_TIMEOUT_MS);
});

describe('secrets', () => {
  it('never puts the hosted API key into a response or a log line, even when the hosted server rejects it', async () => {
    // The gateway presents a key the hosted server does not accept; every hosted call fails with a 401.
    const stack = await startStack({ hostedKey: OTHER_HOSTED_KEY });
    try {
      const forwarded = await stack.call('get_index_stats');
      expect(forwarded.isError).toBe(true);
      expect(textsOf(forwarded)[0]).toMatch(/^hosted server unavailable: /);
      const search = await stack.call('search_symbols', { query: 'CustTable' });
      expect(warningsOf(search)).toEqual([expect.stringMatching(/^hosted unavailable: /)]);
      const status = payloadOf<{ hosted: { reachable: boolean; lastError: string } }>(await stack.call('local_index_status'));
      expect(status.hosted.reachable).toBe(false);
      expect(status.hosted.lastError).toContain('rejected the API key (HTTP 401)');
      expect(stack.hosted.requests.every((request) => request.headers['x-api-key'] === OTHER_HOSTED_KEY)).toBe(true);
    } finally {
      await stack.stop();
    }

    // Everything the other stacks of this file said and logged, too.
    const logs = logLines.join('');
    const responses = transcript.join('\n');
    expect(logs).toContain('Starting D365 FnO MCP gateway');
    expect(logs).toContain('Hosted MCP server unavailable');
    expect(responses).toContain('local_index_status');
    for (const secret of [HOSTED_KEY, OTHER_HOSTED_KEY, GATEWAY_TOKEN]) {
      expect(logs).not.toContain(secret);
      expect(responses).not.toContain(secret);
    }
  }, TEST_TIMEOUT_MS);
});
