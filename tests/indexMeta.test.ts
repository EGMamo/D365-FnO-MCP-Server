import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAllMeta, getMeta, META_KEYS, openDb, type Database } from '../src/indexer/db.js';
import { buildIndex, getIndexStats } from '../src/indexer/buildIndex.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, 'fixtures');

let root: string;
let db: Database;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(testDir, '.tmp-meta-'));
  const dir = path.join(root, 'TestPackage', 'TestModel', 'AxClass');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, 'AxClassSample.xml'), path.join(dir, 'SampleClass.xml'));
  db = openDb(':memory:');
  await buildIndex(db, root, true);
});

afterAll(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('index build metadata', () => {
  it('records when and how the index was built', () => {
    const builtAt = getMeta(db, META_KEYS.builtAt);
    expect(builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getMeta(db, META_KEYS.serverVersion)).toBe('0.1.0');
    expect(getMeta(db, META_KEYS.storeRawXml)).toBe('1');
    expect(getMeta(db, META_KEYS.schemaVersion)).toBe('1');
    expect(Number(getMeta(db, META_KEYS.indexDurationMs))).toBeGreaterThanOrEqual(0);
  });

  it('never stores the full packages path', () => {
    const meta = getAllMeta(db);
    expect(meta[META_KEYS.packagesDirBasename]).toBe(path.basename(root));
    expect(meta[META_KEYS.packagesDirHash]).toMatch(/^[0-9a-f]{16}$/);
    for (const value of Object.values(meta)) expect(value).not.toContain(root);
  });

  it('exposes the build time through getIndexStats', () => {
    const stats = getIndexStats(db);
    expect(stats.builtAt).toBe(getMeta(db, META_KEYS.builtAt));
    expect(stats.lastIndexed).toBe(stats.builtAt);
    expect(stats.serverVersion).toBe('0.1.0');
    expect(stats.storeRawXml).toBe(true);
    expect(stats.usageSnapshot).toEqual({ status: 'not-imported', importedAt: null, rowCount: null });
    expect(stats.totalObjects).toBe(1);
  });

  it('reports nulls for a database that was never indexed', () => {
    const empty = openDb(':memory:');
    try {
      const stats = getIndexStats(empty);
      expect(stats.builtAt).toBeNull();
      expect(stats.serverVersion).toBeNull();
      expect(stats.storeRawXml).toBeNull();
    } finally {
      empty.close();
    }
  });
});
