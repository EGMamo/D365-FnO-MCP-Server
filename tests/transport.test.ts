import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'net';
import { connect } from 'net';
import { request, type Server } from 'http';
import { Server as ProtocolServer } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express, { type Request, type Response, type Router } from 'express';
import { createHttpApp, startHttpServer, type ConnectableServer } from '../src/server/httpTransport.js';
import { logger } from '../src/utils/logger.js';
import type { ServerStatus, StatusProvider } from '../src/server/serverStatus.js';

const API_KEY = 'test-api-key-1234567890-abcdefghijklmnop';
const SECOND_KEY = 'second-api-key-0987654321-zyxwvutsrqpon';

let server: Server;
let baseUrl: string;
const extraServers: Server[] = [];

function makeApp(
  factory: () => ConnectableServer = () => new McpServer({ name: 'test', version: '0.0.0' }),
  overrides: Partial<Parameters<typeof createHttpApp>[1]> = {},
) {
  const app = createHttpApp(factory, {
    port: 0,
    apiKeys: [
      { name: 'test', key: API_KEY },
      { name: 'second', key: SECOND_KEY },
    ],
    version: '0.1.0',
    rateLimitMaxRequests: 10_000,
    rateLimitWindowMs: 60_000,
    requestTimeoutMs: 5_000,
    trustProxyHops: 0,
    maxConcurrentSessions: 100,
    sessionIdleTimeoutMs: 60_000,
    ...overrides,
  });
  return { app, sessions: app.locals.sessions as Map<string, unknown> };
}

async function listen(app: ReturnType<typeof makeApp>['app']): Promise<string> {
  const s = await new Promise<Server>((resolve) => {
    const created = app.listen(0, () => resolve(created));
  });
  extraServers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  const { app } = makeApp();

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(extraServers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('http transport auth', () => {
  it('returns 401 when the API key is missing', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('returns 401 when the API key is wrong', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { 'X-API-Key': 'wrong-key' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a bearer token carrying the API key', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    });
    // Passes auth, fails JSON-RPC validation instead of 401.
    expect(res.status).toBe(400);
  });

  it('accepts every configured key and logs its name, never its value', async () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'INFO');
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write);
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'X-API-Key': SECOND_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      });
      expect(res.status).toBe(400);
    } finally {
      write.mockRestore();
      vi.unstubAllEnvs();
    }
    const request = lines.map((line) => JSON.parse(line) as { message: string; apiKey?: string })
      .find((entry) => entry.message === 'Request');
    expect(request?.apiKey).toBe('second');
    expect(lines.join('')).not.toContain(SECOND_KEY);
  });

  it('refuses to start without any API key', () => {
    expect(() => makeApp(undefined, { apiKeys: [] })).toThrow(/at least one API key/);
  });
});

describe('health endpoint', () => {
  it('is reachable and reports version', async () => {
    const res = await fetch(`${baseUrl}/health`, { headers: { 'X-API-Key': API_KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '0.1.0' });
  });
});

describe('readiness gate', () => {
  it('reports starting and refuses MCP traffic until the index is ready', async () => {
    let ready = false;
    const factory = vi.fn(() => new McpServer({ name: 'test', version: '0.0.0' }));
    const url = await listen(makeApp(factory, { readiness: { isReady: () => ready } }).app);
    const initialize = () =>
      fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'X-API-Key': API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }),
      });

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(503);
    expect(health.headers.get('retry-after')).toBe('10');
    expect(await health.json()).toEqual({ status: 'starting', version: '0.1.0' });
    expect((await fetch(`${url}/live`)).status).toBe(200);
    expect((await fetch(`${url}/mcp`, { method: 'POST' })).status).toBe(401);
    const refused = await initialize();
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: number } }).error.code).toBe(-32000);
    expect(factory).not.toHaveBeenCalled();

    ready = true;
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await initialize()).status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('status endpoint and index version header', () => {
  type DescribeInput = Parameters<StatusProvider['describe']>[0];

  const document = (input: DescribeInput): ServerStatus => ({
    status: input.ready ? 'ok' : 'starting',
    you: { keyName: input.keyName },
    server: { version: '0.1.0', startedAt: '2026-10-25T08:00:00.000Z', uptimeSeconds: 5, keyRegistry: null },
    index: input.ready
      ? {
          applicationVersion: '10.0.2428.63',
          applicationVersionSource: 'packages-dir',
          builtAt: '2026-10-24T22:10:00.000Z',
          schemaVersion: 3,
          objects: 7,
          labels: 2,
        }
      : null,
    artifact: null,
    sessions: input.sessions,
  });

  /** A provider that records what the transport asks it, so the tests do not depend on the real one. */
  function stub(overrides: Partial<StatusProvider> = {}) {
    const asked: DescribeInput[] = [];
    const provider: StatusProvider = {
      indexVersion: () => '10.0.2428.63',
      describe: (input) => {
        asked.push(input);
        return document(input);
      },
      ...overrides,
    };
    return { provider, asked };
  }

  const initialize = (url: string) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });

  describe('GET /status', () => {
    it('needs a key', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider }).app);

      const missing = await fetch(`${url}/status`);
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({
        error: 'Unauthorized: no API key was sent. Send it as the X-API-Key header or as Authorization: Bearer <key>.',
      });
      const wrong = await fetch(`${url}/status`, { headers: { 'X-API-Key': 'wrong-key-wrong-key-wrong-key-wrong' } });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({
        error: 'Unauthorized: the API key was not recognized. It may have been revoked; ask your operator for a new key.',
      });
      expect(wrong.headers.get('www-authenticate')).toBeNull();
    });

    it('answers a key in either header, naming the key that was used and no other', async () => {
      const { provider, asked } = stub();
      const url = await listen(makeApp(undefined, { status: provider }).app);

      const viaHeader = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });
      expect(viaHeader.status).toBe(200);
      expect(await viaHeader.json()).toEqual(document({ ready: true, keyName: 'test', sessions: asked[0].sessions }));

      const viaBearer = await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${SECOND_KEY}` } });
      const text = await viaBearer.text();
      expect((JSON.parse(text) as ServerStatus).you).toEqual({ keyName: 'second' });
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(SECOND_KEY);
      expect(text).not.toContain('"test"');
    });

    it('is not cached by anything on the way', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider }).app);

      const res = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    });

    it('answers HEAD with no body', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider }).app);

      const res = await fetch(`${url}/status`, { method: 'HEAD', headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    });

    it("hands the provider the transport's own session numbers and readiness", async () => {
      const { provider, asked } = stub();
      const url = await listen(makeApp(undefined, { status: provider, maxConcurrentSessions: 7, maxSessionsPerApiKey: 2 }).app);

      await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });
      expect((await initialize(url)).status).toBe(200);
      await fetch(`${url}/status`, { headers: { 'X-API-Key': SECOND_KEY } });

      expect(asked[0]).toEqual({ ready: true, keyName: 'test', sessions: { active: 0, max: 7, maxPerKey: 2 } });
      expect(asked[1]).toEqual({ ready: true, keyName: 'second', sessions: { active: 1, max: 7, maxPerKey: 2 } });
    });

    it('answers 500 with a fixed body when the provider fails, logs it, and keeps serving', async () => {
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const { provider } = stub({
        describe: () => {
          throw new Error('database is not open: /srv/secret/path');
        },
      });
      const url = await listen(makeApp(undefined, { status: provider }).app);

      const res = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'status unavailable' });
      expect(error).toHaveBeenCalledTimes(1);
      // The reason is in the log, under a key the logger does not overwrite (`message` is its own field).
      expect(error).toHaveBeenCalledWith('Status unavailable', { error: expect.stringContaining('database is not open') });
      expect((await fetch(`${url}/nope`, { headers: { 'X-API-Key': API_KEY } })).status).toBe(404);
      expect((await fetch(`${url}/health`)).status).toBe(200);
      error.mockRestore();
    });

    it('spends the same rate-limit budget as the other authenticated routes', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider, rateLimitMaxRequests: 3 }).app);
      const get = () => fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect([(await get()).status, (await get()).status, (await get()).status]).toEqual([200, 200, 200]);
      const limited = await get();
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: { code: number } }).error.code).toBe(-32029);
    });

    it('is not there without a provider, which is how the gateway runs', async () => {
      const url = await listen(makeApp().app);

      const res = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not Found. MCP endpoint is at /mcp' });
      expect(res.headers.get('x-d365-index-version')).toBeNull();
    });
  });

  describe('while the server is starting', () => {
    it('answers /status with the starting document while everything else stays unavailable', async () => {
      let ready = false;
      const { provider, asked } = stub();
      const factory = vi.fn(() => new McpServer({ name: 'test', version: '0.0.0' }));
      const url = await listen(makeApp(factory, { status: provider, readiness: { isReady: () => ready } }).app);
      const status = () => fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect((await fetch(`${url}/health`)).status).toBe(503);
      expect((await fetch(`${url}/status`)).status).toBe(401);
      const starting = await status();
      expect(starting.status).toBe(200);
      expect(await starting.json()).toMatchObject({ status: 'starting', index: null, artifact: null });
      expect(asked.at(-1)?.ready).toBe(false);
      expect((await fetch(`${url}/nope`, { headers: { 'X-API-Key': API_KEY } })).status).toBe(503);
      expect((await initialize(url)).status).toBe(503);
      expect(factory).not.toHaveBeenCalled();

      ready = true;
      expect(await (await status()).json()).toMatchObject({ status: 'ok' });
      expect(asked.at(-1)?.ready).toBe(true);
    });
  });

  describe('x-d365-index-version', () => {
    const header = (res: { headers: Headers }) => res.headers.get('x-d365-index-version');

    it('is sent with the indexed application version on /status and on the MCP handshake', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider }).app);

      const status = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });
      expect(header(status)).toBe('10.0.2428.63');

      const handshake = await initialize(url);
      expect(handshake.status).toBe(200);
      expect(header(handshake)).toBe('10.0.2428.63');
      await handshake.text();
    });

    it('is sent on an authenticated answer that is not a success, such as an unknown path', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider }).app);

      const res = await fetch(`${url}/nope`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(404);
      expect(header(res)).toBe('10.0.2428.63');
    });

    it('is never sent to a caller without a valid key', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider }).app);

      expect(header(await fetch(`${url}/status`))).toBeNull();
      expect(header(await fetch(`${url}/mcp`, { method: 'POST' }))).toBeNull();
      expect(header(await fetch(`${url}/status`, { headers: { 'X-API-Key': 'wrong-key-wrong-key-wrong-key-wrong' } }))).toBeNull();
    });

    it('is not sent on /health or /live', async () => {
      const url = await listen(makeApp(undefined, { status: stub().provider }).app);

      expect(header(await fetch(`${url}/health`, { headers: { 'X-API-Key': API_KEY } }))).toBeNull();
      expect(header(await fetch(`${url}/live`, { headers: { 'X-API-Key': API_KEY } }))).toBeNull();
    });

    it('is left out when the version is unknown', async () => {
      const url = await listen(makeApp(undefined, { status: stub({ indexVersion: () => null }).provider }).app);

      const res = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(200);
      expect(header(res)).toBeNull();
    });

    it('is left out until the server is ready, even if the provider would answer', async () => {
      const indexVersion = vi.fn(() => '10.0.2428.63');
      const url = await listen(makeApp(undefined, { status: stub({ indexVersion }).provider, readiness: { isReady: () => false } }).app);

      const res = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(200);
      expect(header(res)).toBeNull();
      expect(indexVersion).not.toHaveBeenCalled();
    });

    it('never turns a request into an error when the provider fails', async () => {
      const url = await listen(
        makeApp(undefined, {
          status: stub({
            indexVersion: () => {
              throw new Error('The index is not open yet.');
            },
          }).provider,
        }).app
      );

      const res = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(200);
      expect(header(res)).toBeNull();
      const handshake = await initialize(url);
      expect(handshake.status).toBe(200);
      await handshake.text();
    });

    it.each([
      ['a line break', '10.0.2428.63\r\nX-Evil: 1'],
      ['a character outside Latin-1', '10.0.2428.63 €'],
      ['free text', 'latest build'],
      ['three parts', '10.0.39'],
      ['an empty string', ''],
      ['20,000 characters', '1'.repeat(20_000)],
    ])('is left out, and nothing breaks, for a value with %s', async (_label, value) => {
      const url = await listen(makeApp(undefined, { status: stub({ indexVersion: () => value }).provider }).app);

      const res = await fetch(`${url}/status`, { headers: { 'X-API-Key': API_KEY } });

      expect(res.status).toBe(200);
      expect(header(res)).toBeNull();
      expect(res.headers.get('x-evil')).toBeNull();
      const handshake = await initialize(url);
      expect(handshake.status).toBe(200);
      await handshake.text();
    });
  });

  describe('/health and /live are untouched', () => {
    it.each([
      ['without a status provider', false],
      ['with a status provider', true],
    ])('keep their exact answers %s', async (_label, withStatus) => {
      let ready = true;
      const overrides = { readiness: { isReady: () => ready }, ...(withStatus ? { status: stub().provider } : {}) };
      const url = await listen(makeApp(undefined, overrides).app);

      expect(await (await fetch(`${url}/health`)).text()).toBe('{"status":"ok","version":"0.1.0"}');
      expect(await (await fetch(`${url}/live`)).text()).toBe('{"status":"alive","version":"0.1.0"}');

      ready = false;
      const starting = await fetch(`${url}/health`);
      expect(starting.status).toBe(503);
      expect(starting.headers.get('retry-after')).toBe('10');
      expect(await starting.text()).toBe('{"status":"starting","version":"0.1.0"}');
      expect(await (await fetch(`${url}/live`)).text()).toBe('{"status":"alive","version":"0.1.0"}');
    });
  });
});

describe('json-rpc validation', () => {
  it('rejects a request missing "method" with -32600', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number }; id: number };
    expect(body.error.code).toBe(-32600);
    expect(body.id).toBe(7);
  });

  it('accepts a JSON-RPC response envelope (server-initiated request reply)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }),
    });
    // Passes envelope validation; rejected later because it carries no session.
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(res.status).toBe(400);
    expect(body.error.message).toMatch(/mcp-session-id/);
  });

  it('accepts a JSON-RPC error response envelope', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, error: { code: -1, message: 'nope' } }),
    });
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/mcp-session-id/);
  });

  it('rejects a request missing "jsonrpc" with -32600', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'tools/list' }),
    });
    const body = (await res.json()) as { error: { code: number } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32600);
  });
});

describe('body size limit', () => {
  it('returns 413 for a payload over 1mb', async () => {
    const huge = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(2 * 1024 * 1024) } };
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(huge),
    });
    expect(res.status).toBe(413);
  });
});

describe('client body errors', () => {
  const post = (headers: Record<string, string>) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  it('returns 415 for an unsupported charset instead of an internal error', async () => {
    const errors = vi.spyOn(logger, 'error');
    const res = await post({ 'Content-Type': 'application/json; charset=x-unknown' });
    const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
    expect(res.status).toBe(415);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).not.toMatch(/internal/i);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('returns 415 for an unsupported content encoding instead of an internal error', async () => {
    const res = await post({ 'Content-Type': 'application/json', 'Content-Encoding': 'x-unknown' });
    const body = (await res.json()) as { error: { code: number } };
    expect(res.status).toBe(415);
    expect(body.error.code).toBe(-32600);
  });
});

describe('session lifecycle', () => {
  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    },
  };

  const initHeaders = {
    'X-API-Key': API_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  it('rejects tools/list without a session id and creates no server', async () => {
    let created = 0;
    const { app, sessions } = makeApp(() => {
      created += 1;
      return new McpServer({ name: 'test', version: '0.0.0' });
    });
    const url = await listen(app);

    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
    expect(created).toBe(0);
    expect(sessions.size).toBe(0);
  });

  it('registers exactly one session per successful initialize', async () => {
    const { app, sessions } = makeApp();
    const url = await listen(app);

    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify(initBody),
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(sessions.size).toBe(1);
  });

  it('enforces the concurrent session cap', async () => {
    const { app, sessions } = makeApp(undefined, { maxConcurrentSessions: 2 });
    const url = await listen(app);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${url}/mcp`, {
          method: 'POST',
          headers: initHeaders,
          body: JSON.stringify(initBody),
        }).then(async (r) => {
          await r.text();
          return r.status;
        }),
      ),
    );

    expect(results.filter((s) => s === 200).length).toBeLessThanOrEqual(2);
    expect(results.filter((s) => s === 503).length).toBeGreaterThan(0);
    expect(sessions.size).toBeLessThanOrEqual(2);
  });

  it('caps sessions per API key without locking out other keys', async () => {
    const { app, sessions } = makeApp(undefined, { maxSessionsPerApiKey: 2 });
    const url = await listen(app);
    const init = (apiKey: string) =>
      fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { ...initHeaders, 'X-API-Key': apiKey },
        body: JSON.stringify(initBody),
      }).then(async (r) => ({ status: r.status, body: await r.text() }));

    const first = await Promise.all(Array.from({ length: 4 }, () => init(API_KEY)));
    expect(first.filter((r) => r.status === 200)).toHaveLength(2);
    const refused = first.filter((r) => r.status === 429);
    expect(refused).toHaveLength(2);
    expect(JSON.parse(refused[0].body)).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32000 } });

    // The other key still gets its own sessions.
    expect((await init(SECOND_KEY)).status).toBe(200);
    expect(sessions.size).toBe(3);
  });

  it('frees a per-key slot when that key closes a session', async () => {
    const { app, sessions } = makeApp(undefined, { maxSessionsPerApiKey: 1 });
    const url = await listen(app);
    const init = () =>
      fetch(`${url}/mcp`, { method: 'POST', headers: initHeaders, body: JSON.stringify(initBody) });

    const opened = await init();
    await opened.text();
    const sid = opened.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    const blocked = await init();
    await blocked.text();
    expect(blocked.status).toBe(429);

    const closed = await fetch(`${url}/mcp`, {
      method: 'DELETE',
      headers: { 'X-API-Key': API_KEY, 'mcp-session-id': sid as string },
    });
    await closed.text();
    expect(sessions.size).toBe(0);

    const reopened = await init();
    await reopened.text();
    expect(reopened.status).toBe(200);
  });

  it('releases the slot when initialize does not complete', async () => {
    const { app, sessions } = makeApp(
      () =>
        ({
          connect: () => Promise.reject(new Error('connect failed')),
          close: vi.fn().mockResolvedValue(undefined),
        }) as unknown as McpServer,
    );
    const url = await listen(app);

    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify(initBody),
    });

    expect(res.status).toBe(500);
    expect(sessions.size).toBe(0);
  });

  it('binds a session to the API key that created it', async () => {
    const { app } = makeApp();
    const url = await listen(app);

    const init = await fetch(`${url}/mcp`, { method: 'POST', headers: initHeaders, body: JSON.stringify(initBody) });
    expect(init.status).toBe(200);
    await init.text();
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const listBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const otherKey = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...initHeaders, 'X-API-Key': SECOND_KEY, 'mcp-session-id': sessionId! },
      body: listBody,
    });
    expect(otherKey.status).toBe(403);

    const sameKey = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...initHeaders, 'mcp-session-id': sessionId! },
      body: listBody,
    });
    expect(sameKey.status).toBe(200);
    await sameKey.text();
  });

  it('closes idle sessions via the sweep', async () => {
    const { app, sessions } = makeApp(undefined, {
      sessionIdleTimeoutMs: 50,
      sessionSweepIntervalMs: 25,
    });
    const url = await listen(app);

    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify(initBody),
    });
    expect(res.status).toBe(200);
    expect(sessions.size).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sessions.size).toBe(0);
  });
});

describe('host allowlist', () => {
  const GATEWAY_HOST = '127.0.0.1:3101';

  /** `fetch` cannot set Host, so these tests go through node:http. */
  function send(
    url: string,
    host: string | undefined,
    options: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${url}${options.path ?? '/mcp'}`,
        { method: options.method ?? 'GET', headers: { ...(host === undefined ? {} : { Host: host }), ...options.headers } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end(options.body);
    });
  }

  it('lets an allowed Host through to authentication, ignoring case', async () => {
    const url = await listen(makeApp(undefined, { allowedHosts: [GATEWAY_HOST] }).app);

    const unauthenticated = await send(url, GATEWAY_HOST.toUpperCase());
    expect(unauthenticated.status).toBe(401);

    const authenticated = await send(url, '127.0.0.1:3101', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
    });
    expect(authenticated.status).toBe(400);
  });

  it('matches allowed hosts written in any case', async () => {
    const url = await listen(makeApp(undefined, { allowedHosts: ['Gateway.Test:3101'] }).app);
    expect((await send(url, 'gateway.test:3101')).status).toBe(401);
  });

  it('answers 403 with a JSON-RPC error for a foreign Host, valid API key or not', async () => {
    const url = await listen(makeApp(undefined, { allowedHosts: [GATEWAY_HOST] }).app);

    const res = await send(url, 'evil.example:3101', { headers: { 'X-API-Key': API_KEY } });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Forbidden: Host header not allowed' },
    });
  });

  /** An HTTP/1.0 request on a raw socket: node:http would add a Host header of its own, and HTTP/1.0 allows none. */
  function sendWithoutHost(url: string, path = '/mcp'): Promise<{ status: number; head: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(Number(new URL(url).port), '127.0.0.1');
      let head = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (head += chunk));
      socket.on('end', () => resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0), head }));
      socket.on('error', reject);
      socket.write(`GET ${path} HTTP/1.0\r\n\r\n`);
    });
  }

  it('compares the port too and refuses a missing Host', async () => {
    const url = await listen(makeApp(undefined, { allowedHosts: [GATEWAY_HOST] }).app);

    expect((await send(url, '127.0.0.1:3102')).status).toBe(403);
    expect((await send(url, '127.0.0.1')).status).toBe(403);
    // HTTP/1.0 allows a request without Host; it is not on the list either, and gets no further than the check.
    const withoutHost = await sendWithoutHost(url);
    expect(withoutHost.status).toBe(403);
    expect(withoutHost.head).toContain('Host header not allowed');
    expect((await sendWithoutHost(url, '/health')).status).toBe(403);
  });

  it('also guards the unauthenticated health endpoints', async () => {
    const url = await listen(makeApp(undefined, { allowedHosts: [GATEWAY_HOST] }).app);

    for (const path of ['/health', '/live']) {
      expect((await send(url, 'evil.example', { path })).status).toBe(403);
      expect((await send(url, GATEWAY_HOST, { path })).status).toBe(200);
    }
  });

  it('refuses a foreign Host before it can spend rate-limit budget', async () => {
    const url = await listen(makeApp(undefined, { allowedHosts: [GATEWAY_HOST], rateLimitMaxRequests: 1 }).app);

    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await send(url, 'evil.example')).status).toBe(403);
    }
    expect((await send(url, GATEWAY_HOST)).status).toBe(401);
  });

  it('creates no session for a foreign Host', async () => {
    let created = 0;
    const { app, sessions } = makeApp(() => {
      created += 1;
      return new McpServer({ name: 'test', version: '0.0.0' });
    }, { allowedHosts: [GATEWAY_HOST] });
    const url = await listen(app);

    const res = await send(url, 'evil.example', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } },
      }),
    });

    expect(res.status).toBe(403);
    expect(created).toBe(0);
    expect(sessions.size).toBe(0);
  });

  it('applies no Host check when the option is omitted', async () => {
    const url = await listen(makeApp().app);

    expect((await send(url, 'anything.example:1')).status).toBe(401);
    expect((await send(url, 'anything.example:1', { path: '/health' })).status).toBe(200);
  });
});

describe('server factory', () => {
  it('serves sessions from the SDK low-level Server as well as McpServer', async () => {
    const { app, sessions } = makeApp(() => new ProtocolServer({ name: 'low-level', version: '0.0.0' }, { capabilities: {} }));
    const url = await listen(app);

    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } },
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('low-level');
    expect(sessions.size).toBe(1);
  });
});

describe('rate limiting', () => {
  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', ...headers },
      body,
    });

  it('answers 429 with a JSON-RPC error once the budget is spent, and never throttles the health probes', async () => {
    const { app } = makeApp(undefined, { rateLimitMaxRequests: 2 });
    const url = await listen(app);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect((await post(url, body)).status).toBe(400);
    expect((await post(url, body)).status).toBe(400);
    const limited = await post(url, body);
    expect(limited.status).toBe(429);
    const limitedBody = (await limited.json()) as { error: { code: number; message: string } };
    expect(limitedBody.error.code).toBe(-32029);
    expect(limitedBody.error.message).toMatch(/^Too many requests from this address\. Retry in \d+ seconds\.$/);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/live`)).status).toBe(200);
  });

  it('counts malformed and oversized bodies against the budget before parsing them', async () => {
    const { app } = makeApp(undefined, { rateLimitMaxRequests: 2 });
    const url = await listen(app);

    expect((await post(url, '{not json')).status).toBe(400);
    expect((await post(url, JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }))).status).toBe(413);
    expect((await post(url, '{not json')).status).toBe(429);
  });

  it('counts unauthenticated requests too, so a key cannot be guessed at full speed', async () => {
    const { app } = makeApp(undefined, { rateLimitMaxRequests: 2 });
    const url = await listen(app);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    expect((await post(url, body, { 'X-API-Key': 'guess-1' })).status).toBe(401);
    expect((await post(url, body, { 'X-API-Key': 'guess-2' })).status).toBe(401);
    expect((await post(url, body, { 'X-API-Key': API_KEY })).status).toBe(429);
  });

  it('ignores X-Forwarded-For unless proxy hops are trusted', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const untrusted = await listen(makeApp(undefined, { rateLimitMaxRequests: 1 }).app);
    expect((await post(untrusted, body, { 'X-Forwarded-For': '203.0.113.1' })).status).toBe(400);
    // A forged header does not buy a fresh bucket.
    expect((await post(untrusted, body, { 'X-Forwarded-For': '203.0.113.2' })).status).toBe(429);

    const behindProxy = await listen(makeApp(undefined, { rateLimitMaxRequests: 1, trustProxyHops: 1 }).app);
    expect((await post(behindProxy, body, { 'X-Forwarded-For': '203.0.113.1' })).status).toBe(400);
    // The proxy's view of the client decides the bucket.
    expect((await post(behindProxy, body, { 'X-Forwarded-For': '203.0.113.2' })).status).toBe(400);
    expect((await post(behindProxy, body, { 'X-Forwarded-For': '203.0.113.1' })).status).toBe(429);
  });
});

describe('admin routes and fallbacks', () => {
  function adminRouter(handlers: Record<string, (req: Request, res: Response) => void>): Router {
    const router = express.Router();
    for (const [route, handler] of Object.entries(handlers)) router.get(route, handler);
    return router;
  }

  it('mounts admin routes ahead of API-key auth and the body parser, so they check their own credential', async () => {
    let ready = false;
    const { app } = makeApp(undefined, {
      admin: {
        router: adminRouter({ '/whoami': (req, res) => res.json({ apiKeyName: res.locals.apiKeyName ?? null, admin: req.headers['x-admin-key'] ?? null }) }),
      },
      readiness: { isReady: () => ready },
    });
    const url = await listen(app);

    const res = await fetch(`${url}/admin/whoami`, { headers: { 'X-Admin-Key': 'adm_x' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apiKeyName: null, admin: 'adm_x' });
    ready = true;
    expect((await fetch(`${url}/mcp`)).status).toBe(401);
  });

  it('answers 504 when nothing is sent in time, and drops the late failure without a second response', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const { app, sessions } = makeApp(
      () =>
        ({
          // A server stuck past the response timer, which then fails.
          connect: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late failure')), 150)),
          close,
        }) as unknown as McpServer,
      { requestTimeoutMs: 50 },
    );
    const url = await listen(app);

    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
      }),
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Request timed out' } });

    // The reserved slot is released once the stuck initialize finally fails.
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(sessions.size).toBe(0);
  });

  it('answers 500 with a generic JSON-RPC error when a handler throws, without echoing the message', async () => {
    const { app } = makeApp(undefined, {
      admin: {
        router: adminRouter({
          '/boom': () => {
            throw new Error('secret detail /srv/app');
          },
        }),
      },
    });
    const url = await listen(app);

    const res = await fetch(`${url}/admin/boom`, { headers: { 'X-API-Key': API_KEY } });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    expect(text).not.toContain('secret detail');
  });

  it('answers 404 for an unknown path only after authentication', async () => {
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(401);
    const res = await fetch(`${baseUrl}/nope`, { headers: { 'X-API-Key': API_KEY } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found. MCP endpoint is at /mcp' });
  });

  it('rejects a malformed JSON body with a JSON-RPC parse error', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: '{"jsonrpc":',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  });
});

describe('json-rpc envelope edge cases', () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('rejects an empty batch and a batch holding a non-object', async () => {
    for (const body of [[], [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 7]]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ id: null, error: { code: -32600 } });
    }
  });

  it('echoes the id of an invalid single request', async () => {
    const res = await post({ jsonrpc: '1.0', id: 'abc', method: 'tools/list' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ id: 'abc', error: { code: -32600 } });
  });

  it('echoes the first id of a batch sent without a session, and none for a notification', async () => {
    const batch = await post([
      { jsonrpc: '2.0', id: 42, method: 'tools/list' },
      { jsonrpc: '2.0', id: 43, method: 'prompts/list' },
    ]);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toMatchObject({ id: 42, error: { code: -32600 } });

    const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(400);
    expect(await notification.json()).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('refuses a GET without a session and an unknown session id', async () => {
    const get = await fetch(`${baseUrl}/mcp`, { headers: { 'X-API-Key': API_KEY, Accept: 'text/event-stream' } });
    expect(get.status).toBe(400);

    const unknown = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': 'no-such-session' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Session not found. Please reconnect.' });
  });
});

describe('startHttpServer', () => {
  const options = {
    port: 0,
    host: '127.0.0.1',
    apiKeys: [{ name: 'test', key: API_KEY }],
    version: '0.1.0',
    rateLimitMaxRequests: 100,
    rateLimitWindowMs: 60_000,
    requestTimeoutMs: 5_000,
  };
  const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

  it('resolves once listening and closes every session on demand', async () => {
    const closed = vi.fn().mockResolvedValue(undefined);
    const running = startHttpServer(() => {
      const mcp = new McpServer({ name: 'test', version: '0.0.0' });
      const original = mcp.close.bind(mcp);
      mcp.close = async () => {
        closed();
        await original();
      };
      return mcp;
    }, options);
    await running.listening;
    const { port } = running.server.address() as AddressInfo;

    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
      }),
    });
    expect(init.status).toBe(200);
    await init.text();

    running.closeAllSessions();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    await close(running.server);
  });

  it('rejects when the port is taken', async () => {
    const first = startHttpServer(() => new McpServer({ name: 'test', version: '0.0.0' }), options);
    await first.listening;
    const { port } = first.server.address() as AddressInfo;

    const second = startHttpServer(() => new McpServer({ name: 'test', version: '0.0.0' }), { ...options, port });
    await expect(second.listening).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await close(first.server);
  });
});
