import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Database } from 'better-sqlite3';
import { openDb, getObjectByName, getXrefsFrom, searchSymbols } from '../src/indexer/db.js';
import { buildIndex, getIndexStats } from '../src/indexer/buildIndex.js';

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
  });
});
