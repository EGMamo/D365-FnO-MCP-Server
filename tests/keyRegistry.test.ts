import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digestKey, generateAdminKey, generateApiKey } from '../src/server/apiKeys.js';
import {
  KeyRegistryConflictError,
  KeyRegistryError,
  createKeyRegistry,
  emptyRegistryDocument,
  parseRegistryDocument,
  type RegistryStore,
} from '../src/server/keyRegistry.js';
import { createFileRegistryStore } from '../src/server/keyRegistryFile.js';
import { createBlobRegistryStore, type RegistryBlob } from '../src/server/keyRegistryBlob.js';
import { logger } from '../src/utils/logger.js';

const NOW = '2026-11-08T10:00:00.000Z';

describe('keys', () => {
  it('makes a 64-hex developer key and an adm_ admin key, and digests them with SHA-256', () => {
    expect(generateApiKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateAdminKey()).toMatch(/^adm_[0-9a-f]{64}$/);
    expect(generateApiKey()).not.toBe(generateApiKey());
    expect(digestKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('parseRegistryDocument', () => {
  const digest = 'a'.repeat(64);

  it('accepts a valid document and an empty one', () => {
    const doc = { version: 1, admin: { digest, createdAt: NOW }, keys: [{ name: 'alice', digest: 'b'.repeat(64), createdAt: NOW }] };
    expect(parseRegistryDocument(JSON.stringify(doc))).toEqual(doc);
    expect(parseRegistryDocument(JSON.stringify(emptyRegistryDocument()))).toEqual({ version: 1, admin: null, keys: [] });
  });

  it.each([
    ['not JSON', '{'],
    ['a wrong version', JSON.stringify({ version: 2, admin: null, keys: [] })],
    ['a bad name', JSON.stringify({ version: 1, admin: null, keys: [{ name: 'a b', digest, createdAt: NOW }] })],
    ['a bad digest', JSON.stringify({ version: 1, admin: null, keys: [{ name: 'a', digest: 'xyz', createdAt: NOW }] })],
    ['a repeated name', JSON.stringify({ version: 1, admin: null, keys: [{ name: 'a', digest, createdAt: NOW }, { name: 'a', digest: 'c'.repeat(64), createdAt: NOW }] })],
    ['a repeated digest', JSON.stringify({ version: 1, admin: null, keys: [{ name: 'a', digest, createdAt: NOW }, { name: 'b', digest, createdAt: NOW }] })],
    ['the admin digest reused by a key', JSON.stringify({ version: 1, admin: { digest, createdAt: NOW }, keys: [{ name: 'a', digest, createdAt: NOW }] })],
  ])('refuses %s without quoting a digest', (_label, text) => {
    let error: unknown;
    try {
      parseRegistryDocument(text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(KeyRegistryError);
    expect(String((error as Error).message)).not.toContain(digest);
  });
});

describe('file registry store', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'key-registry-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads a missing file as no document, creates it owner-only, and refuses a stale version', async () => {
    const file = path.join(root, 'nested', 'keys.json');
    const store = createFileRegistryStore(file);
    expect(store.kind).toBe('file');
    expect(await store.read()).toEqual({ document: null, version: null });

    const first = await store.write(emptyRegistryDocument(), null);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const read = await store.read();
    expect(read.document).toEqual(emptyRegistryDocument());
    expect(read.version).toBe(first);

    await expect(store.write(emptyRegistryDocument(), null)).rejects.toBeInstanceOf(KeyRegistryConflictError);
    // Someone else wrote in between: the version the caller holds is stale.
    const other = { ...emptyRegistryDocument(), keys: [{ name: 'x', digest: 'd'.repeat(64), createdAt: NOW }] };
    await new Promise((resolve) => setTimeout(resolve, 15));
    await store.write(other, first);
    await expect(store.write(emptyRegistryDocument(), first)).rejects.toBeInstanceOf(KeyRegistryConflictError);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['keys.json']);
  });
});

describe('blob registry store', () => {
  /** An in-memory blob with ETags and the two conditions the store uses. */
  function fakeBlob(): RegistryBlob & { body: string | null; etag: number } {
    const blob = {
      body: null as string | null,
      etag: 0,
      async download() {
        return blob.body === null ? null : { body: blob.body, etag: `"${blob.etag}"` };
      },
      async upload(body: string, condition: { ifMatch?: string; ifNoneMatch?: '*' }) {
        if (condition.ifNoneMatch === '*' && blob.body !== null) return 'conflict' as const;
        if (condition.ifMatch !== undefined && condition.ifMatch !== `"${blob.etag}"`) return 'conflict' as const;
        blob.body = body;
        blob.etag += 1;
        return { etag: `"${blob.etag}"` };
      },
    };
    return blob;
  }

  it('creates with If-None-Match, updates with If-Match, and reports a conflict', async () => {
    const blob = fakeBlob();
    const store = createBlobRegistryStore(blob);
    expect(store.kind).toBe('azure-blob');
    expect(await store.read()).toEqual({ document: null, version: null });
    const v1 = await store.write(emptyRegistryDocument(), null);
    await expect(store.write(emptyRegistryDocument(), null)).rejects.toBeInstanceOf(KeyRegistryConflictError);
    const v2 = await store.write(emptyRegistryDocument(), v1);
    expect(v2).not.toBe(v1);
    await expect(store.write(emptyRegistryDocument(), v1)).rejects.toBeInstanceOf(KeyRegistryConflictError);
    expect((await store.read()).version).toBe(v2);
  });
});

/** A store held in memory, with a counter of reads and a switch to make reads fail. */
function memoryStore(): RegistryStore & { text: string | null; reads: number; failReads: boolean; tag: number } {
  const store = {
    kind: 'file' as const,
    text: null as string | null,
    tag: 0,
    reads: 0,
    failReads: false,
    async read() {
      store.reads += 1;
      if (store.failReads) throw new Error('disk on fire');
      return store.text === null
        ? { document: null, version: null }
        : { document: parseRegistryDocument(store.text), version: String(store.tag) };
    },
    async write(document: unknown, expected: string | null) {
      const current = store.text === null ? null : String(store.tag);
      if (current !== expected) throw new KeyRegistryConflictError();
      store.text = JSON.stringify(document);
      store.tag += 1;
      return String(store.tag);
    },
  };
  return store;
}

describe('createKeyRegistry', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads at start, then adds, lists and revokes keys and resets the admin key', async () => {
    const store = memoryStore();
    const registry = await createKeyRegistry(store, { pollMs: 0, now: () => new Date(NOW) });
    expect(registry.adminDigest()).toBeNull();
    expect(registry.loadedAt()).toBe(NOW);

    const admin = await registry.resetAdmin();
    expect(admin).toMatch(/^adm_/);
    expect(registry.adminDigest()).toBe(digestKey(admin));

    const created = await registry.createKey('alice');
    expect(created).toMatch(/^[0-9a-f]{64}$/);
    expect(registry.developerKeys().get(digestKey(created))).toBe('alice');
    expect(registry.list()).toEqual([{ name: 'alice', createdAt: NOW }]);
    await expect(registry.createKey('alice')).rejects.toThrow('alice already has a key');
    await expect(registry.createKey('a b')).rejects.toThrow(/name/);

    // Resetting the admin key keeps the developer keys.
    await registry.resetAdmin();
    expect(registry.developerKeys().size).toBe(1);

    expect(await registry.revokeKey('alice')).toBe(true);
    expect(await registry.revokeKey('alice')).toBe(false);
    expect(registry.developerKeys().size).toBe(0);
    registry.stop();
  });

  it('applies a change another replica made on the next check, and tells its listeners', async () => {
    const store = memoryStore();
    const one = await createKeyRegistry(store, { pollMs: 0 });
    const two = await createKeyRegistry(store, { pollMs: 0 });
    const changed = vi.fn();
    two.onChange(changed);

    const key = await one.createKey('bob');
    expect(two.developerKeys().size).toBe(0);
    await two.checkNow();
    expect(two.developerKeys().get(digestKey(key))).toBe('bob');
    expect(changed).toHaveBeenCalledTimes(1);

    // An unchanged version is not read into a new list and fires nothing.
    await two.checkNow();
    expect(changed).toHaveBeenCalledTimes(1);
    one.stop();
    two.stop();
  });

  it('retries a write that lost a race once, on the fresh document', async () => {
    const store = memoryStore();
    const one = await createKeyRegistry(store, { pollMs: 0 });
    const two = await createKeyRegistry(store, { pollMs: 0 });
    await one.createKey('first');
    // two still holds the old version; its write conflicts, it re-reads and keeps both keys.
    await two.createKey('second');
    await one.checkNow();
    expect([...one.developerKeys().values()].sort()).toEqual(['first', 'second']);
  });

  it('keeps the previous keys when a reload fails, with one warning that names no key', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const store = memoryStore();
    const registry = await createKeyRegistry(store, { pollMs: 0 });
    const key = await registry.createKey('carol');
    store.failReads = true;
    await registry.checkNow();
    await registry.checkNow();
    expect(registry.developerKeys().get(digestKey(key))).toBe('carol');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(digestKey(key));
    store.failReads = false;
    store.text = '{ broken';
    store.tag += 1;
    await registry.checkNow();
    expect(registry.developerKeys().size).toBe(1);
  });

  it('fails to start when the store cannot be read, naming the problem', async () => {
    const store = memoryStore();
    store.failReads = true;
    await expect(createKeyRegistry(store, { pollMs: 0 })).rejects.toThrow('The key registry cannot be read: disk on fire');
  });

  it('polls on an unref\'d timer and stops', async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStore();
      const registry = await createKeyRegistry(store, { pollMs: 5000 });
      const before = store.reads;
      await vi.advanceTimersByTimeAsync(5000);
      expect(store.reads).toBe(before + 1);
      registry.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(store.reads).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
