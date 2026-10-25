import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMeta, META_KEYS, openDb, setMeta, type Database } from '../src/indexer/db.js';
import {
  buildIndex,
  countIndexRows,
  getIndexStats,
  readIndexApplicationVersion,
  readIndexSchemaVersion,
} from '../src/indexer/buildIndex.js';

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
    expect(getMeta(db, META_KEYS.schemaVersion)).toBe('3');
    expect(Number(getMeta(db, META_KEYS.indexDurationMs))).toBeGreaterThanOrEqual(0);
  });

  it('never stores the full packages path', () => {
    const meta = Object.fromEntries(
      (db.prepare('SELECT key, value FROM ax_meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value])
    );
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

describe('application version of an index', () => {
  let fresh: Database;

  beforeEach(() => {
    fresh = openDb(':memory:');
  });

  afterEach(() => {
    fresh.close();
  });

  it('is unknown when nothing was recorded and nothing is configured', () => {
    expect(readIndexApplicationVersion(fresh)).toEqual({ version: null, source: null });
    expect(readIndexApplicationVersion(fresh, '')).toEqual({ version: null, source: null });
    expect(readIndexApplicationVersion(fresh, null)).toEqual({ version: null, source: null });
  });

  it('reports the recorded version with the source it was recorded with', () => {
    setMeta(fresh, META_KEYS.appVersion, '10.0.2428.63');
    setMeta(fresh, META_KEYS.appVersionSource, 'packages-dir');

    expect(readIndexApplicationVersion(fresh)).toEqual({ version: '10.0.2428.63', source: 'packages-dir' });
  });

  it('reports a recorded version without a source as source unknown, never a guess', () => {
    setMeta(fresh, META_KEYS.appVersion, '10.0.2428.63');

    expect(readIndexApplicationVersion(fresh)).toEqual({ version: '10.0.2428.63', source: null });
  });

  it('normalises leading zeros and surrounding spaces, the way the session instructions do', () => {
    setMeta(fresh, META_KEYS.appVersion, ' 10.0.02428.063 ');
    setMeta(fresh, META_KEYS.appVersionSource, 'packages-dir');

    expect(readIndexApplicationVersion(fresh).version).toBe('10.0.2428.63');
  });

  it('prefers the recorded version over the configured one', () => {
    setMeta(fresh, META_KEYS.appVersion, '10.0.2428.63');
    setMeta(fresh, META_KEYS.appVersionSource, 'packages-dir');

    expect(readIndexApplicationVersion(fresh, '10.0.2500.1')).toEqual({ version: '10.0.2428.63', source: 'packages-dir' });
  });

  it('falls back to the configured version and says so', () => {
    expect(readIndexApplicationVersion(fresh, ' 10.0.2500.1 ')).toEqual({ version: '10.0.2500.1', source: 'configured' });
  });

  it('treats an empty recorded version as none recorded, so the configured one still applies', () => {
    setMeta(fresh, META_KEYS.appVersion, '');
    setMeta(fresh, META_KEYS.appVersionSource, 'packages-dir');

    expect(readIndexApplicationVersion(fresh, '10.0.2500.1')).toEqual({ version: '10.0.2500.1', source: 'configured' });
  });

  it.each(['10.0.39', 'latest', '10.0.2500', 'x'.repeat(5000), '10.0.2500.1\r\nX-Evil: 1', '10.0.2500.1 €'])(
    'is unknown, with no source, for a configured value that is not a four-part version (%#)',
    (configured) => {
      expect(readIndexApplicationVersion(fresh, configured)).toEqual({ version: null, source: null });
    }
  );

  it('is unknown for a recorded value that is not a four-part version, and does not borrow the configured one', () => {
    setMeta(fresh, META_KEYS.appVersion, 'latest');
    setMeta(fresh, META_KEYS.appVersionSource, 'packages-dir');

    expect(readIndexApplicationVersion(fresh, '10.0.2500.1')).toEqual({ version: null, source: null });
  });
});

describe('schema version and row counts of an index', () => {
  let fresh: Database;

  beforeEach(() => {
    fresh = openDb(':memory:');
  });

  afterEach(() => {
    fresh.close();
  });

  it.each([
    [undefined, null],
    ['3', 3],
    ['7', 7],
    ['0', null],
    ['-1', null],
    ['2.5', null],
    ['abc', null],
    ['', null],
    // Number() would read these as 16, 10 and 7.
    ['0x10', null],
    ['1e1', null],
    [' 7 ', null],
    // Beyond what a JavaScript number holds exactly.
    ['9007199254740993', null],
    ['99999999999999999999', null],
  ])('reads the recorded schema version %j as %j', (recorded, expected) => {
    if (recorded !== undefined) setMeta(fresh, META_KEYS.schemaVersion, recorded);

    expect(readIndexSchemaVersion(fresh)).toBe(expected);
  });

  it('counts objects and labels, matching getIndexStats', () => {
    expect(countIndexRows(fresh)).toEqual({ objects: 0, labels: 0 });
    expect(countIndexRows(db)).toEqual({ objects: 1, labels: 0 });

    const stats = getIndexStats(db);
    expect(countIndexRows(db)).toEqual({ objects: stats.totalObjects, labels: stats.totalLabels });
  });

  it('adds the application version to getIndexStats and keeps every field it had', () => {
    const before = {
      totalObjects: 1,
      byType: { Class: 1 },
      totalLabels: 0,
      serverVersion: '0.1.0',
      storeRawXml: true,
      usageSnapshot: { status: 'not-imported', importedAt: null, rowCount: null },
    };
    const stats = getIndexStats(db);

    expect(stats).toMatchObject(before);
    expect(stats.builtAt).toBe(getMeta(db, META_KEYS.builtAt));
    expect(stats.lastIndexed).toBe(stats.builtAt);
    expect(stats.applicationVersion).toBeNull();
    expect(stats.applicationVersionSource).toBeNull();
    expect(Object.keys(stats)).toEqual([
      'totalObjects', 'byType', 'totalLabels', 'builtAt', 'lastIndexed', 'serverVersion', 'storeRawXml',
      'usageSnapshot', 'applicationVersion', 'applicationVersionSource',
    ]);
  });

  it('reports the configured version through getIndexStats when none is recorded', () => {
    const stats = getIndexStats(fresh, { configuredApplicationVersion: '10.0.2500.1' });

    expect(stats.applicationVersion).toBe('10.0.2500.1');
    expect(stats.applicationVersionSource).toBe('configured');
  });
});
