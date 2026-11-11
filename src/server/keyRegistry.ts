import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { KEY_NAME_PATTERN, digestKey, generateAdminKey, generateApiKey, type RegistryKeys } from './apiKeys.js';

/**
 * The key registry: the developer keys and the admin key of a hosted server, kept as SHA-256 digests only, in one
 * JSON document in a file or an Azure blob (`keyRegistryFile.ts`, `keyRegistryBlob.ts`). Every replica reads it at
 * start and re-reads it when it changed, so a key created or revoked on one replica reaches the others within a
 * poll. Operator build only: the developer package never contains it (tests/packageBoundary.test.ts).
 */

const DIGEST = z.string().regex(/^[0-9a-f]{64}$/, 'must be a SHA-256 digest in hexadecimal');
const TIMESTAMP = z.string().datetime();

const documentSchema = z
  .object({
    version: z.literal(1),
    admin: z.object({ digest: DIGEST, createdAt: TIMESTAMP }).nullable(),
    keys: z.array(z.object({ name: z.string().regex(KEY_NAME_PATTERN, 'is not a valid key name'), digest: DIGEST, createdAt: TIMESTAMP })),
  })
  .superRefine((doc, ctx) => {
    const names = new Set<string>();
    const digests = new Set<string>(doc.admin ? [doc.admin.digest] : []);
    doc.keys.forEach((entry, index) => {
      if (names.has(entry.name)) ctx.addIssue({ code: 'custom', path: ['keys', index, 'name'], message: 'repeats another key name' });
      if (digests.has(entry.digest)) ctx.addIssue({ code: 'custom', path: ['keys', index, 'digest'], message: 'repeats another key' });
      names.add(entry.name);
      digests.add(entry.digest);
    });
  });

export type RegistryDocument = z.infer<typeof documentSchema>;
export type RegistryKind = 'file' | 'azure-blob';

/** A problem with the registry document or its store, worded to print as is. It never quotes a digest. */
export class KeyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyRegistryError';
  }
}

/** Another writer changed the document since it was read. */
export class KeyRegistryConflictError extends KeyRegistryError {
  constructor() {
    super('The key registry changed while it was being updated; try again.');
    this.name = 'KeyRegistryConflictError';
  }
}

export function emptyRegistryDocument(): RegistryDocument {
  return { version: 1, admin: null, keys: [] };
}

/** Parses the stored text; throws `KeyRegistryError` naming where the problem is, never a value. */
export function parseRegistryDocument(text: string): RegistryDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KeyRegistryError('The key registry is not valid JSON.');
  }
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'document'} ${issue.message}`);
    throw new KeyRegistryError(`The key registry is not valid: ${problems.join('; ')}.`);
  }
  return parsed.data;
}

/** Where the document lives. `version` is an opaque token: an ETag, or a file's modification time and size. */
export interface RegistryStore {
  readonly kind: RegistryKind;
  read(): Promise<{ document: RegistryDocument | null; version: string | null }>;
  /** Writes when the stored version still equals `expected` (null: there is none yet); else `KeyRegistryConflictError`. */
  write(document: RegistryDocument, expected: string | null): Promise<string>;
}

export interface KeyRegistry extends RegistryKeys {
  readonly kind: RegistryKind;
  adminDigest(): string | null;
  /** When the document was last read from the store, ISO; null before the first read. */
  loadedAt(): string | null;
  list(): Array<{ name: string; createdAt: string }>;
  /** Creates a developer key and returns it; it is not stored, only its digest. */
  createKey(name: string): Promise<string>;
  /** True when a key of that name was there. */
  revokeKey(name: string): Promise<boolean>;
  /** Replaces the admin key (creating the document when missing), keeps the developer keys, returns the new key. */
  resetAdmin(): Promise<string>;
  /** Re-reads the store now; the timer calls it every `pollMs`. Never throws. */
  checkNow(): Promise<void>;
  stop(): void;
}

export interface KeyRegistryOptions {
  /** How often to look for changes; 0 turns the timer off (tests call `checkNow`). Default 5000. */
  pollMs?: number;
  now?: () => Date;
}

const DEFAULT_REGISTRY_POLL_MS = 5_000;

/** Opens the registry: reads it once (failing when it cannot), then keeps it current. */
export async function createKeyRegistry(store: RegistryStore, options: KeyRegistryOptions = {}): Promise<KeyRegistry> {
  const now = options.now ?? (() => new Date());
  let document: RegistryDocument = emptyRegistryDocument();
  let version: string | null = null;
  let developerKeys: ReadonlyMap<string, string> = new Map();
  let loadedAt: string | null = null;
  let failing = false;
  const listeners = new Set<() => void>();

  const apply = (next: RegistryDocument, nextVersion: string | null): void => {
    const before = developerKeys;
    document = next;
    version = nextVersion;
    developerKeys = new Map(next.keys.map((entry) => [entry.digest, entry.name]));
    const changed = before.size !== developerKeys.size || [...before].some(([digest, name]) => developerKeys.get(digest) !== name);
    if (changed) {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          logger.error('A key registry listener failed', { error: String(error) });
        }
      }
    }
  };

  const load = async (): Promise<void> => {
    const read = await store.read();
    loadedAt = now().toISOString();
    if (read.version !== null && read.version === version) return;
    apply(read.document ?? emptyRegistryDocument(), read.version);
  };

  try {
    await load();
  } catch (error) {
    throw new KeyRegistryError(`The key registry cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** Applies `change` to the current document and writes it; on a conflict re-reads once and tries again. */
  const update = async <T>(change: (doc: RegistryDocument) => { next: RegistryDocument; result: T }): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const { next, result } = change(structuredClone(document));
      try {
        const written = await store.write(next, version);
        apply(next, written);
        return result;
      } catch (error) {
        if (!(error instanceof KeyRegistryConflictError) || attempt >= 2) throw error;
        await load();
      }
    }
  };

  const checkNow = async (): Promise<void> => {
    try {
      await load();
      if (failing) logger.info('The key registry can be read again');
      failing = false;
    } catch (error) {
      if (!failing) {
        logger.warn('The key registry could not be re-read; keeping the keys loaded before', {
          kind: store.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      failing = true;
    }
  };

  const pollMs = options.pollMs ?? DEFAULT_REGISTRY_POLL_MS;
  let timer: NodeJS.Timeout | null = null;
  if (pollMs > 0) {
    timer = setInterval(() => void checkNow(), pollMs);
    timer.unref();
  }

  return {
    kind: store.kind,
    developerKeys: () => developerKeys,
    adminDigest: () => document.admin?.digest ?? null,
    loadedAt: () => loadedAt,
    list: () => document.keys.map(({ name, createdAt }) => ({ name, createdAt })),
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async createKey(name) {
      if (!KEY_NAME_PATTERN.test(name)) {
        throw new KeyRegistryError("A key name must be 1-64 characters of letters, digits, '.', '_', '@' or '-'.");
      }
      const key = generateApiKey();
      return update((doc) => {
        if (doc.keys.some((entry) => entry.name === name)) {
          throw new KeyRegistryError(`${name} already has a key; revoke it first to issue a new one.`);
        }
        doc.keys.push({ name, digest: digestKey(key), createdAt: now().toISOString() });
        return { next: doc, result: key };
      });
    },
    async revokeKey(name) {
      return update((doc) => {
        const kept = doc.keys.filter((entry) => entry.name !== name);
        return { next: { ...doc, keys: kept }, result: kept.length !== doc.keys.length };
      });
    },
    async resetAdmin() {
      const key = generateAdminKey();
      return update((doc) => ({ next: { ...doc, admin: { digest: digestKey(key), createdAt: now().toISOString() } }, result: key }));
    },
    checkNow,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
