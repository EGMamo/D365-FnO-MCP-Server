import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readTraceSnapshotFromSql, REQUIRED_TRACE_COLUMNS } from '../src/indexer/traceSql.js';

const state = vi.hoisted(() => ({
  columns: [] as { table_name: string; column_name: string }[],
  queries: [] as string[],
  inputs: [] as { name: string; value: unknown }[],
  close: vi.fn(),
}));

vi.mock('mssql', () => ({
  default: {
    Int: 'int',
    NVarChar: 'nvarchar',
    ConnectionPool: class {
      connect = vi.fn();
      close = state.close;
    },
    Request: class {
      input(name: string, _type: string, value: unknown) { state.inputs.push({ name, value }); return this; }
      cancel() {}
      async query(text: string) {
        state.queries.push(text);
        if (text.includes('sys.columns')) return { recordset: state.columns };
        if (text.includes('FROM dbo.UserSessions us')) {
          return { recordset: [{ session_id: 11, trace_name: 'T', total_ms: 5, db_ms: 1, db_calls: '4', rows_fetched: null }] };
        }
        if (text.includes('worst_line_db_calls')) {
          return { recordset: [{ session_id: 11, method_name: 'A::b', calls: '2', inclusive_ms: 3, exclusive_ms: 1,
            db_ms: 1, db_calls: 4, rows_fetched: 0, worst_line_db_calls: 4, worst_line_db_ms: 1 }] };
        }
        return { recordset: [] };
      }
    },
  },
}));

const ALL_COLUMNS = Object.entries(REQUIRED_TRACE_COLUMNS).flatMap(([t, cols]) =>
  cols.map((c) => ({ table_name: t, column_name: c })));

beforeEach(() => {
  vi.clearAllMocks();
  state.columns = ALL_COLUMNS;
  state.queries = [];
  state.inputs = [];
});

describe('Trace Parser SQL source', () => {
  it('reads parameterized aggregates and closes the pool', async () => {
    const snapshot = await readTraceSnapshotFromSql('Server=x;Database=AxTrace', { trace: 'T', maxRows: 50 });
    expect(snapshot.sessions).toEqual([expect.objectContaining({ session_id: '11', db_calls: 4, rows_fetched: 0 })]);
    expect(snapshot.methods[0]).toMatchObject({ method_name: 'A::b', calls: 2 });
    expect(snapshot.statements).toEqual([]);
    expect(state.inputs).toContainEqual({ name: 'trace', value: 'T' });
    expect(state.inputs).toContainEqual({ name: 'limit', value: 50 });
    expect(state.queries.every((q) => !q.includes("'T'"))).toBe(true);
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('refuses a database that is not a Trace Parser database', async () => {
    state.columns = ALL_COLUMNS.filter((c) => c.table_name !== 'MethodNames');
    await expect(readTraceSnapshotFromSql('Server=x')).rejects.toThrow('Not a Trace Parser database; missing MethodNames.MethodHash');
    expect(state.close).toHaveBeenCalledOnce();
  });
});
