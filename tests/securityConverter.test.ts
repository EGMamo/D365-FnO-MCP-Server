import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDb, upsertObject } from '../src/indexer/db.js';
import { convertSecurityExport, parseSecurityExport } from '../src/security/converter.js';
import { registerSecurityTools } from '../src/tools/security.js';
import type { ToolResult } from './helpers/toolHarness.js';

const EXPORT = `<?xml version="1.0" encoding="utf-8"?>
<SecurityDatabaseCustomizations xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Roles>
    <AxSecurityRole>
      <Name>MyClerk</Name>
      <Label>My clerk</Label>
      <Duties>
        <AxSecurityDutyReference><Name>MyDuty</Name></AxSecurityDutyReference>
        <AxSecurityDutyReference><Name>StdDuty</Name></AxSecurityDutyReference>
      </Duties>
      <Privileges>
        <AxSecurityPrivilegeReference><Name>MissingPriv</Name></AxSecurityPrivilegeReference>
      </Privileges>
      <SubRoles />
    </AxSecurityRole>
  </Roles>
  <Duties>
    <AxSecurityDuty>
      <Name>MyDuty</Name>
      <Privileges>
        <AxSecurityPrivilegeReference><Name>MyPriv</Name></AxSecurityPrivilegeReference>
      </Privileges>
    </AxSecurityDuty>
  </Duties>
  <Privileges>
    <AxSecurityPrivilege>
      <Name>MyPriv</Name>
      <EntryPoints>
        <AxSecurityEntryPointReference>
          <Name>CustTable</Name>
          <Grant><Read>Allow</Read></Grant>
          <ObjectName>CustTable</ObjectName>
          <ObjectType>MenuItemDisplay</ObjectType>
        </AxSecurityEntryPointReference>
      </EntryPoints>
    </AxSecurityPrivilege>
  </Privileges>
</SecurityDatabaseCustomizations>`;

describe('security converter', () => {
  it('parses an export full of unclosed elements in linear time', () => {
    const started = Date.now();
    expect(parseSecurityExport('<AxSecurityRole>'.repeat(120_000))).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });


  it('parses elements and their own names, not reference names', () => {
    const elements = parseSecurityExport(EXPORT);
    expect(elements.map((e) => `${e.kind}:${e.name}`)).toEqual(['Role:MyClerk', 'Duty:MyDuty', 'Privilege:MyPriv']);
    expect(elements[0].references).toEqual([
      { kind: 'Duty', name: 'MyDuty' }, { kind: 'Duty', name: 'StdDuty' }, { kind: 'Privilege', name: 'MissingPriv' },
    ]);
  });

  it('prefixes names and rewrites references to exported elements only', () => {
    const r = convertSecurityExport(EXPORT, { prefix: 'Ctso', existsInIndex: (ref) => ref.name === 'StdDuty' });
    expect(r.files.map((f) => f.path)).toEqual([
      'AxSecurityRole/CtsoMyClerk.xml', 'AxSecurityDuty/CtsoMyDuty.xml', 'AxSecurityPrivilege/CtsoMyPriv.xml',
    ]);
    const role = r.files[0].content;
    expect(role.startsWith('<?xml version="1.0" encoding="utf-8"?>\n<AxSecurityRole')).toBe(true);
    expect(role).toContain('<Name>CtsoMyClerk</Name>');
    expect(role).toContain('<Name>CtsoMyDuty</Name>');
    expect(role).toContain('<Name>StdDuty</Name>');
    expect(r.files[2].content).toContain('<Name>CustTable</Name>');
    expect(r.unresolvedReferences).toEqual([{ from: 'Role MyClerk', kind: 'Privilege', name: 'MissingPriv' }]);
  });

  it('applies explicit renames and include with dependencies', () => {
    const r = convertSecurityExport(EXPORT, { include: ['MyDuty'], includeDependencies: true, renames: { MyPriv: 'NewPriv' } });
    expect(r.files.map((f) => f.name)).toEqual(['MyDuty', 'NewPriv']);
    expect(r.files[0].content).toContain('<Name>NewPriv</Name>');
    expect(convertSecurityExport(EXPORT, { include: ['Nope'] }).skipped).toEqual(['nope (not in export)']);
  });

  it('adds the xmlns:i declaration when i: attributes are used', () => {
    const xml = '<AxSecurityPrivilege><Name>P</Name><Foo i:nil="true" /></AxSecurityPrivilege>';
    expect(convertSecurityExport(xml).files[0].content).toContain('<AxSecurityPrivilege xmlns:i="http://www.w3.org/2001/XMLSchema-instance">');
  });

  it('rejects invalid target names', () => {
    expect(() => convertSecurityExport(EXPORT, { renames: { MyPriv: 'bad name' } })).toThrow(/Invalid AOT name/);
  });

  it('convert_security_customizations tool reports clashes and unresolved references', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secconv-'));
    const db = openDb(path.join(dir, 'idx.db'));
    upsertObject(db, { type: 'SecurityDuty', name: 'StdDuty', model: 'M', package: 'P', file_path: 'x', raw_xml: null, file_mtime: 0 } as never);
    upsertObject(db, { type: 'SecurityPrivilege', name: 'NewPriv', model: 'M', package: 'P', file_path: 'y', raw_xml: null, file_mtime: 0 } as never);
    const handlers = new Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>();
    registerSecurityTools({ tool: (n: string, _d: string, _s: unknown, h: never) => handlers.set(n, h) } as unknown as McpServer, db);
    const tool = handlers.get('convert_security_customizations')!;
    const res = await tool({ xml: EXPORT, renames: { MyPriv: 'NewPriv' }, includeDependencies: true, maxFiles: 2 });
    const json = JSON.parse(res.content[0].text);
    expect(json.summary).toEqual({ roles: 1, duties: 1, privileges: 1 });
    expect(json.files.truncated).toBe(true);
    expect(json.nameClashesWithIndex).toEqual(['Privilege NewPriv']);
    expect(json.unresolvedReferences).toEqual([{ from: 'Role MyClerk', kind: 'Privilege', name: 'MissingPriv' }]);
    expect((await tool({ xml: '<x/>', includeDependencies: true, maxFiles: 50 })).isError).toBe(true);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
