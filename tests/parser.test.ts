import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as parser from '../src/indexer/parser.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), 'utf-8');

describe('parseAxTable', () => {
  const result = parser.parseAxTable(fixture('AxTableSample.xml'));

  it('extracts real field types', () => {
    expect(result.fields.map((f) => [f.name, f.type])).toEqual([
      ['AccountNum', 'String'],
      ['LineNum', 'Int'],
      ['Amount', 'Real'],
    ]);
  });

  it('extracts field metadata', () => {
    const acct = result.fields[0];
    expect(acct.edt).toBe('CustAccount');
    expect(acct.labelId).toBe('@SYS1');
    expect(acct.mandatory).toBe(true);
    expect(result.fields[1].allowEdit).toBe(false);
  });

  it('extracts table properties, indexes and methods', () => {
    expect(result.extends).toBe('BaseTable');
    expect(result.saveDataPerCompany).toBe(true);
    expect(result.indexes).toEqual(['AccountIdx']);
    expect(result.methods[0].name).toBe('find');
    expect(result.methods[0].isStatic).toBe(true);
    expect(result.methods[0].returnType).toBe('SampleTable');
    expect(result.methods[0].params.map((p) => p.name)).toEqual(['_sampleId', '_forUpdate']);
  });

  it('handles a single field child (not an array)', () => {
    const single = parser.parseAxTable(fixture('AxTableSingleField.xml'));
    expect(single.fields).toHaveLength(1);
    expect(single.fields[0]).toMatchObject({ name: 'RecId2', type: 'Guid' });
  });
});

describe('parseAxClass', () => {
  const result = parser.parseAxClass(fixture('AxClassSample.xml'));

  it('extracts class metadata', () => {
    expect(result.extends).toBe('RunBaseBatch');
    expect(result.implements).toEqual(['SysPackable']);
  });

  it('extracts methods from source', () => {
    const names = result.methods.map((m) => m.name);
    expect(names).toEqual(['construct', 'buildMessage', 'run', 'pack']);
  });

  it('extracts modifiers, return types and params', () => {
    const byName = Object.fromEntries(result.methods.map((m) => [m.name, m]));
    expect(byName.construct).toMatchObject({ isStatic: true, accessModifier: 'public', returnType: 'SampleClass' });
    expect(byName.run).toMatchObject({ isStatic: false, accessModifier: 'private', returnType: 'void' });
    expect(byName.pack).toMatchObject({ isAbstract: true, returnType: 'container' });
    expect(byName.buildMessage.params).toEqual([
      { name: '_prefix', type: 'str' },
      { name: '_count', type: 'int' },
    ]);
  });

  it('ignores calls and control-flow statements', () => {
    expect(result.methods.map((m) => m.name)).not.toContain('info');
    expect(result.methods.map((m) => m.name)).not.toContain('if');
  });
});

describe('parseAxClass (legacy flat Source layout)', () => {
  const result = parser.parseAxClass(fixture('AxClassLegacySample.xml'));

  it('still extracts metadata and methods', () => {
    expect(result.extends).toBe('RunBaseBatch');
    expect(result.implements).toEqual(['SysPackable']);
    expect(result.methods.map((m) => m.name)).toEqual(['construct', 'buildMessage', 'run', 'pack']);
  });
});

describe('parseXppMethods', () => {
  it('captures display and edit modifier methods', () => {
    const methods = parser.parseXppMethods(`
      public display Amount total()
      {
          return 0;
      }

      public edit str comment(boolean _set, str _value)
      {
          return _value;
      }
    `);
    expect(methods.map((m) => m.name)).toEqual(['total', 'comment']);
    expect(methods[0]).toMatchObject({ returnType: 'Amount', accessModifier: 'public' });
  });

  it('handles multi-line signatures and comments', () => {
    const src = `
      // leading comment
      public static void doWork(
          str _a,
          int _b = 5)
      {
          if (_b > 0)
          {
              info(_a);
          }
      }
    `;
    const methods = parser.parseXppMethods(src);
    expect(methods).toHaveLength(1);
    expect(methods[0]).toMatchObject({ name: 'doWork', isStatic: true, returnType: 'void' });
    expect(methods[0].params).toEqual([
      { name: '_a', type: 'str' },
      { name: '_b', type: 'int' },
    ]);
  });
});

describe('parseAxEnum', () => {
  it('extracts values', () => {
    const result = parser.parseAxEnum(fixture('AxEnumSample.xml'));
    expect(result.label).toBe('@SYS999');
    expect(result.isExtensible).toBe(true);
    expect(result.values).toEqual([
      { name: 'None', value: 0, labelId: '@SYS1000' },
      { name: 'Open', value: 1, labelId: '' },
      { name: 'Closed', value: 2, labelId: '' },
    ]);
  });

  it('defaults implicit values to previous + 1 starting at 0', () => {
    const result = parser.parseAxEnum(fixture('AxEnumImplicitSample.xml'));
    expect(result.values).toEqual([
      { name: 'None', value: 0, labelId: '' },
      { name: 'Open', value: 1, labelId: '' },
      { name: 'Archived', value: 10, labelId: '' },
      { name: 'Purged', value: 11, labelId: '' },
    ]);
  });
});

describe('parseAxForm', () => {
  const result = parser.parseAxForm(fixture('AxFormSample.xml'));

  it('extracts datasources and pattern', () => {
    expect(result.dataSources).toEqual([{ name: 'SampleTable', table: 'SampleTable' }]);
    expect(result.pattern).toBe('SimpleListDetails');
    expect(result.caption).toBe('@SYS55');
  });

  it('extracts root controls and one nested level', () => {
    expect(result.controls.map((c) => c.name)).toEqual(['MainGroup', 'Grid']);
    expect(result.controls[0].type).toBe('AxFormGroupControl');
    expect(result.controls[0].children.map((c) => c.name)).toEqual(['AccountNum']);
  });
});

describe('parseAxQuery', () => {
  it('extracts root and nested datasources', () => {
    const result = parser.parseAxQuery(fixture('AxQuerySample.xml'));
    expect(result.title).toBe('@SYS77');
    expect(result.dataSources).toEqual([
      { name: 'SampleTable', table: 'SampleTable' },
      { name: 'ChildTable', table: 'ChildTable' },
    ]);
  });
});

describe('parseAxDataEntity', () => {
  it('extracts fields, datasources and properties', () => {
    const result = parser.parseAxDataEntity(fixture('AxDataEntityViewSample.xml'));
    expect(result.fields.map((f) => f.name)).toEqual(['AccountNum', 'Amount']);
    expect(result.fields[0]).toMatchObject({ dataSource: 'SampleTable', dataField: 'AccountNum', mandatory: true });
    expect(result.dataSources).toEqual([{ name: 'SampleTable', table: 'SampleTable' }]);
    expect(result.isPublic).toBe(true);
    expect(result.stagingTable).toBe('SampleEntityStaging');
    expect(result.publicCollectionName).toBe('SampleEntities');
  });
});

describe('parseAxEdt', () => {
  it('extracts extends, sizes and help text', () => {
    const result = parser.parseAxEdt(fixture('AxEdtSample.xml'));
    expect(result).toMatchObject({
      extends: 'CustAccount',
      labelId: '@SYS4001',
      helpText: '@SYS4002',
      stringSize: 30,
      edtType: 'String',
    });
  });
});

describe('parseLabels', () => {
  it('parses label files', () => {
    const labels = parser.parseLabels('SYS1=Hello\nSYS2=World=!\n');
    expect(labels).toEqual([
      { labelId: 'SYS1', value: 'Hello' },
      { labelId: 'SYS2', value: 'World=!' },
    ]);
  });
});

describe('parseLabels with a label file id', () => {
  it('prefixes plain ids with the label file and keeps legacy @ ids global', () => {
    const labels = parser.parseLabels('﻿Greeting=Hello\r\n ;comment\r\n@SYS1=Account\r\n', 'MyLabels');
    expect(labels).toEqual([
      { labelId: 'MyLabels:Greeting', value: 'Hello' },
      { labelId: 'SYS1', value: 'Account' },
    ]);
  });
});

describe('parseAxTableExtension / parseAxView / parseAxMap', () => {
  it('reads the fields and indexes a table extension adds', () => {
    const xml = `<AxTableExtension xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>CustTable.MyExt</Name>
      <Fields><AxTableField xmlns="" i:type="AxTableFieldString"><Name>MyCode</Name><ExtendedDataType>Name</ExtendedDataType><Label>@SYS1</Label></AxTableField></Fields>
      <Indexes><AxTableIndex><Name>MyIdx</Name></AxTableIndex></Indexes></AxTableExtension>`;
    const r = parser.parseAxTableExtension(xml);
    expect(r.fields).toEqual([expect.objectContaining({ name: 'MyCode', type: 'String', edt: 'Name', labelId: '@SYS1' })]);
    expect(r.indexes).toEqual(['MyIdx']);
  });

  it('reads view fields and the tables its query reads, including nested data sources', () => {
    const xml = `<AxView xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>MyView</Name><Label>@SYS2</Label>
      <Fields><AxViewField xmlns="" i:type="AxViewFieldBound"><Name>Acct</Name><DataField>AccountNum</DataField></AxViewField></Fields>
      <ViewMetadata><DataSources><AxQuerySimpleRootDataSource><Name>CustTable</Name><Table>CustTable</Table>
        <DataSources><AxQuerySimpleEmbeddedDataSource><Name>Dir</Name><Table>DirPartyTable</Table></AxQuerySimpleEmbeddedDataSource></DataSources>
      </AxQuerySimpleRootDataSource></DataSources></ViewMetadata></AxView>`;
    const r = parser.parseAxView(xml);
    expect(r.fields.map((f) => f.name)).toEqual(['Acct']);
    expect(r.dataSources.map((d) => d.table)).toEqual(['CustTable', 'DirPartyTable']);
    expect(r.label).toBe('@SYS2');
  });

  it('reads map fields and mapped tables', () => {
    const xml = `<AxMap xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>MyMap</Name>
      <Fields><AxMapField xmlns="" i:type="AxMapFieldString"><Name>Num</Name><ExtendedDataType>Name</ExtendedDataType></AxMapField></Fields>
      <Mappings><AxTableMapping><MappingTable>CustTable</MappingTable></AxTableMapping></Mappings></AxMap>`;
    const r = parser.parseAxMap(xml);
    expect(r.fields).toEqual([expect.objectContaining({ name: 'Num', type: 'String', edt: 'Name' })]);
    expect(r.mappings).toEqual(['CustTable']);
  });
});

describe('parseAxService / parseAxServiceGroup', () => {
  it('reads the class and operations of a service', () => {
    const r = parser.parseAxService(`<AxService><Name>CustSvc</Name><Class>CustServiceClass</Class><ExternalName>Cust</ExternalName>
      <ServiceOperations><AxServiceOperation><Name>GetCust</Name><Method>getCust</Method></AxServiceOperation></ServiceOperations></AxService>`);
    expect(r).toEqual({ className: 'CustServiceClass', externalName: 'Cust', operations: [{ name: 'GetCust', method: 'getCust' }] });
  });

  it('reads the services of a service group', () => {
    const r = parser.parseAxServiceGroup(`<AxServiceGroup><Name>G</Name><Services><AxServiceGroupService><Name>CustSvc</Name><Service>CustSvc</Service></AxServiceGroupService></Services></AxServiceGroup>`);
    expect(r.services).toEqual(['CustSvc']);
  });
});
