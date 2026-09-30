import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApp } from '../src/server/httpTransport.js';
import { createIndexAdminRouter, IndexUploadManager, type IndexUploadOptions } from '../src/server/indexUpload.js';
import { compressFile, hashFile, type CompressedFile, type IndexEncoding } from '../src/indexer/compression.js';
import { snapshotIndex } from '../src/indexer/publishIndex.js';
import { publishToContainer } from '../src/indexer/blobStore.js';
import { syncIndexFromManifest, type CachedManifest } from '../src/indexer/remoteIndex.js';
import { IndexUploadClient, normalizeServerUrl, type UploadEvent } from '../src/indexer/uploadClient.js';
import { uploadIndexCommand } from '../src/cli/upload-index-command.js';
import { openDb, searchSymbols } from '../src/indexer/db.js';
import { createIndexedDb, startStaticServer } from './helpers/indexFixtureServer.js';

const UPLOADER_KEY = 'uploader-key-000000000000000000000000000000';
const READER_KEY = 'reader-key-0000000000000000000000000000000000';

let root: string;
const servers: Server[] = [];
const managers: IndexUploadManager[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-upload-'));
});

afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.close());
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  fs.rmSync(root, { recursive: true, force: true });
});

/** A packaged fixture index with enough objects to span several small chunks. */
async function makePackage(encoding: IndexEncoding, names = ['CustTable', 'SalesTable', 'InventTable']) {
  const source = path.join(root, `source-${encoding}.db`);
  const objects = names.flatMap((name) => [{ type: 'Table', name }, { type: 'Class', name: `${name}_Helper` }]);
  createIndexedDb(source, objects, { builtAt: '2026-09-26T08:00:00.000Z' });
  const snapshot = snapshotIndex(source, path.join(root, `snapshot-${encoding}.db`));
  let packageFile: string;
  let packed: CompressedFile;
  if (encoding === 'identity') {
    const hashed = await hashFile(snapshot.file);
    packageFile = snapshot.file;
    packed = { encoding, sha256: hashed.sha256, bytes: hashed.bytes, rawSha256: hashed.sha256, rawBytes: hashed.bytes };
  } else {
    packageFile = path.join(root, `package-${encoding}`);
    packed = await compressFile(snapshot.file, packageFile, encoding, 'fastest');
  }
  return { packageFile, packed, objects: snapshot.stats.objects, rawSha256: packed.rawSha256 };
}

interface TestServer {
  baseUrl: string;
  activated: { file: string; cache: CachedManifest }[];
  manager?: IndexUploadManager;
}

async function startServer(overrides: Partial<IndexUploadOptions> & { uploadsEnabled?: boolean; rateLimit?: number } = {}): Promise<TestServer> {
  const activated: TestServer['activated'] = [];
  const indexDbPath = path.join(root, 'served', 'd365_index.db');
  fs.mkdirSync(path.dirname(indexDbPath), { recursive: true });
  const manager = overrides.uploadsEnabled === false ? undefined : new IndexUploadManager({
    workDir: path.join(root, 'served', '.uploads'),
    indexDbPath,
    serverVersion: '0.1.0',
    maxBytes: 1024 ** 3,
    maxChunkBytes: 1024 * 1024,
    activate: (incoming, cache) => {
      const kept = path.join(root, `activated-${activated.length}.db`);
      fs.renameSync(incoming, kept);
      activated.push({ file: kept, cache });
    },
    ...overrides,
  });
  if (manager) managers.push(manager);
  const app = createHttpApp(() => new McpServer({ name: 'test', version: '0.0.0' }), {
    port: 0,
    apiKeys: [{ name: 'uploader', key: UPLOADER_KEY }, { name: 'reader', key: READER_KEY }],
    version: '0.1.0',
    rateLimitMaxRequests: overrides.rateLimit ?? 10_000,
    rateLimitWindowMs: 60_000,
    requestTimeoutMs: 5_000,
    admin: {
      router: createIndexAdminRouter({
        uploads: manager,
        uploadKeyNames: new Set(['uploader']),
        describeIndex: () => ({ source: 'local', objects: 0 }),
        version: '0.1.0',
      }),
    },
  });
  const server = await new Promise<Server>((resolve) => {
    const created = app.listen(0, '127.0.0.1', () => resolve(created));
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, activated, manager };
}

describe('index upload', () => {
  it.each(['gzip', 'br', 'identity'] as const)('uploads a %s package in parallel chunks and verifies it end to end', async (encoding) => {
    const { packageFile, packed, objects } = await makePackage(encoding);
    const server = await startServer();
    const events: UploadEvent[] = [];
    const client = new IndexUploadClient(`${server.baseUrl}/mcp`, UPLOADER_KEY);
    const outcome = await client.upload({
      serverUrl: server.baseUrl,
      apiKey: UPLOADER_KEY,
      packageFile,
      packed,
      objects,
      chunkSize: 1000,
      parallel: 3,
      pollIntervalMs: 10,
      onEvent: (event) => events.push(event),
    });

    expect(outcome.state).toBe('completed');
    expect(outcome.checksumMatches).toBe(true);
    expect(outcome.serverSha256).toBe(packed.sha256);
    expect(outcome.checks.map((check) => [check.name, check.ok])).toEqual([
      ['transfer', true], ['content', true], ['database', true],
    ]);
    expect(outcome.index).toMatchObject({ objects, builtAt: '2026-09-26T08:00:00.000Z' });

    const chunkCount = Math.ceil(packed.bytes / 1000);
    expect(events.filter((event) => event.type === 'upload')).toHaveLength(chunkCount);
    expect(server.activated).toHaveLength(1);
    const [{ file, cache }] = server.activated;
    expect((await hashFile(file)).sha256).toBe(packed.rawSha256);
    expect(cache).toMatchObject({ source: 'upload', uploadedBy: 'uploader', db: { encoding, sha256: packed.sha256 } });
    const db = openDb(file);
    try {
      expect(searchSymbols(db, 'SalesTable', 'Table', 5)).toHaveLength(1);
    } finally {
      db.close();
    }
    // The upload's scratch files are gone once it finishes.
    expect(fs.readdirSync(path.join(root, 'served', '.uploads'))).toEqual([]);
  });

  it('streams chunks too large to buffer from disk', async () => {
    const { packageFile, packed, objects } = await makePackage('identity');
    const server = await startServer();
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed, objects,
      chunkSize: 5000, bufferedChunkLimit: 1024, parallel: 2, pollIntervalMs: 10,
    });
    expect(outcome).toMatchObject({ state: 'completed', checksumMatches: true });
  });

  it('sends the whole package in one request when chunking is off', async () => {
    const { packageFile, packed, objects } = await makePackage('gzip');
    const server = await startServer();
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed, objects, chunkSize: null, pollIntervalMs: 10,
    });
    expect(outcome).toMatchObject({ state: 'completed', checksumMatches: true });
    expect(server.activated).toHaveLength(1);
  });

  it('re-sends a chunk that was corrupted in transit', async () => {
    const { packageFile, packed, objects } = await makePackage('gzip');
    const server = await startServer();
    let corrupted = false;
    const flaky: typeof fetch = async (input, init) => {
      if (!corrupted && init?.method === 'PUT' && String(input).endsWith('/chunks/1')) {
        corrupted = true;
        const body = Buffer.from(init.body as Uint8Array);
        body[0] ^= 0xff;
        return fetch(input, { ...init, body });
      }
      return fetch(input, init);
    };
    const events: UploadEvent[] = [];
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY, flaky).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed, objects,
      chunkSize: 1000, parallel: 2, pollIntervalMs: 10, backoffMs: () => 1, onEvent: (event) => events.push(event),
    });
    expect(corrupted).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'retry', chunk: 1, attempt: 1, reason: expect.stringContaining('422') }));
    expect(outcome).toMatchObject({ state: 'completed', checksumMatches: true });
  });

  it('fails the transfer check and replaces nothing when the package differs from the declaration', async () => {
    const { packageFile, packed, objects } = await makePackage('gzip');
    const server = await startServer();
    const lying = { ...packed, sha256: 'a'.repeat(64) };
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed: lying, objects, chunkSize: 1000, pollIntervalMs: 10,
    });
    expect(outcome.state).toBe('failed');
    expect(outcome.checksumMatches).toBe(false);
    expect(outcome.checks).toEqual([expect.objectContaining({ name: 'transfer', ok: false })]);
    expect(outcome.error).toMatch(/SHA-256/);
    expect(server.activated).toHaveLength(0);
  });

  it('fails the content check when the decoded database differs from the declaration', async () => {
    const { packageFile, packed, objects } = await makePackage('br');
    const server = await startServer();
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed: { ...packed, rawSha256: 'b'.repeat(64) },
      objects, chunkSize: 4096, pollIntervalMs: 10,
    });
    expect(outcome.state).toBe('failed');
    expect(outcome.checks.map((check) => [check.name, check.ok])).toEqual([['transfer', true], ['content', false]]);
    expect(server.activated).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'served', 'd365_index.db.incoming'))).toBe(false);
  });

  it('stops decoding a package that grows past the declared database size', async () => {
    const { packageFile, packed, objects } = await makePackage('gzip');
    const server = await startServer();
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed: { ...packed, rawBytes: 1024 },
      objects, chunkSize: 4096, pollIntervalMs: 10,
    });
    expect(outcome.state).toBe('failed');
    expect(outcome.error).toMatch(/decodes to more than the declared 1024 bytes/);
    expect(server.activated).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'served', 'd365_index.db.incoming'))).toBe(false);
  });

  it('keeps other upload keys away from an upload in progress', async () => {
    const { packed } = await makePackage('gzip');
    const server = await startServer();
    const manager = server.manager!;
    const session = manager.create({ ...packed, chunkSize: packed.bytes }, 'uploader');
    const body = fs.createReadStream(path.join(root, 'package-gzip'));
    await expect(manager.writeChunk(session.id, 'other', 0, body, packed.sha256)).rejects.toMatchObject({ status: 403 });
    body.destroy();
    expect(() => manager.complete(session.id, 'other')).toThrow(/belongs to 'uploader'/);
    expect(() => manager.abort(session.id, 'other')).toThrow(/belongs to 'uploader'/);
  });

  it('rejects an object count that differs from the declaration', async () => {
    const { packageFile, packed, objects } = await makePackage('gzip');
    const server = await startServer();
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed, objects: objects + 1, chunkSize: 4096, pollIntervalMs: 10,
    });
    expect(outcome.state).toBe('failed');
    expect(outcome.checks.at(-1)).toMatchObject({ name: 'database', ok: false });
    expect(server.activated).toHaveLength(0);
  });

  it('reports upload permissions and refuses keys that may not upload', async () => {
    const server = await startServer();
    const reader = new IndexUploadClient(server.baseUrl, READER_KEY);
    expect(await reader.info()).toMatchObject({ apiKey: 'reader', upload: { enabled: true, allowed: false } });
    expect(await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).info()).toMatchObject({ upload: { allowed: true } });
    await expect(reader.request('POST', '/admin/index/uploads', { json: {} })).rejects.toMatchObject({ status: 403 });
    const anonymous = await fetch(`${server.baseUrl}/admin/index`);
    expect(anonymous.status).toBe(401);
  });

  it('answers 404 for uploads when they are disabled', async () => {
    const server = await startServer({ uploadsEnabled: false });
    const client = new IndexUploadClient(server.baseUrl, UPLOADER_KEY);
    expect(await client.info()).toMatchObject({ upload: { enabled: false, allowed: false } });
    await expect(client.request('POST', '/admin/index/uploads', { json: {} })).rejects.toMatchObject({ status: 404 });
  });

  it('validates declarations, limits and one upload at a time', async () => {
    const { packed } = await makePackage('gzip');
    const server = await startServer({ maxChunkBytes: 2048 });
    const client = new IndexUploadClient(server.baseUrl, UPLOADER_KEY);
    const declare = (overrides: Record<string, unknown> = {}) => client.request('POST', '/admin/index/uploads', {
      json: {
        encoding: 'gzip', bytes: packed.bytes, sha256: packed.sha256,
        rawBytes: packed.rawBytes, rawSha256: packed.rawSha256, chunkSize: 1024, ...overrides,
      },
    });
    await expect(declare({ sha256: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(declare({ chunkSize: 4096 })).rejects.toMatchObject({ status: 413, body: { maxChunkBytes: 2048 } });

    const first = await declare();
    await expect(declare()).rejects.toMatchObject({ status: 409, body: { activeUploadId: first.uploadId } });
    await expect(client.request('POST', `/admin/index/uploads/${String(first.uploadId)}/complete`))
      .rejects.toMatchObject({ status: 409, body: { missingChunks: expect.arrayContaining([0]) } });

    const wrongLength = await fetch(`${server.baseUrl}/admin/index/uploads/${String(first.uploadId)}/chunks/0`, {
      method: 'PUT',
      headers: { 'x-api-key': UPLOADER_KEY, 'content-type': 'application/octet-stream', 'x-content-sha256': 'c'.repeat(64) },
      body: Buffer.alloc(10),
    });
    expect(wrongLength.status).toBe(400);

    const reader = new IndexUploadClient(server.baseUrl, READER_KEY);
    await expect(reader.request('DELETE', `/admin/index/uploads/${String(first.uploadId)}`)).rejects.toMatchObject({ status: 403 });
    expect(await client.request('DELETE', `/admin/index/uploads/${String(first.uploadId)}`)).toMatchObject({ state: 'aborted' });
    await expect(declare()).resolves.toMatchObject({ state: 'receiving' });
  });

  it('refuses an upload that does not fit on the disk', async () => {
    const { packed } = await makePackage('gzip');
    const server = await startServer({ freeBytes: () => 1024 });
    const client = new IndexUploadClient(server.baseUrl, UPLOADER_KEY);
    await expect(client.request('POST', '/admin/index/uploads', {
      json: { encoding: 'gzip', bytes: packed.bytes, sha256: packed.sha256, rawBytes: packed.rawBytes, rawSha256: packed.rawSha256, chunkSize: 1024 },
    })).rejects.toMatchObject({ status: 507 });
  });

  it('gives upload chunks their own rate-limit budget', async () => {
    const { packageFile, packed, objects } = await makePackage('identity');
    // 5 requests per window would stop a 10+ chunk upload under the global limit.
    const server = await startServer({ rateLimit: 5 });
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed, objects, chunkSize: 4096, pollIntervalMs: 10,
      backoffMs: () => 1,
    });
    expect(Math.ceil(packed.bytes / 4096)).toBeGreaterThan(10);
    expect(outcome.state).toBe('completed');
    const mcp = await Promise.all(Array.from({ length: 6 }, () => fetch(`${server.baseUrl}/mcp`, { headers: { 'x-api-key': READER_KEY } })));
    expect(mcp.map((response) => response.status)).toContain(429);
  });

  it('persists to a blob container that a restarted server can pull from', async () => {
    const { packageFile, packed, objects } = await makePackage('br');
    const blobRoot = path.join(root, 'blobs');
    const blocks = new Map<string, Buffer>();
    const puts: string[] = [];
    const storage = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const name = decodeURIComponent(url.pathname.replace(/^\/indexes\//, ''));
        puts.push(`${url.searchParams.get('comp') ?? 'blob'} ${name}`);
        expect(url.searchParams.get('sig')).toBe('secret');
        const file = path.join(blobRoot, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (url.searchParams.get('comp') === 'block') {
          blocks.set(`${name}:${url.searchParams.get('blockid')}`, body);
        } else if (url.searchParams.get('comp') === 'blocklist') {
          const ids = [...body.toString().matchAll(/<Latest>([^<]+)<\/Latest>/g)].map((match) => match[1]);
          fs.writeFileSync(file, Buffer.concat(ids.map((id) => blocks.get(`${name}:${id}`)!)));
        } else {
          fs.writeFileSync(file, body);
        }
        res.statusCode = 201;
        res.end();
      });
    });
    await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
    servers.push(storage);
    const containerUrl = `http://127.0.0.1:${(storage.address() as AddressInfo).port}/indexes?sig=secret`;

    const server = await startServer({
      persist: (file, manifest) => publishToContainer(containerUrl, file, manifest, { blockBytes: 1000 }),
    });
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed, objects, chunkSize: 1500, pollIntervalMs: 10,
    });
    expect(outcome).toMatchObject({ state: 'completed', persistError: null });
    expect(outcome.persisted?.latestManifestUrl).not.toContain('secret');
    // Version folder first, latest pointer last.
    expect(puts.at(-1)).toBe('blob latest/manifest.json');
    expect(puts.filter((entry) => entry.startsWith('block '))).toHaveLength(Math.ceil(packed.bytes / 1000));

    const statics = await startStaticServer(blobRoot);
    try {
      const pulled = path.join(root, 'pulled.db');
      const result = await syncIndexFromManifest({ manifestUrl: `${statics.baseUrl}/latest/manifest.json`, dbPath: pulled });
      expect(result.status).toBe('downloaded');
      expect(result.manifest.db).toMatchObject({ encoding: 'br', gzip: false, sha256: packed.sha256 });
      expect((await hashFile(pulled)).sha256).toBe(packed.rawSha256);
    } finally {
      await statics.close();
    }
  });

  it('clears only stale session folders from the upload folder at start-up', () => {
    const workDir = path.join(root, 'shared');
    const stale = path.join(workDir, '0f8fad5b-d9cb-469f-a165-70867728950e');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'package'), 'x');
    fs.writeFileSync(path.join(workDir, 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(workDir, 'keep-dir'));
    managers.push(new IndexUploadManager({
      workDir, indexDbPath: path.join(root, 'x.db'), serverVersion: '0', maxBytes: 1, maxChunkBytes: 1, activate: () => {},
    }));
    expect(fs.readdirSync(workDir).sort()).toEqual(['keep-dir', 'keep.txt']);
  });

  it('fails the upload and keeps serving when activation throws', async () => {
    const { packageFile, packed, objects } = await makePackage('gzip');
    const server = await startServer({ activate: () => { throw new Error('rename failed'); } });
    const outcome = await new IndexUploadClient(server.baseUrl, UPLOADER_KEY).upload({
      serverUrl: server.baseUrl, apiKey: UPLOADER_KEY, packageFile, packed, objects, chunkSize: 4096, pollIntervalMs: 10,
    });
    expect(outcome).toMatchObject({ state: 'failed', error: 'rename failed', index: null });
    expect(outcome.checks.every((check) => check.ok)).toBe(true);
    expect(fs.existsSync(path.join(root, 'served', 'd365_index.db.incoming'))).toBe(false);
  });

  it('normalizes server URLs', () => {
    expect(normalizeServerUrl('https://host.example/mcp/')).toBe('https://host.example');
    expect(normalizeServerUrl('https://host.example/base/mcp?x=1')).toBe('https://host.example/base');
    expect(normalizeServerUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });
});

describe('upload-index command', () => {
  it('packages, uploads and reports JSON progress events', async () => {
    const server = await startServer();
    const dbPath = path.join(root, 'cli.db');
    createIndexedDb(dbPath, [{ type: 'Table', name: 'CustTable' }, { type: 'Class', name: 'CustHelper' }]);
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await uploadIndexCommand(
        { server: server.baseUrl, dbPath, compression: 'brotli', level: 'fastest', chunkSizeMb: '1', progress: 'json', workDir: root },
        { D365_MCP_API_KEY: UPLOADER_KEY }
      );
    } finally {
      write.mockRestore();
    }
    const events = lines.join('').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(code).toBe(0);
    expect(events.filter((event) => event.event === 'stage').map((event) => event.stage)).toEqual(
      ['preflight', 'snapshot', 'compress', 'compress', 'upload', 'verify', 'done']
    );
    expect(events).toContainEqual(expect.objectContaining({ event: 'check', name: 'checksum', ok: true }));
    expect(events.find((event) => event.event === 'result')).toMatchObject({ ok: true, encoding: 'br' });
    expect(server.activated).toHaveLength(1);
    // The staging folder is removed.
    expect(fs.readdirSync(root).filter((entry) => entry.startsWith('d365-index-upload-'))).toEqual([]);
  });

  it('fails before packaging when the key may not upload', async () => {
    const server = await startServer();
    const dbPath = path.join(root, 'cli.db');
    createIndexedDb(dbPath, [{ type: 'Table', name: 'CustTable' }]);
    const errors: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((message: string) => errors.push(message));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await uploadIndexCommand({ server: server.baseUrl, dbPath }, { D365_MCP_API_KEY: READER_KEY })).toBe(1);
      expect(await uploadIndexCommand({ server: server.baseUrl, dbPath }, {})).toBe(1);
      expect(await uploadIndexCommand({ server: server.baseUrl, dbPath, compression: 'zip' }, { D365_MCP_API_KEY: UPLOADER_KEY })).toBe(1);
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
    expect(errors.join('\n')).toMatch(/not allowed to upload/);
    expect(errors.join('\n')).toMatch(/D365_MCP_API_KEY/);
    expect(errors.join('\n')).toMatch(/Unknown compression/);
    expect(server.activated).toHaveLength(0);
  });
});
