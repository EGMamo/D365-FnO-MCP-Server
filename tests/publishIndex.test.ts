import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { publishIndex } from '../src/indexer/publishIndex.js';
import { manifestSchema } from '../src/indexer/remoteIndex.js';
import { META_KEYS, openDb, setMeta } from '../src/indexer/db.js';
import { seedLegacyUsageRefs } from './helpers/usageRefs.js';
import { createIndexedDb } from './helpers/indexFixtureServer.js';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-publish-index-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('publishIndex', () => {
  it('writes a versioned gzip copy plus versioned and latest manifests', async () => {
    const dbPath = path.join(root, 'basic.db');
    createIndexedDb(dbPath, [
      { type: 'Class', name: 'One' },
      { type: 'Class', name: 'Two' },
      { type: 'Table', name: 'Three' },
    ], { builtAt: '2026-09-25T20:44:20.123Z' });
    const db = openDb(dbPath);
    seedLegacyUsageRefs(db, [{
      sourceType: 'Class', sourceName: 'One', targetName: 'Two',
      referenceKind: 'Call', sourceTable: 'References', raw: {},
    }]);
    db.close();

    const outDir = path.join(root, 'basic-out');
    const result = await publishIndex({
      dbPath,
      outDir,
      serverVersion: '0.1.0',
      now: () => new Date('2026-09-26T01:00:00.000Z'),
    });

    expect(result.version).toMatch(/^20260925T204420Z-[0-9a-f]{8}$/);
    expect(result.versionDir).toBe(path.join(outDir, result.version));
    expect(fs.existsSync(path.join(outDir, '.staging'))).toBe(false);
    expect(fs.readdirSync(result.versionDir).sort()).toEqual(['d365_index.db.gz', 'manifest.json']);

    const latest = manifestSchema.parse(JSON.parse(fs.readFileSync(result.latestManifestPath, 'utf8')));
    expect(latest).toEqual(result.manifest);
    expect(latest.db.url).toBe(`../${result.version}/d365_index.db.gz`);
    expect(latest.db.sha256).toBe(sha256(result.dbFile));
    expect(latest.db.bytes).toBe(fs.statSync(result.dbFile).size);
    expect(latest.db.rawBytes).toBeGreaterThan(latest.db.bytes);
    expect(latest.builtAt).toBe('2026-09-25T20:44:20.123Z');
    expect(latest.publishedAt).toBe('2026-09-26T01:00:00.000Z');
    expect(latest.serverVersion).toBe('0.1.0');
    expect(latest.stats).toEqual({ objects: 3, labels: 0, usageRows: 1 });
    expect(latest.xref).toBeNull();

    const versioned = manifestSchema.parse(JSON.parse(fs.readFileSync(path.join(result.versionDir, 'manifest.json'), 'utf8')));
    expect(versioned.db.url).toBe('d365_index.db.gz');
    expect(versioned.db.sha256).toBe(latest.db.sha256);

    const restored = path.join(root, 'restored.db');
    fs.writeFileSync(restored, gunzipSync(fs.readFileSync(result.dbFile)));
    const copy = openDb(restored);
    try {
      expect((copy.prepare('SELECT COUNT(*) AS n FROM ax_objects').get() as { n: number }).n).toBe(3);
      expect((copy.prepare('SELECT COUNT(*) AS n FROM ax_usage_refs').get() as { n: number }).n).toBe(1);
      expect((copy.prepare('SELECT name FROM ax_fts WHERE ax_fts MATCH ?').get('Two') as { name: string }).name).toBe('Two');
    } finally {
      copy.close();
    }
  });

  it('refuses an index without build metadata', async () => {
    const dbPath = path.join(root, 'nometa.db');
    openDb(dbPath).close();
    await expect(publishIndex({ dbPath, outDir: path.join(root, 'nometa-out'), serverVersion: '0.1.0' }))
      .rejects.toThrow(/no build metadata; run `index`/);
    expect(fs.existsSync(path.join(root, 'nometa-out', '.staging'))).toBe(false);
  });

  it('refuses a missing database', async () => {
    await expect(publishIndex({ dbPath: path.join(root, 'absent.db'), outDir: path.join(root, 'absent-out'), serverVersion: '0.1.0' }))
      .rejects.toThrow(/Run `index` first/);
  });

  it('refuses an index built without raw XML unless allowed', async () => {
    const dbPath = path.join(root, 'noraw.db');
    createIndexedDb(dbPath, [{ type: 'Class', name: 'NoRaw' }], { storeRawXml: '0' });
    const outDir = path.join(root, 'noraw-out');
    await expect(publishIndex({ dbPath, outDir, serverVersion: '0.1.0' })).rejects.toThrow(/D365_INDEX_STORE_RAW_XML=0/);
    const result = await publishIndex({ dbPath, outDir, serverVersion: '0.1.0', allowNoRawXml: true, integrityCheck: true });
    expect(result.manifest.stats.objects).toBe(1);
  });

  it('writes an absolute database URL when a prefix is given', async () => {
    const dbPath = path.join(root, 'prefix.db');
    createIndexedDb(dbPath, [{ type: 'Class', name: 'Prefixed' }]);
    const result = await publishIndex({
      dbPath,
      outDir: path.join(root, 'prefix-out'),
      serverVersion: '0.1.0',
      dbUrlPrefix: 'https://acct.blob.core.windows.net/indexes/',
    });
    expect(result.manifest.db.url).toBe(`https://acct.blob.core.windows.net/indexes/${result.version}/d365_index.db.gz`);
  });

  it('rewrites indexed paths relative to the packages directory in the copy only', async () => {
    const packagesDir = path.join(root, 'PackagesLocalDirectory');
    const filePath = path.join(packagesDir, 'Pkg', 'Model', 'AxClass', 'Rel.xml');
    const dbPath = path.join(root, 'relative.db');
    createIndexedDb(dbPath, [
      { type: 'Class', name: 'Rel', filePath },
      { type: 'Class', name: 'Elsewhere', filePath: path.join(root, 'outside', 'Elsewhere.xml') },
    ]);
    const result = await publishIndex({
      dbPath,
      outDir: path.join(root, 'relative-out'),
      serverVersion: '0.1.0',
      relativePathsRoot: packagesDir,
    });

    const restored = path.join(root, 'relative-restored.db');
    fs.writeFileSync(restored, gunzipSync(fs.readFileSync(result.dbFile)));
    const copy = openDb(restored);
    try {
      const rows = copy.prepare('SELECT name, file_path FROM ax_objects ORDER BY name').all() as { name: string; file_path: string }[];
      expect(rows.find((row) => row.name === 'Rel')?.file_path).toBe(path.join('Pkg', 'Model', 'AxClass', 'Rel.xml'));
      expect(rows.find((row) => row.name === 'Elsewhere')?.file_path).toBe(path.join(root, 'outside', 'Elsewhere.xml'));
    } finally {
      copy.close();
    }

    const source = openDb(dbPath);
    try {
      expect((source.prepare('SELECT file_path FROM ax_objects WHERE name = ?').get('Rel') as { file_path: string }).file_path).toBe(filePath);
    } finally {
      source.close();
    }
  });

  it('records the usage snapshot import time when one exists', async () => {
    const dbPath = path.join(root, 'xref.db');
    createIndexedDb(dbPath, [{ type: 'Class', name: 'WithXref' }]);
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO ax_usage_snapshot (singleton, run_id, imported_at, row_count, source_json) VALUES (1, 'run', '2026-09-20T00:00:00.000Z', 0, '{}')`).run();
    setMeta(db, META_KEYS.builtAt, '2026-09-21T00:00:00.000Z');
    db.close();
    const result = await publishIndex({ dbPath, outDir: path.join(root, 'xref-out'), serverVersion: '0.1.0' });
    expect(result.manifest.xref).toEqual({ importedAt: '2026-09-20T00:00:00.000Z' });
    expect(result.version).toMatch(/^20260921T000000Z-/);
  });
});
