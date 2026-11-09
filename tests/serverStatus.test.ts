import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { META_KEYS, openDb, setMeta, upsertObject, type Database } from '../src/indexer/db.js';
import {
  createStatusProvider,
  describeArtifact,
  describeServedIndex,
  type ArtifactDescription,
  type SessionCounts,
} from '../src/server/serverStatus.js';
import { logger } from '../src/utils/logger.js';
import { seedDb } from './helpers/toolHarness.js';

const BUNDLE_ID = `sha256:${'ab'.repeat(32)}`;
const SESSIONS: SessionCounts = { active: 3, max: 100, maxPerKey: 0 };
const START = Date.parse('2026-10-25T09:00:00.000Z');

function addObject(db: Database, name: string): void {
  upsertObject(db, {
    type: 'Table',
    name,
    package: 'TestPackage',
    model: 'TestModel',
    file_path: `/fake/${name}.xml`,
    raw_xml: `<Table><Name>${name}</Name></Table>`,
    file_mtime: 1,
  });
}

function stamp(db: Database, values: { version?: string; source?: string; builtAt?: string; schema?: string }): void {
  if (values.version) setMeta(db, META_KEYS.appVersion, values.version);
  if (values.source) setMeta(db, META_KEYS.appVersionSource, values.source);
  if (values.builtAt) setMeta(db, META_KEYS.builtAt, values.builtAt);
  if (values.schema) setMeta(db, META_KEYS.schemaVersion, values.schema);
}

describe('describeArtifact', () => {
  // A manifest carries much more than a status document may show, and a validated bundle carries a directory.
  const manifest = {
    bundleId: BUNDLE_ID,
    createdAt: '2026-10-24T21:40:00.000Z',
    d365: { applicationVersion: '10.0.2428.63', sdkVersion: '10.0.2428.63', releaseId: 'release-2026-10' },
    generator: { name: 'prepare-bundle', version: '0.1.0' },
    directory: '/srv/artifact-store/bundles/abababab',
  };

  it('copies exactly the five facts and nothing else', () => {
    const artifact = describeArtifact('azure-blob', 12, manifest);

    expect(artifact).toEqual({
      source: 'azure-blob',
      bundleId: BUNDLE_ID,
      pointerRevision: 12,
      createdAt: '2026-10-24T21:40:00.000Z',
      applicationVersion: '10.0.2428.63',
    });
    expect(Object.keys(artifact).sort()).toEqual(['applicationVersion', 'bundleId', 'createdAt', 'pointerRevision', 'source']);
  });

  it('never carries a path, a release id or the generator', () => {
    const text = JSON.stringify(describeArtifact('local', 1, manifest));

    expect(text).not.toContain('/srv');
    expect(text).not.toContain('release-2026-10');
    expect(text).not.toContain('prepare-bundle');
  });

  it('is frozen, because one description is shared by every session', () => {
    expect(Object.isFrozen(describeArtifact('local', 1, manifest))).toBe(true);
  });
});

describe('describeServedIndex', () => {
  let db: Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('reports every fact as unknown for an index that was never built', () => {
    expect(describeServedIndex(db, { objects: 0, labels: 0 })).toEqual({
      applicationVersion: null,
      applicationVersionSource: null,
      builtAt: null,
      schemaVersion: null,
      objects: 0,
      labels: 0,
    });
  });

  it('reports what the index recorded, with the counts it is given', () => {
    stamp(db, { version: '10.0.2428.63', source: 'packages-dir', builtAt: '2026-10-24T22:10:00.000Z', schema: '3' });

    expect(describeServedIndex(db, { objects: 312044, labels: 88120 })).toEqual({
      applicationVersion: '10.0.2428.63',
      applicationVersionSource: 'packages-dir',
      builtAt: '2026-10-24T22:10:00.000Z',
      schemaVersion: 3,
      objects: 312044,
      labels: 88120,
    });
  });

  it('falls back to the configured version, with the source configured', () => {
    expect(describeServedIndex(db, { objects: 1, labels: 0 }, '10.0.2500.1')).toMatchObject({
      applicationVersion: '10.0.2500.1',
      applicationVersionSource: 'configured',
    });
  });
});

describe('createStatusProvider', () => {
  let db: Database;
  let clock: number;
  let uptime: number;

  beforeEach(() => {
    db = seedDb([{ type: 'Table', name: 'CustTable' }]);
    stamp(db, { version: '10.0.2428.63', source: 'packages-dir', builtAt: '2026-10-24T22:10:00.000Z', schema: '3' });
    clock = START;
    uptime = 3600;
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function provider(overrides: Partial<Parameters<typeof createStatusProvider>[0]> = {}) {
    return createStatusProvider({
      version: '0.1.0',
      database: () => db,
      artifact: () => null,
      now: () => clock,
      uptimeSeconds: () => uptime,
      ...overrides,
    });
  }

  const ask = (p: ReturnType<typeof provider>, ready = true) => p.describe({ ready, keyName: 'alice', sessions: SESSIONS });

  it('describes a ready server', () => {
    expect(ask(provider())).toEqual({
      status: 'ok',
      you: { keyName: 'alice' },
      server: { version: '0.1.0', startedAt: '2026-10-25T08:00:00.000Z', uptimeSeconds: 3600, keyRegistry: null },
      index: {
        applicationVersion: '10.0.2428.63',
        applicationVersionSource: 'packages-dir',
        builtAt: '2026-10-24T22:10:00.000Z',
        schemaVersion: 3,
        objects: 1,
        labels: 0,
      },
      artifact: null,
      sessions: { active: 3, max: 100, maxPerKey: 0 },
    });
  });

  it('puts the live bundle in the document, as given', () => {
    const artifact: ArtifactDescription = describeArtifact('local', 12, {
      bundleId: BUNDLE_ID,
      createdAt: '2026-10-24T21:40:00.000Z',
      d365: { applicationVersion: '10.0.2428.63' },
    });

    expect(ask(provider({ artifact: () => artifact })).artifact).toEqual(artifact);
  });

  it('says starting, with no index and no artifact, and never touches the database', () => {
    const database = vi.fn(() => {
      throw new Error('The index is not open yet.');
    });
    const artifact = vi.fn(() => null);

    const document = ask(provider({ database, artifact }), false);

    expect(document.status).toBe('starting');
    expect(document.index).toBeNull();
    expect(document.artifact).toBeNull();
    expect(document.you).toEqual({ keyName: 'alice' });
    expect(document.server.version).toBe('0.1.0');
    expect(document.sessions).toEqual(SESSIONS);
    expect(database).not.toHaveBeenCalled();
    expect(artifact).not.toHaveBeenCalled();
  });

  it('reports where the keys live and when they were read, and nothing else about them', () => {
    const provider = createStatusProvider({
      version: '0.1.0',
      database: () => null,
      artifact: () => null,
      keyRegistry: () => ({ kind: 'azure-blob', loadedAt: '2026-11-08T10:00:00.000Z' }),
    });
    const described = provider.describe({ ready: false, keyName: 'alice', sessions: { active: 0, max: 1, maxPerKey: 0 } });
    expect(described.server.keyRegistry).toEqual({ kind: 'azure-blob', loadedAt: '2026-11-08T10:00:00.000Z' });
  });

  it('contains only the documented keys, and no path, environment name or secret', () => {
    const text = JSON.stringify(ask(provider({ configuredApplicationVersion: '10.0.2500.1' })));
    const document = JSON.parse(text) as Record<string, Record<string, unknown>>;

    expect(Object.keys(document)).toEqual(['status', 'you', 'server', 'index', 'artifact', 'sessions']);
    expect(Object.keys(document.you)).toEqual(['keyName']);
    expect(Object.keys(document.server)).toEqual(['version', 'startedAt', 'uptimeSeconds', 'keyRegistry']);
    expect(Object.keys(document.index)).toEqual([
      'applicationVersion', 'applicationVersionSource', 'builtAt', 'schemaVersion', 'objects', 'labels',
    ]);
    expect(Object.keys(document.sessions)).toEqual(['active', 'max', 'maxPerKey']);
    expect(text).not.toMatch(/D365_|MCP_|\/fake|\/tmp|\\\\/);
  });

  it('computes when the process started once, so it does not drift with the clock', () => {
    const p = provider();
    const first = ask(p);
    // Only the clock moves: a start time worked out again on every call would move with it.
    clock += 120_000;
    const second = ask(p);

    expect(second.server.startedAt).toBe(first.server.startedAt);
  });

  it('uses the real clock and process.uptime() in seconds when none are injected', () => {
    // The server injects neither, so these defaults are all production uses.
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.spyOn(process, 'uptime').mockReturnValue(7200.9);
    try {
      const { server } = createStatusProvider({ version: '0.1.0', database: () => db, artifact: () => null }).describe({
        ready: true,
        keyName: 'alice',
        sessions: SESSIONS,
      });

      expect(server.uptimeSeconds).toBe(7200);
      expect(server.startedAt).toBe('2026-10-25T06:59:59.100Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the uptime on every call', () => {
    const p = provider();
    ask(p);
    uptime += 120;

    expect(ask(p).server.uptimeSeconds).toBe(3720);
  });

  it('rounds the uptime down to whole seconds', () => {
    uptime = 3600.9;

    expect(ask(provider()).server.uptimeSeconds).toBe(3600);
  });

  describe('cache', () => {
    it('keeps the whole index description for 60 seconds, so the document never disagrees with itself', () => {
      const p = provider();
      const first = ask(p).index;
      addObject(db, 'Another');
      stamp(db, { builtAt: '2026-10-25T09:00:30.000Z', version: '10.0.2500.1' });
      clock += 59_999;

      expect(ask(p).index).toEqual(first);
      expect(p.indexVersion()).toBe('10.0.2428.63');
    });

    it('reads the index again once the 60 seconds have passed', () => {
      const p = provider();
      ask(p);
      addObject(db, 'Another');
      stamp(db, { builtAt: '2026-10-25T09:00:30.000Z', version: '10.0.2500.1' });
      clock += 60_000;

      expect(ask(p).index).toMatchObject({ objects: 2, builtAt: '2026-10-25T09:00:30.000Z', applicationVersion: '10.0.2500.1' });
      expect(p.indexVersion()).toBe('10.0.2500.1');
    });

    it('does not freeze when the clock steps backwards', () => {
      const p = provider();
      ask(p);
      addObject(db, 'Another');
      clock -= 10_000;

      expect(ask(p).index).toMatchObject({ objects: 2 });
    });

    it('honours a shorter lifetime', () => {
      const p = provider({ cacheTtlMs: 1_000 });
      ask(p);
      addObject(db, 'Another');
      clock += 1_000;

      expect(ask(p).index).toMatchObject({ objects: 2 });
    });

    it('does not cache a failure', () => {
      let broken = true;
      const p = provider({
        database: () => {
          if (broken) throw new Error('database is not open');
          return db;
        },
      });

      expect(() => ask(p)).toThrow('database is not open');
      broken = false;

      expect(ask(p).index).toMatchObject({ objects: 1 });
    });

    it('starts again when the database handle is a different one', () => {
      let current = db;
      const other = seedDb([{ type: 'Table', name: 'A' }, { type: 'Table', name: 'B' }, { type: 'Table', name: 'C' }]);
      const p = provider({ database: () => current });
      try {
        expect(ask(p).index).toMatchObject({ objects: 1 });
        current = other;

        expect(ask(p).index).toMatchObject({ objects: 3 });
      } finally {
        other.close();
      }
    });
  });

  describe('indexVersion', () => {
    it('is the normalised application version of the index', () => {
      stamp(db, { version: ' 10.0.02428.063 ' });

      expect(provider().indexVersion()).toBe('10.0.2428.63');
    });

    it('is null when the version is unknown, or not a four-part version', () => {
      const unknown = seedDb([{ type: 'Table', name: 'T' }]);
      try {
        expect(provider({ database: () => unknown }).indexVersion()).toBeNull();
        expect(provider({ database: () => unknown, configuredApplicationVersion: '10.0.39' }).indexVersion()).toBeNull();
      } finally {
        unknown.close();
      }
    });

    it('uses the configured version when the index records none', () => {
      const unknown = seedDb([{ type: 'Table', name: 'T' }]);
      try {
        expect(provider({ database: () => unknown, configuredApplicationVersion: '10.0.2500.1' }).indexVersion()).toBe('10.0.2500.1');
      } finally {
        unknown.close();
      }
    });

    it('is null, not an error, while the database is not open', () => {
      expect(provider({ database: () => null }).indexVersion()).toBeNull();
    });

    it('is null, not an error, when the database cannot be read', () => {
      const closed = seedDb([{ type: 'Table', name: 'T' }]);
      closed.close();

      expect(provider({ database: () => closed }).indexVersion()).toBeNull();
    });

    it('logs why the version is unknown, under a key the logger does not overwrite', () => {
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const broken = provider({
        database: () => {
          throw new Error('index file unreadable');
        },
      });

      expect(broken.indexVersion()).toBeNull();

      // `message` is the logger's own field and would replace the reason.
      expect(debug).toHaveBeenCalledWith('Index version unavailable for the response header', {
        error: expect.stringContaining('index file unreadable'),
      });
    });
  });
});

describe('import boundary', () => {
  it('does not reach the server configuration, which exits the process on bad settings', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'serverStatus.ts'), 'utf-8');

    expect(source).not.toMatch(/from '\.\.?\/(?:\.\.\/)?(?:config|configLoader)\.js'/);
    expect(source).not.toMatch(/from '\.\/start\.js'/);
    expect(source).not.toMatch(/from '\.\/httpTransport\.js'/);
  });
});
