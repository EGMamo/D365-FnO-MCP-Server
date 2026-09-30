import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApp } from '../src/server/httpTransport.js';

const API_KEY = 'test-api-key-1234567890-abcdefghijklmnop';
const SECOND_KEY = 'second-api-key-0987654321-zyxwvutsrqpon';

let server: Server;
let baseUrl: string;
const extraServers: Server[] = [];

function makeApp(
  factory: () => McpServer = () => new McpServer({ name: 'test', version: '0.0.0' }),
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
