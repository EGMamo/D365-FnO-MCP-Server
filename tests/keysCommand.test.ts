import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keysCommand, normalizeServerUrl } from '../src/cli/keys.js';
import { createKeyAdminRouter } from '../src/server/adminRoutes.js';
import { digestKey } from '../src/server/apiKeys.js';
import { createHttpApp } from '../src/server/httpTransport.js';
import { createKeyRegistry, type KeyRegistry } from '../src/server/keyRegistry.js';
import { createFileRegistryStore } from '../src/server/keyRegistryFile.js';
import { logger } from '../src/utils/logger.js';

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections(); })));
});

describe('normalizeServerUrl', () => {
  it.each([
    ['contoso.azurewebsites.net', 'https://contoso.azurewebsites.net'],
    ['https://contoso.azurewebsites.net/mcp', 'https://contoso.azurewebsites.net'],
    ['https://contoso.azurewebsites.net/', 'https://contoso.azurewebsites.net'],
    ['http://127.0.0.1:3000/mcp', 'http://127.0.0.1:3000'],
  ])('reads %s as %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each(['http://contoso.example.com', 'https://user:pw@contoso.example.com', 'not a url at all'])('refuses %s', (input) => {
    expect(() => normalizeServerUrl(input)).toThrow();
  });
});

describe('keys', () => {
  let root: string;
  let registry: KeyRegistry;
  let admin: string;
  let url: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void out.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void err.push(args.join(' ')));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-command-'));
    registry = await createKeyRegistry(createFileRegistryStore(path.join(root, 'registry.json')), { pollMs: 0 });
    admin = await registry.resetAdmin();
    const app = createHttpApp(() => new McpServer({ name: 't', version: '0' }), {
      port: 0,
      apiKeys: [],
      registryKeys: registry,
      admin: { router: createKeyAdminRouter({ registry, staticKeys: [], trustProxyHops: 0 }) },
      version: '0',
      rateLimitMaxRequests: 1000,
      rateLimitWindowMs: 60_000,
      requestTimeoutMs: 5000,
    });
    const server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, '127.0.0.1', () => resolve(created));
    });
    servers.push(server);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterEach(() => {
    registry.stop();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (positionals: string[], flags: Record<string, string | boolean> = {}, env: NodeJS.ProcessEnv = { D365_MCP_ADMIN_KEY: admin }) =>
    keysCommand({ positionals, flags, env });

  it('new prints the key once and the developer command without the key in it', async () => {
    expect(await run(['new', 'alice'], { server: url })).toBe(0);
    const text = out.join('\n');
    const key = /\b([0-9a-f]{64})\b/.exec(text)?.[1] ?? '';
    expect(registry.developerKeys().get(digestKey(key))).toBe('alice');
    expect(text).toContain('Key for alice (shown once; the server keeps only its fingerprint):');
    const command = out.find((line) => line.includes('d365-fno-mcp setup --mode hosted'));
    expect(command?.trim()).toBe(`d365-fno-mcp setup --mode hosted --hosted-url ${url}`);
    expect(command).not.toContain(key);
  });

  it('list shows names and dates, revoke removes a key, and an unknown name is exit 1', async () => {
    await run(['new', 'bob'], { server: url });
    out.length = 0;
    expect(await run(['list'], { server: url })).toBe(0);
    expect(out.join('\n')).toMatch(/bob\s+\d{4}-\d{2}-\d{2}/);
    expect(await run(['revoke', 'bob'], { server: url })).toBe(0);
    expect(out.join('\n')).toContain('Revoked bob. Its sessions have ended.');
    expect(registry.developerKeys().size).toBe(0);
    expect(await run(['revoke', 'bob'], { server: url })).toBe(1);
    expect(err.join('\n')).toContain('There is no key named bob.');
  });

  it('reads the admin key from a file, and never from a command-line value', async () => {
    const file = path.join(root, 'admin.key');
    fs.writeFileSync(file, `${admin}\n`);
    expect(await run(['list'], { server: url, 'admin-key-file': file }, {})).toBe(0);
    expect(await run(['list'], { server: url, 'admin-key': admin }, {})).toBe(1);
    expect(err.join('\n')).toContain('--admin-key is not accepted');
    expect(err.join('\n')).not.toContain(admin);
  });

  it('says what is wrong with a wrong admin key, a missing server or name, and an unknown action', async () => {
    expect(await run(['list'], { server: url }, { D365_MCP_ADMIN_KEY: `adm_${'1'.repeat(64)}` })).toBe(1);
    expect(err.join('\n')).toContain('Admin key required');
    expect(await run(['list'])).toBe(1);
    expect(err.join('\n')).toContain('--server is required');
    expect(await run(['new'], { server: url })).toBe(1);
    expect(err.join('\n')).toContain('keys new needs a name');
    expect(await run(['rotate'], { server: url })).toBe(1);
    expect(err.join('\n')).toContain('Unknown keys action: rotate');
    expect(await run(['list'], { server: url }, {})).toBe(1);
    expect(err.join('\n')).toContain('D365_MCP_ADMIN_KEY');
  });

  it('reset-admin on a file registry prints a new admin key once and keeps the developer keys', async () => {
    await run(['new', 'carol'], { server: url });
    const file = path.join(root, 'registry.json');
    out.length = 0;
    expect(await run(['reset-admin'], { registry: 'file', path: file }, {})).toBe(0);
    const text = out.join('\n');
    const fresh = /\b(adm_[0-9a-f]{64})\b/.exec(text)?.[1] ?? '';
    expect(fresh).not.toBe(admin);
    expect(text).toContain('Save this admin key now. It manages developer keys and is not shown again.');
    await registry.checkNow();
    expect(registry.adminDigest()).toBe(digestKey(fresh));
    expect([...registry.developerKeys().values()]).toEqual(['carol']);
  });

  it('reset-admin needs the registry flags', async () => {
    expect(await run(['reset-admin'], {}, {})).toBe(1);
    expect(err.join('\n')).toContain('--registry file --path <file> or --registry azure-blob --account-url <url>');
  });
});
