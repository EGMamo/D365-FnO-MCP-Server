import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Database } from '../src/indexer/db.js';
import { openDb } from '../src/indexer/db.js';
import { buildIndex } from '../src/indexer/buildIndex.js';
import {
  parseAxDataEntity,
  parseAxDataEntityDetails,
  parseAxSecurityDuty,
  parseAxSecurityPrivilege,
  parseAxSecurityRole,
  parseAxTableKeys,
} from '../src/indexer/parser.js';
import { chooseNaturalKey, registerEntityTools } from '../src/tools/entities.js';
import { fakeToolServer, type ToolResult } from './helpers/toolHarness.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(testDir, 'fixtures', name), 'utf-8');

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function stage(root: string, files: [string, string, string][]) {
  for (const [typeDir, name, xml] of files) {
    const dir = path.join(root, 'TestPackage', 'TestModel', typeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.xml`), xml);
  }
}

const NS = 'xmlns:i="http://www.w3.org/2001/XMLSchema-instance"';
const field = (type: string, name: string, edt = '') =>
  `<AxTableField i:type="AxTableField${type}"><Name>${name}</Name>${edt ? `<ExtendedDataType>${edt}</ExtendedDataType>` : ''}</AxTableField>`;
const index = (name: string, fields: string[], extra = '') =>
  `<AxTableIndex><Name>${name}</Name>${extra}<Fields>${fields
    .map((f) => `<AxTableIndexField><DataField>${f}</DataField></AxTableIndexField>`)
    .join('')}</Fields></AxTableIndex>`;
const table = (name: string, fields: string, indexes: string, extra = '') =>
  `<?xml version="1.0" encoding="utf-8"?><AxTable ${NS}><Name>${name}</Name>${extra}<Fields>${fields}</Fields><Indexes>${indexes}</Indexes></AxTable>`;

const SAMPLE_TABLE = table(
  'SampleTable',
  field('String', 'AccountNum', 'CustAccount') + field('String', 'Name') + field('Container', 'Notes') + field('Real', 'Amount'),
  index('DupIdx', ['Name'], '<AllowDuplicates>Yes</AllowDuplicates>') +
    index('AccountIdx', ['AccountNum'], '<AlternateKey>Yes</AlternateKey>'),
  '<ReplacementKey>AccountIdx</ReplacementKey>'
);

const GOOD_ENTITY = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView ${NS}>
  <Name>GoodEntity</Name>
  <IsPublic>Yes</IsPublic>
  <IsReadOnly>Yes</IsReadOnly>
  <PrimaryKey>EntityKey</PrimaryKey>
  <PublicCollectionName>Goods</PublicCollectionName>
  <PublicEntityName>Good</PublicEntityName>
  <Fields>
    <AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField"><Name>AccountNum</Name><DataField>AccountNum</DataField><DataSource>SampleTable</DataSource></AxDataEntityViewField>
    <AxDataEntityViewField xmlns="" i:type="AxDataEntityViewMappedField"><Name>Notes</Name><DataField>Notes</DataField><DataSource>SampleTable</DataSource></AxDataEntityViewField>
    <AxDataEntityViewField xmlns="" i:type="AxDataEntityViewUnmappedFieldString"><Name>Computed</Name></AxDataEntityViewField>
  </Fields>
  <Keys><AxDataEntityViewKey><Name>EntityKey</Name><Fields><AxDataEntityViewKeyField><DataField>AccountNum</DataField></AxDataEntityViewKeyField></Fields></AxDataEntityViewKey></Keys>
  <ViewMetadata><DataSources><AxQuerySimpleRootDataSource><Name>SampleTable</Name><Table>SampleTable</Table></AxQuerySimpleRootDataSource></DataSources></ViewMetadata>
</AxDataEntityView>`;

// Not public, and reuses SampleEntity's collection name.
const DUP_ENTITY = `<?xml version="1.0" encoding="utf-8"?>
<AxDataEntityView ${NS}><Name>DupEntity</Name><PublicEntityName>Dup</PublicEntityName><PublicCollectionName>SampleEntities</PublicCollectionName></AxDataEntityView>`;

const splitFiles = (text: string) => {
  const files: Record<string, string> = {};
  for (const part of text.split(/^=== /m).filter(Boolean)) {
    const [header, ...rest] = part.split('\n');
    files[header.replace(/ ===$/, '')] = rest.join('\n').trim();
  }
  return files;
};

describe('table key and entity detail parsers', () => {
  it('reads index fields, uniqueness and table key properties', () => {
    const keys = parseAxTableKeys(SAMPLE_TABLE);
    expect(keys.replacementKey).toBe('AccountIdx');
    expect(keys.tableType).toBe('Regular');
    expect(keys.saveDataPerCompany).toBe(true);
    expect(keys.indexes).toEqual([
      { name: 'DupIdx', fields: ['Name'], allowDuplicates: true, alternateKey: false, enabled: true },
      { name: 'AccountIdx', fields: ['AccountNum'], allowDuplicates: false, alternateKey: true, enabled: true },
    ]);
    expect(chooseNaturalKey(keys)?.index.name).toBe('AccountIdx');
  });

  it('falls back to the first unique index and returns null without one', () => {
    const unique = parseAxTableKeys(table('T', field('String', 'A'), index('AIdx', ['A'])));
    expect(chooseNaturalKey(unique)).toMatchObject({ index: { name: 'AIdx' }, reason: 'first unique index' });
    const none = parseAxTableKeys(table('T', field('String', 'A'), index('AIdx', ['A'], '<AllowDuplicates>Yes</AllowDuplicates>')));
    expect(chooseNaturalKey(none)).toBeNull();
  });

  it('reads entity keys, flags and field kinds', () => {
    const details = parseAxDataEntityDetails(GOOD_ENTITY);
    expect(details.keys).toEqual([{ name: 'EntityKey', fields: ['AccountNum'] }]);
    expect(details.isReadOnly).toBe(true);
    expect(details.fieldKinds.Computed).toBe('AxDataEntityViewUnmappedFieldString');
    expect(details.fieldKinds.AccountNum).toBe('AxDataEntityViewMappedField');
  });
});

describe('entity and security generator tools', () => {
  let db: Database;
  let root: string;
  const tools = new Map<string, Handler>();
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!(args);
  const text = (r: ToolResult) => r.content[0].text;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(testDir, '.tmp-entities-'));
    stage(root, [
      ['AxTable', 'SampleTable', SAMPLE_TABLE],
      ['AxTable', 'TempTable', table('TempTable', field('String', 'A'), index('AIdx', ['A']), '<TableType>TempDB</TableType>')],
      ['AxTable', 'NoKeyTable', table('NoKeyTable', field('String', 'A'), index('AIdx', ['A'], '<AllowDuplicates>Yes</AllowDuplicates>'))],
      ['AxDataEntityView', 'SampleEntity', fixture('AxDataEntityViewSample.xml')],
      ['AxDataEntityView', 'GoodEntity', GOOD_ENTITY],
      ['AxDataEntityView', 'DupEntity', DUP_ENTITY],
      ['AxMenuItemDisplay', 'SampleForm', fixture('AxMenuItemDisplaySample.xml')],
      ['AxEdt', 'SampleEdt', fixture('AxEdtSample.xml')],
      ['AxEnum', 'SampleEnum', fixture('AxEnumSample.xml')],
      ['AxClass', 'Taken_Extension', '<AxClass><Name>Taken_Extension</Name><SourceCode><Declaration>class Taken_Extension {}</Declaration></SourceCode></AxClass>'],
      [
        'AxSecurityPrivilege',
        'GoodEntityView',
        `<AxSecurityPrivilege><Name>GoodEntityView</Name><DataEntityPermissions><AxSecurityDataEntityPermission><Grant><Read>Allow</Read></Grant><Name>GoodEntity</Name></AxSecurityDataEntityPermission></DataEntityPermissions></AxSecurityPrivilege>`,
      ],
      [
        'AxSecurityRole',
        'GoodReaderRole',
        `<AxSecurityRole><Name>GoodReaderRole</Name><Privileges><AxSecurityPrivilegeReference><Name>GoodEntityView</Name></AxSecurityPrivilegeReference></Privileges></AxSecurityRole>`,
      ],
    ]);
    db = openDb(path.join(root, 'index.db'));
    await buildIndex(db, root, true);
    registerEntityTools(fakeToolServer(tools), db);
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('check_entity_odata_readiness', () => {
    it('reports a ready entity with warnings, info and the granting roles', async () => {
      const body = JSON.parse(text(await call('check_entity_odata_readiness', { entityName: 'GoodEntity' })));
      expect(body.ready).toBe(true);
      expect(body.odata).toEqual({ entitySet: 'Goods', url: '/data/Goods' });
      expect(body.primaryKey).toEqual({ name: 'EntityKey', fields: ['AccountNum'] });
      expect(body.warnings.join()).toContain('Notes (Container)');
      expect(body.info.join()).toContain('IsReadOnly');
      expect(body.info.join()).toContain('Computed');
      expect(body.security).toEqual({ privileges: [{ privilege: 'GoodEntityView', grants: 'Read' }], roles: ['GoodReaderRole'] });
    });

    it('reports blockers for a missing key and a duplicated public name', async () => {
      const body = JSON.parse(text(await call('check_entity_odata_readiness', { entityName: 'SampleEntity' })));
      expect(body.ready).toBe(false);
      expect(body.blockers.join('\n')).toContain("PrimaryKey 'SampleEntityKey' does not match any key");
      expect(body.blockers.join('\n')).toContain('DupEntity');
      expect(body.warnings.join()).toContain('No indexed privilege');
    });

    it('blocks a non-public entity and rejects unknown ones', async () => {
      const body = JSON.parse(text(await call('check_entity_odata_readiness', { entityName: 'DupEntity' })));
      expect(body.blockers.join()).toContain('IsPublic');
      expect((await call('check_entity_odata_readiness', { entityName: 'Nope' })).isError).toBe(true);
    });
  });

  describe('create_data_entity', () => {
    it('generates a read-only entity keyed on the replacement key that round-trips through the parser', async () => {
      const result = await call('create_data_entity', { table: 'SampleTable', entityName: 'SampleTableEntity' });
      expect(result.isError).toBeFalsy();
      const xml = text(result);
      expect(xml).toContain("Entity key mirrors index 'AccountIdx' (table ReplacementKey)");
      expect(xml).toContain('<PrimaryCompanyContext>DataAreaId</PrimaryCompanyContext>');
      const parsed = parseAxDataEntity(xml);
      expect(parsed.publicEntityName).toBe('SampleTable');
      expect(parsed.publicCollectionName).toBe('SampleTables');
      expect(parsed.isPublic).toBe(true);
      expect(parsed.dataSources).toEqual([{ name: 'SampleTable', table: 'SampleTable' }]);
      expect(parsed.fields.map((f) => f.name)).toEqual(['AccountNum', 'Name', 'Amount', 'dataAreaId']);
      const details = parseAxDataEntityDetails(xml);
      expect(details.isReadOnly).toBe(true);
      expect(details.keys).toEqual([{ name: 'EntityKey', fields: ['AccountNum'] }]);
    });

    it('adds missing key fields, warns on container fields and honours readOnly=false', async () => {
      const xml = text(await call('create_data_entity', {
        table: 'SampleTable', entityName: 'NotesEntity', fields: ['Notes'], readOnly: false,
        publicEntityName: 'Note', publicCollectionName: 'NoteList',
      }));
      expect(xml).toContain("Added key field 'AccountNum'");
      expect(xml).toContain('Container field');
      expect(parseAxDataEntityDetails(xml).isReadOnly).toBe(false);
      expect(parseAxDataEntity(xml).fields.map((f) => f.name)).toEqual(['AccountNum', 'Notes', 'dataAreaId']);
    });

    it('fails closed on bad input', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ table: 'Missing', entityName: 'XEntity' }, "table 'Missing' was not found"],
        [{ table: 'SampleTable', entityName: 'GoodEntity' }, 'already exists'],
        [{ table: 'SampleTable', entityName: 'XEntity', fields: ['Bogus'] }, "Field 'Bogus' does not exist"],
        [{ table: 'TempTable', entityName: 'XEntity' }, 'TempDB'],
        [{ table: 'NoKeyTable', entityName: 'XEntity' }, 'no unique index'],
        [{ table: 'SampleTable', entityName: 'XEntity', publicEntityName: 'Good', publicCollectionName: 'Xs' }, 'GoodEntity'],
        [{ table: 'SampleTable', entityName: 'XEntity', keyFields: ['RecId'] }, "Key field 'RecId'"],
      ];
      for (const [args, message] of cases) {
        const result = await call('create_data_entity', args);
        expect(result.isError, JSON.stringify(args)).toBe(true);
        expect(text(result)).toContain(message);
      }
    });

    it('warns when explicit key fields are not backed by a unique index', async () => {
      const xml = text(await call('create_data_entity', { table: 'SampleTable', entityName: 'ByNameEntity', keyFields: ['Name'] }));
      expect(xml).toContain('No unique index');
    });
  });

  describe('create_security_privilege', () => {
    it('emits entry points and entity permissions that the parser reads back', async () => {
      const result = await call('create_security_privilege', {
        name: 'SampleMaintain',
        targets: [
          { type: 'MenuItemDisplay', name: 'SampleForm', access: 'maintain' },
          { type: 'DataEntity', name: 'GoodEntity', access: 'view' },
        ],
      });
      expect(result.isError).toBeFalsy();
      const files = splitFiles(text(result));
      const parsed = parseAxSecurityPrivilege(files['AxSecurityPrivilege/SampleMaintain.xml']);
      expect(parsed.grants).toEqual([
        { kind: 'entrypoint', objectType: 'MenuItemDisplay', objectName: 'SampleForm', childName: '', grants: ['Read', 'Update', 'Create', 'Delete'] },
        { kind: 'dataentity', objectType: 'DataEntity', objectName: 'GoodEntity', childName: '', grants: ['Read'] },
      ]);
    });

    it('fails closed on unknown targets, existing names and invalid grants', async () => {
      const bad = await call('create_security_privilege', {
        name: 'GoodEntityView',
        targets: [
          { type: 'MenuItemDisplay', name: 'Missing' },
          { type: 'DataEntity', name: 'GoodEntity', grants: ['Invoke'] },
        ],
      });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toContain("already exists");
      expect(text(bad)).toContain("MenuItemDisplay 'Missing' was not found");
      expect(text(bad)).toContain('Invoke is not a data entity grant');
    });
  });

  describe('create_readonly_role_for_entities', () => {
    it('emits privilege, duty and role linked together, warning about non-public entities', async () => {
      const result = await call('create_readonly_role_for_entities', {
        roleName: 'AgentReader', entities: ['GoodEntity', 'DupEntity'], label: 'Agent reader',
      });
      expect(result.isError).toBeFalsy();
      const files = splitFiles(text(result));
      expect(Object.keys(files)).toEqual([
        'AxSecurityPrivilege/AgentReaderView.xml',
        'AxSecurityDuty/AgentReaderInquire.xml',
        'AxSecurityRole/AgentReader.xml',
      ]);
      const privilege = parseAxSecurityPrivilege(files['AxSecurityPrivilege/AgentReaderView.xml']);
      expect(privilege.grants.map((g) => [g.objectName, g.grants])).toEqual([['GoodEntity', ['Read']], ['DupEntity', ['Read']]]);
      expect(files['AxSecurityPrivilege/AgentReaderView.xml']).toContain('DupEntity is not public');
      expect(parseAxSecurityDuty(files['AxSecurityDuty/AgentReaderInquire.xml']).privileges).toEqual(['AgentReaderView']);
      const role = parseAxSecurityRole(files['AxSecurityRole/AgentReader.xml']);
      expect(role).toMatchObject({ label: 'Agent reader', duties: ['AgentReaderInquire'], privileges: [], subRoles: [] });

      // The same three files, ready to save, in the generated files item.
      const generated = JSON.parse(result.content.at(-1)!.text).generatedFiles;
      expect(generated.map((f: { aotType: string; name: string }) => `${f.aotType}/${f.name}`)).toEqual([
        'AxSecurityPrivilege/AgentReaderView', 'AxSecurityDuty/AgentReaderInquire', 'AxSecurityRole/AgentReader',
      ]);
      expect(generated[2].content.trim()).toBe(files['AxSecurityRole/AgentReader.xml'].trim());
    });

    it('rejects unknown entities and clashing names', async () => {
      const result = await call('create_readonly_role_for_entities', {
        roleName: 'GoodReaderRole', entities: ['Nope'],
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("SecurityRole named 'GoodReaderRole' already exists");
      expect(text(result)).toContain("DataEntity 'Nope' was not found");
    });
  });

  describe('create_odata_action', () => {
    it('generates a static action on the entity set with grounded parameter types', async () => {
      const result = await call('create_odata_action', {
        entityName: 'GoodEntity', actionName: 'recalculate', instance: false,
        parameters: [{ name: 'account', type: 'SampleEdt' }, { name: 'mode', type: 'SampleEnum' }, { name: 'force', type: 'Boolean' }],
        returnType: 'str',
      });
      expect(result.isError).toBeFalsy();
      const xpp = text(result);
      expect(xpp).toContain('POST /data/Goods/Microsoft.Dynamics.DataEntities.recalculate');
      expect(xpp).toContain('[ExtensionOf(tableStr(GoodEntity))]');
      expect(xpp).toContain('final class GoodEntity_Extension');
      expect(xpp).toContain("[SysODataActionAttribute('recalculate', false)]");
      expect(xpp).toContain('public static str recalculate(SampleEdt _account, SampleEnum _mode, boolean _force)');
      expect(xpp).toContain('return result;');
    });

    it('binds instance actions to a record and warns for non-public entities', async () => {
      const xpp = text(await call('create_odata_action', {
        entityName: 'DupEntity', actionName: 'approve', instance: true, extensionName: 'DupEntityApprove_Extension',
      }));
      expect(xpp).toContain("[SysODataActionAttribute('approve', true)]");
      expect(xpp).toContain('public void approve()');
      expect(xpp).toContain('/data/SampleEntities(<key>)/Microsoft.Dynamics.DataEntities.approve');
      expect(xpp).toContain('WARNING: the entity is not public');
    });

    it('fails closed on unknown entities, types and clashing classes', async () => {
      const result = await call('create_odata_action', {
        entityName: 'GoodEntity', actionName: 'bad name', instance: false, extensionName: 'Taken_Extension',
        parameters: [{ name: 'x', type: 'NoSuchEdt' }, { name: 'X', type: 'int' }], returnType: 'NoSuchType',
      });
      expect(result.isError).toBe(true);
      const message = text(result);
      for (const part of ["'bad name' is not a valid", "'Taken_Extension' already exists", "type 'NoSuchEdt'", "'X' is declared twice", "Return type 'NoSuchType'"]) {
        expect(message).toContain(part);
      }
      expect(text(await call('create_odata_action', { entityName: 'Nope', actionName: 'a', instance: false }))).toContain("DataEntity 'Nope'");
    });
  });
});
