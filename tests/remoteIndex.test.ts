import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  RemoteIndexError,
  manifestCachePath,
  readManifestCache,
  redactUrl,
  resolveDbUrl,
  syncIndexFromManifest,
} from '../src/indexer/remoteIndex.js';
import { publishIndex } from '../src/indexer/publishIndex.js';
import { openDb } from '../src/indexer/db.js';
import { createIndexedDb, startStaticServer, type StaticServer } from './helpers/indexFixtureServer.js';

let root: string;
let publishDir: string;
let latestManifestPath: string;
let version: string;
let server: StaticServer;
let manifestUrl: string;

function countObjects(dbPath: string): number {
  const db = openDb(dbPath);
  try {
    return Number((db.prepare('SELECT COUNT(*) AS n FROM ax_objects').get() as { n: number }).n);
  } finally {
    db.close();
  }
}

async function expectError(promise: Promise<unknown>, code: RemoteIndexError['code']): Promise<RemoteIndexError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteIndexError);
    expect((err as RemoteIndexError).code).toBe(code);
    return err as RemoteIndexError;
  }
  throw new Error(`Expected a RemoteIndexError with code ${code}`);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-remote-index-'));
  const sourceDb = path.join(root, 'source.db');
  createIndexedDb(sourceDb, [
    { type: 'Class', name: 'PublishedClass' },
    { type: 'Table', name: 'PublishedTable' },
  ]);
  publishDir = path.join(root, 'publish');
  const result = await publishIndex({ dbPath: sourceDb, outDir: publishDir, serverVersion: '0.1.0' });
  version = result.version;
  latestManifestPath = result.latestManifestPath;
  server = await startStaticServer(publishDir);
  manifestUrl = `${server.baseUrl}/latest/manifest.json?sv=test&sig=abc`;
});

afterAll(async () => {
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveDbUrl', () => {
  it('resolves a relative URL against the manifest and forwards its query string', () => {
    const resolved = resolveDbUrl(new URL('https://acct.blob.core.windows.net/indexes/latest/manifest.json?sv=1&sig=x'), '../v1/d365_index.db.gz');
    expect(resolved.toString()).toBe('https://acct.blob.core.windows.net/indexes/v1/d365_index.db.gz?sv=1&sig=x');
  });

  it('keeps an absolute URL and its own query untouched', () => {
    const resolved = resolveDbUrl(new URL('https://a.test/latest/manifest.json?sv=1'), 'https://b.test/v1/db.gz?token=2');
    expect(resolved.toString()).toBe('https://b.test/v1/db.gz?token=2');
  });

  it('redacts query strings for logs', () => {
    expect(redactUrl('https://a.test/latest/manifest.json?sv=1&sig=secret')).toBe('https://a.test/latest/manifest.json');
  });
});

describe('syncIndexFromManifest', () => {
  it('downloads, verifies and installs the published index', async () => {
    const dbPath = path.join(root, 'hosted', 'index.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(`${dbPath}-wal`, 'stale wal');
    fs.writeFileSync(`${dbPath}-shm`, 'stale shm');
    server.requests.length = 0;

    const result = await syncIndexFromManifest({ manifestUrl, dbPath, expectedServerVersion: '0.1.0' });

    expect(result.status).toBe('downloaded');
    expect(result.manifest.version).toBe(version);
    expect(result.bytes).toBe(result.manifest.db.bytes);
    expect(countObjects(dbPath)).toBe(2);
    expect(fs.existsSync(`${dbPath}.download`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(readManifestCache(dbPath)?.db.sha256).toBe(result.manifest.db.sha256);

    const dbRequest = server.requests.find((url) => url.includes('d365_index.db.gz'));
    expect(dbRequest).toBe(`/${version}/d365_index.db.gz?sv=test&sig=abc`);
  });

  it('skips the download when the cached manifest already matches', async () => {
    const dbPath = path.join(root, 'hosted', 'index.db');
    server.requests.length = 0;
    const result = await syncIndexFromManifest({ manifestUrl, dbPath });
    expect(result.status).toBe('up-to-date');
    expect(server.requests).toEqual(['/latest/manifest.json?sv=test&sig=abc']);
  });

  it('downloads again when forced or when the cache is missing', async () => {
    const dbPath = path.join(root, 'hosted', 'index.db');
    expect((await syncIndexFromManifest({ manifestUrl, dbPath, force: true })).status).toBe('downloaded');
    fs.rmSync(manifestCachePath(dbPath));
    expect((await syncIndexFromManifest({ manifestUrl, dbPath })).status).toBe('downloaded');
  });

  it('rejects a checksum mismatch and leaves the existing index untouched', async () => {
    const dbPath = path.join(root, 'hosted', 'index.db');
    const before = fs.readFileSync(dbPath);
    const original = fs.readFileSync(latestManifestPath, 'utf8');
    const tampered = JSON.parse(original) as { db: { sha256: string } };
    tampered.db.sha256 = '0'.repeat(64);
    fs.writeFileSync(latestManifestPath, JSON.stringify(tampered));
    try {
      const err = await expectError(syncIndexFromManifest({ manifestUrl, dbPath }), 'checksum');
      expect(err.message).not.toContain('sv=test');
      expect(fs.readFileSync(dbPath)).toEqual(before);
      expect(fs.existsSync(`${dbPath}.download`)).toBe(false);

      const fresh = path.join(root, 'fresh', 'index.db');
      await expectError(syncIndexFromManifest({ manifestUrl, dbPath: fresh }), 'checksum');
      expect(fs.existsSync(fresh)).toBe(false);
    } finally {
      fs.writeFileSync(latestManifestPath, original);
    }
  });

  it('reports an unreachable or invalid manifest', async () => {
    const dbPath = path.join(root, 'other', 'index.db');
    const missing = await expectError(
      syncIndexFromManifest({ manifestUrl: `${server.baseUrl}/nope/manifest.json`, dbPath }),
      'manifest'
    );
    expect(missing.status).toBe(404);

    const original = fs.readFileSync(latestManifestPath, 'utf8');
    fs.writeFileSync(latestManifestPath, '{"schema":2}');
    try {
      await expectError(syncIndexFromManifest({ manifestUrl, dbPath }), 'invalid');
    } finally {
      fs.writeFileSync(latestManifestPath, original);
    }
  });

  it('uses an absolute database URL verbatim', async () => {
    const dbPath = path.join(root, 'absolute', 'index.db');
    const original = fs.readFileSync(latestManifestPath, 'utf8');
    const manifest = JSON.parse(original) as { db: { url: string } };
    manifest.db.url = `${server.baseUrl}/${version}/d365_index.db.gz`;
    fs.writeFileSync(latestManifestPath, JSON.stringify(manifest));
    server.requests.length = 0;
    try {
      expect((await syncIndexFromManifest({ manifestUrl, dbPath })).status).toBe('downloaded');
      expect(server.requests).toContain(`/${version}/d365_index.db.gz`);
    } finally {
      fs.writeFileSync(latestManifestPath, original);
    }
  });

  it('fails cleanly when the payload is not a gzip stream', async () => {
    const dbPath = path.join(root, 'garbage', 'index.db');
    const gzPath = path.join(publishDir, version, 'd365_index.db.gz');
    const originalGz = fs.readFileSync(gzPath);
    const originalManifest = fs.readFileSync(latestManifestPath, 'utf8');
    const garbage = Buffer.from('this is not gzip data');
    const manifest = JSON.parse(originalManifest) as { db: { sha256: string; bytes: number } };
    manifest.db.sha256 = createHash('sha256').update(garbage).digest('hex');
    manifest.db.bytes = garbage.length;
    fs.writeFileSync(gzPath, garbage);
    fs.writeFileSync(latestManifestPath, JSON.stringify(manifest));
    try {
      await expectError(syncIndexFromManifest({ manifestUrl, dbPath }), 'download');
      expect(fs.existsSync(`${dbPath}.download`)).toBe(false);
      expect(fs.existsSync(dbPath)).toBe(false);
    } finally {
      fs.writeFileSync(gzPath, originalGz);
      fs.writeFileSync(latestManifestPath, originalManifest);
    }
  });

  it('times out a stalled database download', async () => {
    const dbPath = path.join(root, 'timeout', 'index.db');
    const manifestBody = fs.readFileSync(latestManifestPath, 'utf8');
    const gzippedBody = gzipSync(Buffer.from('partial index contents '.repeat(1024)));
    const firstChunk = gzippedBody.subarray(0, gzippedBody.length - 8);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('manifest.json')) {
        return new Response(manifestBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(firstChunk);
            signal?.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')), {
              once: true,
            });
          },
        }),
        { status: 200 }
      );
    };

    await expectError(syncIndexFromManifest({ manifestUrl, dbPath, downloadTimeoutMs: 20, fetchImpl }), 'download');
    expect(fs.existsSync(`${dbPath}.download`)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});
