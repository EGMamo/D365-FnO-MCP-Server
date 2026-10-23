import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Database } from '../src/indexer/db.js';
import { openDb, getMeta, META_KEYS } from '../src/indexer/db.js';
import { buildIndex, getIndexStats } from '../src/indexer/buildIndex.js';
import {
  parseAxMenuItem,
  parseAxSecurityDuty,
  parseAxSecurityPrivilege,
  parseAxSecurityRole,
} from '../src/indexer/parser.js';
import { expandRole, extensionBaseName } from '../src/security/model.js';
import { registerSecurityTools } from '../src/tools/security.js';
import { collectMetadataTools, fakeToolServer, type ToolResult } from './helpers/toolHarness.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), 'utf-8');

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectSecurityTools(db: Database): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerSecurityTools(fakeToolServer(handlers), db);
  return handlers;
}

const role = (name: string, body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><AxSecurityRole><Name>${name}</Name>${body}</AxSecurityRole>`;
const refs = (container: string, refType: string, names: string[]) =>
  `<${container}>${names.map((n) => `<${refType}><Name>${n}</Name></${refType}>`).join('')}</${container}>`;

/** Stages <root>/TestPackage/TestModel/<AxType>/<Name>.xml */
function stage(root: string, files: [string, string, string][]) {
  for (const [typeDir, name, xml] of files) {
    const dir = path.join(root, 'TestPackage', 'TestModel', typeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.xml`), xml);
  }
}

describe('security parsers', () => {
  it('parses role duties, privileges and sub-roles', () => {
    const parsed = parseAxSecurityRole(fixture('AxSecurityRoleSample.xml'));
    expect(parsed.label).toBe('Sample clerk');
    expect(parsed.duties).toEqual(['SampleMaintainDuty']);
    expect(parsed.privileges).toEqual(['SampleEntityView']);
    expect(parsed.subRoles).toEqual(['SampleViewerRole']);
  });

  it('parses role extensions with the same parser', () => {
    expect(parseAxSecurityRole(fixture('AxSecurityRoleExtensionSample.xml')).duties).toEqual(['SampleApproveDuty']);
    expect(extensionBaseName('SampleClerkRole.Contoso')).toBe('SampleClerkRole');
    expect(extensionBaseName('NoDot')).toBe('NoDot');
  });

  it('parses duty privileges', () => {
    expect(parseAxSecurityDuty(fixture('AxSecurityDutySample.xml')).privileges).toEqual(['SampleFormMaintain']);
  });

  it('parses privilege entry points and data entity permissions with grants', () => {
    const parsed = parseAxSecurityPrivilege(fixture('AxSecurityPrivilegeSample.xml'));
    expect(parsed.grants).toEqual([
      {
        kind: 'entrypoint',
        objectType: 'MenuItemDisplay',
        objectName: 'SampleForm',
        childName: '',
        grants: ['Read', 'Update', 'Create', 'Delete'],
      },
      { kind: 'dataentity', objectType: 'DataEntity', objectName: 'SampleEntity', childName: '', grants: ['Read', 'Update'] },
    ]);
  });

  it('parses menu items and defaults the object type per menu item kind', () => {
    const display = parseAxMenuItem(fixture('AxMenuItemDisplaySample.xml'), 'MenuItemDisplay');
    expect(display).toMatchObject({ label: 'Sample form', object: 'SampleForm', objectType: 'Form' });
    const action = parseAxMenuItem('<AxMenuItemAction><Name>A</Name><Object>SampleClass</Object></AxMenuItemAction>', 'MenuItemAction');
    expect(action.objectType).toBe('Class');
  });
});

describe('security model tools', () => {
  let db: Database;
  let root: string;
  let tools: Map<string, Handler>;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tools.get(name)!(args);
    return { result, body: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(testDir, '.tmp-security-'));
    stage(root, [
      ['AxSecurityRole', 'SampleClerkRole', fixture('AxSecurityRoleSample.xml')],
      ['AxSecurityRoleExtension', 'SampleClerkRole.Contoso', fixture('AxSecurityRoleExtensionSample.xml')],
      ['AxSecurityDuty', 'SampleMaintainDuty', fixture('AxSecurityDutySample.xml')],
      ['AxSecurityPrivilege', 'SampleFormMaintain', fixture('AxSecurityPrivilegeSample.xml')],
      ['AxMenuItemDisplay', 'SampleForm', fixture('AxMenuItemDisplaySample.xml')],
      // Viewer nests the clerk role back: a sub-role cycle the traversal must survive.
      [
        'AxSecurityRole',
        'SampleViewerRole',
        role('SampleViewerRole', refs('Privileges', 'AxSecurityPrivilegeReference', ['SampleEntityView']) +
          refs('SubRoles', 'AxSecurityRoleReference', ['SampleClerkRole'])),
      ],
      ['AxSecurityRole', 'SampleManagerRole', role('SampleManagerRole', refs('SubRoles', 'AxSecurityRoleReference', ['SampleClerkRole']))],
      ['AxSecurityRole', 'SampleAuditorRole', role('SampleAuditorRole', refs('Duties', 'AxSecurityDutyReference', ['SampleMaintainDuty']))],
      [
        'AxSecurityDuty',
        'SampleApproveDuty',
        `<AxSecurityDuty><Name>SampleApproveDuty</Name>${refs('Privileges', 'AxSecurityPrivilegeReference', ['SampleApprovePriv'])}</AxSecurityDuty>`,
      ],
      [
        'AxSecurityPrivilege',
        'SampleEntityView',
        `<AxSecurityPrivilege><Name>SampleEntityView</Name><DataEntityPermissions><AxSecurityDataEntityPermission><Grant><Read>Allow</Read></Grant><Name>SampleEntity</Name></AxSecurityDataEntityPermission></DataEntityPermissions></AxSecurityPrivilege>`,
      ],
      [
        'AxSecurityPrivilege',
        'SampleApprovePriv',
        `<AxSecurityPrivilege><Name>SampleApprovePriv</Name><EntryPoints><AxSecurityEntryPointReference><Name>SampleApprove</Name><Grant><Invoke>Allow</Invoke></Grant><ObjectName>SampleApprove</ObjectName><ObjectType>MenuItemAction</ObjectType></AxSecurityEntryPointReference></EntryPoints></AxSecurityPrivilege>`,
      ],
      ['AxMenuItemAction', 'SampleApprove', '<AxMenuItemAction><Name>SampleApprove</Name><Object>SampleApproveController</Object></AxMenuItemAction>'],
    ]);
    db = openDb(':memory:');
    await buildIndex(db, root, true);
    tools = collectSecurityTools(db);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('indexes security objects and menu items and bumps the schema version', () => {
    expect(getIndexStats(db).byType).toMatchObject({
      SecurityRole: 4,
      SecurityRoleExtension: 1,
      SecurityDuty: 2,
      SecurityPrivilege: 3,
      MenuItemDisplay: 1,
      MenuItemAction: 1,
    });
    expect(getMeta(db, META_KEYS.schemaVersion)).toBe('3');
  });

  it('lists and searches the new object types through the metadata tools', async () => {
    const metadata = collectMetadataTools(db);
    const list = await metadata.get('list_objects')!({ type: 'SecurityPrivilege', offset: 0, limit: 50 });
    expect(JSON.parse(list.content[0].text).map((o: { name: string }) => o.name).sort()).toEqual([
      'SampleApprovePriv',
      'SampleEntityView',
      'SampleFormMaintain',
    ]);
  });

  it.each(['SampleClerkRole', 'sampleclerkrole'])('flattens %s through extensions, duties and cyclic sub-roles', (name) => {
    const effective = expandRole(db, name);
    expect(effective.role).toBe('SampleClerkRole');
    expect(effective.subRoles).toEqual(['SampleViewerRole']);
    expect(effective.duties).toEqual(['SampleApproveDuty', 'SampleMaintainDuty']);
    expect(Object.fromEntries(effective.privileges)).toEqual({
      SampleApprovePriv: ['duty:SampleApproveDuty'],
      SampleEntityView: ['role:SampleClerkRole', 'role:SampleViewerRole'],
      SampleFormMaintain: ['duty:SampleMaintainDuty'],
    });
    expect(effective.missing).toEqual([]);
  });

  it.each(['SampleClerkRole', 'sampleclerkrole'])('get_security_object describes role %s, including extensions and parents', async (name) => {
    const { body } = await call('get_security_object', { type: 'Role', name, flatten: true, maxItems: 100 });
    expect(body.name).toBe('SampleClerkRole');
    expect(body.label).toBe('Sample clerk');
    expect(body.extensions).toEqual(['SampleClerkRole.Contoso']);
    expect(body.duties.items).toEqual(['SampleApproveDuty', 'SampleMaintainDuty']);
    expect(body.includedInRoles).toEqual(['SampleManagerRole', 'SampleViewerRole']);
    expect(body.effective.privileges.total).toBe(3);
  });

  it.each([
    ['SampleMaintainDuty', 'SampleFormMaintain'],
    ['samplemaintainduty', 'sampleformmaintain'],
  ])('get_security_object describes duty %s and privilege %s', async (dutyName, privilegeName) => {
    const duty = await call('get_security_object', { type: 'Duty', name: dutyName, flatten: false, maxItems: 100 });
    expect(duty.body.name).toBe('SampleMaintainDuty');
    expect(duty.body.usedByRoles.items).toEqual(['SampleAuditorRole', 'SampleClerkRole']);

    const priv = await call('get_security_object', { type: 'Privilege', name: privilegeName, flatten: false, maxItems: 100 });
    expect(priv.body.name).toBe('SampleFormMaintain');
    expect(priv.body.entryPoints.items[0]).toMatchObject({ objectName: 'SampleForm', grants: ['Read', 'Update', 'Create', 'Delete'] });
    expect(priv.body.dataEntityPermissions.items[0]).toMatchObject({ objectName: 'SampleEntity', grants: ['Read', 'Update'] });
    expect(priv.body.usedByDuties.items).toEqual(['SampleMaintainDuty']);
  });

  it('get_security_object reports unknown objects as errors', async () => {
    const { result } = await call('get_security_object', { type: 'Role', name: 'NoSuchRole', flatten: false, maxItems: 100 });
    expect(result.isError).toBe(true);
  });

  it.each([
    ['Form', 'SampleForm'], ['Form', 'sampleform'], ['MenuItemDisplay', 'sampleform'],
  ])('find_security_path resolves %s %s to every role', async (objectType, objectName) => {
    const { body } = await call('find_security_path', { objectType, objectName, maxPaths: 100 });
    expect(body.entryPoints).toEqual([{ type: 'MenuItemDisplay', name: 'SampleForm' }]);
    expect(body.roles).toEqual(['SampleAuditorRole', 'SampleClerkRole', 'SampleManagerRole', 'SampleViewerRole']);
    expect(body.paths.items).toContainEqual({
      entryPoint: { type: 'MenuItemDisplay', name: 'SampleForm' },
      privilege: 'SampleFormMaintain',
      grants: 'Read,Update,Create,Delete',
      duty: 'SampleMaintainDuty',
      role: 'SampleManagerRole',
      viaSubRole: 'SampleClerkRole',
    });
  });

  it('find_security_path follows role-extension duties and data entity permissions', async () => {
    const action = await call('find_security_path', { objectType: 'Class', objectName: 'SampleApproveController', maxPaths: 100 });
    expect(action.body.entryPoints).toEqual([{ type: 'MenuItemAction', name: 'SampleApprove' }]);
    expect(action.body.paths.items[0]).toMatchObject({ duty: 'SampleApproveDuty', role: 'SampleClerkRole', grants: 'Invoke' });

    const entity = await call('find_security_path', { objectType: 'DataEntity', objectName: 'SampleEntity', maxPaths: 100 });
    expect(entity.body.roles).toContain('SampleViewerRole');
    expect(entity.body.roles).toContain('SampleAuditorRole');
  });

  it('find_security_path explains when nothing exposes the object', async () => {
    const { body } = await call('find_security_path', { objectType: 'Form', objectName: 'UnexposedForm', maxPaths: 100 });
    expect(body.roles).toEqual([]);
    expect(body.note).toMatch(/No indexed menu item/);
  });

  it.each([
    ['SampleMaintainDuty', 'SampleApproveDuty'],
    ['samplemaintainduty', 'SAMPLEAPPROVEDUTY'],
  ])('analyze_sod_conflicts detects conflicting duties %s and %s', async (dutyA, dutyB) => {
    const { body } = await call('analyze_sod_conflicts', {
      rules: [
        { name: 'Maintain vs approve', dutyA, dutyB },
        { name: 'Unknown', dutyA: 'SampleMaintainDuty', dutyB: 'GhostDuty' },
      ],
      maxConflicts: 200,
    });
    expect(body.rolesChecked).toBe(4);
    expect(body.conflicts.items.map((c: { role: string }) => c.role)).toEqual([
      'SampleClerkRole',
      'SampleManagerRole',
      'SampleViewerRole',
    ]);
    expect(body.unknownDuties).toEqual(['GhostDuty']);
  });

  it('treats differently cased security references as the same indexed objects', async () => {
    db.exec('BEGIN');
    try {
      db.exec('UPDATE ax_xref SET to_name = lower(to_name); UPDATE ax_security_grants SET target_name = lower(target_name)');
      const role = expandRole(db, 'SampleClerkRole');
      expect(role.subRoles).toEqual(['SampleViewerRole']);
      expect(role.duties).toEqual(['SampleApproveDuty', 'SampleMaintainDuty']);
      expect([...role.privileges.keys()]).toEqual(['SampleApprovePriv', 'SampleEntityView', 'SampleFormMaintain']);
      const { body } = await call('find_security_path', { objectType: 'MenuItemDisplay', objectName: 'sampleform', maxPaths: 100 });
      expect(body.paths.items).toContainEqual({
        entryPoint: { type: 'MenuItemDisplay', name: 'SampleForm' }, privilege: 'SampleFormMaintain',
        grants: 'Read,Update,Create,Delete', duty: 'SampleMaintainDuty', role: 'SampleAuditorRole',
      });
    } finally {
      db.exec('ROLLBACK');
    }
  });

  it('diff_roles compares flattened roles', async () => {
    const { body } = await call('diff_roles', { roleA: 'SampleClerkRole', roleB: 'SampleAuditorRole', maxItems: 100 });
    expect(body.duties.onlyA.items).toEqual(['SampleApproveDuty']);
    expect(body.duties.shared.items).toEqual(['SampleMaintainDuty']);
    expect(body.duties.onlyB.items).toEqual([]);
    expect(body.privileges.onlyA.items).toEqual(['SampleApprovePriv', 'SampleEntityView']);
  });

  it('removes security links when a role file changes', async () => {
    const file = path.join(root, 'TestPackage', 'TestModel', 'AxSecurityRole', 'SampleAuditorRole.xml');
    fs.writeFileSync(file, role('SampleAuditorRole', ''));
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(file, future, future);
    await buildIndex(db, root);
    const { body } = await call('get_security_object', { type: 'Duty', name: 'SampleMaintainDuty', flatten: false, maxItems: 100 });
    expect(body.usedByRoles.items).toEqual(['SampleClerkRole']);
  });
});
