import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { byteLimit, createDecompressor, hashFile, HashingTap, INDEX_ENCODINGS, type IndexEncoding } from '../indexer/compression.js';
import { getMeta, META_KEYS } from '../indexer/db.js';
import { getUsageSnapshotStatus } from '../indexer/xrefUsage.js';
import { publishedDbFileName, versionName } from '../indexer/publishIndex.js';
import { manifestSchema, type CachedManifest, type IndexManifest } from '../indexer/remoteIndex.js';
import { logger } from '../utils/logger.js';

/**
 * Receives a packaged index over HTTP, in one request or in chunks, verifies
 * it end to end and hands it to the server to swap in.
 *
 *   POST   /admin/index/uploads                    declare: encoding, sizes, sha256s, chunk size
 *   PUT    /admin/index/uploads/:id/chunks/:n      raw bytes of chunk n, X-Content-SHA256 header
 *   GET    /admin/index/uploads/:id                progress, missing chunks, checks, result
 *   POST   /admin/index/uploads/:id/complete       start verification (202); poll the GET
 *   DELETE /admin/index/uploads/:id                abort and delete
 *   GET    /admin/index                            the index being served, upload settings
 *
 * Verification, in order, before anything is replaced:
 *   transfer  sha256 + size of the assembled file == the declared package
 *   content   sha256 + size of the decompressed database == the declared database
 *   database  opens read-only, has build metadata, object count as declared
 * Every check reports expected and actual values so the client can show them.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const SHA256 = /^[0-9a-f]{64}$/;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CHUNKS = 100_000;
/** Kept free on the volume beyond the package and the decompressed database. */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;

export const uploadDeclarationSchema = z.object({
  encoding: z.enum(INDEX_ENCODINGS),
  /** Size and SHA-256 of the bytes sent (the package). */
  bytes: z.number().int().positive(),
  sha256: z.string().regex(SHA256),
  /** Size and SHA-256 of the database once decoded. */
  rawBytes: z.number().int().positive(),
  rawSha256: z.string().regex(SHA256),
  /** Bytes per chunk; equal to `bytes` for a single-request upload. */
  chunkSize: z.number().int().positive(),
  /** Object count the client read from the database, checked after decoding. */
  objects: z.number().int().nonnegative().optional(),
});
export type UploadDeclaration = z.infer<typeof uploadDeclarationSchema>;

export type UploadState = 'receiving' | 'verifying' | 'activating' | 'persisting' | 'completed' | 'failed' | 'aborted';
const ACTIVE_STATES: UploadState[] = ['receiving', 'verifying', 'activating', 'persisting'];

export interface UploadCheck {
  name: 'transfer' | 'content' | 'database';
  ok: boolean;
  expected: string;
  actual: string;
}

/** The index a successful upload activated. */
export interface UploadedIndex {
  version: string;
  builtAt: string;
  serverVersion: string;
  objects: number;
  labels: number;
  usageRows: number;
  xrefImportedAt: string | null;
}

export interface PersistResult {
  latestManifestUrl: string;
}

interface UploadSession {
  id: string;
  owner: string;
  declaration: UploadDeclaration;
  chunkCount: number;
  received: Uint8Array;
  receivedCount: number;
  inFlight: Set<number>;
  state: UploadState;
  createdAt: number;
  updatedAt: number;
  dir: string;
  packageFile: string;
  checks: UploadCheck[];
  index?: UploadedIndex;
  persisted?: PersistResult;
  persistError?: string;
  error?: string;
}

export interface IndexUploadOptions {
  /** Upload scratch folder; must be on the same volume as the served database. */
  workDir: string;
  /** Path the server serves; the decoded database is staged next to it. */
  indexDbPath: string;
  serverVersion: string;
  maxBytes: number;
  maxChunkBytes: number;
  /** A receiving upload with no chunk for this long is deleted. */
  idleTimeoutMs?: number;
  /** Finished uploads stay queryable for this long. */
  retainMs?: number;
  /**
   * Swaps the verified database at `incomingDbPath` in. Must be synchronous
   * with respect to requests (no await between closing and reopening).
   */
  activate: (incomingDbPath: string, cache: CachedManifest) => void;
  /** Copies the package to durable storage so a restart serves it again. */
  persist?: (packageFile: string, manifest: IndexManifest) => Promise<PersistResult>;
  /** A reason to refuse new uploads right now (for example, indexing in progress). */
  blockedReason?: () => string | undefined;
  /** Free bytes on the upload volume; overridable for tests. */
  freeBytes?: (dir: string) => number;
  now?: () => number;
}

export class UploadError extends Error {
  constructor(public readonly status: number, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'UploadError';
  }
}

function defaultFreeBytes(dir: string): number {
  const stats = fs.statfsSync(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class IndexUploadManager {
  private readonly sessions = new Map<string, UploadSession>();
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly retainMs: number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly options: IndexUploadOptions) {
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 2 * 60 * 60 * 1000;
    this.retainMs = options.retainMs ?? 60 * 60 * 1000;
    // Sessions live in memory, so session folders on disk are from an earlier
    // process. Only UUID-named folders are removed, never anything else there.
    fs.mkdirSync(options.workDir, { recursive: true });
    for (const entry of fs.readdirSync(options.workDir, { withFileTypes: true })) {
      if (entry.isDirectory() && SESSION_DIR.test(entry.name)) {
        fs.rmSync(path.join(options.workDir, entry.name), { recursive: true, force: true });
      }
    }
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  get persists(): boolean {
    return this.options.persist !== undefined;
  }

  get limits(): { maxBytes: number; maxChunkBytes: number } {
    return { maxBytes: this.options.maxBytes, maxChunkBytes: this.options.maxChunkBytes };
  }

  close(): void {
    clearInterval(this.sweepTimer);
  }

  create(input: unknown, owner: string): UploadSession {
    const parsed = uploadDeclarationSchema.safeParse(input);
    if (!parsed.success) {
      throw new UploadError(400, `Invalid upload declaration: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
    }
    const declaration = parsed.data;
    const { maxBytes, maxChunkBytes } = this.options;
    if (declaration.bytes > maxBytes) {
      throw new UploadError(413, `The package is ${declaration.bytes} bytes; this server accepts at most ${maxBytes}.`);
    }
    const chunkSize = Math.min(declaration.chunkSize, declaration.bytes);
    if (chunkSize > maxChunkBytes) {
      throw new UploadError(413, `Chunks of ${chunkSize} bytes exceed the server limit of ${maxChunkBytes}; use smaller chunks.`, {
        maxChunkBytes,
      });
    }
    const chunkCount = Math.ceil(declaration.bytes / chunkSize);
    if (chunkCount > MAX_CHUNKS) {
      throw new UploadError(400, `${chunkCount} chunks is more than the ${MAX_CHUNKS} allowed; use larger chunks.`);
    }
    if (declaration.encoding === 'identity' && declaration.bytes !== declaration.rawBytes) {
      throw new UploadError(400, 'An uncompressed upload must declare bytes equal to rawBytes.');
    }

    const blocked = this.options.blockedReason?.();
    if (blocked) throw new UploadError(409, blocked);

    this.sweep();
    const active = [...this.sessions.values()].find((session) => ACTIVE_STATES.includes(session.state));
    if (active) {
      throw new UploadError(409, `Upload ${active.id} by '${active.owner}' is in progress (${active.state}).`, {
        activeUploadId: active.id,
        activeOwner: active.owner,
      });
    }

    const needed = declaration.bytes + declaration.rawBytes + DISK_MARGIN_BYTES;
    const free = (this.options.freeBytes ?? defaultFreeBytes)(this.options.workDir);
    if (free < needed) {
      throw new UploadError(507, `Not enough disk space on the server: ${free} bytes free, ${needed} needed.`, { free, needed });
    }

    const id = randomUUID();
    const dir = path.join(this.options.workDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const packageFile = path.join(dir, 'package');
    fs.writeFileSync(packageFile, '');
    const now = this.now();
    const session: UploadSession = {
      id,
      owner,
      declaration: { ...declaration, chunkSize },
      chunkCount,
      received: new Uint8Array(chunkCount),
      receivedCount: 0,
      inFlight: new Set(),
      state: 'receiving',
      createdAt: now,
      updatedAt: now,
      dir,
      packageFile,
      checks: [],
    };
    this.sessions.set(id, session);
    logger.info('Index upload started', { uploadId: id, owner, bytes: declaration.bytes, encoding: declaration.encoding, chunkCount });
    return session;
  }

  get(id: string): UploadSession {
    const session = this.sessions.get(id);
    if (!session) throw new UploadError(404, `Upload ${id} not found; it may have expired.`);
    return session;
  }

  chunkLength(session: UploadSession, index: number): number {
    const { bytes, chunkSize } = session.declaration;
    return index === session.chunkCount - 1 ? bytes - chunkSize * index : chunkSize;
  }

  /** The session, provided `owner` (an API key name) started it; other upload keys may not touch it. */
  private owned(id: string, owner: string): UploadSession {
    const session = this.get(id);
    if (session.owner !== owner) throw new UploadError(403, `Upload ${id} belongs to '${session.owner}'.`);
    return session;
  }

  async writeChunk(
    id: string,
    owner: string,
    index: number,
    body: NodeJS.ReadableStream,
    sha256: string,
    declaredLength?: number
  ): Promise<UploadSession> {
    const session = this.owned(id, owner);
    if (session.state !== 'receiving') throw new UploadError(409, `Upload ${id} is ${session.state}; it no longer accepts chunks.`);
    if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
      throw new UploadError(400, `Chunk index must be 0-${session.chunkCount - 1}.`);
    }
    if (!SHA256.test(sha256)) throw new UploadError(400, 'X-Content-SHA256 must be the lowercase hex SHA-256 of the chunk.');
    const expected = this.chunkLength(session, index);
    if (declaredLength !== undefined && declaredLength !== expected) {
      throw new UploadError(400, `Chunk ${index} must be ${expected} bytes; Content-Length says ${declaredLength}.`);
    }
    if (session.inFlight.has(index)) throw new UploadError(409, `Chunk ${index} is already being received.`);

    session.inFlight.add(index);
    // A re-sent chunk overwrites the region, so it counts as missing until verified again.
    if (session.received[index]) {
      session.received[index] = 0;
      session.receivedCount--;
    }
    try {
      const tap = new HashingTap();
      await pipeline(
        body,
        byteLimit(expected, () => new UploadError(400, `Chunk is longer than the expected ${expected} bytes.`)),
        tap,
        fs.createWriteStream(session.packageFile, { flags: 'r+', start: index * session.declaration.chunkSize })
      );
      if (tap.bytes !== expected) {
        throw new UploadError(400, `Chunk ${index} ended after ${tap.bytes} of ${expected} bytes.`);
      }
      const actual = tap.digest();
      if (actual !== sha256) {
        throw new UploadError(422, `Chunk ${index} checksum mismatch: expected ${sha256}, received ${actual}. Send it again.`, {
          expected: sha256,
          actual,
        });
      }
      if (session.state !== 'receiving') throw new UploadError(409, `Upload ${id} was ${session.state} while chunk ${index} arrived.`);
      session.received[index] = 1;
      session.receivedCount++;
      session.updatedAt = this.now();
      return session;
    } finally {
      session.inFlight.delete(index);
    }
  }

  missingChunks(session: UploadSession, limit = 1000): number[] {
    const missing: number[] = [];
    for (let index = 0; index < session.chunkCount && missing.length < limit; index++) {
      if (!session.received[index]) missing.push(index);
    }
    return missing;
  }

  /** Starts verification and activation in the background; poll `get`. */
  complete(id: string, owner: string): UploadSession {
    const session = this.owned(id, owner);
    if (session.state !== 'receiving') {
      if (session.state === 'aborted') throw new UploadError(409, `Upload ${id} was aborted.`);
      return session;
    }
    if (session.inFlight.size > 0) throw new UploadError(409, `${session.inFlight.size} chunk(s) are still being received.`);
    if (session.receivedCount !== session.chunkCount) {
      throw new UploadError(409, `${session.chunkCount - session.receivedCount} of ${session.chunkCount} chunks are missing.`, {
        missingChunks: this.missingChunks(session),
      });
    }
    session.state = 'verifying';
    session.updatedAt = this.now();
    void this.finish(session);
    return session;
  }

  /** Resolves once the upload has reached a final state; for tests and the CLI's in-process use. */
  async settled(id: string, timeoutMs = 60_000): Promise<UploadSession> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const session = this.get(id);
      if (!ACTIVE_STATES.includes(session.state)) return session;
      if (Date.now() > deadline) throw new Error(`Upload ${id} did not settle within ${timeoutMs} ms.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  abort(id: string, owner: string): UploadSession {
    const session = this.owned(id, owner);
    if (session.state === 'receiving') {
      session.state = 'aborted';
      session.updatedAt = this.now();
      this.cleanup(session);
      logger.info('Index upload aborted', { uploadId: id, owner });
    } else if (ACTIVE_STATES.includes(session.state)) {
      throw new UploadError(409, `Upload ${id} is ${session.state} and can no longer be aborted.`);
    }
    return session;
  }

  private async finish(session: UploadSession): Promise<void> {
    const { declaration } = session;
    const incoming = `${this.options.indexDbPath}.incoming`;
    try {
      const transfer = await hashFile(session.packageFile);
      const transferOk = transfer.sha256 === declaration.sha256 && transfer.bytes === declaration.bytes;
      session.checks.push({
        name: 'transfer',
        ok: transferOk,
        expected: `${declaration.sha256} (${declaration.bytes} bytes)`,
        actual: `${transfer.sha256} (${transfer.bytes} bytes)`,
      });
      if (!transferOk) throw new Error('The assembled package does not match the declared SHA-256; nothing was replaced.');

      fs.rmSync(incoming, { force: true });
      const decoded = new HashingTap();
      try {
        await pipeline(
          fs.createReadStream(session.packageFile, { highWaterMark: 1024 * 1024 }),
          createDecompressor(declaration.encoding),
          // A package that decodes past the declared size is refused before it fills the disk.
          byteLimit(declaration.rawBytes, () => new Error(`it decodes to more than the declared ${declaration.rawBytes} bytes`)),
          decoded,
          fs.createWriteStream(incoming)
        );
      } catch (err) {
        throw new Error(`The package could not be decoded as ${declaration.encoding}: ${errorMessage(err)}`);
      }
      const rawSha256 = decoded.digest();
      const contentOk = rawSha256 === declaration.rawSha256 && decoded.bytes === declaration.rawBytes;
      session.checks.push({
        name: 'content',
        ok: contentOk,
        expected: `${declaration.rawSha256} (${declaration.rawBytes} bytes)`,
        actual: `${rawSha256} (${decoded.bytes} bytes)`,
      });
      if (!contentOk) throw new Error('The decoded database does not match the declared SHA-256; nothing was replaced.');

      const facts = readIndexFacts(incoming);
      const objectsOk = declaration.objects === undefined || facts.objects === declaration.objects;
      session.checks.push({
        name: 'database',
        ok: objectsOk,
        expected: declaration.objects === undefined ? 'build metadata present' : `${declaration.objects} objects`,
        actual: `${facts.objects} objects, built ${facts.builtAt}`,
      });
      if (!objectsOk) throw new Error('The database object count differs from the declared one; nothing was replaced.');

      const fileName = publishedDbFileName(declaration.encoding);
      const index: UploadedIndex = {
        version: versionName(facts.builtAt, declaration.sha256),
        builtAt: facts.builtAt,
        serverVersion: facts.serverVersion ?? this.options.serverVersion,
        objects: facts.objects,
        labels: facts.labels,
        usageRows: facts.usageRows,
        xrefImportedAt: facts.xrefImportedAt,
      };
      const nowIso = new Date(this.now()).toISOString();
      const manifest = manifestSchema.parse({
        schema: 1,
        version: index.version,
        serverVersion: index.serverVersion,
        builtAt: index.builtAt,
        publishedAt: nowIso,
        db: {
          url: fileName,
          sha256: declaration.sha256,
          bytes: declaration.bytes,
          rawBytes: declaration.rawBytes,
          rawSha256: declaration.rawSha256,
          gzip: declaration.encoding === 'gzip',
          encoding: declaration.encoding,
        },
        stats: { objects: index.objects, labels: index.labels, usageRows: index.usageRows },
        xref: index.xrefImportedAt ? { importedAt: index.xrefImportedAt } : null,
      });

      session.state = 'activating';
      this.options.activate(incoming, { ...manifest, downloadedAt: nowIso, source: 'upload', uploadedBy: session.owner });
      session.index = index;
      logger.info('Uploaded index activated', { uploadId: session.id, owner: session.owner, version: index.version, objects: index.objects });

      if (this.options.persist) {
        session.state = 'persisting';
        session.updatedAt = this.now();
        try {
          session.persisted = await this.options.persist(session.packageFile, manifest);
          logger.info('Uploaded index persisted', { uploadId: session.id, version: index.version, latest: session.persisted.latestManifestUrl });
        } catch (err) {
          session.persistError = errorMessage(err);
          logger.error('Uploaded index is live but could not be persisted', { uploadId: session.id, message: session.persistError });
        }
      }
      session.state = 'completed';
    } catch (err) {
      session.state = 'failed';
      session.error = errorMessage(err);
      fs.rmSync(incoming, { force: true });
      logger.warn('Index upload failed verification', { uploadId: session.id, owner: session.owner, message: session.error });
    } finally {
      session.updatedAt = this.now();
      this.cleanup(session);
    }
  }

  private cleanup(session: UploadSession): void {
    fs.rmSync(session.dir, { recursive: true, force: true });
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.state === 'receiving' && session.inFlight.size === 0 && now - session.updatedAt > this.idleTimeoutMs) {
        session.state = 'aborted';
        session.error = 'Expired: no chunk arrived for too long.';
        session.updatedAt = now;
        this.cleanup(session);
        logger.info('Index upload expired', { uploadId: id, owner: session.owner });
      } else if (!ACTIVE_STATES.includes(session.state) && now - session.updatedAt > this.retainMs) {
        this.sessions.delete(id);
      }
    }
  }

  describe(session: UploadSession): Record<string, unknown> {
    return {
      uploadId: session.id,
      state: session.state,
      owner: session.owner,
      encoding: session.declaration.encoding,
      bytes: session.declaration.bytes,
      sha256: session.declaration.sha256,
      chunkSize: session.declaration.chunkSize,
      chunkCount: session.chunkCount,
      receivedChunks: session.receivedCount,
      missingChunks: session.state === 'receiving' ? this.missingChunks(session) : [],
      checks: session.checks,
      index: session.index ?? null,
      persisted: session.persisted ?? null,
      persistError: session.persistError ?? null,
      error: session.error ?? null,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
    };
  }
}

interface IndexFacts {
  objects: number;
  labels: number;
  usageRows: number;
  builtAt: string;
  serverVersion: string | null;
  xrefImportedAt: string | null;
}

/** Reads what the manifest records from a database, read-only and without an integrity scan. */
export function readIndexFacts(file: string): IndexFacts {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    throw new Error(`The uploaded file is not a readable SQLite database: ${errorMessage(err)}`);
  }
  try {
    let objects: number;
    let builtAt: string | null;
    try {
      objects = Number((db.prepare('SELECT COUNT(*) AS n FROM ax_objects').get() as { n: number | bigint }).n);
      builtAt = getMeta(db, META_KEYS.builtAt);
    } catch (err) {
      throw new Error(`The uploaded database is not a D365 index: ${errorMessage(err)}`);
    }
    if (!builtAt) throw new Error('The uploaded database has no build metadata; build it with `index` before uploading.');
    let usage: { status?: string; importedAt?: string; rowCount?: number } = {};
    try {
      usage = getUsageSnapshotStatus(db) as typeof usage;
    } catch {
      // Indexes built before usage snapshots have no such table.
    }
    const imported = usage.status === 'imported';
    return {
      objects,
      labels: Number((db.prepare('SELECT COUNT(*) AS n FROM ax_labels').get() as { n: number | bigint }).n),
      usageRows: imported ? Number(usage.rowCount ?? 0) : 0,
      builtAt,
      serverVersion: getMeta(db, META_KEYS.serverVersion),
      xrefImportedAt: imported ? (usage.importedAt ?? null) : null,
    };
  } finally {
    db.close();
  }
}

export interface IndexAdminRouterOptions {
  /** Upload manager; undefined when uploads are disabled. */
  uploads?: IndexUploadManager;
  /** API key names allowed to upload. */
  uploadKeyNames: ReadonlySet<string>;
  /** What `GET /admin/index` reports about the index being served. */
  describeIndex: () => Record<string, unknown>;
  version: string;
}

/**
 * Routes under `/admin`, mounted after API-key authentication. Upload routes
 * additionally require a key named in `uploadKeyNames`.
 */
export function createIndexAdminRouter(options: IndexAdminRouterOptions): Router {
  const router = express.Router();
  const { uploads, uploadKeyNames } = options;

  const send = (res: Response, err: unknown): void => {
    if (res.headersSent) return;
    if (err instanceof UploadError) {
      res.status(err.status).json({ error: err.message, ...err.details });
      return;
    }
    logger.error('Index upload request failed', { message: errorMessage(err) });
    res.status(500).json({ error: 'Internal error' });
  };

  const requireUploader = (req: Request, res: Response): IndexUploadManager | undefined => {
    if (!uploads) {
      res.status(404).json({ error: 'Index uploads are disabled on this server (D365_INDEX_UPLOAD_KEYS is empty).' });
      return undefined;
    }
    const name = res.locals.apiKeyName as string;
    if (!uploadKeyNames.has(name)) {
      logger.warn('Index upload refused for key', { apiKey: name, method: req.method, path: req.path });
      res.status(403).json({ error: `API key '${name}' may not upload indexes; add it to D365_INDEX_UPLOAD_KEYS.` });
      return undefined;
    }
    return uploads;
  };

  router.get('/index', (_req, res) => {
    const name = res.locals.apiKeyName as string;
    res.json({
      serverVersion: options.version,
      apiKey: name,
      index: options.describeIndex(),
      upload: {
        enabled: uploads !== undefined,
        allowed: uploads !== undefined && uploadKeyNames.has(name),
        encodings: INDEX_ENCODINGS,
        maxBytes: uploads?.limits.maxBytes ?? null,
        maxChunkBytes: uploads?.limits.maxChunkBytes ?? null,
        persistent: uploads?.persists ?? false,
      },
    });
  });

  router.post('/index/uploads', (req, res) => {
    const manager = requireUploader(req, res);
    if (!manager) return;
    try {
      const session = manager.create(req.body, res.locals.apiKeyName as string);
      res.status(201).json(manager.describe(session));
    } catch (err) {
      send(res, err);
    }
  });

  router.get('/index/uploads/:id', (req, res) => {
    const manager = requireUploader(req, res);
    if (!manager) return;
    try {
      res.json(manager.describe(manager.get(req.params.id)));
    } catch (err) {
      send(res, err);
    }
  });

  router.put('/index/uploads/:id/chunks/:index', async (req, res) => {
    const manager = requireUploader(req, res);
    if (!manager) {
      req.resume();
      return;
    }
    const lengthHeader = req.headers['content-length'];
    const declaredLength = lengthHeader === undefined ? undefined : Number(lengthHeader);
    const sha256 = String(req.headers['x-content-sha256'] ?? '').toLowerCase();
    try {
      const session = await manager.writeChunk(req.params.id, res.locals.apiKeyName as string, Number(req.params.index), req, sha256, declaredLength);
      res.json({ index: Number(req.params.index), sha256, receivedChunks: session.receivedCount, chunkCount: session.chunkCount });
    } catch (err) {
      // Drain what is left so the connection can be reused for the retry.
      if (!req.readableEnded) req.resume();
      send(res, err);
    }
  });

  router.post('/index/uploads/:id/complete', (req, res) => {
    const manager = requireUploader(req, res);
    if (!manager) return;
    try {
      res.status(202).json(manager.describe(manager.complete(req.params.id, res.locals.apiKeyName as string)));
    } catch (err) {
      send(res, err);
    }
  });

  router.delete('/index/uploads/:id', (req, res) => {
    const manager = requireUploader(req, res);
    if (!manager) return;
    try {
      res.json(manager.describe(manager.abort(req.params.id, res.locals.apiKeyName as string)));
    } catch (err) {
      send(res, err);
    }
  });

  return router;
}

export type { IndexEncoding };
