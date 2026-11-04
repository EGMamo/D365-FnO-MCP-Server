import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { getObjectByName, getObjectHeader, searchSymbols } from '../src/indexer/db.js';
import { sourceFileReadsAllowed } from '../src/indexer/sourceFiles.js';
import { openLocalIndex, type LocalIndexOptions } from '../src/gateway/localIndex.js';
import type { LocalIndex } from '../src/gateway/types.js';

// Passes through to the real indexer; tests count runs and inject failures or delays.
vi.mock('../src/indexer/buildIndex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/buildIndex.js')>();
  return { ...actual, buildIndex: vi.fn(actual.buildIndex) };
});

const real = await vi.importActual<typeof import('../src/indexer/buildIndex.js')>('../src/indexer/buildIndex.js');
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const runs = () => vi.mocked(buildIndex).mock.calls.length;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tableXml(name: string, fields: string[]): string {
  const items = fields
    .map((f) => `<AxTableField i:type="AxTableFieldString"><Name>${f}</Name></AxTableField>`)
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Name>${name}</Name>
  <Fields>${items}</Fields>
</AxTable>`;
}

describe('openLocalIndex', () => {
  let root: string;
  let customDir: string;
  let dbPath: string;
  let clock: number;
  let opened: LocalIndex[];

  /** Writes <customDir>/CustPkg/CustModel/<typeDir>/<name>.xml with an mtime no earlier write shares. */
  function writeAot(typeDir: string, name: string, xml: string): string {
    const dir = path.join(customDir, 'CustPkg', 'CustModel', typeDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.xml`);
    fs.writeFileSync(file, xml);
    clock += 10;
    fs.utimesSync(file, clock, clock);
    return file;
  }

  const writeTable = (name: string, fields: string[] = ['AccountNum']) =>
    writeAot('AxTable', name, tableXml(name, fields));

  function writeLabels(): void {
    const dir = path.join(customDir, 'CustPkg', 'CustModel', 'AxLabelFile', 'LabelResources', 'en-US');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CustLabels.en-US.label.txt'), 'Label1=Custom one\nLabel2=Custom two\n');
  }

  async function open(overrides: Partial<LocalIndexOptions> = {}): Promise<LocalIndex> {
    const index = await openLocalIndex({ customDir, dbPath, ttlMs: 60_000, debounceMs: 0, ...overrides });
    opened.push(index);
    return index;
  }

  const hasTable = (index: LocalIndex, name: string) => getObjectHeader(index.db, name, 'Table') !== null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-index-'));
    customDir = path.join(root, 'Custom');
    dbPath = path.join(root, 'state', 'local', 'custom_index.db');
    fs.mkdirSync(customDir);
    clock = 1_700_000_000;
    opened = [];
    vi.mocked(buildIndex).mockReset();
    vi.mocked(buildIndex).mockImplementation(real.buildIndex);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const index of opened) index.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates the database directory and indexes the custom objects before resolving', async () => {
    writeTable('CustTable', ['AccountNum', 'Amount']);
    fs.copyFileSync(path.join(fixturesDir, 'AxClassSample.xml'), writeAot('AxClass', 'CustHelper', ''));
    writeLabels();

    const index = await open();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(index.customDir).toBe(customDir);
    expect(getObjectByName(index.db, 'CustTable', 'Table')?.fields.map((f) => f.name)).toEqual(['AccountNum', 'Amount']);
    expect(getObjectHeader(index.db, 'CustHelper', 'Class')).not.toBeNull();
    expect(searchSymbols(index.db, 'CustTable')).toHaveLength(1);
    const status = index.status();
    expect(status).toMatchObject({ customDirName: 'Custom', objects: 2, labels: 2, dirty: false, watcher: 'inactive', lastError: null });
    expect(status.lastRefreshAt).not.toBeNull();
    expect(sourceFileReadsAllowed()).toBe(true);
  });

  it('rejects invalid options', async () => {
    await expect(openLocalIndex({ customDir: '', dbPath, ttlMs: 1000 })).rejects.toThrow();
    await expect(openLocalIndex({ customDir, dbPath, ttlMs: -1 })).rejects.toThrow();
  });

  it('serves the index as it is until it is marked dirty', async () => {
    writeTable('CustTable');
    const index = await open();
    const before = runs();

    writeTable('LaterTable');
    await index.ensureFresh();

    expect(runs()).toBe(before);
    expect(hasTable(index, 'LaterTable')).toBe(false);
  });

  it('picks up an added, edited and deleted file', async () => {
    writeTable('CustTable', ['AccountNum']);
    const index = await open();

    writeTable('AddedTable');
    index.markDirty();
    expect(index.status().dirty).toBe(true);
    await index.ensureFresh();
    expect(hasTable(index, 'AddedTable')).toBe(true);
    expect(index.status().dirty).toBe(false);
    expect(index.status().objects).toBe(2);

    writeTable('CustTable', ['AccountNum', 'EditedField']);
    index.markDirty();
    await index.ensureFresh();
    expect(getObjectByName(index.db, 'CustTable', 'Table')?.fields.map((f) => f.name)).toEqual(['AccountNum', 'EditedField']);

    fs.rmSync(path.join(customDir, 'CustPkg', 'CustModel', 'AxTable', 'AddedTable.xml'));
    index.markDirty();
    await index.ensureFresh();
    expect(hasTable(index, 'AddedTable')).toBe(false);
    expect(searchSymbols(index.db, 'AddedTable')).toHaveLength(0);
    expect(index.status().objects).toBe(1);
  });

  it('refreshes once the TTL has passed even though nothing was marked dirty', async () => {
    writeTable('CustTable');
    vi.useFakeTimers({ toFake: ['Date'] });
    const index = await open({ ttlMs: 30_000 });
    const before = runs();

    vi.setSystemTime(Date.now() + 29_000);
    await index.ensureFresh();
    expect(runs()).toBe(before);

    writeTable('TtlTable');
    vi.setSystemTime(Date.now() + 2_000);
    await index.ensureFresh();
    expect(runs()).toBe(before + 1);
    expect(hasTable(index, 'TtlTable')).toBe(true);

    await index.ensureFresh();
    expect(runs()).toBe(before + 1);
  });

  it('shares one run between concurrent callers', async () => {
    writeTable('CustTable');
    const index = await open();
    const before = runs();

    writeTable('SharedTable');
    index.markDirty();
    await Promise.all([index.ensureFresh(), index.ensureFresh(), index.ensureFresh()]);

    expect(runs()).toBe(before + 1);
    expect(hasTable(index, 'SharedTable')).toBe(true);
  });

  it('runs one more pass for a change that arrived after the scan began', async () => {
    writeTable('CustTable');
    const index = await open();
    const before = runs();

    const scanned = deferred();
    const release = deferred();
    vi.mocked(buildIndex).mockImplementationOnce(async (...args) => {
      const stats = await real.buildIndex(...args);
      scanned.resolve();
      await release.promise;
      return stats;
    });

    index.markDirty();
    const first = index.ensureFresh();
    await scanned.promise;
    writeTable('LateTable');
    index.markDirty();
    const second = index.ensureFresh();
    const third = index.ensureFresh();
    release.resolve();
    await Promise.all([first, second, third]);

    expect(runs()).toBe(before + 2);
    expect(hasTable(index, 'LateTable')).toBe(true);
    expect(index.status().dirty).toBe(false);
  });

  it('waits for changes to stop before refreshing', async () => {
    writeTable('CustTable');
    const index = await open({ debounceMs: 120 });

    index.markDirty();
    const startedAt = performance.now();
    await index.ensureFresh();

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(100);
  });

  it('keeps an in-memory index off the disk', async () => {
    writeTable('CustTable');
    // A relative ':memory:' resolved against the working directory would become a database file there.
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const index = await open({ dbPath: ':memory:' });

    expect(hasTable(index, 'CustTable')).toBe(true);
    expect(index.status()).toMatchObject({ objects: 1, lastError: null });
    expect(fs.readdirSync(root)).toEqual(['Custom']);

    vi.mocked(buildIndex).mockRejectedValueOnce(new Error(`EACCES: permission denied, scandir '${customDir}/CustPkg'`));
    index.markDirty();
    await index.ensureFresh();
    expect(index.status().lastError).toBe("EACCES: permission denied, scandir '<customDir>/CustPkg'");
  });

  describe.skipIf(process.platform === 'win32')('links in the custom folder', () => {
    let outside: string;

    beforeEach(() => {
      outside = path.join(root, 'outside');
      fs.mkdirSync(path.join(outside, 'enums'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET-NOT-XML');
      fs.writeFileSync(path.join(outside, 'keys.env'), 'HOSTED_KEY=SUPERSECRET\n');
      fs.writeFileSync(path.join(outside, 'enums', 'Leaked.xml'), '<AxEnum><Name>Leaked</Name></AxEnum>');
    });

    const modelPath = (...parts: string[]) => path.join(customDir, 'CustPkg', 'CustModel', ...parts);

    function link(target: string, ...from: string[]): void {
      fs.mkdirSync(path.dirname(modelPath(...from)), { recursive: true });
      fs.symlinkSync(target, modelPath(...from));
    }

    const labelValues = (index: LocalIndex) =>
      (index.db.prepare('SELECT value FROM ax_labels ORDER BY value').all() as { value: string }[]).map((row) => row.value);

    it('does not index a file, a label file or a folder that leads out of the folder', async () => {
      writeTable('CustTable');
      link(path.join(outside, 'secret.txt'), 'AxClass', 'Linked.xml');
      link(path.join(outside, 'keys.env'), 'AxLabelFile', 'LabelResources', 'en-US', 'Leak.en-US.label.txt');
      link(path.join(outside, 'enums'), 'AxEnum');
      link(path.join(outside, 'missing.xml'), 'AxClass', 'Dangling.xml');

      const index = await open();

      expect(hasTable(index, 'CustTable')).toBe(true);
      expect(getObjectHeader(index.db, 'Linked', 'Class')).toBeNull();
      expect(getObjectHeader(index.db, 'Leaked', 'Enum')).toBeNull();
      expect(getObjectHeader(index.db, 'Dangling', 'Class')).toBeNull();
      expect(labelValues(index)).toEqual([]);
      expect(index.status()).toMatchObject({ objects: 1, labels: 0, lastError: null });
      const stored = (index.db.prepare('SELECT COUNT(*) AS count FROM ax_objects WHERE raw_xml LIKE ?').get('%SECRET%') as { count: number }).count;
      expect(stored).toBe(0);
    });

    it('still indexes a link that stays inside the folder, and drops a file that becomes a link out of it', async () => {
      writeTable('CustTable');
      link(modelPath('AxTable', 'CustTable.xml'), 'AxTable', 'CustAlias.xml');
      const index = await open();
      expect(hasTable(index, 'CustAlias')).toBe(true);

      fs.rmSync(modelPath('AxTable', 'CustAlias.xml'));
      link(path.join(outside, 'secret.txt'), 'AxTable', 'CustAlias.xml');
      index.markDirty();
      await index.ensureFresh();

      expect(hasTable(index, 'CustAlias')).toBe(false);
      expect(hasTable(index, 'CustTable')).toBe(true);
    });
  });

  describe('when files were removed', () => {
    beforeEach(() => {
      for (let n = 1; n <= 6; n++) writeTable(`Tbl${n}`, ['AccountNum', `Extra${n}`]);
      writeLabels();
    });

    const removeTables = (from: number, to: number) => {
      for (let n = from; n <= to; n++) fs.rmSync(path.join(customDir, 'CustPkg', 'CustModel', 'AxTable', `Tbl${n}.xml`));
    };

    it('rebuilds from scratch when the prune guard kept most of them', async () => {
      const index = await open();
      const handle = index.db;
      expect(index.status().objects).toBe(6);

      removeTables(1, 4);
      // The indexer alone keeps every row: the scan overlaps fewer than half of them.
      const alone = await real.buildIndex(index.db, customDir, false);
      expect(alone.deleted).toBe(0);
      expect(index.status().objects).toBe(6);

      const before = runs();
      index.markDirty();
      await index.ensureFresh();

      expect(vi.mocked(buildIndex).mock.calls.slice(before).map((call) => call[2])).toEqual([false, true]);
      expect(index.status()).toMatchObject({ objects: 2, labels: 2, lastError: null });
      expect(hasTable(index, 'Tbl1')).toBe(false);
      expect(hasTable(index, 'Tbl5')).toBe(true);
      expect(searchSymbols(index.db, 'Tbl1')).toHaveLength(0);
      expect(searchSymbols(index.db, 'Tbl5')).toHaveLength(1);
      expect((index.db.prepare('SELECT COUNT(*) AS count FROM ax_fields').get() as { count: number }).count).toBe(4);
      // Tool handlers hold this connection, so it must survive the rebuild.
      expect(index.db).toBe(handle);
      expect(handle.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
    });

    it('counts only object files when it looks for rows the prune guard kept, so label files cannot hide them', async () => {
      // Four label files and two tables remain: as many scanned files as the six rows, but only two of them objects.
      for (const language of ['de-DE', 'fr-FR', 'es-ES']) {
        const dir = path.join(customDir, 'CustPkg', 'CustModel', 'AxLabelFile', 'LabelResources', language);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `CustLabels.${language}.label.txt`), `Label1=Custom one ${language}\n`);
      }
      const index = await open();
      expect(index.status()).toMatchObject({ objects: 6, labels: 5 });

      removeTables(1, 4);
      index.markDirty();
      await index.ensureFresh();

      expect(index.status()).toMatchObject({ objects: 2, labels: 5, lastError: null });
      expect(hasTable(index, 'Tbl1')).toBe(false);
      expect(hasTable(index, 'Tbl5')).toBe(true);
    });

    it('prunes normally, without a rebuild, when most files remain', async () => {
      const index = await open();
      const before = runs();

      removeTables(1, 1);
      index.markDirty();
      await index.ensureFresh();

      expect(vi.mocked(buildIndex).mock.calls.slice(before).map((call) => call[2])).toEqual([false]);
      expect(hasTable(index, 'Tbl1')).toBe(false);
      expect(index.status().objects).toBe(5);
    });

    it('keeps the index when the scan finds no files at all', async () => {
      const index = await open();

      removeTables(1, 6);
      fs.rmSync(path.join(customDir, 'CustPkg'), { recursive: true });
      index.markDirty();
      await index.ensureFresh();

      expect(index.status()).toMatchObject({ objects: 6, lastError: null });
    });

    it('reports an unreachable directory and keeps the index', async () => {
      const index = await open();
      const refreshedAt = index.status().lastRefreshAt;

      fs.rmSync(customDir, { recursive: true });
      index.markDirty();
      await index.ensureFresh();

      const status = index.status();
      expect(status.objects).toBe(6);
      expect(status.lastRefreshAt).toBe(refreshedAt);
      expect(status.lastError).toBe('Custom metadata directory is not accessible (ENOENT)');
    });
  });

  it('keeps serving the stale index when a build fails, then recovers', async () => {
    writeTable('CustTable');
    const index = await open();
    const refreshedAt = index.status().lastRefreshAt;

    writeTable('NewTable');
    vi.mocked(buildIndex).mockRejectedValueOnce(new Error(`EACCES: permission denied, scandir '${customDir}/CustPkg'`));
    index.markDirty();
    await expect(index.ensureFresh()).resolves.toBeUndefined();

    let status = index.status();
    expect(status.lastError).toBe("EACCES: permission denied, scandir '<customDir>/CustPkg'");
    expect(status.lastRefreshAt).toBe(refreshedAt);
    expect(hasTable(index, 'CustTable')).toBe(true);
    expect(hasTable(index, 'NewTable')).toBe(false);

    // The retry waits for the TTL or the next change instead of failing on every call.
    const before = runs();
    await index.ensureFresh();
    expect(runs()).toBe(before);

    index.markDirty();
    await index.ensureFresh();
    status = index.status();
    expect(status.lastError).toBeNull();
    expect(hasTable(index, 'NewTable')).toBe(true);
  });

  it('never exposes a full path in the status', async () => {
    writeTable('CustTable');
    const index = await open();
    vi.mocked(buildIndex).mockRejectedValueOnce(new Error(`disk error at ${path.dirname(dbPath)}${path.sep}custom_index.db`));
    index.markDirty();
    await index.ensureFresh();

    const status = index.status();
    const text = JSON.stringify(status);
    expect(status.customDirName).toBe('Custom');
    expect(status.lastError).toBe(`disk error at <dbDir>${path.sep}custom_index.db`);
    expect(text).not.toContain(root);
    expect(text).not.toContain(os.tmpdir());
    expect(new Date(status.lastRefreshAt ?? '').toISOString()).toBe(status.lastRefreshAt);
  });

  describe('watcher', () => {
    it('marks the index dirty when an AOT watcher event arrives', async () => {
      writeTable('CustTable');
      const index = await open();
      expect(index.status().dirty).toBe(false);

      const fake = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
      let onChange: fs.WatchListener<string> | undefined;
      const watch = (
        _filename: fs.PathLike,
        _options: fs.WatchOptions,
        listener: fs.WatchListener<string>,
      ): fs.FSWatcher => {
        onChange = listener;
        return fake as unknown as fs.FSWatcher;
      };
      vi.spyOn(fs, 'watch').mockImplementation(watch as typeof fs.watch);
      index.startWatcher();
      expect(index.status().watcher).toBe('active');

      writeTable('WatchedTable');
      onChange?.('rename', 'WatchedTable.xml');
      expect(index.status().dirty).toBe(true);
      await index.ensureFresh();
      expect(hasTable(index, 'WatchedTable')).toBe(true);
    });

    it('falls back to the TTL when the watcher cannot start', async () => {
      writeTable('CustTable');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.spyOn(fs, 'watch').mockImplementation(() => {
        throw new Error(`ENOSPC: no watch space left for ${customDir}`);
      });
      const index = await open({ ttlMs: 30_000 });

      index.startWatcher();
      expect(index.status()).toMatchObject({ watcher: 'error', watcherError: 'ENOSPC: no watch space left for <customDir>' });

      writeTable('TtlTable');
      vi.setSystemTime(Date.now() + 31_000);
      await index.ensureFresh();
      expect(hasTable(index, 'TtlTable')).toBe(true);
    });

    it('records an error raised by a running watcher and closes it', async () => {
      const fake = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
      vi.spyOn(fs, 'watch').mockReturnValue(fake as unknown as fs.FSWatcher);
      const index = await open();

      index.startWatcher();
      expect(index.status().watcher).toBe('active');
      fake.emit('error', new Error('EMFILE: too many open files'));

      expect(index.status()).toMatchObject({ watcher: 'error', watcherError: 'EMFILE: too many open files' });
      expect(fake.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('close', () => {
    it('closes the watcher and releases the database', async () => {
      writeTable('CustTable');
      const index = await open();
      const fake = Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() });
      vi.spyOn(fs, 'watch').mockReturnValue(fake as unknown as fs.FSWatcher);
      index.startWatcher();

      index.close();
      index.close();

      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(() => index.db.prepare('SELECT 1')).toThrow();
      expect(index.status()).toMatchObject({ objects: 1, watcher: 'inactive' });

      const before = runs();
      index.markDirty();
      await expect(index.ensureFresh()).resolves.toBeUndefined();
      index.startWatcher();
      expect(runs()).toBe(before);
      expect(index.status().watcher).toBe('inactive');
    });

    it('lets a pass in flight finish before the database is closed', async () => {
      writeTable('CustTable');
      const index = await open();
      const scanned = deferred();
      const release = deferred();
      vi.mocked(buildIndex).mockImplementationOnce(async (...args) => {
        const stats = await real.buildIndex(...args);
        scanned.resolve();
        await release.promise;
        return stats;
      });

      index.markDirty();
      const pass = index.ensureFresh();
      await scanned.promise;
      index.close();
      expect(index.db.isOpen).toBe(true);

      release.resolve();
      await pass;
      await vi.waitFor(() => expect(index.db.isOpen).toBe(false));
      expect(index.status().lastError).toBeNull();
    });

    it('releases callers waiting out the debounce without building', async () => {
      writeTable('CustTable');
      const index = await open({ debounceMs: 60_000 });
      const before = runs();

      index.markDirty();
      const waiting = index.ensureFresh();
      index.close();
      await expect(waiting).resolves.toBeUndefined();

      expect(runs()).toBe(before);
      expect(index.db.isOpen).toBe(false);
    });
  });
});
