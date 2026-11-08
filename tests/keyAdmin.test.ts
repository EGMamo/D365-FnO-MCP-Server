import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyAdminRouter } from '../src/server/adminRoutes.js';
import { createHttpApp } from '../src/server/httpTransport.js';
import { createKeyRegistry, type KeyRegistry } from '../src/server/keyRegistry.js';
import { createFileRegistryStore } from '../src/server/keyRegistryFile.js';
import { logger } from '../src/utils/logger.js';

const STATIC_KEY = 'static-key-0123456789-0123456789-abcdef';
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        })
    )
  );
});

interface Harness {
  url: string;
  registry: KeyRegistry;
  admin: string;
  sessions: Map<string, unknown>;
  file: string;
}

async function start(options: { allowLoopback?: boolean; trustProxyHops?: number; maxSessionsPerApiKey?: number; maxConcurrentSessions?: number; rateLimit?: { max: number; windowMs: number } } = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-admin-'));
  const file = path.join(root, 'key-registry.json');
  const registry = await createKeyRegistry(createFileRegistryStore(file), { pollMs: 0 });
  const admin = await registry.resetAdmin();
  const staticKeys = [{ name: 'ci-smoke', key: STATIC_KEY }];
  const app = createHttpApp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
    port: 0,
    apiKeys: staticKeys,
    registryKeys: registry,
    admin: {
      router: createKeyAdminRouter({
        registry,
        staticKeys,
        trustProxyHops: options.trustProxyHops ?? 0,
        allowLoopback: options.allowLoopback,
        rateLimit: options.rateLimit,
      }),
    },
    version: '0.1.0',
    rateLimitMaxRequests: 10_000,
    rateLimitWindowMs: 60_000,
    requestTimeoutMs: 5_000,
    trustProxyHops: options.trustProxyHops ?? 0,
    maxConcurrentSessions: options.maxConcurrentSessions ?? 100,
    maxSessionsPerApiKey: options.maxSessionsPerApiKey ?? 0,
    sessionIdleTimeoutMs: 30 * 60_000,
  });
  const server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    registry,
    admin,
    sessions: app.locals.sessions as Map<string, unknown>,
    file,
  };
}

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

async function connect(url: string, key: string): Promise<Client> {
  const client = new Client({ name: 'key-admin-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { 'X-API-Key': key } } }));
  return client;
}

describe('key administration API', () => {
  let h: Harness;
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    h = await start();
  });
  afterEach(() => {
    h.registry.stop();
    vi.restoreAllMocks();
  });

  const api = (method: string, route: string, headers: Record<string, string> = {}, body?: unknown) =>
    fetch(`${h.url}/admin/api${route}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('creates a key shown once, which opens /mcp at once, and lists it with the static keys', async () => {
    const created = await api('POST', '/keys', { 'X-Admin-Key': h.admin }, { name: 'alice' });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const { name, key } = (await created.json()) as { name: string; key: string };
    expect(name).toBe('alice');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(h.file, 'utf8')).not.toContain(key);

    const client = await connect(h.url, key);
    await client.close();

    const list = await json(await api('GET', '/keys', { 'X-Admin-Key': h.admin }));
    expect(list.keys).toEqual([
      { name: 'alice', createdAt: expect.any(String), source: 'registry' },
      { name: 'ci-smoke', createdAt: null, source: 'settings' },
    ]);
    expect(JSON.stringify(list)).not.toContain(key);

    const audit = JSON.stringify(info.mock.calls);
    expect(audit).toContain('"action":"create"');
    expect(audit).toContain('"name":"alice"');
    expect(audit).not.toContain(key);
    expect(audit).not.toContain(h.admin);
  });

  it('refuses no admin key, a wrong one and a developer key, and logs the refusals without the keys', async () => {
    const created = (await (await api('POST', '/keys', { 'X-Admin-Key': h.admin }, { name: 'bob' })).json()) as { key: string };

    const none = await api('GET', '/keys');
    expect(none.status).toBe(401);
    expect(await json(none)).toEqual({ error: 'Admin key required: send it as X-Admin-Key.' });
    expect((await api('GET', '/keys', { 'X-Admin-Key': `adm_${'0'.repeat(64)}` })).status).toBe(401);
    const developerAttempts: Record<string, string>[] = [{ 'X-Admin-Key': created.key }, { 'X-API-Key': created.key }, { 'X-Admin-Key': STATIC_KEY }];
    for (const headers of developerAttempts) {
      const refused = await api('GET', '/keys', headers);
      expect(refused.status).toBe(403);
      expect(await json(refused)).toEqual({ error: 'This is a developer key; key management needs the admin key.' });
    }
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('Key administration refused');
    expect(logged).not.toContain(created.key);
    expect(logged).not.toContain(STATIC_KEY);
  });

  it('keeps the admin key off /mcp', async () => {
    const res = await fetch(`${h.url}/mcp`, { headers: { 'X-API-Key': h.admin } });
    expect(res.status).toBe(401);
  });

  it('answers 400 for a bad name, 409 for a taken or static one, 404 for an unknown one, 413 for a big body', async () => {
    const auth = { 'X-Admin-Key': h.admin };
    expect((await api('POST', '/keys', auth, { name: 'a b' })).status).toBe(400);
    expect((await api('POST', '/keys', auth, {})).status).toBe(400);
    expect((await api('POST', '/keys', auth, { name: 'carol' })).status).toBe(201);
    const again = await api('POST', '/keys', auth, { name: 'carol' });
    expect(again.status).toBe(409);
    expect(String((await json(again)).error)).toContain('carol already has a key');
    expect((await api('POST', '/keys', auth, { name: 'ci-smoke' })).status).toBe(409);
    expect((await api('DELETE', '/keys/ci-smoke', auth)).status).toBe(409);
    expect((await api('DELETE', '/keys/nobody', auth)).status).toBe(404);
    expect((await api('POST', '/keys', auth, { name: 'x'.repeat(2000) })).status).toBe(413);
  });

  it('revokes a key: 401 at once, and the sessions it opened are closed while others stay', async () => {
    const auth = { 'X-Admin-Key': h.admin };
    const dave = (await (await api('POST', '/keys', auth, { name: 'dave' })).json()) as { key: string };
    const erin = (await (await api('POST', '/keys', auth, { name: 'erin' })).json()) as { key: string };
    const daveClient = await connect(h.url, dave.key);
    const erinClient = await connect(h.url, erin.key);
    const staticClient = await connect(h.url, STATIC_KEY);
    expect(h.sessions.size).toBe(3);

    expect((await api('DELETE', '/keys/dave', auth)).status).toBe(204);
    expect(h.sessions.size).toBe(2);
    const after = await fetch(`${h.url}/mcp`, { headers: { 'X-API-Key': dave.key } });
    expect(after.status).toBe(401);
    expect(await json(after)).toEqual({
      error: 'Unauthorized: the API key was not recognized. It may have been revoked; ask your operator for a new key.',
    });
    await expect(erinClient.ping()).resolves.toBeDefined();
    await Promise.allSettled([daveClient.close(), erinClient.close(), staticClient.close()]);
  });

  it('closes the sessions of a key revoked on another replica once the registry is re-read', async () => {
    const auth = { 'X-Admin-Key': h.admin };
    const frank = (await (await api('POST', '/keys', auth, { name: 'frank' })).json()) as { key: string };
    const client = await connect(h.url, frank.key);
    const other = await createKeyRegistry(createFileRegistryStore(h.file), { pollMs: 0 });
    // A different mtime, so the file's version visibly changes.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await other.revokeKey('frank');
    expect(h.sessions.size).toBe(1);
    await h.registry.checkNow();
    expect(h.sessions.size).toBe(0);
    await client.close().catch(() => undefined);
  });

  it('serves the page with a fresh nonce in a strict CSP, no external resource and no key in it', async () => {
    const first = await fetch(`${h.url}/admin`);
    const second = await fetch(`${h.url}/admin`);
    expect(first.status).toBe(200);
    const csp = first.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/^default-src 'none'; script-src 'nonce-[A-Za-z0-9+/=]+'; style-src 'nonce-/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toBe(second.headers.get('content-security-policy'));
    const html = await first.text();
    const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(csp)?.[1];
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toMatch(/https?:\/\/(?!")/);
    expect(html).not.toMatch(/localStorage|sessionStorage|innerHTML/);
    expect(html).not.toContain(h.admin);
  });
});

describe('key administration rules', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses plain HTTP that is not from this machine', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = await start({ allowLoopback: false });
    const res = await fetch(`${h.url}/admin/api/keys`, { headers: { 'X-Admin-Key': h.admin } });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: 'Key management is served over HTTPS only.' });
    // Behind a trusted proxy that says the client used HTTPS, it answers.
    const proxied = await start({ allowLoopback: false, trustProxyHops: 1 });
    const ok = await fetch(`${proxied.url}/admin/api/keys`, { headers: { 'X-Admin-Key': proxied.admin, 'X-Forwarded-Proto': 'https' } });
    expect(ok.status).toBe(200);
    const plain = await fetch(`${proxied.url}/admin/api/keys`, { headers: { 'X-Admin-Key': proxied.admin, 'X-Forwarded-Proto': 'http' } });
    expect(plain.status).toBe(403);
    h.registry.stop();
    proxied.registry.stop();
  });

  it('limits admin requests per address', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const h = await start({ rateLimit: { max: 2, windowMs: 60_000 } });
    for (let i = 0; i < 2; i++) expect((await fetch(`${h.url}/admin/api/keys`, { headers: { 'X-Admin-Key': h.admin } })).status).toBe(200);
    const limited = await fetch(`${h.url}/admin/api/keys`, { headers: { 'X-Admin-Key': h.admin } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    h.registry.stop();
  });

  it('says there is no admin key yet on a new registry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-admin-empty-'));
    const registry = await createKeyRegistry(createFileRegistryStore(path.join(root, 'r.json')), { pollMs: 0 });
    const app = createHttpApp(() => new McpServer({ name: 't', version: '0' }), {
      port: 0,
      apiKeys: [],
      registryKeys: registry,
      admin: { router: createKeyAdminRouter({ registry, staticKeys: [], trustProxyHops: 0 }) },
      version: '0',
      rateLimitMaxRequests: 100,
      rateLimitWindowMs: 60_000,
      requestTimeoutMs: 5_000,
    });
    const server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created));
    });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/api/keys`, { headers: { 'X-Admin-Key': 'adm_x' } });
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ error: 'No admin key yet: run keys reset-admin.' });
    registry.stop();
  });

  it('sends Retry-After: 30 and the idle minutes on both session caps', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const perKey = await start({ maxSessionsPerApiKey: 1 });
    const first = await connect(perKey.url, STATIC_KEY);
    const init = {
      method: 'POST',
      headers: { 'X-API-Key': STATIC_KEY, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '0' } } }),
    };
    const capped = await fetch(`${perKey.url}/mcp`, init);
    expect(capped.status).toBe(429);
    expect(capped.headers.get('retry-after')).toBe('30');
    expect(((await capped.json()) as { error: { message: string } }).error.message).toBe(
      'Too many sessions: this API key already holds its maximum number of sessions. Close one you no longer use, or wait: idle sessions end after 30 minutes.'
    );
    await first.close();

    const global = await start({ maxConcurrentSessions: 1 });
    const holder = await connect(global.url, STATIC_KEY);
    const busy = await fetch(`${global.url}/mcp`, init);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('30');
    expect(((await busy.json()) as { error: { message: string } }).error.message).toBe(
      'Server busy: the maximum number of concurrent sessions is open. Retry shortly; idle sessions end after 30 minutes.'
    );
    await holder.close();
    perKey.registry.stop();
    global.registry.stop();
  });
});
