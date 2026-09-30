import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importXrefSnapshot } from '../src/cli/index-xref-command.js';
import { openDb } from '../src/indexer/db.js';
import { findUsageRefs, getUsageSnapshotStatus, usageSnapshotVersion } from '../src/indexer/xrefUsage.js';
import { seedLegacyUsageRefs } from './helpers/usageRefs.js';
import { xrefPageQuery, type XrefSqlClient, type XrefTableSchema } from '../src/indexer/xrefSql.js';

let root: string;
let dbPath: string;
const row = {
  __source_path: '/Classes/Caller/Methods/run',
  __target_path: '/Classes/Target/Methods/go',
  Kind: 'Call', Line: 23,
};
const names: XrefTableSchema = { name: 'Names', columns: ['Id', 'Path'], keys: [['Id']] };
const references: XrefTableSchema = {
  name: 'References', columns: ['SourceId', 'TargetId', 'Kind', 'Line'], keys: [['SourceId', 'TargetId', 'Line']],
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-xref-import-'));
  dbPath = path.join(root, 'index.db');
  const db = openDb(dbPath);
  seedLegacyUsageRefs(db, [{
    sourceType: 'Class', sourceName: 'OldCaller', targetName: 'Target',
    referenceKind: 'Call', sourceTable: 'References', raw: {},
  }]);
  db.close();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function client(rows: Record<string, unknown>[], expectedRows = rows.length): XrefSqlClient {
  return {
    source: { consistency: 'snapshot', tables: [references], expectedRows },
    async *batches() { yield { table: 'References', rows }; },
    async close() {},
  };
}

function currentCallers(): string[] {
  const db = openDb(dbPath);
  try { return findUsageRefs(db, 'Target').map((ref) => ref.sourceName); }
  finally { db.close(); }
}

describe('atomic xref import', () => {
  it('publishes a complete snapshot with provenance and discards raw rows by default', async () => {
    expect(await importXrefSnapshot(dbPath, client([row]))).toBe(1);
    const db = openDb(dbPath);
    try {
      expect(findUsageRefs(db, 'Target', 'Class', 'go')).toMatchObject([{
        sourceType: 'Class', sourceName: 'Caller', sourceMethod: 'run',
        targetName: 'Target', targetMethod: 'go', referenceKind: 'Call', sourceLine: 23, raw: {},
      }]);
      expect(findUsageRefs(db, 'Target', 'Class', 'other')).toEqual([]);
      expect(usageSnapshotVersion(db)).toBeTruthy();
      expect(getUsageSnapshotStatus(db)).toMatchObject({ status: 'imported', rowCount: 1 });
      expect(db.prepare('SELECT row_count FROM ax_usage_snapshot').get()).toMatchObject({ row_count: 1 });
    } finally { db.close(); }
  });

  it('leaves the previous snapshot visible during paging and on disconnection', async () => {
    const source = client([], 2);
    source.batches = async function* () {
      yield { table: 'References', rows: [row] };
      expect(currentCallers()).toEqual(['OldCaller']);
      throw new Error('Source disconnected');
    };
    await expect(importXrefSnapshot(dbPath, source)).rejects.toThrow('disconnected');
    expect(currentCallers()).toEqual(['OldCaller']);
  });

  it('refuses unresolved references instead of silently importing a partial snapshot', async () => {
    await expect(importXrefSnapshot(dbPath, client([row, { SourceId: 9, TargetId: 10 }]))).rejects.toThrow('Unresolved');
    expect(currentCallers()).toEqual(['OldCaller']);
  });

  it('requires explicit permission for an empty replacement', async () => {
    await expect(importXrefSnapshot(dbPath, client([]))).rejects.toThrow('--allow-empty');
    expect(currentCallers()).toEqual(['OldCaller']);
    await importXrefSnapshot(dbPath, client([]), { allowEmpty: true });
    expect(currentCallers()).toEqual([]);
  });

  it('refuses incomplete paging or join multiplication', async () => {
    await expect(importXrefSnapshot(dbPath, client([row], 2))).rejects.toThrow('count mismatch');
    await expect(importXrefSnapshot(dbPath, client([row, row], 1))).rejects.toThrow('count mismatch');
    expect(currentCallers()).toEqual(['OldCaller']);
  });

  it('retains raw rows only on explicit opt-in', async () => {
    await importXrefSnapshot(dbPath, client([row]), { storeRaw: true });
    const db = openDb(dbPath);
    try { expect(findUsageRefs(db, 'Target')[0].raw).toMatchObject({ Kind: 'Call' }); }
    finally { db.close(); }
  });

  it('cancellation preserves the previous snapshot and releases SQLite', async () => {
    const abort = new AbortController();
    const source = client([row]);
    source.batches = async function* () {
      yield { table: 'References', rows: [row] };
      abort.abort(new Error('cancelled'));
    };
    await expect(importXrefSnapshot(dbPath, source, { signal: abort.signal })).rejects.toThrow('cancelled');
    expect(currentCallers()).toEqual(['OldCaller']);
    await importXrefSnapshot(dbPath, client([row]));
    expect(currentCallers()).toEqual(['Caller']);
  });

  it('does not overwrite a newer concurrently published snapshot', async () => {
    const slow = client([], 1);
    slow.batches = async function* () {
      yield { table: 'References', rows: [row] };
      await importXrefSnapshot(dbPath, client([{ ...row, __source_path: '/Classes/Newer/Methods/run' }]));
    };
    await expect(importXrefSnapshot(dbPath, slow)).rejects.toThrow('Another import');
    expect(currentCallers()).toEqual(['Newer']);
  });

  it('does not rebuild usage indexes every time the database opens', () => {
    const first = openDb(dbPath);
    const version = first.prepare('PRAGMA schema_version').get();
    first.close();
    const second = openDb(dbPath);
    expect(second.prepare('PRAGMA schema_version').get()).toEqual(version);
    second.close();
  });

  it('distinguishes unimported, legacy and deliberately empty snapshots', async () => {
    const db = openDb(dbPath);
    expect(getUsageSnapshotStatus(db)).toMatchObject({ status: 'legacy-unverified' });
    db.close();
    const empty = openDb(':memory:');
    expect(getUsageSnapshotStatus(empty)).toMatchObject({ status: 'not-imported' });
    empty.close();
    await importXrefSnapshot(dbPath, client([]), { allowEmpty: true });
    const refreshed = openDb(dbPath);
    expect(getUsageSnapshotStatus(refreshed)).toMatchObject({ status: 'imported', rowCount: 0 });
    refreshed.close();
  });
});

describe('SQL Server query contract', () => {
  it('closes table identifiers, resolves names in SQL and uses the actual unique key', () => {
    const sql = xrefPageQuery(references, names);
    expect(sql).toContain('FROM [dbo].[References] r');
    expect(sql).toContain('LEFT JOIN [dbo].[Names]');
    expect(sql).toContain('ORDER BY r.[SourceId], r.[TargetId], r.[Line]');
    expect(sql).toContain('OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY');
    expect(sql).not.toContain('ORDER BY [Id]');
  });

  it('rejects guessed schemas and unknown tables before replacement', () => {
    expect(() => xrefPageQuery({ ...references, name: 'Other' }, names)).toThrow('Unsupported xref table');
    expect(() => xrefPageQuery({ ...references, keys: [] }, names)).toThrow('unique key');
    expect(() => xrefPageQuery(references, { ...names, keys: [] })).toThrow('must be unique');
    expect(() => xrefPageQuery(references)).toThrow('requires dbo.Names');
    expect(() => xrefPageQuery({ name: 'SysXRefClassReferences', columns: ['Id'], keys: [['Id']] })).toThrow('SourcePath');
  });
});
