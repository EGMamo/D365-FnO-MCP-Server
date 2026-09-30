import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '../src/indexer/db.js';
import { collectLabelsTools, seedDb, type ToolResult } from './helpers/toolHarness.js';

let db: Database;
let tools: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>;

function call(name: string, args: Record<string, unknown> = {}) {
  const handler = tools.get(name);
  if (!handler) throw new Error(`Tool ${name} not registered`);
  return handler(args);
}

beforeAll(() => {
  db = seedDb(
    [{ type: 'Table', name: 'CustTable' }],
    [
      { labelId: 'SYS1', value: 'Customer account', language: 'en-US' },
      { labelId: 'SYS1', value: 'Kundenkonto', language: 'de' },
      { labelId: 'SYS2', value: 'Sales order line', language: 'en-US' },
      { labelId: 'SYS3', value: '100% done', language: 'en-US' },
      { labelId: 'SYS4', value: 'Customer group', language: 'en-US' },
    ]
  );
  tools = collectLabelsTools(db);
});

afterAll(() => {
  db.close();
});

describe('resolve_label_by_language', () => {
  it('picks the en-US value when other languages share the label id', async () => {
    const res = await call('resolve_label_by_language', { labelId: 'SYS1', language: 'en-US' });
    expect(res.content[0].text).toBe('Customer account');
  });

  it('resolves a non-default language and strips a leading @', async () => {
    const res = await call('resolve_label_by_language', { labelId: '@SYS1', language: 'de' });
    expect(res.content[0].text).toBe('Kundenkonto');
  });

  it('returns "not found" for an unknown language', async () => {
    const res = await call('resolve_label_by_language', { labelId: 'SYS1', language: 'fr' });
    expect(res.content[0].text).toBe('not found');
  });
});

describe('search_labels', () => {
  it('treats % and _ in the query as literal text', async () => {
    const percent = JSON.parse((await call('search_labels', { query: '%', limit: 20 })).content[0].text) as { label_id: string }[];
    expect(percent.map((h) => h.label_id)).toEqual(['SYS3']);
    expect(JSON.parse((await call('search_labels', { query: '_', limit: 20 })).content[0].text)).toEqual([]);
  });
});

describe('search_labels_fts', () => {
  it('finds labels by value across languages', async () => {
    const res = await call('search_labels_fts', { query: 'Customer', limit: 20 });
    const hits = JSON.parse(res.content[0].text);
    expect(hits.map((h: { label_id: string }) => h.label_id)).toContain('SYS1');
  });

  it('filters by language', async () => {
    const res = await call('search_labels_fts', { query: 'Kundenkonto', language: 'en-US', limit: 20 });
    expect(JSON.parse(res.content[0].text)).toEqual([]);
  });

  it('respects the limit', async () => {
    const res = await call('search_labels_fts', { query: 'Customer', limit: 1 });
    expect(JSON.parse(res.content[0].text)).toHaveLength(1);
  });
});

describe('resolve_label', () => {
  it('prefers the en-US text and accepts the label file forms', async () => {
    const local = seedDb([], [
      { labelId: 'SYS1', value: 'Kundenkonto', language: 'de' },
      { labelId: 'SYS1', value: 'Customer account', language: 'en-US' },
      { labelId: 'MyLabels:Greeting', value: 'Hello', language: 'en-US' },
      { labelId: 'SYS:SYS7', value: 'Written without @', language: 'en-US' },
    ]);
    const localTools = collectLabelsTools(local);
    const resolve = async (labelId: string) => (await localTools.get('resolve_label')!({ labelId })).content[0].text;
    try {
      expect(await resolve('@SYS1')).toBe('Customer account');
      expect(await resolve('@MyLabels:Greeting')).toBe('Hello');
      expect(await resolve('@SYS7')).toBe('Written without @');
      expect(await resolve('@Greeting')).toBe('Label not found');
    } finally {
      local.close();
    }
  });
});
