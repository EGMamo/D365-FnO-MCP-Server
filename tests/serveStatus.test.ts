import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { INDEX_SCHEMA_VERSION, META_KEYS, openDb, setMeta, upsertObject } from '../src/indexer/db.js';
import { createArtifactBundle } from '../src/indexer/artifactBundle.js';
import { promoteArtifactBundle } from '../src/indexer/artifactPointers.js';
import type { ArtifactCompatibilityPolicy, ArtifactProvenance, CapabilityInventory } from '../src/indexer/artifactContract.js';
import { VERSION } from '../src/version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repoRoot, 'src', 'index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
/** 40 characters each, so a leak is easy to spot and both pass the length check. */
const aliceKey = 'serve-status-test-alice-key-'.padEnd(40, '0');
const defaultKey = 'serve-status-test-default-key-'.padEnd(40, '1');
const TIMEOUT_MS = 120_000;
const WAIT_MS = 90_000;
const BUILT_AT = '2026-10-24T22:10:00.000Z';
const CREATED_AT = '2026-10-24T21:40:00.000Z';

interface Serve {
  child: ChildProcess;
  stderr(): string;
}

let root: string;
const children: ChildProcess[] = [];
const clients: Client[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-serve-status-'));
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A local index with one object and the given metadata. */
function localIndex(file: string, meta: { version?: string; source?: string } = {}): void {
  const db = openDb(file);
  upsertObject(db, {
    type: 'Class',
    name: 'StatusFixture',
    package: 'ApplicationSuite',
    model: 'ApplicationSuite',
    file_path: path.join(root, 'Fixture.xml'),
    raw_xml: '<AxClass><Name>StatusFixture</Name></AxClass>',
    file_mtime: 1,
  });
  setMeta(db, META_KEYS.builtAt, BUILT_AT);
  setMeta(db, META_KEYS.serverVersion, VERSION);
  setMeta(db, META_KEYS.schemaVersion, String(INDEX_SCHEMA_VERSION));
  setMeta(db, META_KEYS.storeRawXml, '1');
  if (meta.version) setMeta(db, META_KEYS.appVersion, meta.version);
  if (meta.source) setMeta(db, META_KEYS.appVersionSource, meta.source);
  db.close();
}

/** Runs `serve` from source in a temp directory, so no repo `.env` is loaded and nothing needs a build. */
function startServe(extraEnv: Record<string, string>): Serve {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string' && !/^(D365_|MCP_|DOTENV_)/.test(pair[0])
    )
  );
  const child = spawn(process.execPath, ['--import', tsx, entry, 'serve'], {
    cwd: root,
    env: {
      ...inherited,
      MCP_API_KEYS: `alice=${aliceKey}`,
      MCP_API_KEY: defaultKey,
      MCP_PORT: '0',
      // Loopback only: these keys are written in this file, so nothing else on the network may reach the server.
      MCP_HOST: '127.0.0.1',
      D365_KNOWLEDGE_FILTER: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return { child, stderr: () => stderr };
}

/** The complete structured log lines so far. */
function logLines(stderr: string): Array<{ message?: string; port?: number }> {
  return stderr
    .split('\n')
    .slice(0, -1)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { message?: string; port?: number });
}

async function waitFor<T>(serve: Serve, probe: () => T | null, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    const { exitCode, signalCode } = serve.child;
    if (exitCode !== null || signalCode !== null) {
      throw new Error(`serve exited (${exitCode ?? signalCode}) before ${what}. Log:\n${serve.stderr()}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Log:\n${serve.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The port, once the server both listens and reports ready (local servers are ready at once; hosted ones log it). */
async function readyPort(serve: Serve, hosted: boolean): Promise<number> {
  const port = await waitFor(
    serve,
    () => logLines(serve.stderr()).find((line) => line.message === 'MCP HTTP transport listening' && typeof line.port === 'number')?.port ?? null,
    'the listening log line'
  );
  if (hosted) await waitFor(serve, () => (logLines(serve.stderr()).some((line) => line.message === 'MCP server ready') ? true : null), 'the ready log line');
  return port;
}

interface StatusDocument {
  status: string;
  you: unknown;
  server: { version: string; startedAt: string; uptimeSeconds: number };
  index: unknown;
  artifact: unknown;
  sessions: unknown;
}

const statusOf = (port: number, key: string) => fetch(`http://127.0.0.1:${port}/status`, { headers: { 'X-API-Key': key } });

async function connect(port: number, key: string): Promise<Client> {
  const client = new Client({ name: 'serve-status-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { 'X-API-Key': key } } }));
  return client;
}

async function statsOf(client: Client): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: 'get_index_stats', arguments: {} });
  const content = result.content;
  if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('get_index_stats did not return text.');
  return JSON.parse(content[0].text as string) as Record<string, unknown>;
}

describe('a local server tells what it is serving', () => {
  it('answers /status for an authenticated caller, and sends the indexed version in a header', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index, { version: '10.0.2428.63', source: 'packages-dir' });
    const serve = startServe({ D365_INDEX_DB_PATH: index });
    const port = await readyPort(serve, false);

    const res = await statusOf(port, aliceKey);
    const text = await res.text();
    const document = JSON.parse(text) as StatusDocument;

    expect(res.status).toBe(200);
    expect(res.headers.get('x-d365-index-version')).toBe('10.0.2428.63');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(document.status).toBe('ok');
    expect(document.you).toEqual({ keyName: 'alice' });
    expect(document.server.version).toBe(VERSION);
    expect(document.server.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(new Date(document.server.startedAt as string).getTime()).toBeLessThanOrEqual(Date.now());
    expect(document.index).toEqual({
      applicationVersion: '10.0.2428.63',
      applicationVersionSource: 'packages-dir',
      builtAt: BUILT_AT,
      schemaVersion: INDEX_SCHEMA_VERSION,
      objects: 1,
      labels: 0,
    });
    expect(document.artifact).toBeNull();
    expect(document.sessions).toEqual({ active: 0, max: 100, maxPerKey: 0 });
    expect(text).not.toContain(aliceKey);
    expect(text).not.toContain(defaultKey);
    expect(text).not.toContain(root);
  }, TIMEOUT_MS);

  it('names the key that asked, whichever of the configured keys it is', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index, { version: '10.0.2428.63', source: 'packages-dir' });
    const serve = startServe({ D365_INDEX_DB_PATH: index });
    const port = await readyPort(serve, false);

    expect(((await (await statusOf(port, defaultKey)).json()) as { you: unknown }).you).toEqual({ keyName: 'default' });
    expect(((await (await statusOf(port, aliceKey)).json()) as { you: unknown }).you).toEqual({ keyName: 'alice' });
  }, TIMEOUT_MS);

  it('refuses /status without a key or with a wrong one, and sends no version to them', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index, { version: '10.0.2428.63', source: 'packages-dir' });
    const serve = startServe({ D365_INDEX_DB_PATH: index });
    const port = await readyPort(serve, false);

    const anonymous = await fetch(`http://127.0.0.1:${port}/status`);
    const wrong = await statusOf(port, 'wrong-key-wrong-key-wrong-key-wrong-key');

    expect(anonymous.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(anonymous.headers.get('x-d365-index-version')).toBeNull();
    expect(wrong.headers.get('x-d365-index-version')).toBeNull();
  }, TIMEOUT_MS);

  it('leaves /health exactly as it was', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index, { version: '10.0.2428.63', source: 'packages-dir' });
    const serve = startServe({ D365_INDEX_DB_PATH: index });
    const port = await readyPort(serve, false);

    const health = await fetch(`http://127.0.0.1:${port}/health`);

    expect(health.status).toBe(200);
    expect(await health.text()).toBe(`{"status":"ok","version":"${VERSION}"}`);
    expect(health.headers.get('x-d365-index-version')).toBeNull();
  }, TIMEOUT_MS);

  it('reports the application version through get_index_stats, without a bundle', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index, { version: '10.0.2428.63', source: 'packages-dir' });
    const serve = startServe({ D365_INDEX_DB_PATH: index });
    const client = await connect(await readyPort(serve, false), aliceKey);

    const stats = await statsOf(client);

    expect(stats.applicationVersion).toBe('10.0.2428.63');
    expect(stats.applicationVersionSource).toBe('packages-dir');
    expect(stats.totalObjects).toBe(1);
    expect(stats).not.toHaveProperty('artifact');
  }, TIMEOUT_MS);

  it('uses the version configured on the server when the index records none, and says so', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index);
    const serve = startServe({ D365_INDEX_DB_PATH: index, D365_APP_VERSION: '10.0.2500.1' });
    const port = await readyPort(serve, false);

    const res = await statusOf(port, aliceKey);
    const document = (await res.json()) as { index: { applicationVersion: string; applicationVersionSource: string } };

    expect(document.index.applicationVersion).toBe('10.0.2500.1');
    expect(document.index.applicationVersionSource).toBe('configured');
    expect(res.headers.get('x-d365-index-version')).toBe('10.0.2500.1');
    // The tool is registered separately from the route, so it must be given the same setting.
    const stats = await statsOf(await connect(port, aliceKey));
    expect(stats.applicationVersion).toBe('10.0.2500.1');
    expect(stats.applicationVersionSource).toBe('configured');
  }, TIMEOUT_MS);

  it('treats a configured version that is not a four-part version as unknown, and every route keeps working', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index);
    const serve = startServe({ D365_INDEX_DB_PATH: index, D365_APP_VERSION: '10.0.39 latest' });
    const port = await readyPort(serve, false);

    const res = await statusOf(port, aliceKey);
    const document = (await res.json()) as { index: { applicationVersion: unknown; applicationVersionSource: unknown } };

    expect(res.status).toBe(200);
    expect(document.index.applicationVersion).toBeNull();
    expect(document.index.applicationVersionSource).toBeNull();
    expect(res.headers.get('x-d365-index-version')).toBeNull();
    const client = await connect(port, aliceKey);
    expect((await statsOf(client)).applicationVersion).toBeNull();
  }, TIMEOUT_MS);
});

describe('a hosted server tells which bundle it activated', () => {
  const provenance: ArtifactProvenance = {
    packagesLocalDirectory: {
      sourceId: 'packages-local-directory',
      version: '10.0.2500.1',
      acquiredAt: CREATED_AT,
      sha256: 'a'.repeat(64),
      bytes: 1000,
    },
    vsixAssets: [
      { sourceId: 'unified-developer-experience-tools-vsix', version: '10.0.2500.1', acquiredAt: CREATED_AT, sha256: 'b'.repeat(64), bytes: 2000 },
    ],
    dbrefx: { sourceId: 'dbrefx-xref', version: '10.0.2500.1', acquiredAt: CREATED_AT, sha256: 'd'.repeat(64), bytes: 4000 },
    optionalInputs: [],
  };
  const capabilities: CapabilityInventory = {
    codeMetadata: { completeness: 'complete', itemCount: 1 },
    dataModelMetadata: { completeness: 'complete', itemCount: 1 },
    uiFormPatterns: { completeness: 'complete', itemCount: 0 },
    workflowServiceMetadata: { completeness: 'complete', itemCount: 0 },
    reportingAnalytics: { completeness: 'partial', itemCount: 0 },
    labelsResources: { completeness: 'complete', itemCount: 0 },
    extensions: { completeness: 'complete', itemCount: 0 },
    reports: { completeness: 'partial', itemCount: 0 },
    securityGraphs: { completeness: 'complete', itemCount: 0 },
  };
  const [major, minor] = VERSION.split('.');
  const policy: ArtifactCompatibilityPolicy = {
    serverVersion: VERSION,
    minimumIndexSchemaVersion: INDEX_SCHEMA_VERSION,
    maximumIndexSchemaVersion: INDEX_SCHEMA_VERSION,
    requiredCapabilities: ['codeMetadata', 'dataModelMetadata', 'securityGraphs'],
  };

  /** A promoted bundle in a store on disk; returns the store folder and the bundle id. */
  function publishedStore(): { store: string; bundleId: string } {
    const source = path.join(root, 'source.db');
    localIndex(source, { version: '10.0.2500.1', source: 'configured' });
    const store = path.join(root, 'store');
    const bundle = createArtifactBundle(source, store, {
      applicationVersion: '10.0.2500.1',
      sdkVersion: '10.0.2500.1',
      releaseId: 'service-update-2500',
      generatorVersion: VERSION,
      minimumServerVersion: `${major}.${minor}.0`,
      maximumServerVersion: `${major}.${minor}.99`,
      requiredCapabilities: ['codeMetadata', 'dataModelMetadata', 'securityGraphs'],
      capabilities,
      provenance,
      createdAt: CREATED_AT,
      relativePathsRoot: root,
      integrityCheck: true,
    });
    promoteArtifactBundle(store, bundle.manifest.bundleId, 0, policy, CREATED_AT);
    return { store, bundleId: bundle.manifest.bundleId };
  }

  it('describes the bundle with exactly the facts of its manifest and pointer, and no path', async () => {
    const { store, bundleId } = publishedStore();
    const serve = startServe({ D365_ARTIFACT_STORE_PATH: store, D365_INDEX_DB_PATH: path.join(root, 'runtime', 'active.db') });
    const port = await readyPort(serve, true);

    const res = await statusOf(port, aliceKey);
    const text = await res.text();
    const document = JSON.parse(text) as { status: string; artifact: unknown; index: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(document.status).toBe('ok');
    expect(document.artifact).toEqual({
      source: 'local',
      bundleId,
      pointerRevision: 1,
      createdAt: CREATED_AT,
      applicationVersion: '10.0.2500.1',
    });
    expect(document.index).toMatchObject({ applicationVersion: '10.0.2500.1', applicationVersionSource: 'configured', objects: 1 });
    expect(res.headers.get('x-d365-index-version')).toBe('10.0.2500.1');
    expect(text).not.toContain(root);
    expect(text).not.toContain('store');
    expect(text).not.toContain(aliceKey);
  }, TIMEOUT_MS);

  it('reports the live bundle through get_index_stats', async () => {
    const { store, bundleId } = publishedStore();
    const serve = startServe({ D365_ARTIFACT_STORE_PATH: store, D365_INDEX_DB_PATH: path.join(root, 'runtime', 'active.db') });
    const client = await connect(await readyPort(serve, true), aliceKey);

    const stats = await statsOf(client);

    expect(stats.applicationVersion).toBe('10.0.2500.1');
    expect(stats.artifact).toEqual({
      source: 'local',
      bundleId,
      pointerRevision: 1,
      createdAt: CREATED_AT,
      applicationVersion: '10.0.2500.1',
    });
    expect(JSON.stringify(stats)).not.toContain(root);
  }, TIMEOUT_MS);

  it('counts an open session in /status', async () => {
    const { store } = publishedStore();
    const serve = startServe({ D365_ARTIFACT_STORE_PATH: store, D365_INDEX_DB_PATH: path.join(root, 'runtime', 'active.db') });
    const port = await readyPort(serve, true);
    await connect(port, aliceKey);

    const document = (await (await statusOf(port, aliceKey)).json()) as { sessions: { active: number } };

    expect(document.sessions.active).toBe(1);
  }, TIMEOUT_MS);
});

describe('a server with a key registry', () => {
  it('takes keys made with keys new at once, reports the registry in /status, and refuses a revoked key', async () => {
    const index = path.join(root, 'index.db');
    localIndex(index, { version: '10.0.2428.63', source: 'packages-dir' });
    const registryFile = path.join(root, 'state', 'key-registry.json');
    const { keysCommand } = await import('../src/cli/keys.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await keysCommand({ positionals: ['reset-admin'], flags: { registry: 'file', path: registryFile }, env: {} })).toBe(0);
      const admin = /adm_[0-9a-f]{64}/.exec(log.mock.calls.map((call) => String(call[0])).join('\n'))?.[0] ?? '';
      const serve = startServe({ D365_INDEX_DB_PATH: index, MCP_KEY_REGISTRY: 'file', MCP_KEY_REGISTRY_PATH: registryFile });
      const port = await readyPort(serve, false);
      const server = `http://127.0.0.1:${port}`;

      log.mockClear();
      expect(await keysCommand({ positionals: ['new', 'grace'], flags: { server }, env: { D365_MCP_ADMIN_KEY: admin } })).toBe(0);
      const key = /\b[0-9a-f]{64}\b/.exec(log.mock.calls.map((call) => String(call[0])).join('\n'))?.[0] ?? '';
      const client = await connect(port, key);
      expect(await statsOf(client)).toHaveProperty('totalObjects', 1);

      const status = (await (await statusOf(port, key)).json()) as { you: unknown; server: { keyRegistry: unknown } };
      expect(status.you).toEqual({ keyName: 'grace' });
      expect(status.server.keyRegistry).toEqual({ kind: 'file', loadedAt: expect.any(String) });

      expect(await keysCommand({ positionals: ['revoke', 'grace'], flags: { server }, env: { D365_MCP_ADMIN_KEY: admin } })).toBe(0);
      expect((await statusOf(port, key)).status).toBe(401);
      expect(serve.stderr()).not.toContain(key);
      expect(serve.stderr()).not.toContain(admin);
    } finally {
      log.mockRestore();
    }
  }, TIMEOUT_MS);
});
