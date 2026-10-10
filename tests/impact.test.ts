import { describe, it, expect } from 'vitest';
import { openDb, upsertObject, type Database, type XrefInput } from '../src/indexer/db.js';
import { analyzeImpact } from '../src/tools/impact.js';
import { collectMetadataTools } from './helpers/toolHarness.js';

function obj(db: Database, type: string, name: string) {
  upsertObject(db, { type, name, package: 'P', model: 'M', file_path: `/f/${name}.xml`, raw_xml: null, file_mtime: 1 });
}

function upsertXrefs(db: Database, xrefs: XrefInput[]) {
  const stmt = db.prepare('INSERT INTO ax_xref (from_type, from_name, to_type, to_name, xref_kind) VALUES (?, ?, ?, ?, ?)');
  for (const x of xrefs) stmt.run(x.fromType, x.fromName, x.toType, x.toName, x.xrefKind);
}

function setup() {
  const db = openDb(':memory:');
  for (const [t, n] of [['Table', 'CustTable'], ['TableExtension', 'CustTable.X'], ['Form', 'CustForm'], ['Query', 'CustQ'], ['Class', 'A']] as const) obj(db, t, n);
  upsertXrefs(db, [
    { fromType: 'TableExtension', fromName: 'CustTable.X', toType: 'Table', toName: 'CustTable', xrefKind: 'extends' },
    { fromType: 'Form', fromName: 'CustForm', toType: 'Table', toName: 'CustTable', xrefKind: 'datasource' },
    { fromType: 'Query', fromName: 'CustQ', toType: 'Table', toName: 'CustTable', xrefKind: 'datasource' },
    { fromType: 'Class', fromName: 'A', toType: 'Form', toName: 'CustForm', xrefKind: 'uses' },
    // cycle back to the root must not loop
    { fromType: 'Table', fromName: 'CustTable', toType: 'Class', toName: 'A', xrefKind: 'uses' },
  ]);
  return db;
}

describe('analyzeImpact', () => {
  it('walks dependents transitively by depth, case-insensitively, visiting cycles once', () => {
    const r = analyzeImpact(setup(), 'custtable', 'Table', 3, 100)!;
    expect(r.root.name).toBe('CustTable');
    expect(r.levels[0].items.map((i) => i.name).sort()).toEqual(['CustForm', 'CustQ', 'CustTable.X']);
    expect(r.levels[1].items).toEqual([{ type: 'Class', name: 'A', via: 'uses', dependsOn: 'Form:CustForm' }]);
    expect(r.totals).toEqual({ objects: 4, byType: { TableExtension: 1, Form: 1, Query: 1, Class: 1 } });
    expect(r.truncated).toBe(false);
  });

  it('honours maxDepth and flags truncation at the limit', () => {
    const db = setup();
    expect(analyzeImpact(db, 'CustTable', 'Table', 1, 100)!.totals.objects).toBe(3);
    const capped = analyzeImpact(db, 'CustTable', 'Table', 3, 2)!;
    expect(capped.totals.objects).toBe(2);
    expect(capped.truncated).toBe(true);
    expect(analyzeImpact(db, 'CustTable', 'Table', 1, 3)!.truncated).toBe(false);
  });

  it('returns null for unknown roots and suggests names through the tool', async () => {
    const db = setup();
    expect(analyzeImpact(db, 'Nope', 'Table', 2, 10)).toBeNull();
    const res = await collectMetadataTools(db).get('analyze_impact')!({ name: 'CustTabl', type: 'Table' });
    expect(res.content[0].text).toContain('Did you mean: CustTable');
  });
});

describe('search_symbols explain', () => {
  it('labels each hit with why it matched and leaves default output unchanged', async () => {
    const db = openDb(':memory:');
    for (const n of ['Cust', 'CustTable', 'MyCustTable']) obj(db, 'Table', n);
    db.exec(`INSERT INTO ax_fts(rowid, name, type, package) SELECT id, name, type, package FROM ax_objects`);
    const search = collectMetadataTools(db).get('search_symbols')!;
    const plain = JSON.parse((await search({ query: 'Cust', limit: 10 })).content[0].text);
    expect(plain[0]).not.toHaveProperty('match');
    const explained = JSON.parse((await search({ query: 'Cust', limit: 10, explain: true })).content[0].text);
    const byName = Object.fromEntries(explained.map((h: { name: string; match: string }) => [h.name, h.match]));
    expect(byName.Cust).toBe('exact');
    expect(byName.CustTable).toBe('prefix');
    expect(explained[0].explanation).toContain('exact');
    db.close();
  });
});
