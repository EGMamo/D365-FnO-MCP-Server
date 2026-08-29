import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApp } from '../src/server/httpTransport.js';

const API_KEY = 'test-api-key-1234567890';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createHttpApp(
    () => new McpServer({ name: 'test', version: '0.0.0' }),
    {
      port: 0,
      mcpApiKey: API_KEY,
      version: '0.1.0',
      rateLimitMaxRequests: 10_000,
      rateLimitWindowMs: 60_000,
      requestTimeoutMs: 5_000,
    },
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
