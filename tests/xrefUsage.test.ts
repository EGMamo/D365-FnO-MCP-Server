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

  it('registers find_usages and returns an empty result before import', async () => {
    const db = openDb(':memory:');
    const tool = collectMetadataTools(db).get('find_usages');
    expect(tool).toBeDefined();
    const result = await tool!({ name: 'Missing', limit: 10 });
    expect(JSON.parse(result.content[0].text)).toEqual([]);
    db.close();
  });
});
