import { describe, expect, it } from 'vitest';
import { importCustomXrefs } from '../src/gateway/xrefImport.js';
import { findUsageRefs, getUsageSnapshotStatus } from '../src/indexer/xrefUsage.js';
import type { XrefSqlClient, XrefTableSchema } from '../src/indexer/xrefSql.js';
import { seedDb } from './helpers/toolHarness.js';

const references: XrefTableSchema = {
  name: 'References', columns: ['SourceId', 'TargetId', 'Kind', 'Line'], keys: [['SourceId', 'TargetId', 'Line']],
};

const ref = (source: string, target: string, line: number) => ({
  __source_path: `/Classes/${source}/Methods/run`,
  __target_path: `/Classes/${target}/Methods/go`,
  Kind: 'Call', Line: line,
});

function fakeSource(rows: Record<string, unknown>[], seen: { closed: boolean; locks?: boolean }) {
  return async (_connectionString: string, options: { allowSourceLocks?: boolean }): Promise<XrefSqlClient> => {
    seen.locks = options.allowSourceLocks;
    return {
      source: { consistency: 'serializable', tables: [references], expectedRows: rows.length },
      async *batches() { yield { table: 'References', rows }; },
      async close() { seen.closed = true; },
    };
  };
}

describe('importing compiler cross-references into the custom index', () => {
  it('keeps only references that start or end in a custom object', async () => {
    const db = seedDb([{ type: 'Class', name: 'ZelPriceJob' }, { type: 'Table', name: 'ZelDailyPrice' }]);
    const seen = { closed: false } as { closed: boolean; locks?: boolean };
    try {
      const count = await importCustomXrefs(db, 'Server=(LocalDB)\\MSSQLLocalDB;Database=XRef_dev;Trusted_Connection=yes', {
        connect: fakeSource([
          ref('ZelPriceJob', 'CustTable', 1), // custom calls standard: kept
          ref('SalesLine', 'zelpricejob', 2), // standard calls custom (any casing): kept
          ref('SalesLine', 'CustTable', 3), // standard only: dropped
        ], seen),
      });

      expect(count).toBe(2);
      expect(findUsageRefs(db, 'CustTable').map((r) => r.sourceName)).toEqual(['ZelPriceJob']);
      expect(findUsageRefs(db, 'zelpricejob').map((r) => r.sourceName)).toEqual(['SalesLine']);
      expect(getUsageSnapshotStatus(db)).toMatchObject({ status: 'imported', rowCount: 2 });
      expect(seen.closed).toBe(true);
      expect(seen.locks).toBe(true);
    } finally {
      db.close();
    }
  });

  it('can run again on the same connection', async () => {
    const db = seedDb([{ type: 'Class', name: 'ZelPriceJob' }]);
    try {
      const seen = { closed: false };
      await importCustomXrefs(db, 'x', { connect: fakeSource([ref('ZelPriceJob', 'A', 1)], seen) });
      expect(await importCustomXrefs(db, 'x', { connect: fakeSource([ref('ZelPriceJob', 'B', 1)], seen) })).toBe(1);
      expect(findUsageRefs(db, 'B')).toHaveLength(1);
      expect(findUsageRefs(db, 'A')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('does not connect when the custom index is empty', async () => {
    const db = seedDb([]);
    try {
      const seen = { closed: false };
      expect(await importCustomXrefs(db, 'x', { connect: fakeSource([], seen) })).toBe(0);
      expect(seen.closed).toBe(false);
    } finally {
      db.close();
    }
  });

  it('keeps the previous snapshot when the source is cut short', async () => {
    const db = seedDb([{ type: 'Class', name: 'ZelPriceJob' }]);
    try {
      await importCustomXrefs(db, 'x', { connect: fakeSource([ref('ZelPriceJob', 'A', 1)], { closed: false }) });
      const short = async (): Promise<XrefSqlClient> => ({
        source: { consistency: 'serializable', tables: [references], expectedRows: 5 },
        async *batches() { yield { table: 'References', rows: [ref('ZelPriceJob', 'B', 1)] }; },
        async close() {},
      });
      await expect(importCustomXrefs(db, 'x', { connect: short })).rejects.toThrow(/row count mismatch/);
      expect(findUsageRefs(db, 'A')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
