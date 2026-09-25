import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMssqlClient } from '../src/indexer/xrefSql.js';

const state = vi.hoisted(() => ({
  snapshotEnabled: true,
  failOnPage: false,
  queries: [] as string[],
  parameters: [] as { name: string; type: string; value: number }[],
  connect: vi.fn(),
  close: vi.fn(),
  rollback: vi.fn(),
  begin: vi.fn(),
}));

vi.mock('mssql', () => ({
  default: {
    Int: 'int',
    BigInt: 'bigint',
    ISOLATION_LEVEL: { SNAPSHOT: 5, SERIALIZABLE: 4 },
    ConnectionPool: class {
      connect = state.connect;
      close = state.close;
    },
    Transaction: class {
      begin = state.begin;
      rollback = state.rollback;
      on() {}
    },
    Request: class {
      input(name: string, type: string, value: number) { state.parameters.push({ name, type, value }); return this; }
      cancel() {}
      async query(text: string) {
        state.queries.push(text);
        if (text.includes('sys.databases')) return { recordset: [{ state: state.snapshotEnabled ? 1 : 0 }] };
        if (text.includes('sys.indexes')) return {
          recordset: [
            { table_name: 'References', index_id: 1, column_name: 'SourceId' },
            { table_name: 'References', index_id: 1, column_name: 'TargetId' },
            { table_name: 'Names', index_id: 1, column_name: 'Id' },
          ],
        };
        if (text.includes('sys.columns')) return {
          recordset: [
            { table_name: 'References', column_name: 'SourceId' },
            { table_name: 'References', column_name: 'TargetId' },
            { table_name: 'References', column_name: 'Kind' },
            { table_name: 'Names', column_name: 'Id' },
            { table_name: 'Names', column_name: 'Path' },
          ],
        };
        if (text.includes('COUNT_BIG')) return { recordset: [{ n: '1' }] };
        if (state.failOnPage) throw new Error('read failed');
        return { recordset: [{ __source_path: '/Classes/A', __target_path: '/Classes/B' }] };
      }
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.snapshotEnabled = true;
  state.failOnPage = false;
  state.queries = [];
  state.parameters = [];
});

describe('mssql source lifecycle and schema probing', () => {
  it('uses snapshot isolation and server-side name joins with parameterized pages', async () => {
    const client = await createMssqlClient('test-configuration');
    expect(client.source).toMatchObject({ consistency: 'snapshot', expectedRows: 1 });
    const batches = [];
    for await (const batch of client.batches()) batches.push(batch);
    expect(batches).toHaveLength(1);
    expect(state.begin).toHaveBeenCalledWith(5);
    expect(state.queries.at(-1)).toContain('FROM [dbo].[References] r LEFT JOIN');
    expect(state.queries.some((query) => /^SELECT \* FROM.*Names/.test(query))).toBe(false);
    expect(state.parameters).toEqual([
      { name: 'offset', type: 'bigint', value: 0 },
      { name: 'limit', type: 'int', value: 5000 },
    ]);
    await client.close();
    expect(state.rollback).toHaveBeenCalledTimes(1);
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('never silently takes source locks if snapshot isolation is disabled', async () => {
    state.snapshotEnabled = false;
    await expect(createMssqlClient('test-configuration')).rejects.toThrow('--allow-source-locks');
    expect(state.begin).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('allows serializable source locks only when explicitly enabled', async () => {
    state.snapshotEnabled = false;
    const client = await createMssqlClient('test-configuration', { allowSourceLocks: true });
    expect(state.begin).toHaveBeenCalledWith(4);
    expect(client.source.consistency).toBe('serializable');
    await client.close();
  });

  it('releases both transaction and pool after a read error', async () => {
    const client = await createMssqlClient('test-configuration');
    state.failOnPage = true;
    try {
      await expect(client.batches()[Symbol.asyncIterator]().next()).rejects.toThrow('read failed');
    } finally {
      await client.close();
    }
    expect(state.rollback).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('closes the pool even if transaction rollback fails', async () => {
    const client = await createMssqlClient('test-configuration');
    state.rollback.mockRejectedValueOnce(new Error('rollback failed'));
    await expect(client.close()).rejects.toThrow('rollback failed');
    expect(state.close).toHaveBeenCalledOnce();
  });
});
