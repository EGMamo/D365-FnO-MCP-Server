import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Database } from 'better-sqlite3';
import { openDb, getObjectByName, getXrefsFrom, searchSymbols } from '../src/indexer/db.js';
import { buildIndex, getIndexStats } from '../src/indexer/buildIndex.js';
import { logger } from '../src/utils/logger.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, 'fixtures');

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
  it('should initialize memory db properly', () => {
    const db = openDb(':memory:');
    expect(db).toBeDefined();
    db.close();
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
    const tableXrefs = getXrefsFrom(db, 'SampleTable', 'Table');
    expect(tableXrefs.some((x) => x.to_name === 'BaseTable' && x.xref_kind === 'extends')).toBe(true);
    expect(tableXrefs.some((x) => x.to_name === 'CustAccount' && x.to_type === 'Edt')).toBe(true);

    const formXrefs = getXrefsFrom(db, 'SampleForm', 'Form');
    expect(formXrefs.some((x) => x.to_name === 'SampleTable' && x.xref_kind === 'datasource')).toBe(true);

    const classXrefs = getXrefsFrom(db, 'SampleClass', 'Class');
    expect(classXrefs.some((x) => x.to_name === 'SysPackable' && x.xref_kind === 'implements')).toBe(true);
  });

  it('supports full-text search over indexed objects', () => {
    const results = searchSymbols(db, 'SampleTable') as { name: string; type: string }[];
    expect(results.some((r) => r.name === 'SampleTable' && r.type === 'Table')).toBe(true);
  });

  it('skips unchanged files on a second incremental run', async () => {
    const stats = await buildIndex(db, root, false);
    // Label files are not tracked in ax_objects, so they are always re-read.
    expect(stats.skipped).toBe(stats.total - 1);
    expect(stats.added).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(stats.collisions).toBe(0);
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
    expect(getXrefsFrom(db, 'SampleClass', 'Class')).toEqual([]);
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
    const full = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, full, true);
    expect(getIndexStats(db).totalObjects).toBe(3);

    const partial = stageClasses(['ClassA']);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, partial, false);
      expect(stats.deleted).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Pruning skipped: scanned 1 objects vs 3 previously indexed'),
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

  it('prunes stale rows when a disjoint scan still covers half of the previously indexed objects', async () => {
    const original = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, original, true);
    expect(getIndexStats(db).totalObjects).toBe(3);

    // Disjoint tree: 2 new objects vs 3 previously indexed => 2 >= 1.5, prune runs.
    const replacement = stageClasses(['ClassD', 'ClassE']);
    const stats = await buildIndex(db, replacement, false);

    expect(stats.deleted).toBe(3);
    expect(getObjectByName(db, 'ClassA', 'Class')).toBeNull();
    expect(getObjectByName(db, 'ClassB', 'Class')).toBeNull();
    expect(getObjectByName(db, 'ClassC', 'Class')).toBeNull();
    expect(getObjectByName(db, 'ClassD', 'Class')).not.toBeNull();
    expect(getObjectByName(db, 'ClassE', 'Class')).not.toBeNull();
    expect(getIndexStats(db).totalObjects).toBe(2);
  });

  it('skips pruning when a disjoint scan covers less than half of the previously indexed objects', async () => {
    const original = stageClasses(['ClassA', 'ClassB', 'ClassC']);
    const db = openTracked();
    await buildIndex(db, original, true);

    // Disjoint tree: 1 new object vs 3 previously indexed => 1 < 1.5, prune skipped.
    const replacement = stageClasses(['ClassD']);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, replacement, false);
      expect(stats.deleted).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Pruning skipped: scanned 1 objects vs 3 previously indexed'),
        expect.anything()
      );
    } finally {
      warn.mockRestore();
    }

    expect(getObjectByName(db, 'ClassA', 'Class')).not.toBeNull();
    expect(getIndexStats(db).totalObjects).toBe(4);
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

  it('keeps a single indexed object when the scan finds nothing', async () => {    const root = stageClasses(['ClassA']);
    const db = openTracked();
    await buildIndex(db, root, true);

    const emptyRoot = fs.mkdtempSync(path.join(testDir, '.tmp-partial-empty-'));
    roots.push(emptyRoot);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const stats = await buildIndex(db, emptyRoot, false);
      expect(stats.total).toBe(0);
      expect(stats.deleted).toBe(0);
    } finally {
      warn.mockRestore();
    }

    expect(getObjectByName(db, 'ClassA', 'Class')).not.toBeNull();
  });
});
