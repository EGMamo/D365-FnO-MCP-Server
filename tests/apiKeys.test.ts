import { describe, it, expect } from 'vitest';
import { describeApiKeys, parseApiKeys } from '../src/server/apiKeys.js';

const key = (char: string) => char.repeat(40);

describe('parseApiKeys', () => {
  it('reports the legacy MCP_API_KEY under the name default', () => {
    const parsed = parseApiKeys(undefined, key('a'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.keys).toEqual([{ name: 'default', key: key('a') }]);
  });

  it('parses several named entries', () => {
    const parsed = parseApiKeys(`alice=${key('a')}, bob=${key('b')}`, undefined);
    expect(parsed.errors).toEqual([]);
    expect(parsed.keys.map((entry) => entry.name)).toEqual(['alice', 'bob']);
    expect(describeApiKeys(parsed.keys)).toBe('alice, bob');
  });

  it('combines MCP_API_KEYS with the legacy key', () => {
    const parsed = parseApiKeys(`alice=${key('a')}`, key('z'));
    expect(parsed.keys.map((entry) => entry.name)).toEqual(['alice', 'default']);
  });

  it('names the entry with a short key without echoing the value', () => {
    const parsed = parseApiKeys(`alice=${key('a')},bob=tooshort`, undefined);
    expect(parsed.keys.map((entry) => entry.name)).toEqual(['alice']);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("'bob'");
    expect(parsed.errors[0]).not.toContain('tooshort');
  });

  it('rejects the placeholder key older .env.example files shipped', () => {
    const parsed = parseApiKeys(undefined, 'change-me-to-a-strong-random-secret-min-32-chars');
    expect(parsed.keys).toEqual([]);
    expect(parsed.errors[0]).toMatch(/placeholder/);
  });

  it('rejects duplicate names and duplicate keys', () => {
    const names = parseApiKeys(`a=${key('a')},a=${key('b')}`, undefined);
    expect(names.errors[0]).toMatch(/duplicate name 'a'/);
    const keys = parseApiKeys(`a=${key('a')},b=${key('a')}`, undefined);
    expect(keys.errors[0]).toMatch(/key for 'b' duplicates/);
    expect(keys.keys).toHaveLength(1);
  });

  it('keeps a key that itself contains an equals sign', () => {
    const parsed = parseApiKeys(`svc=${key('x')}=tail`, undefined);
    expect(parsed.keys[0].key).toBe(`${key('x')}=tail`);
  });

  it('ignores blank entries, newlines and surrounding whitespace', () => {
    const parsed = parseApiKeys(`\n a=${key('a')} \n\n,b=${key('b')},\n`, undefined);
    expect(parsed.errors).toEqual([]);
    expect(parsed.keys.map((entry) => entry.name)).toEqual(['a', 'b']);
  });

  it('rejects a legacy key when an explicit default entry exists', () => {
    const parsed = parseApiKeys(`default=${key('a')}`, key('b'));
    expect(parsed.errors[0]).toMatch(/MCP_API_KEY: duplicate name 'default'/);
  });

  it('rejects malformed entries and invalid names', () => {
    expect(parseApiKeys('nokey', undefined).errors[0]).toMatch(/expected the form name=key/);
    expect(parseApiKeys(`=${key('a')}`, undefined).errors[0]).toMatch(/expected the form name=key/);
    expect(parseApiKeys(`bad name=${key('a')}`, undefined).errors[0]).toMatch(/name 'bad name'/);
  });

  it('returns nothing for empty input', () => {
    expect(parseApiKeys('', '')).toEqual({ keys: [], errors: [] });
    expect(parseApiKeys(undefined, undefined)).toEqual({ keys: [], errors: [] });
  });
});
