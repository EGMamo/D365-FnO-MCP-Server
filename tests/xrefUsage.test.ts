import { describe, expect, it } from 'vitest';
import { openDb } from '../src/indexer/db.js';
import { normalizeUsageRow } from '../src/indexer/xrefUsage.js';
import { collectMetadataTools } from './helpers/toolHarness.js';

describe('xref usage normalization', () => {
  it('resolves compiler IDs through Names paths and preserves location', () => {
    const ref = normalizeUsageRow(
      { SourceId: 1, TargetId: 2, Kind: 'Call', Line: 42, Column: 8 },
      'References',
      new Map([['1', '/Classes/OrderService/Methods/run'], ['2', '/Classes/SalesTable/Methods/confirm']])
    );
    expect(ref).toMatchObject({
      sourceType: 'Class', sourceName: 'OrderService', sourceMethod: 'run',
      targetType: 'Class', targetName: 'SalesTable', targetMethod: 'confirm',
      referenceKind: 'Call', sourceLine: 42, sourceColumn: 8,
    });
  });

  it('normalizes Windows-style compiler paths', () => {
    const ref = normalizeUsageRow(
      { SourceId: 1, TargetId: 2, Kind: 'Call' },
      'References',
      new Map([['1', '\\Classes\\Caller\\Methods\\run'], ['2', '\\Classes\\Target\\Methods\\go']])
    );
    expect(ref).toMatchObject({ sourceName: 'Caller', targetName: 'Target', targetMethod: 'go' });
  });

  it('classifies broader AOT paths and decodes compiler reference kinds', () => {
    const ref = normalizeUsageRow(
      { SourceId: 1, TargetId: 2, Kind: 2 },
      'References',
      new Map([['1', '/Maps/SalesMap/Methods/lookup'], ['2', '/Tables/SalesTable/Fields/AccountNum']])
    );
    expect(ref).toMatchObject({
      sourceType: 'Map',
      sourceName: 'SalesMap',
      sourceMethod: 'lookup',
      targetType: 'Table',
      targetName: 'SalesTable',
      referenceKind: 'TypeReference',
    });
  });

  it.each([
    ['/DataEntityViews/CustCustomerEntity/Methods/mapEntityToDataSource', 'DataEntity'],
    ['/TableExtensions/CustTable.Contoso/Fields/LoyaltyCode', 'TableExtension'],
    ['/SecurityPrivileges/CustTableMaintain', 'SecurityPrivilege'],
    ['/MenuItemDisplay/CustTable', 'MenuItemDisplay'],
  ])('classifies %s as %s', (sourcePath, sourceType) => {
    const ref = normalizeUsageRow(
      { SourcePath: sourcePath, TargetPath: '/Classes/Target', Kind: 10 },
      'References'
    );
    expect(ref).toMatchObject({ sourceType, referenceKind: 'MethodOverride' });
  });

  it.each([
    [0, 'Any'],
    [1, 'MethodCall'],
    [2, 'TypeReference'],
    [3, 'InterfaceImplementation'],
    [4, 'ClassExtended'],
    [5, 'TestCall'],
    [6, 'Property'],
    [7, 'Attribute'],
    [8, 'TestHelperCall'],
    [9, 'Tag'],
    [10, 'MethodOverride'],
  ])('decodes compiler reference kind %i as %s', (kind, expected) => {
    const ref = normalizeUsageRow(
      { SourcePath: '/Classes/Caller', TargetPath: '/Classes/Target', Kind: kind },
      'References'
    );
    expect(ref?.referenceKind).toBe(expected);
  });

  it('preserves unknown numeric reference kinds explicitly', () => {
    const ref = normalizeUsageRow(
      { SourcePath: '/Classes/Caller', TargetPath: '/Classes/Target', Kind: 999 },
      'References'
    );
    expect(ref?.referenceKind).toBe('Unknown(999)');
  });

  it('registers find_usages and returns an empty result before import', async () => {
    const db = openDb(':memory:');
    const tool = collectMetadataTools(db).get('find_usages');
    expect(tool).toBeDefined();
    const result = await tool!({ name: 'Missing', limit: 10 });
    expect(JSON.parse(result.content[0].text)).toEqual([]);
    db.close();
  });
});
