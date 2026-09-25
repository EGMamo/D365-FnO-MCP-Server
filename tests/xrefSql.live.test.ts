import { describe, expect, it } from 'vitest';
import { createMssqlClient } from '../src/indexer/xrefSql.js';
import { normalizeUsageRow } from '../src/indexer/xrefUsage.js';

// Explicit opt-in only. Never attach/restore a database or modify SQL Server in a test.
describe.skipIf(process.env.D365_RUN_SQL_INTEGRATION !== '1')('live DynamicsXrefDB read contract', () => {
  it('validates the installed schema and reads a bounded batch using the actual driver', async () => {
    const connectionString = process.env.D365_XREF_CONNECTION_STRING;
    if (!connectionString) throw new Error('D365_XREF_CONNECTION_STRING is required for this opt-in test.');
    const client = await createMssqlClient(connectionString, {
      allowSourceLocks: process.env.D365_TEST_ALLOW_SOURCE_LOCKS === '1',
    });
    try {
      expect(client.source.tables.length).toBeGreaterThan(0);
      expect(client.source.expectedRows).toBeGreaterThan(0);
      let checked = 0;
      for await (const batch of client.batches()) {
        expect(batch.rows.length).toBeLessThanOrEqual(5000);
        for (const row of batch.rows) {
          expect(normalizeUsageRow({
            ...row, SourcePath: row.__source_path, TargetPath: row.__target_path,
          }, batch.table)).not.toBeNull();
          checked++;
        }
        break;
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 120_000);
});
