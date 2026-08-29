import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from 'better-sqlite3';
import { collectGeneratorTools, seedDb, type ToolResult } from './helpers/toolHarness.js';

let db: Database;
let tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;

function call(name: string, args: Record<string, unknown>) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(args);
}

beforeAll(() => {
  db = seedDb(
    [
      {
        type: 'Class',
        name: 'SalesLineType',
        properties: { extends: 'SalesLineTypeBase', implements: 'SysPackable' },
        methods: [
          { name: 'insert', accessModifier: 'public', returnType: 'void', params: [] },
          {
            name: 'validateWrite',
            accessModifier: 'public',
            returnType: 'boolean',
            params: [{ name: '_line', type: 'SalesLine' }],
          },
        ],
      },
      { type: 'Class', name: 'SalesLineTypeBase' },
      { type: 'Class', name: 'SysPackable' },
      {
        type: 'Table',
        name: 'CustTable',
        fields: [{ name: 'AccountNum', type: 'String', edt: 'CustAccount' }],
      },
      { type: 'Edt', name: 'CustAccount', properties: { edtType: 'String' } },
      { type: 'Edt', name: 'AmountMST', properties: { edtType: 'Real' } },
    ],
    [{ labelId: 'SYS1', value: 'Account' }]
  );
  tools = collectGeneratorTools(db);
});

afterAll(() => db.close());

describe('generator tool registration', () => {
  it('registers all generator tools', () => {
    expect([...tools.keys()].sort()).toEqual([
      'create_class_extension',
      'create_coc_extension',
      'create_runbase_batch',
      'create_sys_operation',
      'create_table_extension',
      'generate_xpp_class',
    ]);
  });
});

describe('create_coc_extension', () => {
  it('fails when the target does not exist', async () => {
    const res = await call('create_coc_extension', {
      targetClass: 'GhostClass',
      extensionName: 'GhostClass_Extension',
      methods: [{ name: 'insert' }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('GhostClass');
  });

  it('fails when no methods are supplied', async () => {
    const res = await call('create_coc_extension', {
      targetClass: 'SalesLineType',
      extensionName: 'SalesLineType_Extension2',
      methods: [],
    });
    expect(res.isError).toBe(true);
  });

  it('emits an extension marker and target metadata for a valid target', async () => {
    const res = await call('create_coc_extension', {
      targetClass: 'SalesLineType',
      extensionName: 'MySalesLineType_Extension',
      methods: [{ name: 'insert' }],
    });
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain('[ExtensionOf(classStr(SalesLineType))]');
    expect(text).toContain('final class MySalesLineType_Extension');
    expect(text).toContain('next insert();');
    expect(text).toContain('extends SalesLineTypeBase');
  });

  it('warns when the method does not exist on the target', async () => {
    const res = await call('create_coc_extension', {
      targetClass: 'SalesLineType',
      extensionName: 'MySalesLineType_Extension',
      methods: [{ name: 'brandNewMethod' }],
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('WARNING');
  });

  it('uses tableStr for table targets', async () => {
    const res = await call('create_coc_extension', {
      targetClass: 'CustTable',
      extensionName: 'MyCustTable_Extension',
      methods: [{ name: 'insert' }],
    });
    expect(res.content[0].text).toContain('tableStr(CustTable)');
  });

  it('rejects targeting an existing extension class', async () => {
    const res = await call('create_coc_extension', {
      targetClass: 'SomeThing_Extension',
      extensionName: 'Another_Extension',
      methods: [{ name: 'insert' }],
    });
    expect(res.isError).toBe(true);
  });
});

describe('create_table_extension', () => {
  it('fails when the target table is missing', async () => {
    const res = await call('create_table_extension', {
      targetTable: 'GhostTable',
      extensionName: 'Ext',
      fields: [],
    });
    expect(res.isError).toBe(true);
  });

  it('fails when a field EDT does not exist', async () => {
    const res = await call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'Ext',
      fields: [{ name: 'MyField', edt: 'GhostEdt' }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('GhostEdt');
  });

  it('fails when a field already exists on the table', async () => {
    const res = await call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'Ext',
      fields: [{ name: 'AccountNum', edt: 'CustAccount' }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('already exist');
  });

  it('fails when an index references an unknown field', async () => {
    const res = await call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'Ext',
      fields: [{ name: 'MyAmount', edt: 'AmountMST' }],
      indexes: [{ name: 'MyIdx', fields: ['NotAField'] }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NotAField');
  });

  it('generates real XML containing fields and indexes', async () => {
    const res = await call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'Ext',
      fields: [{ name: 'MyAmount', edt: 'AmountMST', label: '@SYS1' }],
      indexes: [{ name: 'MyAmountIdx', fields: ['MyAmount', 'AccountNum'], allowDuplicates: true }],
    });
    expect(res.isError).toBeUndefined();
    const xml = res.content[0].text;
    expect(xml).toContain('<AxTableExtension');
    expect(xml).toContain('<Name>CustTable.Ext</Name>');
    expect(xml).toContain('<Name>MyAmount</Name>');
    expect(xml).toContain('<ExtendedDataType>AmountMST</ExtendedDataType>');
    expect(xml).toContain('AxTableFieldReal');
    expect(xml).toContain('<Name>MyAmountIdx</Name>');
    expect(xml).toContain('<AllowDuplicates>Yes</AllowDuplicates>');
    expect(xml).not.toContain('to be scaffolded');
  });

  it('fails on an unknown label reference', async () => {
    const res = await call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'Ext',
      fields: [{ name: 'MyAmount', edt: 'AmountMST', label: '@SYS999999' }],
    });
    expect(res.isError).toBe(true);
  });
});

describe('create_class_extension', () => {
  it('fails for a missing target class', async () => {
    const res = await call('create_class_extension', {
      targetClass: 'GhostClass',
      extensionName: 'GhostClass_Ext',
    });
    expect(res.isError).toBe(true);
  });

  it('generates boilerplate for a valid target', async () => {
    const res = await call('create_class_extension', {
      targetClass: 'SalesLineType',
      extensionName: 'MySalesLineType_Ext',
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('[ExtensionOf(classStr(SalesLineType))]');
  });
});

describe('generate_xpp_class', () => {
  it('fails when the parent class does not exist', async () => {
    const res = await call('generate_xpp_class', { className: 'MyClass', extends: 'GhostBase' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('GhostBase');
  });

  it('fails when an interface does not exist', async () => {
    const res = await call('generate_xpp_class', {
      className: 'MyClass',
      implements: ['SysPackable', 'GhostInterface'],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('GhostInterface');
  });

  it('fails on an invalid class name', async () => {
    const res = await call('generate_xpp_class', { className: 'class' });
    expect(res.isError).toBe(true);
  });

  it('generates a class when everything resolves', async () => {
    const res = await call('generate_xpp_class', {
      className: 'MyClass',
      extends: 'SalesLineTypeBase',
      implements: ['SysPackable'],
      isAbstract: true,
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain(
      'abstract class MyClass extends SalesLineTypeBase implements SysPackable'
    );
  });
});

describe('create_runbase_batch and create_sys_operation', () => {
  it('rejects invalid class names', async () => {
    const res = await call('create_runbase_batch', { className: '9Bad', description: 'x' });
    expect(res.isError).toBe(true);
  });

  it('rejects invalid menu item names', async () => {
    const res = await call('create_runbase_batch', {
      className: 'MyBatch',
      description: 'x',
      menuItemName: 'bad name',
    });
    expect(res.isError).toBe(true);
  });

  it('generates a RunBaseBatch class', async () => {
    const res = await call('create_runbase_batch', { className: 'MyBatch', description: 'Runs' });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('class MyBatch extends RunBaseBatch');
  });

  it('rejects invalid SysOperation base names', async () => {
    const res = await call('create_sys_operation', { baseName: 'select', description: 'x' });
    expect(res.isError).toBe(true);
  });

  it('generates the four SysOperation classes', async () => {
    const res = await call('create_sys_operation', { baseName: 'MyOp', description: 'x' });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.contract).toContain('class MyOpContract');
    expect(parsed.service).toContain('class MyOpService');
    expect(parsed.controller).toContain('SysOperationServiceController');
    expect(parsed.uiBuilder).toContain('MyOpUIBuilder');
  });
});
