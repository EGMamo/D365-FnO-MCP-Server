import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { createDecompressor, HashingTap, INDEX_ENCODINGS, type IndexEncoding } from './compression.js';
import { logger } from '../utils/logger.js';

/**
 * Downloads a published index (produced by `publish-index`) described by a
 * manifest URL, verifies it, and swaps it into place. Used by `serve` in
 * hosted mode and by the `pull-index` command.
 *
 * Only `fetch` and Node built-ins are used: the manifest URL may carry a
 * storage SAS token, which is forwarded to the database blob when its URL is
 * relative. Nothing here logs a URL without stripping its query string.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export const manifestSchema = z.object({
  schema: z.literal(1),
  /** `<builtAt compacted>-<sha256 prefix>`; also the blob folder name. */
  version: z.string().min(1),
  serverVersion: z.string(),
  builtAt: z.string(),
  publishedAt: z.string(),
  db: z.object({
    /** Absolute URL, or relative to the manifest URL. */
    url: z.string().min(1),
    /** SHA-256 of the transferred (gzip) bytes. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    rawBytes: z.number().int().nonnegative(),
    /** SHA-256 of the database itself; absent in manifests written before it was recorded. */
    rawSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** True for gzip. Kept so older readers still recognise gzip manifests. */
    gzip: z.boolean(),
    /** Transfer encoding; absent in older manifests, which were always gzip. */
    encoding: z.enum(INDEX_ENCODINGS).optional(),
  }).refine((db) => db.encoding === undefined ? db.gzip : db.gzip === (db.encoding === 'gzip'), {
    message: 'gzip and encoding disagree',
  }),
  stats: z.object({
    objects: z.number().int().nonnegative(),
    labels: z.number().int().nonnegative(),
    usageRows: z.number().int().nonnegative(),
  }),
  xref: z.object({ importedAt: z.string() }).nullable().optional(),
});

export type IndexManifest = z.infer<typeof manifestSchema>;

/** Transfer encoding of a manifest's database blob. */
export function manifestEncoding(db: IndexManifest['db']): IndexEncoding {
  return db.encoding ?? (db.gzip ? 'gzip' : 'identity');
}

export type RemoteIndexErrorCode = 'manifest' | 'invalid' | 'download' | 'checksum';

export class RemoteIndexError extends Error {
  constructor(
    public readonly code: RemoteIndexErrorCode,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'RemoteIndexError';
  }
}

/** Strips the query string (where a SAS token lives) for logs and messages. */
export function redactUrl(url: string | URL): string {
  try {
    const copy = new URL(url.toString());
    copy.search = '';
    return copy.toString();
  } catch {
    return url.toString().split('?')[0];
  }
}

/**
 * Resolves the database URL named by a manifest. A relative URL inherits the
 * manifest's query string so a container-scoped SAS covers both blobs.
 */
function resolveDbUrl(manifestUrl: URL, dbUrl: string): URL {
  if (/^https?:\/\//i.test(dbUrl)) return new URL(dbUrl);
  const resolved = new URL(dbUrl, manifestUrl);
  if (!resolved.search && manifestUrl.search) resolved.search = manifestUrl.search;
  return resolved;
}

export function manifestCachePath(dbPath: string): string {
  return `${dbPath}.manifest.json`;
}

const cachedManifestSchema = manifestSchema.extend({
  downloadedAt: z.string(),
  /** How the index arrived: pulled from a manifest URL (default) or uploaded to the server. */
  source: z.enum(['manifest', 'upload']).optional(),
  /** Name of the API key that uploaded the index. */
  uploadedBy: z.string().optional(),
});
export type CachedManifest = z.infer<typeof cachedManifestSchema>;

/** The manifest of the index currently on disk, or null when none was recorded. */
export function readManifestCache(dbPath: string): CachedManifest | null {
  try {
    const parsed = cachedManifestSchema.safeParse(JSON.parse(fs.readFileSync(manifestCachePath(dbPath), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeManifestCache(dbPath: string, cache: CachedManifest): void {
  fs.writeFileSync(manifestCachePath(dbPath), JSON.stringify(cache, null, 2));
}

export interface FetchManifestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_MANIFEST_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function requestTimeoutSignal(timeoutMs: number | undefined, defaultTimeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs ?? defaultTimeoutMs);
}

export async function fetchManifest(manifestUrl: string, options: FetchManifestOptions = {}): Promise<IndexManifest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(manifestUrl, {
      headers: { accept: 'application/json' },
      signal: requestTimeoutSignal(options.timeoutMs, DEFAULT_MANIFEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RemoteIndexError('manifest', `Could not fetch the index manifest: ${errorMessage(err)}`);
  }
  if (!response.ok) {
    throw new RemoteIndexError('manifest', `Index manifest request failed with HTTP ${response.status}`, response.status);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new RemoteIndexError('invalid', 'Index manifest is not valid JSON');
  }
  const parsed = manifestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.errors.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new RemoteIndexError('invalid', `Index manifest is invalid: ${issues}`);
  }
  return parsed.data;
}

export interface SyncOptions extends FetchManifestOptions {
  manifestUrl: string;
  dbPath: string;
  /** Download even when the cached manifest already matches. */
  force?: boolean;
  /** Warn when the index was built by another server version. */
  expectedServerVersion?: string;
  /**
   * Keep a local index that was uploaded to this server when it was built
   * after the published one, instead of replacing it with an older snapshot.
   */
  keepNewerUpload?: boolean;
  /** Override the deadline for downloading the database payload. */
  downloadTimeoutMs?: number;
}

export interface SyncResult {
  /** `kept-upload`: the local copy is an upload newer than the published index. */
  status: 'downloaded' | 'up-to-date' | 'kept-upload';
  manifest: IndexManifest;
  /** Compressed bytes transferred (0 when up to date). */
  bytes: number;
}

/**
 * Brings `dbPath` in line with the published index. The download is streamed
 * through a hash and gunzip into a sibling temp file, verified, then renamed
 * over the target so a failure never leaves a half-written database behind.
 */
export async function syncIndexFromManifest(options: SyncOptions): Promise<SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const dbPath = options.dbPath;
  const manifest = await fetchManifest(options.manifestUrl, options);

  if (options.expectedServerVersion && manifest.serverVersion !== options.expectedServerVersion) {
    logger.warn('Published index was built by a different server version', {
      indexServerVersion: manifest.serverVersion,
      thisServerVersion: options.expectedServerVersion,
    });
  }

  const cached = readManifestCache(dbPath);
  if (!options.force && cached && cached.db.sha256 === manifest.db.sha256 && fs.existsSync(dbPath)) {
    return { status: 'up-to-date', manifest, bytes: 0 };
  }
  if (
    !options.force && options.keepNewerUpload && cached?.source === 'upload' && fs.existsSync(dbPath) &&
    Date.parse(cached.builtAt) > Date.parse(manifest.builtAt)
  ) {
    return { status: 'kept-upload', manifest: cached, bytes: 0 };
  }

  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const tmp = `${dbPath}.download`;
  fs.rmSync(tmp, { force: true });

  const dbUrl = resolveDbUrl(new URL(options.manifestUrl), manifest.db.url);
  logger.info('Downloading published index', { url: redactUrl(dbUrl), bytes: manifest.db.bytes, version: manifest.version });

  let response: Response;
  try {
    response = await fetchImpl(dbUrl, {
      signal: requestTimeoutSignal(options.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RemoteIndexError('download', `Index download failed: ${errorMessage(err)}`);
  }
  if (!response.ok || !response.body) {
    throw new RemoteIndexError('download', `Index download failed with HTTP ${response.status}`, response.status);
  }

  const encoded = new HashingTap();
  const decoded = new HashingTap();
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      encoded,
      createDecompressor(manifestEncoding(manifest.db)),
      decoded,
      fs.createWriteStream(tmp)
    );
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new RemoteIndexError('download', `Index download failed: ${errorMessage(err)}`);
  }

  const digest = encoded.digest();
  const received = encoded.bytes;
  if (digest !== manifest.db.sha256 || received !== manifest.db.bytes) {
    fs.rmSync(tmp, { force: true });
    throw new RemoteIndexError(
      'checksum',
      `Downloaded index does not match the manifest (expected sha256 ${manifest.db.sha256.slice(0, 12)}… / ${manifest.db.bytes} bytes, got ${digest.slice(0, 12)}… / ${received} bytes)`
    );
  }
  const rawDigest = decoded.digest();
  if (decoded.bytes !== manifest.db.rawBytes || (manifest.db.rawSha256 && rawDigest !== manifest.db.rawSha256)) {
    fs.rmSync(tmp, { force: true });
    throw new RemoteIndexError(
      'checksum',
      `Decompressed index does not match the manifest (expected ${manifest.db.rawBytes} bytes, got ${decoded.bytes})`
    );
  }

  try {
    verifyIndexFile(tmp, manifest.stats.objects);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw new RemoteIndexError('invalid', `Downloaded index failed verification: ${errorMessage(err)}`);
  }

  // A leftover WAL from the previous database would be replayed into the new
  // file on open, so it must go before the rename.
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
  fs.renameSync(tmp, dbPath);

  writeManifestCache(dbPath, { ...manifest, downloadedAt: new Date().toISOString(), source: 'manifest' });

  return { status: 'downloaded', manifest, bytes: received };
}

/**
 * Opens a database read-only and checks it holds the expected object count.
 * The sha256 already proves the bytes are intact, so no integrity scan runs.
 */
export function verifyIndexFile(filePath: string, expectedObjects: number): void {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM ax_objects').get() as { n: number | bigint };
    const count = Number(row.n);
    if (count !== expectedObjects) {
      throw new Error(`object count ${count} does not match the manifest (${expectedObjects})`);
    }
  } finally {
    db.close();
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
