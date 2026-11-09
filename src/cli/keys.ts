import fs from 'node:fs';
import path from 'node:path';
import type { KeyRegistry } from '../server/keyRegistry.js';
import { createPrompt } from './prompt.js';

/**
 * `keys`: developer keys of a hosted server, managed through its admin API with the admin key, plus `reset-admin`,
 * which writes the registry directly (the one path that needs access to where the registry lives). Operator package
 * only; tests/packageBoundary.test.ts keeps it out of the developer package.
 */

export interface KeysOptions {
  positionals: string[];
  flags: Readonly<Record<string, string | boolean>>;
  env?: NodeJS.ProcessEnv;
  /** Opens the registry for reset-admin; replaceable for tests and for the deploy walkthrough. */
  openRegistry?: (settings: RegistryFlags) => Promise<KeyRegistry>;
}

export type RegistryFlags = { kind: 'file'; path: string } | { kind: 'azure-blob'; accountUrl: string; container: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A problem with the command, worded to print as is. */
class KeysError extends Error {}

/** The server's origin from a host, an origin or the `/mcp` URL; https:// unless it is this machine. */
export function normalizeServerUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new KeysError('--server must be the server address, for example https://<your-app>.azurewebsites.net');
  }
  if (url.username || url.password) throw new KeysError('--server must not contain a user name or password.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new KeysError('--server must use https:// (plain http:// only for this machine).');
  }
  if (!/^[a-z0-9.[\]:-]+$/i.test(url.host) || url.hostname.includes(' ')) {
    throw new KeysError('--server must be the server address, for example https://<your-app>.azurewebsites.net');
  }
  return url.origin;
}

async function adminKeyFrom(flags: KeysOptions['flags'], env: NodeJS.ProcessEnv): Promise<string> {
  if (flags['admin-key'] !== undefined) {
    throw new KeysError('--admin-key is not accepted: a key on the command line is visible to other processes. Use D365_MCP_ADMIN_KEY or --admin-key-file.');
  }
  const file = flags['admin-key-file'];
  if (typeof file === 'string') {
    try {
      const key = fs.readFileSync(path.resolve(file), 'utf8').trim();
      if (key) return key;
    } catch (error) {
      throw new KeysError(`--admin-key-file cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    }
    throw new KeysError('--admin-key-file is empty.');
  }
  const fromEnv = env.D365_MCP_ADMIN_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    const prompt = createPrompt();
    try {
      const typed = (await prompt.ask('Admin key', { secret: true })).trim();
      if (typed) return typed;
    } finally {
      prompt.close();
    }
  }
  throw new KeysError('The admin key is needed: set D365_MCP_ADMIN_KEY, pass --admin-key-file <file>, or run this in a terminal to type it.');
}

async function callAdmin(origin: string, adminKey: string, method: string, route: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${origin}/admin/api${route}`, {
      method,
      headers: { 'X-Admin-Key': adminKey, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new KeysError(`The server at ${origin} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 204) return null;
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    const reason = typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`;
    throw new KeysError(`The server refused (HTTP ${res.status}): ${reason}`);
  }
  return data;
}

function registryFlags(flags: KeysOptions['flags']): RegistryFlags {
  const text = (name: string): string => (typeof flags[name] === 'string' ? String(flags[name]).trim() : '');
  if (text('registry') === 'file' && text('path')) return { kind: 'file', path: text('path') };
  if (text('registry') === 'azure-blob' && text('account-url')) {
    return { kind: 'azure-blob', accountUrl: text('account-url'), container: text('container') || 'd365-keys' };
  }
  throw new KeysError('keys reset-admin needs --registry file --path <file> or --registry azure-blob --account-url <url> [--container <name>].');
}

async function defaultOpenRegistry(settings: RegistryFlags): Promise<KeyRegistry> {
  const { openKeyRegistry } = await import('../server/keyRegistryOpen.js');
  return openKeyRegistry(settings);
}

/** Runs `keys <action>`; returns the exit code. Usage and server errors are exit 1 with the reason. */
export async function keysCommand(options: KeysOptions): Promise<number> {
  const env = options.env ?? process.env;
  const [action, name] = options.positionals;
  try {
    if (action === 'reset-admin') {
      const registry = await (options.openRegistry ?? defaultOpenRegistry)(registryFlags(options.flags));
      try {
        const key = await registry.resetAdmin();
        console.log('New admin key (shown once; the registry keeps only its fingerprint):');
        console.log(`  ${key}`);
        console.log('Save this admin key now. It manages developer keys and is not shown again.');
        console.log('The developer keys were kept. The old admin key stops working within a few seconds.');
      } finally {
        registry.stop();
      }
      return 0;
    }
    if (action !== 'new' && action !== 'list' && action !== 'revoke') {
      throw new KeysError(`Unknown keys action: ${action ?? '(none)'}. Use keys new <name>, keys list, keys revoke <name> or keys reset-admin.`);
    }
    const server = options.flags.server;
    if (typeof server !== 'string' || !server.trim()) throw new KeysError('--server is required: the hosted server, for example https://<your-app>.azurewebsites.net');
    const origin = normalizeServerUrl(server);
    if ((action === 'new' || action === 'revoke') && !name) throw new KeysError(`keys ${action} needs a name, for example keys ${action} alice.`);
    const adminKey = await adminKeyFrom(options.flags, env);

    if (action === 'new') {
      const created = (await callAdmin(origin, adminKey, 'POST', '/keys', { name })) as { name: string; key: string };
      console.log(`Key for ${created.name} (shown once; the server keeps only its fingerprint):`);
      console.log(`  ${created.key}`);
      console.log('Send it to the developer over a channel you trust. They run:');
      console.log(`  d365-fno-mcp setup --mode hosted --hosted-url ${origin}/mcp`);
      console.log('and paste the key when it asks.');
      return 0;
    }
    if (action === 'list') {
      const { keys } = (await callAdmin(origin, adminKey, 'GET', '/keys')) as { keys: Array<{ name: string; createdAt: string | null; source: string }> };
      if (keys.length === 0) console.log('No keys yet. Create one with keys new <name>.');
      const width = Math.max(4, ...keys.map((key) => key.name.length));
      for (const key of keys) {
        console.log(`${key.name.padEnd(width)}  ${key.source === 'settings' ? 'managed outside the server (MCP_API_KEYS)' : (key.createdAt ?? '')}`);
      }
      return 0;
    }
    await callAdmin(origin, adminKey, 'DELETE', `/keys/${encodeURIComponent(String(name))}`);
    console.log(`Revoked ${name}. Its sessions have ended.`);
    return 0;
  } catch (error) {
    if (error instanceof KeysError || (error instanceof Error && error.name === 'KeyRegistryError')) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
