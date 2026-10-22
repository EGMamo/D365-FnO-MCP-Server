import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { GatewayConfigError } from '../src/gateway/config.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import { createGatewayRuntime, createGatewayServer, HostedCatalog, type GatewayRuntime } from '../src/gateway/server.js';
import { UpstreamUnavailableError, type UpstreamSession } from '../src/gateway/upstream.js';
import { CLIENT_SDK_VERSION_HEADER } from '../src/indexer/appVersion.js';
import type { GatewayConfig, LocalIndex, LocalTools, UpstreamPort } from '../src/gateway/types.js';
import { seedDb } from './helpers/toolHarness.js';

const workspace = {
  workspaceDir: '',
  customMetadataDir: '/dev/null/CustomModels',
  targetProject: '',
  targetPackage: '',
  targetModel: '',
  targetSolution: '',
};

const HOSTED_KEY = 'hosted-secret-key-0123456789-abcdefghijklmnop';

const baseConfig: GatewayConfig = {
  hostedUrl: 'https://hosted.example/mcp',
  hostedApiKey: HOSTED_KEY,
  customMetadataDir: workspace.customMetadataDir,
  localIndexDbPath: ':memory:',
  standardIndexDbPath: null,
  port: 3101,
  host: '127.0.0.1',
  token: 'gateway-token-0123456789-abcdefghijklmnopqrstu',
  tokenFile: null,
  appVersion: '10.0.2095.13',
  privatePrefixes: [],
  upstreamTimeoutMs: 5_000,
  reindexTtlMs: 60_000,
  workspace,
};

function localSide(): { local: LocalTools; localIndex: LocalIndex } {
  const db = seedDb([]);
  const localIndex = { db, customDir: workspace.customMetadataDir, status: () => ({}) } as unknown as LocalIndex;
  return { local: captureLocalTools(db, localIndex, workspace), localIndex };
}

/** The hosted connection a session opens; every relay method is a spy the test programs. */
function fakeUpstream() {
  return {
    isAvailable: () => true,
    serverVersion: '1.0.0',
    lastError: null,
    listTools: vi.fn(async (): Promise<Tool[]> => []),
    callTool: vi.fn(),
    listResources: vi.fn(async (_params?: { cursor?: string }) => ({ resources: [{ uri: 'kb://hosted/a', name: 'a' }] })),
    readResource: vi.fn(async ({ uri }: { uri: string }) => ({ contents: [{ uri, text: 'hosted text' }] })),
    listPrompts: vi.fn(async (_params?: { cursor?: string }) => ({ prompts: [{ name: 'review' }] })),
    getPrompt: vi.fn(async ({ name }: { name: string }) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `prompt ${name}` } }],
    })),
    close: vi.fn(async () => undefined),
  };
}

type FakeUpstream = ReturnType<typeof fakeUpstream>;

/** A runtime whose hosted connections are fakes, so each relay can be driven without a network. */
function fakeRuntime(upstream: FakeUpstream): GatewayRuntime & { opened: (string | null | undefined)[]; released: unknown[] } {
  const { local, localIndex } = localSide();
  const opened: (string | null | undefined)[] = [];
  const released: unknown[] = [];
  return {
    config: baseConfig,
    localIndex,
    local,
    catalog: new HostedCatalog(local),
    layered: null,
    openUpstream(clientSdkVersion) {
      opened.push(clientSdkVersion);
      return upstream as unknown as UpstreamSession;
    },
    releaseUpstream(session) {
      released.push(session);
    },
    hosted: () => ({ reachable: true, lastError: null }),
    closeUpstreams: async () => undefined,
    opened,
    released,
  };
}

const clients: Client[] = [];

async function connect(runtime: GatewayRuntime, clientSdkVersion?: string | null): Promise<Client> {
  const server = createGatewayServer(runtime, { clientSdkVersion });
  const client = new Client({ name: 'relay-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('gateway resource and prompt relay', () => {
  it('relays resources and prompts to the hosted server, passing the cursor only when one is given', async () => {
    const upstream = fakeUpstream();
    const client = await connect(fakeRuntime(upstream));

    expect((await client.listResources()).resources).toEqual([{ uri: 'kb://hosted/a', name: 'a' }]);
    await client.listResources({ cursor: 'page-2' });
    expect(upstream.listResources.mock.calls).toEqual([[undefined], [{ cursor: 'page-2' }]]);

    const read = await client.readResource({ uri: 'kb://hosted/a' });
    expect(read.contents).toEqual([{ uri: 'kb://hosted/a', text: 'hosted text' }]);

    expect((await client.listPrompts()).prompts).toEqual([{ name: 'review' }]);
    await client.listPrompts({ cursor: 'p2' });
    expect(upstream.listPrompts.mock.calls).toEqual([[undefined], [{ cursor: 'p2' }]]);

    const prompt = await client.getPrompt({ name: 'review', arguments: { table: 'CustTable' } });
    expect(prompt.messages[0].content).toEqual({ type: 'text', text: 'prompt review' });
    expect(upstream.getPrompt).toHaveBeenCalledWith({ name: 'review', arguments: { table: 'CustTable' } });
  });

  it('offers no resource templates of its own', async () => {
    const client = await connect(fakeRuntime(fakeUpstream()));
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
  });

  it('lists nothing, instead of failing, while the hosted server is unreachable', async () => {
    const upstream = fakeUpstream();
    const down = new UpstreamUnavailableError('The hosted MCP server at hosted.example is unreachable (ECONNREFUSED).');
    upstream.listResources.mockRejectedValue(down);
    upstream.listPrompts.mockRejectedValue(down);
    const client = await connect(fakeRuntime(upstream));

    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listPrompts()).prompts).toEqual([]);
  });

  it('surfaces an unreachable hosted server on a read or get as an internal error with the safe message', async () => {
    const upstream = fakeUpstream();
    const down = new UpstreamUnavailableError('The hosted MCP server at hosted.example did not respond within 5000 ms.');
    upstream.readResource.mockRejectedValue(down);
    upstream.getPrompt.mockRejectedValue(down);
    const client = await connect(fakeRuntime(upstream));

    // The test client adds one prefix of its own on top of the one the gateway sends.
    await expect(client.readResource({ uri: 'kb://hosted/a' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: `MCP error ${ErrorCode.InternalError}: MCP error ${ErrorCode.InternalError}: ${down.message}`,
    });
    await expect(client.getPrompt({ name: 'review' })).rejects.toMatchObject({ code: ErrorCode.InternalError });
  });

  it('keeps the code of a hosted protocol error and adds its prefix only once', async () => {
    const upstream = fakeUpstream();
    // As the SDK client throws it after one hop: the message already carries the prefix.
    upstream.readResource.mockRejectedValue(new McpError(ErrorCode.InvalidParams, 'Resource kb://nope not found'));
    upstream.listResources.mockRejectedValue(new McpError(ErrorCode.MethodNotFound, 'Method not found'));
    const client = await connect(fakeRuntime(upstream));

    const error = await client.readResource({ uri: 'kb://nope' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
    // One prefix from the gateway and one from the test client; the hosted one is not repeated.
    const prefix = `MCP error ${ErrorCode.InvalidParams}: `;
    expect((error as McpError).message).toBe(`${prefix}${prefix}Resource kb://nope not found`);

    // A list relays a protocol error too: only an unreachable hosted server becomes an empty list.
    await expect(client.listResources()).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
  });

  it('strips secrets and paths from an unexpected hosted failure before the agent sees it', async () => {
    const upstream = fakeUpstream();
    upstream.getPrompt.mockRejectedValue(new Error(`boom at https://hosted.example/mcp with api_key=${HOSTED_KEY} in /srv/app/index.js`));
    const client = await connect(fakeRuntime(upstream));

    const error = (await client.getPrompt({ name: 'review' }).catch((caught: unknown) => caught)) as McpError;
    expect(error.code).toBe(ErrorCode.InternalError);
    expect(error.message).not.toContain(HOSTED_KEY);
    expect(error.message).not.toContain('hosted.example');
    expect(error.message).not.toContain('/srv/app');
    expect(error.message).toContain('boom at <url>');
  });
});

describe('gateway session lifecycle', () => {
  it('opens one hosted connection per session, on first use, with the client SDK version, and releases it on close', async () => {
    const upstream = fakeUpstream();
    const runtime = fakeRuntime(upstream);
    const client = await connect(runtime, '10.0.2177.20');
    expect(runtime.opened).toEqual([]);

    await client.listPrompts();
    await client.listResources();
    expect(runtime.opened).toEqual(['10.0.2177.20']);

    await client.close();
    await vi.waitFor(() => expect(runtime.released).toEqual([upstream]));
  });

  it('releases nothing when a session closes without ever using the hosted server', async () => {
    const runtime = fakeRuntime(fakeUpstream());
    const client = await connect(runtime);
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.opened).toEqual([]);
    expect(runtime.released).toEqual([]);
  });

  it('tells a connected agent to list tools again once the hosted list arrives', async () => {
    const upstream = fakeUpstream();
    const runtime = fakeRuntime(upstream);
    const client = await connect(runtime);
    const changed = vi.fn();
    client.setNotificationHandler(ToolListChangedNotificationSchema, changed);

    await runtime.catalog.refresh(upstream as unknown as UpstreamPort);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });
});

describe('gateway runtime connections', () => {
  it('turns a hosted setting the connection rejects into a config problem that names the variable, not the value', () => {
    const { local, localIndex } = localSide();
    const runtime = createGatewayRuntime({ ...baseConfig, hostedApiKey: 'has a space' }, localIndex, local);

    const error = (() => {
      try {
        runtime.openUpstream(null);
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(GatewayConfigError);
    expect((error as GatewayConfigError).problems).toEqual([
      'D365_HOSTED_API_KEY: must be non-empty printable ASCII without whitespace',
    ]);
    expect((error as GatewayConfigError).message).not.toContain('has a space');
  });

  it('sends the client SDK version upstream, falling back to D365_APP_VERSION for one the hosted server cannot accept', async () => {
    const { local, localIndex } = localSide();
    const runtime = createGatewayRuntime(baseConfig, localIndex, local);
    const sentVersion = (upstream: UpstreamSession): string | undefined =>
      (upstream as unknown as { headers: Record<string, string> }).headers[CLIENT_SDK_VERSION_HEADER];

    expect(sentVersion(runtime.openUpstream(' 10.0.2177.20 '))).toBe('10.0.2177.20');
    // Not printable ASCII, or over the header limit: passing either through would fail the connection's own validation.
    expect(sentVersion(runtime.openUpstream('10.0.\u00e9'))).toBe(baseConfig.appVersion);
    expect(sentVersion(runtime.openUpstream('9'.repeat(65)))).toBe(baseConfig.appVersion);
    expect(sentVersion(runtime.openUpstream(null))).toBe(baseConfig.appVersion);
    // Neither side declares one: no header at all rather than an empty one.
    const silent = createGatewayRuntime({ ...baseConfig, appVersion: '' }, localIndex, local);
    expect(sentVersion(silent.openUpstream(undefined))).toBeUndefined();
    await runtime.closeUpstreams();
    await silent.closeUpstreams();
  });

  it('reports a lost session as the hosted state and closes every open connection on shutdown', async () => {
    const { local, localIndex } = localSide();
    const runtime = createGatewayRuntime(baseConfig, localIndex, local);
    expect(runtime.hosted()).toEqual({ reachable: true, lastError: null });

    const upstream = runtime.openUpstream(null);
    const close = vi.spyOn(upstream, 'close');
    vi.spyOn(upstream, 'lastError', 'get').mockReturnValue('The hosted MCP server at hosted.example closed the connection.');
    expect(runtime.hosted()).toEqual({
      reachable: false,
      lastError: 'The hosted MCP server at hosted.example closed the connection.',
    });

    await runtime.closeUpstreams();
    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.hosted()).toEqual({ reachable: true, lastError: null });
  });
});
