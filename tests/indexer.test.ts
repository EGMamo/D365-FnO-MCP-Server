import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import type { Database } from '../src/indexer/db.js';
import { openDb, getObjectByName, searchSymbols, type Xref } from '../src/indexer/db.js';
import { buildIndex, getIndexStats } from '../src/indexer/buildIndex.js';
import { logger } from '../src/utils/logger.js';
import { collectMetadataTools } from './helpers/toolHarness.js';
import { validateCoCTarget } from '../src/validation/grounding.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, 'fixtures');
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function xrefsFrom(db: Database, name: string, type: string): Xref[] {
  return db.prepare('SELECT * FROM ax_xref WHERE from_name = ? AND from_type = ?').all(name, type) as unknown as Xref[];
}

/** Build a fake PackagesLocalDirectory layout: <root>/<Package>/<Model>/<AxType>/<Name>.xml */
function stagePackages(root: string) {
  const layout: [string, string, string][] = [
    ['AxTable', 'AxTableSample.xml', 'SampleTable'],
    ['AxClass', 'AxClassSample.xml', 'SampleClass'],
    ['AxEnum', 'AxEnumSample.xml', 'SampleEnum'],
    ['AxForm', 'AxFormSample.xml', 'SampleForm'],
    ['AxQuery', 'AxQuerySample.xml', 'SampleQuery'],
    ['AxDataEntityView', 'AxDataEntityViewSample.xml', 'SampleEntity'],
    ['AxEdt', 'AxEdtSample.xml', 'SampleEdt'],
  ];

  for (const [typeDir, fixture, name] of layout) {
    const dir = path.join(root, 'TestPackage', 'TestModel', typeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(fixturesDir, fixture), path.join(dir, `${name}.xml`));
  }

  const labelDir = path.join(root, 'TestPackage', 'TestModel', 'AxLabelFile');
  fs.mkdirSync(labelDir, { recursive: true });
  fs.writeFileSync(path.join(labelDir, 'SampleLabels_en-US.label.txt'), 'SYS1=Account\nSYS2=Amount\n');
}

describe('Indexer DB Tests', () => {
  it('migrates older databases before creating indexes on new columns', () => {
    const tmpDir = fs.mkdtempSync(path.join(testDir, '.tmp-old-db-'));
    const dbPath = path.join(tmpDir, 'old.db');
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE ax_objects (
        id INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        package TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        file_path TEXT NOT NULL,
        raw_xml TEXT,
        file_mtime INTEGER NOT NULL DEFAULT 0,
        UNIQUE(type, name)
      );
      CREATE TABLE ax_fields (
        id INTEGER PRIMARY KEY,
        object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT,
        edt TEXT,
        label_id TEXT,
        mandatory INTEGER DEFAULT 0,
        allow_edit INTEGER DEFAULT 1
      );
      CREATE TABLE ax_methods (
        id INTEGER PRIMARY KEY,
        object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        access_modifier TEXT DEFAULT 'public',
        return_type TEXT,
        params TEXT,
        is_static INTEGER DEFAULT 0,
        is_abstract INTEGER DEFAULT 0
      );
      CREATE TABLE ax_labels (
        id INTEGER PRIMARY KEY,
        label_id TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'en-US',
        value TEXT NOT NULL,
        UNIQUE(label_id, language)
      );
      CREATE TABLE ax_xref (
        id INTEGER PRIMARY KEY,
        from_type TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_type TEXT NOT NULL,
        to_name TEXT NOT NULL,
        xref_kind TEXT
      );
      CREATE TABLE ax_enum_values (
        id INTEGER PRIMARY KEY,
        object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value TEXT,
        label_id TEXT
      );
      CREATE TABLE ax_datasources (
        id INTEGER PRIMARY KEY,
        object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        table_name TEXT
      );
      CREATE TABLE ax_form_controls (
        id INTEGER PRIMARY KEY,
        object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT,
        parent_name TEXT
      );
      CREATE TABLE ax_properties (
        id INTEGER PRIMARY KEY,
        object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT,
        UNIQUE(object_id, key)
      );
    `);
    oldDb.close();

    const db = openDb(dbPath);
    try {
      const labelCols = (db.prepare(`PRAGMA table_info(ax_labels)`).all() as { name: string }[]).map((c) => c.name);
      expect(labelCols).toContain('source_file');
      const indexes = (db.prepare(`PRAGMA index_list(ax_labels)`).all() as { name: string }[]).map((i) => i.name);
      expect(indexes).toContain('idx_ax_labels_source_file');
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('buildIndex with fixtures', () => {
  let db: Database;
  let root: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(testDir, '.tmp-packages-'));
    stagePackages(root);
    db = openDb(':memory:');
    await buildIndex(db, root, true);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('indexes all object types', () => {
    const stats = getIndexStats(db);
    expect(stats.byType).toMatchObject({
      Table: 1,
      Class: 1,
      Enum: 1,
      Form: 1,
      Query: 1,
      DataEntity: 1,
      Edt: 1,
    });
    expect(stats.totalLabels).toBe(2);
  });

  it('stores table fields with correct types', () => {
    const table = getObjectByName(db, 'SampleTable', 'Table')!;
    expect(table.fields.map((f: { name: string; type: string }) => [f.name, f.type])).toEqual([
      ['AccountNum', 'String'],
      ['LineNum', 'Int'],
      ['Amount', 'Real'],
    ]);
    expect(table.properties.extends).toBe('BaseTable');
  });

  it('stores class methods with params', () => {
    const cls = getObjectByName(db, 'SampleClass', 'Class')!;
    const construct = cls.methods.find((m: { name: string }) => m.name === 'construct');
    expect(construct).toBeDefined();
    expect(construct.is_static).toBe(1);
    const build = cls.methods.find((m: { name: string }) => m.name === 'buildMessage');
    expect(build.params).toEqual([
      { name: '_prefix', type: 'str' },
      { name: '_count', type: 'int' },
    ]);
    expect(build.access_modifier).toBe('protected');
  });

  it('stores enum values', () => {
    const en = getObjectByName(db, 'SampleEnum', 'Enum')!;
    expect(en.enumValues).toEqual([
      { name: 'None', value: '0', label_id: '@SYS1000' },
      { name: 'Open', value: '1', label_id: '' },
      { name: 'Closed', value: '2', label_id: '' },
    ]);
  });

  it('stores form datasources and controls', () => {
    const form = getObjectByName(db, 'SampleForm', 'Form')!;
    expect(form.dataSources).toEqual([{ name: 'SampleTable', table_name: 'SampleTable' }]);
    expect(form.properties.pattern).toBe('SimpleListDetails');
    const controlNames = form.controls.map((c: { name: string }) => c.name);
    expect(controlNames).toContain('MainGroup');
    expect(controlNames).toContain('AccountNum');
    const nested = form.controls.find((c: { name: string }) => c.name === 'AccountNum');
    expect(nested.parent_name).toBe('MainGroup');
  });

  it('stores query datasources', () => {
    const q = getObjectByName(db, 'SampleQuery', 'Query')!;
    expect(q.dataSources).toEqual([
      { name: 'SampleTable', table_name: 'SampleTable' },
      { name: 'ChildTable', table_name: 'ChildTable' },
    ]);
  });

  it('stores data entity fields and properties', () => {
    const e = getObjectByName(db, 'SampleEntity', 'DataEntity')!;
    expect(e.fields.map((f: { name: string; data_field: string }) => [f.name, f.data_field])).toEqual([
      ['AccountNum', 'AccountNum'],
      ['Amount', 'Amount'],
    ]);
    expect(e.properties.stagingTable).toBe('SampleEntityStaging');
    expect(e.properties.isPublic).toBe('true');
  });

  it('stores EDT properties', () => {
    const edt = getObjectByName(db, 'SampleEdt', 'Edt')!;
    expect(edt.properties).toMatchObject({
      extends: 'CustAccount',
      label: '@SYS4001',
      helpText: '@SYS4002',
      stringSize: '30',
    });
  });

  it('records cross references', () => {
    const tableXrefs = xrefsFrom(db, 'SampleTable', 'Table');
    expect(tableXrefs.some((x) => x.to_name === 'BaseTable' && x.xref_kind === 'extends')).toBe(true);
    expect(tableXrefs.some((x) => x.to_name === 'CustAccount' && x.to_type === 'Edt')).toBe(true);

    const formXrefs = xrefsFrom(db, 'SampleForm', 'Form');
    expect(formXrefs.some((x) => x.to_name === 'SampleTable' && x.xref_kind === 'datasource')).toBe(true);

    const classXrefs = xrefsFrom(db, 'SampleClass', 'Class');
    expect(classXrefs.some((x) => x.to_name === 'SysPackable' && x.xref_kind === 'implements')).toBe(true);
  });

  it('supports full-text search over indexed objects', () => {
    const results = searchSymbols(db, 'SampleTable') as { name: string; type: string }[];
    expect(results.some((r) => r.name === 'SampleTable' && r.type === 'Table')).toBe(true);
  });

  it('skips unchanged files on a second incremental run', async () => {
    const stats = await buildIndex(db, root, false);
    expect(stats.skipped).toBe(stats.total);
    expect(stats.added).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(stats.collisions).toBe(0);
  });

  it('skips FTS rebuild when an incremental run has no changed content', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, root, false);
      expect(stats.skipped).toBe(stats.total);
      expect(info).toHaveBeenCalledWith('Skipping FTS rebuild; no indexed content changed');
      expect(info).not.toHaveBeenCalledWith('Rebuilding FTS index', expect.anything());
    } finally {
      info.mockRestore();
    }
  });

  it('rebuilds both FTS indexes on force even when only objects are scanned', async () => {
    const objectOnlyRoot = fs.mkdtempSync(path.join(testDir, '.tmp-object-only-'));
    const classDir = path.join(objectOnlyRoot, 'TestPackage', 'TestModel', 'AxClass');
    fs.mkdirSync(classDir, { recursive: true });
    fs.copyFileSync(path.join(fixturesDir, 'AxClassSample.xml'), path.join(classDir, 'SampleClass.xml'));
    const objectOnlyDb = openDb(':memory:');
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await buildIndex(objectOnlyDb, objectOnlyRoot, true);
      expect(info).toHaveBeenCalledWith('Rebuilding FTS index', { objects: true, labels: true });
    } finally {
      info.mockRestore();
      objectOnlyDb.close();
      fs.rmSync(objectOnlyRoot, { recursive: true, force: true });
    }
  });
});

describe('index lifecycle: pruning, renames and collisions', () => {
  let db: Database;
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(testDir, '.tmp-lifecycle-'));
    stagePackages(root);
    db = openDb(':memory:');
    await buildIndex(db, root, true);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('prunes objects whose file was removed from disk', async () => {
    fs.rmSync(path.join(root, 'TestPackage', 'TestModel', 'AxClass', 'SampleClass.xml'));

    const stats = await buildIndex(db, root, false);

    expect(stats.deleted).toBe(1);
    expect(getObjectByName(db, 'SampleClass', 'Class')).toBeNull();
    expect(xrefsFrom(db, 'SampleClass', 'Class')).toEqual([]);
    expect(getObjectByName(db, 'SampleTable', 'Table')).not.toBeNull();
    const results = searchSymbols(db, 'SampleClass') as { name: string }[];
    expect(results.some((r) => r.name === 'SampleClass')).toBe(false);
  });

  it('does not prune when the scan returns no files at all', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(testDir, '.tmp-empty-'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, emptyRoot, false);
      expect(stats.total).toBe(0);
      expect(stats.deleted).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        'Skipping prune: no files were scanned',
        expect.anything()
      );
      expect(getIndexStats(db).totalObjects).toBe(7);
      expect(getObjectByName(db, 'SampleClass', 'Class')).not.toBeNull();
    } finally {
      warn.mockRestore();
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('does not prune when more than half the scanned files fail to parse', async () => {
    const corruptRoot = fs.mkdtempSync(path.join(testDir, '.tmp-corrupt-'));
    const dir = path.join(corruptRoot, 'TestPackage', 'TestModel', 'AxClass');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(dir, `Corrupt${i}.xml`), '<AxClass><Name>Corrupt</Name');
    }

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, corruptRoot, false);
      expect(stats.total).toBe(4);
      expect(stats.errors / stats.total).toBeGreaterThan(0.5);
      expect(stats.deleted).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        'Skipping prune: too many files failed to parse',
        expect.anything()
      );
      expect(getObjectByName(db, 'SampleClass', 'Class')).not.toBeNull();
      expect(getObjectByName(db, 'SampleTable', 'Table')).not.toBeNull();
    } finally {
      warn.mockRestore();
      fs.rmSync(corruptRoot, { recursive: true, force: true });
    }
  });

  it('updates file_path on rename without leaving a stale row', async () => {
    const dir = path.join(root, 'TestPackage', 'TestModel', 'AxClass');
    const oldPath = path.join(dir, 'SampleClass.xml');
    const newDir = path.join(root, 'OtherPackage', 'OtherModel', 'AxClass');
    fs.mkdirSync(newDir, { recursive: true });
    const newPath = path.join(newDir, 'SampleClass.xml');
    fs.copyFileSync(oldPath, newPath);
    fs.rmSync(oldPath);

    const stats = await buildIndex(db, root, false);

    expect(stats.deleted).toBe(0);
    const rows = db
      .prepare(`SELECT file_path, package FROM ax_objects WHERE type = 'Class' AND name = 'SampleClass'`)
      .all() as { file_path: string; package: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path.replace(/\\/g, '/')).toBe(newPath.replace(/\\/g, '/'));
    expect(rows[0].package).toBe('OtherPackage');
  });

  it('logs a collision when two files define the same type and name', async () => {
    const dupDir = path.join(root, 'DupPackage', 'DupModel', 'AxClass');
    fs.mkdirSync(dupDir, { recursive: true });
    fs.copyFileSync(
      path.join(root, 'TestPackage', 'TestModel', 'AxClass', 'SampleClass.xml'),
      path.join(dupDir, 'SampleClass.xml')
    );

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, root, false);
      expect(stats.collisions).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^Collision: Class SampleClass defined in both .+ and .+$/),
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }

    const rows = db
      .prepare(`SELECT file_path FROM ax_objects WHERE type = 'Class' AND name = 'SampleClass'`)
      .all();
    expect(rows).toHaveLength(1);
  });

  it('prunes labels when their label file is removed', async () => {
    const labelPath = path.join(
      root,
      'TestPackage',
      'TestModel',
      'AxLabelFile',
      'SampleLabels_en-US.label.txt'
    );
    const sourced = db
      .prepare(`SELECT COUNT(*) as count FROM ax_labels WHERE source_file <> ''`)
      .get() as { count: number };
    expect(sourced.count).toBe(2);

    fs.rmSync(labelPath);
    await buildIndex(db, root, false);

    expect(getIndexStats(db).totalLabels).toBe(0);
  });

  it('re-indexing a label file replaces its previous labels', async () => {
    const labelPath = path.join(
      root,
      'TestPackage',
      'TestModel',
      'AxLabelFile',
      'SampleLabels_en-US.label.txt'
    );
    fs.writeFileSync(labelPath, 'SYS1=Account renamed\n');

    await buildIndex(db, root, false);

    const rows = db.prepare(`SELECT label_id, value FROM ax_labels`).all() as {
      label_id: string;
      value: string;
    }[];
    expect(rows).toEqual([{ label_id: 'SYS1', value: 'Account renamed' }]);
  });

  it('does not re-parse an unchanged label file', async () => {
    const labelPath = path.join(
      root,
      'TestPackage',
      'TestModel',
      'AxLabelFile',
      'SampleLabels_en-US.label.txt'
    );
    db.prepare(`UPDATE ax_labels SET value = ? WHERE label_id = ?`).run('Manual value', 'SYS1');

    const stats = await buildIndex(db, root, false);

    expect(stats.skipped).toBe(stats.total);
    const row = db.prepare(`SELECT value FROM ax_labels WHERE label_id = ?`).get('SYS1') as { value: string };
    expect(row.value).toBe('Manual value');
    expect(fs.existsSync(labelPath)).toBe(true);
  });

  it('re-applies a duplicate label from a surviving source when the winning source is deleted', async () => {
    const duplicateRoot = fs.mkdtempSync(path.join(testDir, '.tmp-label-dupe-'));
    const labelDir = path.join(duplicateRoot, 'TestPackage', 'TestModel', 'AxLabelFile');
    fs.mkdirSync(labelDir, { recursive: true });
    const first = path.join(labelDir, 'A_en-US.label.txt');
    const second = path.join(labelDir, 'B_en-US.label.txt');
    fs.writeFileSync(first, 'SYS1=First\n');
    fs.writeFileSync(second, 'SYS1=Second\n');
    const duplicateDb = openDb(':memory:');

    try {
      await buildIndex(duplicateDb, duplicateRoot, true);
      const winner = duplicateDb.prepare(`SELECT source_file FROM ax_labels WHERE label_id = ?`).get('SYS1') as {
        source_file: string;
      };
      const survivor = winner.source_file === first ? second : first;
      fs.rmSync(winner.source_file);

      await buildIndex(duplicateDb, duplicateRoot, false);

      const row = duplicateDb.prepare(`SELECT value, source_file FROM ax_labels WHERE label_id = ?`).get('SYS1') as {
        value: string;
        source_file: string;
      };
      expect(row).toBeDefined();
      expect(row.source_file).toBe(survivor);
    } finally {
      duplicateDb.close();
      fs.rmSync(duplicateRoot, { recursive: true, force: true });
    }
  });

  it('retries label recovery on the next run when re-applying the survivor fails', async () => {
    const duplicateRoot = fs.mkdtempSync(path.join(testDir, '.tmp-label-retry-'));
    const labelDir = path.join(duplicateRoot, 'TestPackage', 'TestModel', 'AxLabelFile');
    fs.mkdirSync(labelDir, { recursive: true });
    const first = path.join(labelDir, 'A_en-US.label.txt');
    const second = path.join(labelDir, 'B_en-US.label.txt');
    fs.writeFileSync(first, 'SYS1=First\n');
    fs.writeFileSync(second, 'SYS1=Second\n');
    const retryDb = openDb(':memory:');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const realReadFile = fsp.readFile;

    try {
      await buildIndex(retryDb, duplicateRoot, true);
      const winner = retryDb.prepare(`SELECT source_file FROM ax_labels WHERE label_id = ?`).get('SYS1') as {
        source_file: string;
      };
      const survivor = winner.source_file === first ? second : first;
      fs.rmSync(winner.source_file);

      // Fail reads of the survivor so the post-prune recovery pass fails. A
      // chmod 0o000 cannot do this portably: Windows ignores POSIX permission
      // bits and root bypasses them, so the file would stay readable.
      const readFile = vi.spyOn(fsp, 'readFile').mockImplementation((async (file: unknown, ...rest: unknown[]) => {
        if (file === survivor) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${survivor}'`), { code: 'EACCES' });
        }
        return (realReadFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
      }) as typeof fsp.readFile);
      try {
        await buildIndex(retryDb, duplicateRoot, false);
        expect(readFile).toHaveBeenCalledWith(survivor, 'utf-8');
      } finally {
        readFile.mockRestore();
      }

      expect(warn).toHaveBeenCalledWith(
        'Failed to re-apply label source after prune; will retry next run',
        expect.objectContaining({ filePath: survivor })
      );

      // The tracked mtime must be cleared so the next run cannot skip the file.
      const tracked = retryDb
        .prepare(`SELECT file_mtime FROM ax_label_sources WHERE source_file = ?`)
        .get(survivor) as { file_mtime: number };
      expect(tracked.file_mtime).toBe(0);

      await buildIndex(retryDb, duplicateRoot, false);

      const row = retryDb.prepare(`SELECT source_file FROM ax_labels WHERE label_id = ?`).get('SYS1') as {
        source_file: string;
      };
      expect(row?.source_file).toBe(survivor);
    } finally {
      warn.mockRestore();
      retryDb.close();
      fs.rmSync(duplicateRoot, { recursive: true, force: true });
    }
  });

  it('prunes label source tracking for removed empty label files', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(testDir, '.tmp-empty-label-'));
    const labelDir = path.join(emptyRoot, 'TestPackage', 'TestModel', 'AxLabelFile');
    const classDir = path.join(emptyRoot, 'TestPackage', 'TestModel', 'AxClass');
    fs.mkdirSync(labelDir, { recursive: true });
    fs.mkdirSync(classDir, { recursive: true });
    const labelPath = path.join(labelDir, 'Empty_en-US.label.txt');
    fs.writeFileSync(labelPath, '# no parseable labels\n');
    fs.copyFileSync(path.join(fixturesDir, 'AxClassSample.xml'), path.join(classDir, 'SampleClass.xml'));
    const emptyDb = openDb(':memory:');

    try {
      await buildIndex(emptyDb, emptyRoot, true);
      expect(emptyDb.prepare(`SELECT COUNT(*) as count FROM ax_label_sources`).get()).toEqual({ count: 1 });
      fs.rmSync(labelPath);
      await buildIndex(emptyDb, emptyRoot, false);
      expect(emptyDb.prepare(`SELECT COUNT(*) as count FROM ax_label_sources`).get()).toEqual({ count: 0 });
    } finally {
      emptyDb.close();
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe('raw XML storage options', () => {
  let db: Database;
  let root: string;
  let previousStoreRawXml: string | undefined;

  beforeEach(async () => {
    previousStoreRawXml = process.env.D365_INDEX_STORE_RAW_XML;
    process.env.D365_INDEX_STORE_RAW_XML = '0';
    root = fs.mkdtempSync(path.join(testDir, '.tmp-rawxml-'));
    stagePackages(root);
    db = openDb(':memory:');
    await buildIndex(db, root, true);
  });

  afterEach(() => {
    if (previousStoreRawXml === undefined) {
      delete process.env.D365_INDEX_STORE_RAW_XML;
    } else {
      process.env.D365_INDEX_STORE_RAW_XML = previousStoreRawXml;
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('can omit raw_xml and read get_element_xml from the source file', async () => {
    const table = getObjectByName(db, 'SampleTable', 'Table')!;
    expect(table.raw_xml).toBeNull();

    const tools = collectMetadataTools(db);
    const getElementXml = tools.get('get_element_xml');
    if (!getElementXml) throw new Error('get_element_xml was not registered');

    const result = await getElementXml({ name: 'SampleTable', type: 'Table' });
    expect(result.content[0].text).toContain('<AxTable');
    expect(result.content[0].text).toContain('<Name>AccountNum</Name>');
  });

  it('reports a clear message when raw_xml is omitted and the source file is gone', async () => {
    const tablePath = path.join(root, 'TestPackage', 'TestModel', 'AxTable', 'SampleTable.xml');
    fs.rmSync(tablePath);

    const tools = collectMetadataTools(db);
    const getElementXml = tools.get('get_element_xml');
    if (!getElementXml) throw new Error('get_element_xml was not registered');

    const result = await getElementXml({ name: 'SampleTable', type: 'Table' });
    expect(result.content[0].text).toContain('Raw XML for Table SampleTable is not stored in the index');
    expect(result.content[0].text).toContain(tablePath);
  });

  it('keeps Chain of Command target validation safe when raw_xml is omitted', () => {
    const classPath = path.join(root, 'TestPackage', 'TestModel', 'AxClass', 'MyExtension.xml');
    fs.writeFileSync(
      classPath,
      '<AxClass><Name>MyExtension</Name><Source>[ExtensionOf(classStr(SalesLineType))] class MyExtension {}</Source></AxClass>'
    );

    return buildIndex(db, root, false).then(() => {
      expect(getObjectByName(db, 'MyExtension', 'Class')?.raw_xml).toBeNull();
      expect(validateCoCTarget(db, 'MyExtension')).toMatchObject({
        ok: false,
        error: expect.stringContaining('already an extension class'),
      });
    });
  });
});

describe('upgrade path from a pre-existing populated index', () => {
  let root: string;
  let workDir: string;
  let dbPath: string;
  let previousStoreRawXml: string | undefined;

  beforeEach(async () => {
    previousStoreRawXml = process.env.D365_INDEX_STORE_RAW_XML;
    delete process.env.D365_INDEX_STORE_RAW_XML;

    root = fs.mkdtempSync(path.join(testDir, '.tmp-upgrade-'));
    workDir = fs.mkdtempSync(path.join(testDir, '.tmp-upgradedb-'));
    dbPath = path.join(workDir, 'd365_index.db');
    stagePackages(root);

    // Populate a database the way the previous release did: raw_xml stored and
    // no label-source tracking table at all.
    const seedDb = openDb(dbPath);
    await buildIndex(seedDb, root, true);
    seedDb.close();

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`DROP TABLE IF EXISTS ax_label_sources`);
    rawDb.close();
  });

  afterEach(() => {
    if (previousStoreRawXml === undefined) {
      delete process.env.D365_INDEX_STORE_RAW_XML;
    } else {
      process.env.D365_INDEX_STORE_RAW_XML = previousStoreRawXml;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('reopens an old populated database without error or data loss', () => {
    const db = openDb(dbPath);
    try {
      expect(getIndexStats(db).totalObjects).toBe(7);
      expect(getIndexStats(db).totalLabels).toBe(2);
    } finally {
      db.close();
    }
  });

  it('skips unchanged objects and only catches up labels on the first upgraded run', async () => {
    process.env.D365_INDEX_STORE_RAW_XML = '0';
    const db = openDb(dbPath);
    try {
      const stats = await buildIndex(db, root, false);

      // Every AOT object is untouched on disk, so none may be re-parsed.
      expect(stats.added).toBe(0);
      expect(stats.skipped).toBe(7);
      // Only the label file is reprocessed, because ax_label_sources starts empty.
      expect(stats.updated).toBe(1);
      expect(stats.deleted).toBe(0);
    } finally {
      db.close();
    }
  });

  it('keeps raw_xml already stored for objects that were skipped', async () => {
    process.env.D365_INDEX_STORE_RAW_XML = '0';
    const db = openDb(dbPath);
    try {
      await buildIndex(db, root, false);

      const table = getObjectByName(db, 'SampleTable', 'Table')!;
      expect(table.raw_xml).toBeTruthy();
      expect(table.raw_xml).toContain('<AxTable');

      // Delete the source file to prove get_element_xml served raw_xml and never
      // needed the on-disk fallback for these pre-existing rows.
      fs.rmSync(path.join(root, 'TestPackage', 'TestModel', 'AxTable', 'SampleTable.xml'));

      const getElementXml = collectMetadataTools(db).get('get_element_xml');
      if (!getElementXml) throw new Error('get_element_xml was not registered');
      const result = await getElementXml({ name: 'SampleTable', type: 'Table' });
      expect(result.content[0].text).toContain('<AxTable');
    } finally {
      db.close();
    }
  });

  it('settles into a fully skipped run with no FTS rebuild after the label catch-up', async () => {
    const db = openDb(dbPath);
    try {
      await buildIndex(db, root, false);

      const infoSpy = vi.spyOn(logger, 'info');
      const stats = await buildIndex(db, root, false);

      expect(stats.skipped).toBe(8);
      expect(stats.added).toBe(0);
      expect(stats.updated).toBe(0);
      expect(infoSpy.mock.calls.some(([msg]) => msg === 'Rebuilding FTS index')).toBe(false);
      expect(
        infoSpy.mock.calls.some(([msg]) => msg === 'Skipping FTS rebuild; no indexed content changed')
      ).toBe(true);
      infoSpy.mockRestore();

      // Labels survived the catch-up and remain searchable.
      expect(getIndexStats(db).totalLabels).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('prune guard: partially available packages directory', () => {
  const dbs: Database[] = [];
  const roots: string[] = [];

  function stageClasses(names: string[]): string {
    const root = fs.mkdtempSync(path.join(testDir, '.tmp-partial-'));
    roots.push(root);
    const dir = path.join(root, 'TestPackage', 'TestModel', 'AxClass');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of names) {
      fs.copyFileSync(path.join(fixturesDir, 'AxClassSample.xml'), path.join(dir, `${name}.xml`));
    }
    return root;
  }

  function openTracked(): Database {
    const db = openDb(':memory:');
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not prune when only a fraction of the indexed objects is present', async () => {
    const root = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, root, true);
    expect(getIndexStats(db).totalObjects).toBe(3);

    const dir = path.join(root, 'TestPackage', 'TestModel', 'AxClass');
    fs.rmSync(path.join(dir, 'ClassB.xml'));
    fs.rmSync(path.join(dir, 'ClassC.xml'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, root, false);
      expect(stats.deleted).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Pruning skipped: only 1 of 3 existing objects overlap'),
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }

    expect(getIndexStats(db).totalObjects).toBe(3);
    expect(getObjectByName(db, 'ClassB', 'Class')).not.toBeNull();
    expect(getObjectByName(db, 'ClassC', 'Class')).not.toBeNull();
  });

  it('prunes when the scan still covers at least half of the indexed objects', async () => {
    const root = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, root, true);

    fs.rmSync(path.join(root, 'TestPackage', 'TestModel', 'AxClass', 'ClassC.xml'));
    const stats = await buildIndex(db, root, false);

    expect(stats.deleted).toBe(1);
    expect(getObjectByName(db, 'ClassC', 'Class')).toBeNull();
    expect(getObjectByName(db, 'ClassA', 'Class')).not.toBeNull();
    expect(getObjectByName(db, 'ClassB', 'Class')).not.toBeNull();
  });

  it('skips pruning when a disjoint scan of similar size does not overlap the existing objects', async () => {
    const original = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, original, true);
    expect(getIndexStats(db).totalObjects).toBe(3);

    // Disjoint tree: 2 new objects but 0 overlap vs 3 previously indexed => prune skipped.
    const replacement = stageClasses(['ClassD', 'ClassE']);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, replacement, false);
      expect(stats.deleted).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Pruning skipped: only 0 of 3 existing objects overlap'),
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }

    expect(getObjectByName(db, 'ClassA', 'Class')).not.toBeNull();
    expect(getObjectByName(db, 'ClassB', 'Class')).not.toBeNull();
    expect(getObjectByName(db, 'ClassC', 'Class')).not.toBeNull();
    expect(getIndexStats(db).totalObjects).toBe(5);
  });

  it('prunes the missing object when the scan overlaps two of three indexed objects', async () => {
    const root = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, root, true);
    expect(getIndexStats(db).totalObjects).toBe(3);

    // Keep ClassA/ClassB (overlap 2 >= 1.5), drop ClassC, add a brand new file.
    const dir = path.join(root, 'TestPackage', 'TestModel', 'AxClass');
    fs.rmSync(path.join(dir, 'ClassC.xml'));
    fs.copyFileSync(path.join(fixturesDir, 'AxClassSample.xml'), path.join(dir, 'ClassD.xml'));

    const stats = await buildIndex(db, root, false);

    expect(stats.deleted).toBe(1);
    expect(getObjectByName(db, 'ClassC', 'Class')).toBeNull();
    expect(getObjectByName(db, 'ClassA', 'Class')).not.toBeNull();
    expect(getObjectByName(db, 'ClassB', 'Class')).not.toBeNull();
    expect(getObjectByName(db, 'ClassD', 'Class')).not.toBeNull();
    expect(getIndexStats(db).totalObjects).toBe(3);
  });

  it('prunes despite the magnitude guard when D365_BYPASS_PRUNE_GUARD=1', async () => {
    const original = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, original, true);

    const replacement = stageClasses(['ClassD']);
    process.env.D365_BYPASS_PRUNE_GUARD = '1';
    try {
      const stats = await buildIndex(db, replacement, false);
      expect(stats.deleted).toBe(3);
    } finally {
      delete process.env.D365_BYPASS_PRUNE_GUARD;
    }

    expect(getObjectByName(db, 'ClassA', 'Class')).toBeNull();
    expect(getObjectByName(db, 'ClassD', 'Class')).not.toBeNull();
  });
});
