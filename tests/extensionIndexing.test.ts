import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, getObjectByName, getTableExtensionFieldNames, type Database, type Xref } from '../src/indexer/db.js';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { collectGeneratorTools } from './helpers/toolHarness.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const NS = 'xmlns:i="http://www.w3.org/2001/XMLSchema-instance"';

let root: string;
let db: Database;

function stage(type: string, name: string, xml: string) {
  const dir = path.join(root, 'AppPkg', 'AppModel', type);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.xml`), xml);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(testDir, '.tmp-extidx-'));
  stage('AxTable', 'CustTable', `<AxTable ${NS}><Name>CustTable</Name><Fields><AxTableField i:type="AxTableFieldString"><Name>AccountNum</Name></AxTableField></Fields></AxTable>`);
  stage(
    'AxTableExtension',
    'CustTable.MyExt',
    `<AxTableExtension ${NS}><Name>CustTable.MyExt</Name><Fields><AxTableField i:type="AxTableFieldString"><Name>MyCode</Name></AxTableField></Fields></AxTableExtension>`
  );
  stage(
    'AxView',
    'CustView',
    `<AxView ${NS}><Name>CustView</Name><Fields><AxViewField i:type="AxViewFieldBound"><Name>Acct</Name></AxViewField></Fields><ViewMetadata><DataSources><AxQuerySimpleRootDataSource><Name>CustTable</Name><Table>CustTable</Table></AxQuerySimpleRootDataSource></DataSources></ViewMetadata></AxView>`
  );
  stage(
    'AxMap',
    'AcctMap',
    `<AxMap ${NS}><Name>AcctMap</Name><Fields><AxMapField i:type="AxMapFieldString"><Name>Num</Name></AxMapField></Fields><Mappings><AxTableMapping><MappingTable>CustTable</MappingTable></AxTableMapping></Mappings></AxMap>`
  );
  db = openDb(':memory:');
  await buildIndex(db, root, true);
});

afterAll(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const xrefsFrom = (name: string, type: string) =>
  db.prepare('SELECT * FROM ax_xref WHERE from_name = ? AND from_type = ?').all(name, type) as unknown as Xref[];

describe('table extension, view and map indexing', () => {
  it('indexes table extension fields and links the extension to its base table', () => {
    const ext = getObjectByName(db, 'CustTable.MyExt', 'TableExtension');
    expect(ext?.fields.map((f) => f.name)).toEqual(['MyCode']);
    expect(xrefsFrom('CustTable.MyExt', 'TableExtension')).toEqual([
      expect.objectContaining({ to_type: 'Table', to_name: 'CustTable', xref_kind: 'extends' }),
    ]);
    expect(getTableExtensionFieldNames(db, 'custtable')).toEqual(['MyCode']);
    expect(getTableExtensionFieldNames(db, 'CustTable')).toEqual(['MyCode']);
  });

  it('indexes views with their query tables and maps with their mapped tables', () => {
    expect(getObjectByName(db, 'CustView', 'View')?.fields.map((f) => f.name)).toEqual(['Acct']);
    expect(xrefsFrom('CustView', 'View')).toEqual([expect.objectContaining({ to_name: 'CustTable', xref_kind: 'datasource' })]);
    expect(getObjectByName(db, 'AcctMap', 'Map')?.fields.map((f) => f.name)).toEqual(['Num']);
    expect(xrefsFrom('AcctMap', 'Map')).toEqual([expect.objectContaining({ to_name: 'CustTable', xref_kind: 'maps' })]);
  });

  it('create_table_extension rejects a field another extension already adds', async () => {
    const create = collectGeneratorTools(db).get('create_table_extension')!;
    const res = await create({ targetTable: 'CustTable', extensionName: 'OtherExt', fields: [{ name: 'MyCode', type: 'String' }] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("'MyCode'");
  });
});

describe('other extension types', () => {
  it('indexes form, EDT, enum, data entity and query extensions and links them to their base objects', async () => {
    const dir = fs.mkdtempSync(path.join(testDir, '.tmp-extidx2-'));
    const put = (t: string, n: string, xml: string) => {
      const d = path.join(dir, 'P', 'M', t);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${n}.xml`), xml);
    };
    put('AxFormExtension', 'CustTable.X', `<AxFormExtension ${NS}><Name>CustTable.X</Name></AxFormExtension>`);
    put('AxEdtExtension', 'Name.X', `<AxEdtExtension ${NS}><Name>Name.X</Name></AxEdtExtension>`);
    put('AxDataEntityViewExtension', 'CustCustomerV3Entity.X', `<AxDataEntityViewExtension ${NS}><Name>CustCustomerV3Entity.X</Name></AxDataEntityViewExtension>`);
    put('AxQueryExtension', 'CustQ.X', `<AxQueryExtension ${NS}><Name>CustQ.X</Name></AxQueryExtension>`);
    put('AxEnumExtension', 'NoYes.X', `<AxEnumExtension ${NS}><Name>NoYes.X</Name><EnumValues><AxEnumValue><Name>Maybe</Name><Value>5</Value></AxEnumValue></EnumValues></AxEnumExtension>`);
    const d2 = openDb(':memory:');
    try {
      await buildIndex(d2, dir, true);
      const links = d2.prepare("SELECT from_type, to_type, to_name FROM ax_xref WHERE xref_kind = 'extends' ORDER BY from_type").all();
      expect(links).toEqual([
        { from_type: 'DataEntityExtension', to_type: 'DataEntity', to_name: 'CustCustomerV3Entity' },
        { from_type: 'EdtExtension', to_type: 'Edt', to_name: 'Name' },
        { from_type: 'EnumExtension', to_type: 'Enum', to_name: 'NoYes' },
        { from_type: 'FormExtension', to_type: 'Form', to_name: 'CustTable' },
        { from_type: 'QueryExtension', to_type: 'Query', to_name: 'CustQ' },
      ]);
      expect(getObjectByName(d2, 'NoYes.X', 'EnumExtension')?.enumValues.map((v) => v.name)).toEqual(['Maybe']);
    } finally {
      d2.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('name-level indexing of services, workflows, reports and menu extensions', () => {
  it('stores them, finds them by search, and links menu item extensions to their base item', async () => {
    const dir = fs.mkdtempSync(path.join(testDir, '.tmp-extidx3-'));
    const put = (t: string, n: string) => {
      const d = path.join(dir, 'P', 'M', t);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${n}.xml`), `<${t} ${NS}><Name>${n}</Name></${t}>`);
    };
    put('AxService', 'CustService');
    put('AxServiceGroup', 'CustServices');
    fs.writeFileSync(path.join(dir, 'P', 'M', 'AxService', 'CustService.xml'), `<AxService ${NS}><Name>CustService</Name><Class>CustServiceClass</Class></AxService>`);
    fs.writeFileSync(path.join(dir, 'P', 'M', 'AxServiceGroup', 'CustServices.xml'), `<AxServiceGroup ${NS}><Name>CustServices</Name><Services><AxServiceGroupService><Service>CustService</Service></AxServiceGroupService></Services></AxServiceGroup>`);
    put('AxReport', 'CustReport');
    put('AxWorkflowType', 'CustApproval');
    put('AxKPI', 'CustKpi');
    put('AxMenuItemDisplayExtension', 'CustTable.X');
    const d3 = openDb(':memory:');
    try {
      await buildIndex(d3, dir, true);
      const types = d3.prepare('SELECT type FROM ax_objects ORDER BY type').all().map((r) => (r as { type: string }).type);
      expect(types).toEqual(['KPI', 'MenuItemDisplayExtension', 'Report', 'Service', 'ServiceGroup', 'WorkflowType']);
      expect(d3.prepare("SELECT to_type, to_name FROM ax_xref WHERE from_type = 'MenuItemDisplayExtension'").all()).toEqual([
        { to_type: 'MenuItemDisplay', to_name: 'CustTable' },
      ]);
      expect(getObjectByName(d3, 'custreport', 'Report')?.name).toBe('CustReport');
      const links = d3.prepare("SELECT from_type, to_type, to_name, xref_kind FROM ax_xref WHERE xref_kind IN ('service_class','group_service') ORDER BY from_type").all();
      expect(links).toEqual([
        { from_type: 'Service', to_type: 'Class', to_name: 'CustServiceClass', xref_kind: 'service_class' },
        { from_type: 'ServiceGroup', to_type: 'Service', to_name: 'CustService', xref_kind: 'group_service' },
      ]);
    } finally {
      d3.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
