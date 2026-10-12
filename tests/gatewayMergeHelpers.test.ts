import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  containsPrivateName,
  dedupeAcrossSides,
  dedupeBy,
  errorResult,
  isMiss,
  jsonResult,
  parsePayload,
  rankSearchHits,
  sanitizeReason,
  tag,
  textResult,
  warningsOf,
  withWarnings,
} from '../src/gateway/merge.js';

const text = (value: string) => ({ type: 'text' as const, text: value });
const result = (...items: string[]): CallToolResult => ({ content: items.map(text) });

describe('parsePayload', () => {
  it('parses the first text item as JSON', () => {
    const parsed = parsePayload(result('[{"name":"CustTable"}]'));
    expect(parsed.json).toEqual([{ name: 'CustTable' }]);
    expect(parsed.text).toBe('[{"name":"CustTable"}]');
    expect(parsed.extras).toEqual([]);
  });

  it('treats plain text such as a not-found message as a miss', () => {
    const parsed = parsePayload(result('Table Foo not found. Did you mean: Bar? (use search_symbols to browse)'));
    expect(parsed.json).toBeUndefined();
    expect(parsed.text).toContain('not found');
  });

  it('keeps later items as extras and never parses them', () => {
    const knowledge = text('{"knowledge":{"hints":["use find_usages"]}}');
    const parsed = parsePayload({ content: [text('{"ok":true}'), knowledge] });
    expect(parsed.json).toEqual({ ok: true });
    expect(parsed.extras).toEqual([knowledge]);
  });

  it('parses only the first text item even when it is not JSON and a later one is', () => {
    const parsed = parsePayload(result('not found', '{"knowledge":1}'));
    expect(parsed.json).toBeUndefined();
    expect(parsed.extras).toEqual([text('{"knowledge":1}')]);
  });

  it('skips a leading non-text item and keeps it as an extra', () => {
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
    const parsed = parsePayload({ content: [image, text('{"a":1}')] });
    expect(parsed.json).toEqual({ a: 1 });
    expect(parsed.extras).toEqual([image]);
  });

  it('handles a result without text or content', () => {
    expect(parsePayload({ content: [] })).toEqual({ json: undefined, text: '', extras: [] });
    const parsed = parsePayload({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    expect(parsed.json).toBeUndefined();
    expect(parsed.extras).toHaveLength(1);
    expect(parsePayload({} as CallToolResult).extras).toEqual([]);
  });
});

describe('isMiss', () => {
  it('is false for any JSON payload, including an empty list', () => {
    expect(isMiss(result('[]'))).toBe(false);
    expect(isMiss(result('{"a":1}'))).toBe(false);
  });

  it('is true for plain text, an error and an empty result', () => {
    expect(isMiss(result('not found'))).toBe(true);
    expect(isMiss({ content: [text('[{"a":1}]')], isError: true })).toBe(true);
    expect(isMiss({ content: [] })).toBe(true);
  });
});

describe('tag', () => {
  it('marks rows with their source without changing the input', () => {
    const rows = [{ name: 'A', type: 'Table' }];
    expect(tag(rows, 'hosted')).toEqual([{ name: 'A', type: 'Table', source: 'hosted' }]);
    expect(rows).toEqual([{ name: 'A', type: 'Table' }]);
  });

  it('drops the numeric id of local rows only', () => {
    expect(tag([{ id: 7, name: 'A' }], 'local')).toEqual([{ name: 'A', source: 'local' }]);
    expect(tag([{ id: 7, name: 'A' }], 'hosted')).toEqual([{ id: 7, name: 'A', source: 'hosted' }]);
    expect(tag([{ id: 'x', name: 'A' }], 'local')).toEqual([{ id: 'x', name: 'A', source: 'local' }]);
  });

  it('leaves out entries that are not objects', () => {
    expect(tag(['Contoso', null, 3, ['a'], { name: 'A' }], 'local')).toEqual([{ name: 'A', source: 'local' }]);
  });
});

describe('dedupeBy', () => {
  const key = (row: { name: string; type: string }) => `${row.type}:${row.name.toLowerCase()}`;

  it('keeps the local row and flags that it shadows a hosted one', () => {
    const rows = [
      { name: 'CustTable', type: 'Table', source: 'local' },
      { name: 'custtable', type: 'Table', source: 'hosted' },
      { name: 'SalesTable', type: 'Table', source: 'hosted' },
    ];
    expect(dedupeBy(rows, key)).toEqual([
      { name: 'CustTable', type: 'Table', source: 'local', shadowedHosted: true },
      { name: 'SalesTable', type: 'Table', source: 'hosted' },
    ]);
  });

  it('lets a later local row replace an earlier hosted one at the earlier position', () => {
    const rows = [
      { name: 'A', type: 'Table', source: 'hosted' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'A', type: 'Table', source: 'local' },
    ];
    expect(dedupeBy(rows, key)).toEqual([
      { name: 'A', type: 'Table', source: 'local', shadowedHosted: true },
      { name: 'B', type: 'Table', source: 'hosted' },
    ]);
  });

  it('does not flag rows that have no hosted twin or repeat within one side', () => {
    const rows = [
      { name: 'A', type: 'Table', source: 'local' },
      { name: 'A', type: 'Table', source: 'local' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'A', type: 'Class', source: 'hosted' },
    ];
    expect(dedupeBy(rows, key)).toEqual([
      { name: 'A', type: 'Table', source: 'local' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'A', type: 'Class', source: 'hosted' },
    ]);
  });

  it('does not change the rows it is given', () => {
    const local = { name: 'A', type: 'Table', source: 'local' };
    dedupeBy([local, { name: 'A', type: 'Table', source: 'hosted' }], key);
    expect(local).toEqual({ name: 'A', type: 'Table', source: 'local' });
  });
});

describe('dedupeAcrossSides', () => {
  const key = (row: { name: string; type: string }) => `${row.type}:${row.name.toLowerCase()}`;

  it('drops a hosted row that has a local twin and flags the local row, whatever the order', () => {
    const rows = [
      { name: 'A', type: 'Table', source: 'hosted' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'a', type: 'Table', source: 'local' },
    ];
    expect(dedupeAcrossSides(rows, key)).toEqual([
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'a', type: 'Table', source: 'local', shadowedHosted: true },
    ]);
  });

  it('keeps rows an index repeats within one side, which dedupeBy would collapse', () => {
    const rows = [
      { name: 'A', type: 'Table', source: 'local' },
      { name: 'A', type: 'Table', source: 'local' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'B', type: 'Table', source: 'hosted' },
      { name: 'A', type: 'Class', source: 'hosted' },
    ];
    expect(dedupeAcrossSides(rows, key)).toEqual(rows);
    expect(dedupeBy(rows, key)).toHaveLength(3);
  });

  it('flags every local row that hides a hosted twin, and does not change the rows it is given', () => {
    const local = [
      { name: 'A', type: 'Table', source: 'local' },
      { name: 'A', type: 'Table', source: 'local' },
    ];
    const merged = dedupeAcrossSides([...local, { name: 'A', type: 'Table', source: 'hosted' }], key);
    expect(merged).toEqual(local.map((row) => ({ ...row, shadowedHosted: true })));
    expect(local[0]).toEqual({ name: 'A', type: 'Table', source: 'local' });
  });
});

describe('rankSearchHits', () => {
  const hit = (name: string, source: 'local' | 'hosted', extra: Record<string, unknown> = {}) => ({
    name,
    type: 'Table',
    package: 'Pkg',
    source,
    ...extra,
  });

  it('orders exact, prefix, substring, then token matches', () => {
    const ranked = rankSearchHits('cust', [
      hit('SalesLine', 'hosted'),
      hit('BankCustomer', 'hosted'),
      hit('CustTable', 'hosted'),
      hit('Cust', 'hosted'),
    ]);
    expect(ranked.map((row) => row.name)).toEqual(['Cust', 'CustTable', 'BankCustomer', 'SalesLine']);
  });

  it('puts a local row before a hosted row of the same class', () => {
    const ranked = rankSearchHits('Cust', [
      hit('CustGroup', 'hosted'),
      hit('CustTable', 'hosted'),
      hit('ContosoCust', 'local'),
      hit('CustContoso', 'local'),
    ]);
    expect(ranked.map((row) => row.name)).toEqual(['CustContoso', 'CustGroup', 'CustTable', 'ContosoCust']);
  });

  it('keeps the incoming order within a class and side', () => {
    const rows = ['Cust3', 'Cust1', 'Cust2'].map((name) => hit(name, 'hosted'));
    expect(rankSearchHits('cust', rows).map((row) => row.name)).toEqual(['Cust3', 'Cust1', 'Cust2']);
  });

  it('matches exact names case-insensitively and does not modify its input', () => {
    const rows = [hit('CustTable', 'hosted'), hit('CUSTTABLE', 'local')];
    const ranked = rankSearchHits('custtable', rows);
    expect(ranked.map((row) => row.source)).toEqual(['local', 'hosted']);
    expect(rows.map((row) => row.source)).toEqual(['hosted', 'local']);
  });

  it('copes with rows that lack a name', () => {
    const ranked = rankSearchHits('cust', [{ source: 'hosted' }, hit('Cust', 'hosted')]);
    expect(ranked[0]).toMatchObject({ name: 'Cust' });
    expect(ranked).toHaveLength(2);
  });
});

describe('withWarnings and result builders', () => {
  const gateway = (warnings: string[]) => text(JSON.stringify({ gateway: { warnings } }));

  it('appends one trailing gateway item after the extras', () => {
    const knowledge = text('{"knowledge":1}');
    const out = withWarnings({ content: [text('[1]'), knowledge] }, ['hosted unavailable: timeout']);
    expect(out.content).toEqual([text('[1]'), knowledge, gateway(['hosted unavailable: timeout'])]);
  });

  it('returns the result as it is when there is nothing to say', () => {
    const original = result('[1]');
    expect(withWarnings(original, [])).toBe(original);
    expect(withWarnings(original, [''])).toBe(original);
  });

  it('extends its own item instead of adding a second one, once per warning', () => {
    const once = withWarnings(result('[1]'), ['a']);
    const twice = withWarnings(once, ['a', 'b', 'b']);
    expect(twice.content).toEqual([text('[1]'), gateway(['a', 'b'])]);
    expect(withWarnings(twice, ['b'])).toBe(twice);
    expect(warningsOf(twice)).toEqual(['a', 'b']);
  });

  it('keeps isError and does not change the input', () => {
    const failed: CallToolResult = { content: [text('boom')], isError: true };
    const out = withWarnings(failed, ['w']);
    expect(out.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
  });

  it('does not mistake a payload that merely mentions gateway for a warning item', () => {
    const payload = text(JSON.stringify({ gateway: { warnings: ['x'], other: 1 } }));
    expect(warningsOf({ content: [payload] })).toEqual([]);
    expect(warningsOf(result('plain'))).toEqual([]);
    expect(warningsOf({ content: [] })).toEqual([]);
  });

  it('builds json, text and error results', () => {
    const extra = text('{"knowledge":1}');
    expect(jsonResult([{ a: 1 }])).toEqual({ content: [text('[{"a":1}]')] });
    expect(jsonResult({ a: 1 }, [extra], ['w']).content).toEqual([text('{"a":1}'), extra, gateway(['w'])]);
    expect(jsonResult(undefined).content).toEqual([text('null')]);
    expect(textResult('hello', [extra], ['w']).content).toEqual([text('hello'), extra, gateway(['w'])]);
    expect(errorResult('nope')).toEqual({ content: [text('nope')], isError: true });
  });
});

describe('containsPrivateName', () => {
  const prefixes = ['Contoso', 'zz'];

  it('matches identifier tokens by prefix, ignoring case', () => {
    expect(containsPrivateName({ tableName: 'ContosoCustTable' }, prefixes)).toBe(true);
    expect(containsPrivateName({ tableName: 'contosocusttable' }, prefixes)).toBe(true);
    expect(containsPrivateName({ name: 'ZZ_Helper' }, prefixes)).toBe(true);
  });

  it('finds the token inside longer text, dotted names and label ids', () => {
    expect(containsPrivateName({ query: 'find the Contoso customer' }, prefixes)).toBe(true);
    expect(containsPrivateName({ name: 'CustTable.Contoso' }, prefixes)).toBe(true);
    expect(containsPrivateName({ labelId: '@Contoso:Hello' }, prefixes)).toBe(true);
  });

  it('does not match a token that merely contains the prefix', () => {
    expect(containsPrivateName({ name: 'NotContosoTable', query: 'Fizzy' }, prefixes)).toBe(false);
    expect(containsPrivateName({ name: 'CustTable' }, prefixes)).toBe(false);
  });

  it('scans nested objects and arrays but not keys, numbers or booleans', () => {
    expect(containsPrivateName({ fields: [{ name: 'Ok' }, { edt: 'ContosoAmount' }] }, prefixes)).toBe(true);
    expect(containsPrivateName({ ContosoKey: 'value', n: 1, flag: true, nothing: null }, prefixes)).toBe(false);
    expect(containsPrivateName(['a', ['b', ['Contoso']]], prefixes)).toBe(true);
  });

  it('is false without prefixes and ignores blank prefixes', () => {
    expect(containsPrivateName({ name: 'ContosoX' }, [])).toBe(false);
    expect(containsPrivateName({ name: 'Anything' }, ['', '  '])).toBe(false);
  });

  it('treats absurdly deep values as private', () => {
    let nested: unknown = 'harmless';
    for (let depth = 0; depth < 40; depth += 1) nested = { next: nested };
    expect(containsPrivateName(nested, prefixes)).toBe(true);
  });
});

describe('sanitizeReason', () => {
  it('removes urls, credentials, paths and long tokens', () => {
    const reason = sanitizeReason(
      new Error(
        "fetch https://user:pw@hosted.example.com/mcp?key=abc failed; Authorization: Bearer abcdef.ghijkl; open '/home/dev/Secret/CustomModels/x.xml' and C:\\Users\\dev\\proj\\x.xml, key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      )
    );
    expect(reason).not.toMatch(/hosted\.example|user:pw|abcdef|\/home\/dev|Secret|C:\\|AAAAAAAA/);
    expect(reason).toContain('<url>');
    expect(reason).toContain('<path>');
  });

  it('keeps a short, ordinary reason and flattens whitespace', () => {
    expect(sanitizeReason(new Error('connect ECONNREFUSED 127.0.0.1:3000\n  at x'))).toBe('connect ECONNREFUSED 127.0.0.1:3000 at x');
    expect(sanitizeReason('application/json parse error')).toBe('application/json parse error');
  });

  it('caps the length and names an unknown error', () => {
    expect(sanitizeReason(new Error('x '.repeat(500))).length).toBeLessThanOrEqual(200);
    expect(sanitizeReason(undefined)).toBe('unknown error');
    expect(sanitizeReason(new Error(''))).toBe('unknown error');
  });
});
