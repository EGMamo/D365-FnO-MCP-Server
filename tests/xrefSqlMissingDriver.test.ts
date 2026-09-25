import { describe, it, expect, vi } from 'vitest';

// Simulates an install made with `npm install --omit=optional`, where the
// optional mssql driver is absent.
vi.mock('mssql', () => {
  throw new Error("Cannot find package 'mssql' imported from xrefSql.ts");
});

describe('index-xref without the optional mssql driver', () => {
  it('explains how to install the driver instead of surfacing a module error', async () => {
    const { createMssqlClient } = await import('../src/indexer/xrefSql.js');
    await expect(createMssqlClient('Server=example;Database=DynamicsXrefDB')).rejects.toThrow(/npm install mssql/);
  });
});
