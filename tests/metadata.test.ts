import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '../src/indexer/db.js';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import { openDb, openDbReadOnly, setMeta, META_KEYS } from '../src/indexer/db.js';
import { snapshotIndex } from '../src/indexer/indexSnapshot.js';
import { collectMetadataTools, seedDb, type ToolResult } from './helpers/toolHarness.js';
import { seedLegacyUsageRefs } from './helpers/usageRefs.js';

let db: Database;
let tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;
let tmpDir: string;
let livePath: string;

function call(name: string, args: Record<string, unknown> = {}) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(args);
}

async function json(name: string, args: Record<string, unknown> = {}) {
  const res = await call(name, args);
  return JSON.parse(res.content[0].text);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tests', '.tmp-metadata-'));
  livePath = path.join(tmpDir, 'Fresh.xml');
  fs.writeFileSync(livePath, '<Table><Name>Fresh</Name></Table>');
  const freshMtime = Math.floor(fs.statSync(livePath).mtimeMs);

  db = seedDb([
    { type: 'Table', name: 'CustTable', package: 'ApplicationSuite', model: 'Foundation' },
    { type: 'Class', name: 'SalesLineType', package: 'ApplicationSuite', model: 'Foundation' },
    { type: 'Table', name: 'MyTable', package: 'MyPackage', model: 'MyModel' },
    // Indexed mtime far in the past: the on-disk file is newer, so this is stale.
    { type: 'Table', name: 'Stale', package: 'MyPackage', model: 'MyModel', file_path: livePath, file_mtime: freshMtime - 10_000 },
    // Up to date: db mtime matches disk.
    { type: 'Table', name: 'Fresh', package: 'MyPackage', model: 'MyModel', file_path: livePath, file_mtime: freshMtime },
  ]);
  tools = collectMetadataTools(db);
});

afterAll(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('list_packages', () => {
  it('returns distinct packages with counts', async () => {
    const packages = await json('list_packages');
    const names = packages.map((p: { package: string }) => p.package);
    expect(names).toEqual(['ApplicationSuite', 'MyPackage']);
    expect(packages.find((p: { package: string }) => p.package === 'ApplicationSuite').objectCount).toBe(2);
  });
});

describe('list_models', () => {
  it('returns distinct models with counts', async () => {
    const models = await json('list_models');
    const names = models.map((m: { model: string }) => m.model);
    expect(names).toEqual(['Foundation', 'MyModel']);
  });
});

describe('get_index_staleness', () => {
  it('reports changed files and missing files, but not up-to-date ones', async () => {
    const stale = await json('get_index_staleness', { limit: 100 });
    const byName = new Map(stale.map((s: { name: string }) => [s.name, s]));

    expect(byName.has('Fresh')).toBe(false);

    const staleEntry = byName.get('Stale') as { fs_mtime: number; db_mtime: number; file_path: string };
    expect(staleEntry).toBeDefined();
    expect(staleEntry.fs_mtime).toBeGreaterThan(staleEntry.db_mtime);
    expect(staleEntry.file_path).toBe(livePath);

    // Seeded objects use /fake/... paths that do not exist on disk.
    const missing = byName.get('CustTable') as { fs_mtime: string };
    expect(missing.fs_mtime).toBe('missing');
  });

  it('honours the result limit', async () => {
    const stale = await json('get_index_staleness', { limit: 2 });
    expect(stale.length).toBe(2);
  });

  it('reports snapshot mode instead of scanning when source files are unavailable', async () => {
    const snapshot = collectMetadataTools(db, { sourceFilesAvailable: false });
    const handler = snapshot.get('get_index_staleness');
    if (!handler) throw new Error('get_index_staleness not registered');
    const report = JSON.parse((await handler({ limit: 100 })).content[0].text);
    expect(report).toMatchObject({ mode: 'snapshot', builtAt: null });
    expect(JSON.stringify(report)).not.toContain('missing');
  });
});

describe('get_index_stats', () => {
  it('reports counts and null provenance for a seeded database', async () => {
    const stats = await json('get_index_stats');
    expect(stats.totalObjects).toBe(5);
    expect(stats.builtAt).toBeNull();
    expect(stats.lastIndexed).toBeNull();
    expect(stats.usageSnapshot).toEqual({ status: 'not-imported', importedAt: null, rowCount: null });
  });
});

describe.each(['local', 'snapshot', 'legacy-snapshot'])('case-insensitive metadata resolution (%s)', (mode) => {
  let index: Database;
  let metadata: ReturnType<typeof collectMetadataTools>;
  let snapshotDir: string | undefined;

  beforeAll(() => {
    index = seedDb([
      { type: 'Table', name: 'InvoiceTable' },
      { type: 'Class', name: 'InvoiceService', methods: [{ name: 'postInvoice', returnType: 'boolean' }] },
      { type: 'Class', name: 'CustomInvoiceService' },
    ]);
    index.exec(`INSERT INTO ax_xref (from_type, from_name, to_type, to_name, xref_kind) VALUES
      ('Class', 'InvoiceService', 'Table', 'INVOICETABLE', 'relation'),
      ('Class', 'CustomInvoiceService', 'Class', 'InvoiceService', 'extends'),
      ('Class', 'UnrelatedService', 'Class', 'InvoiceService', 'field')`);
    seedLegacyUsageRefs(index, [
      { sourceType: 'Class', sourceName: 'InvoiceCaller', targetType: 'Class', targetName: 'InvoiceService',
        targetMethod: 'postInvoice', referenceKind: 'Call', sourceTable: 'References', sourceLine: 42, raw: {} },
      { sourceType: 'Class', sourceName: 'OtherCaller', targetType: 'Class', targetName: 'InvoiceService',
        targetMethod: 'cancelInvoice', referenceKind: 'Call', sourceTable: 'References', raw: {} },
      { sourceType: 'Class', sourceName: 'TableCaller', targetType: 'Table', targetName: 'InvoiceService',
        targetMethod: 'postInvoice', referenceKind: 'Call', sourceTable: 'References', raw: {} },
    ]);
    if (mode !== 'local') {
      snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-resolution-'));
      const source = path.join(snapshotDir, 'source.db');
      const snapshot = path.join(snapshotDir, 'snapshot.db');
      setMeta(index, META_KEYS.builtAt, '2026-10-10T00:00:00.000Z');
      index.exec(`VACUUM INTO '${source.replace(/'/g, "''")}'`);
      index.close();
      snapshotIndex(source, snapshot);
      if (mode === 'legacy-snapshot') {
        // Older immutable bundles have the same tables but lack these additive indexes.
        const legacy = openDb(snapshot);
        try {
          legacy.exec(`DROP INDEX idx_ax_objects_name_nocase;
            DROP INDEX idx_ax_xref_from_nocase;
            DROP INDEX idx_ax_xref_to_nocase;
            DROP INDEX idx_ax_usage_target_nocase;`);
        } finally { legacy.close(); }
      }
      index = openDbReadOnly(snapshot);
    }
    metadata = collectMetadataTools(index);
  });

  afterAll(() => {
    index.close();
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
  });

  it('returns table references even when the caller and reference use different casing', async () => {
    const result = await metadata.get('get_table_schema')!({ tableName: 'invoicetable', xrefLimit: 100 });
    const body = JSON.parse(result.content[0].text);
    expect(body.name).toBe('InvoiceTable');
    expect(body.xrefs).toMatchObject([{ from_name: 'InvoiceService', to_name: 'INVOICETABLE' }]);
  });

  it('returns only derived classes for a differently cased base class name', async () => {
    const result = await metadata.get('get_class_hierarchy')!({ className: 'invoiceservice', childLimit: 100 });
    const body = JSON.parse(result.content[0].text);
    expect(body.class).toBe('InvoiceService');
    expect(body.children).toMatchObject([{ from_name: 'CustomInvoiceService', xref_kind: 'extends' }]);
  });

  it('resolves method signatures with the indexed spelling', async () => {
    const result = await metadata.get('get_method_signature')!({ className: 'invoiceservice', methodName: 'POSTINVOICE' });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ name: 'postInvoice', return_type: 'boolean' });
  });

  it('finds structural references without requiring the canonical input spelling', async () => {
    const result = await metadata.get('find_references')!({ name: 'invoiceservice', type: 'Class', limit: 1 });
    const refs = JSON.parse(result.content[0].text);
    expect(refs).toHaveLength(1);
    expect(refs[0].to_name).toBe('InvoiceService');
  });

  it('matches usage names and methods case-insensitively while retaining type and method filters', async () => {
    const result = await metadata.get('find_usages')!({ name: 'INVOICESERVICE', type: 'Class', method: 'POSTINVOICE', limit: 100 });
    expect(JSON.parse(result.content[0].text)).toMatchObject([{
      sourceName: 'InvoiceCaller', targetName: 'InvoiceService', targetMethod: 'postInvoice', sourceLine: 42,
    }]);
  });
});

describe('did-you-mean suggestions', () => {
  it('suggests close indexed names when a table is not found', async () => {
    const res = await call('get_table_schema', { tableName: 'CustTabl' });
    expect(res.content[0].text).toContain('Did you mean: CustTable');
  });

  it('suggests by substring and does not suggest unrelated names', async () => {
    const res = await call('get_class_hierarchy', { className: 'SalesLine' });
    expect(res.content[0].text).toContain('SalesLineType');
    const none = await call('get_table_schema', { tableName: 'Zzzzzzzz' });
    expect(none.content[0].text).toBe('Table Zzzzzzzz not found.');
  });
});

describe('connection tuning', () => {
  it('applies read tuning pragmas on read-write and read-only connections', () => {
    const p = path.join(tmpDir, 'tuned.db');
    const rw = openDb(p);
    const pragma = (d: Database, n: string) => Object.values(d.prepare(`PRAGMA ${n}`).get() as Record<string, number>)[0];
    expect(pragma(rw, 'busy_timeout')).toBe(5000);
    expect(pragma(rw, 'cache_size')).toBe(-65536);
    rw.close();
    const ro = openDbReadOnly(p);
    expect(pragma(ro, 'busy_timeout')).toBe(5000);
    expect(pragma(ro, 'temp_store')).toBe(2);
    ro.close();
  });
});

describe('get_element_xml response budget', () => {
  it('truncates oversized XML with an explicit notice and honours a larger cap', async () => {
    const bigDb = seedDb([{ type: 'Table', name: 'BigOne', package: 'P', model: 'M', raw_xml: `<Table><Name>BigOne</Name>${'<F/>'.repeat(5000)}</Table>` }]);
    const t = collectMetadataTools(bigDb).get('get_element_xml')!;
    const capped = (await t({ name: 'BigOne', type: 'Table', maxChars: 1000 })).content[0].text;
    expect(capped).toContain('TRUNCATED: returned 1000 of');
    const full = (await t({ name: 'BigOne', type: 'Table', maxChars: 100000 })).content[0].text;
    expect(full).not.toContain('TRUNCATED');
    bigDb.close();
  });
});

describe('detail tool response budgets', () => {
  const fields = Array.from({ length: 30 }, (_, i) => ({ name: `F${i}`, type: 'String', edt: '', labelId: '', mandatory: false, allowEdit: true }));
  const wide = seedDb([{ type: 'Table', name: 'Wide', fields }]);
  const wideTools = collectMetadataTools(wide);

  it('keeps the shape when nothing is clipped and reports clipped lists', async () => {
    const full = JSON.parse((await wideTools.get('get_table_schema')!({ tableName: 'Wide' })).content[0].text);
    expect(full.fields).toHaveLength(30);
    expect(full).not.toHaveProperty('truncated');
    const clipped = JSON.parse((await wideTools.get('get_table_schema')!({ tableName: 'Wide', maxItems: 10 })).content[0].text);
    expect(clipped.fields).toHaveLength(10);
    expect(clipped.truncated).toEqual({ fields: { returned: 10, total: 30 } });
  });
});

describe('enum and query response budgets', () => {
  it('clips enum values and reports it', async () => {
    const d = seedDb([{ type: 'Enum', name: 'Big' }]);
    try {
      d.exec(`INSERT INTO ax_enum_values (object_id, name, value) SELECT o.id, 'V' || n.i, n.i FROM ax_objects o, (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 25) SELECT i FROM c) n WHERE o.name = 'Big'`);
      const t = collectMetadataTools(d).get('get_enum_values')!;
      expect(JSON.parse((await t({ enumName: 'Big' })).content[0].text).values).toHaveLength(25);
      const clipped = JSON.parse((await t({ enumName: 'Big', maxItems: 10 })).content[0].text);
      expect(clipped.values).toHaveLength(10);
      expect(clipped.truncated).toEqual({ values: { returned: 10, total: 25 } });
    } finally {
      d.close();
    }
  });
});
