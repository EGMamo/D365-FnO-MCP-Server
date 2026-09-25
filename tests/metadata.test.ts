import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '../src/indexer/db.js';
import fs from 'fs';
import path from 'path';
import { collectMetadataTools, seedDb, type ToolResult } from './helpers/toolHarness.js';

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

  it('reports the snapshot provenance instead of scanning files on a hosted server', async () => {
    const published = {
      manifestUrl: 'https://acct.blob.core.windows.net/indexes/latest/manifest.json',
      syncedAt: '2026-09-26T01:00:00.000Z',
      builtAt: '2026-09-25T20:00:00.000Z',
      version: '20260925T200000Z-abcdef01',
    };
    const hosted = collectMetadataTools(db, { published });
    const handler = hosted.get('get_index_staleness');
    if (!handler) throw new Error('get_index_staleness not registered');
    const report = JSON.parse((await handler({ limit: 100 })).content[0].text);
    expect(report).toMatchObject({ mode: 'published', ...published });
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
