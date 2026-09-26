import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { CompressedFile } from './compression.js';

/**
 * Client for the server's `/admin/index/uploads` API: declares a package,
 * sends it in one request or in parallel chunks with retries, asks the server
 * to verify it, and checks the server's SHA-256 against the local one.
 */

export interface UploadEventMap {
  upload: { sentBytes: number; totalBytes: number; chunksDone: number; chunkCount: number };
  retry: { chunk: number; attempt: number; reason: string };
  state: { state: string };
  check: { name: string; ok: boolean; expected: string; actual: string };
}
export type UploadEvent = { [K in keyof UploadEventMap]: { type: K } & UploadEventMap[K] }[keyof UploadEventMap];

export interface UploadPackageOptions {
  /** Server base URL (`https://host`); a trailing `/mcp` is ignored. */
  serverUrl: string;
  apiKey: string;
  packageFile: string;
  packed: CompressedFile;
  objects: number;
  /** Bytes per chunk; null sends the whole package in one request. */
  chunkSize: number | null;
  parallel?: number;
  /** Attempts per chunk before giving up. */
  attempts?: number;
  fetchImpl?: typeof fetch;
  onEvent?: (event: UploadEvent) => void;
  pollIntervalMs?: number;
  /** How long to wait for server-side verification and activation. */
  verifyTimeoutMs?: number;
  signal?: AbortSignal;
  /** Delay before retry n (1-based); overridable for tests. */
  backoffMs?: (attempt: number) => number;
  /** Chunks up to this size are read into memory, larger ones streamed from disk (default 256 MiB). */
  bufferedChunkLimit?: number;
}

export interface UploadCheck {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface UploadOutcome {
  uploadId: string;
  state: 'completed' | 'failed';
  /** SHA-256 the server computed over the bytes it assembled. */
  serverSha256: string | null;
  /** True when the server's SHA-256 equals the local package's. */
  checksumMatches: boolean;
  checks: UploadCheck[];
  index: Record<string, unknown> | null;
  persisted: { latestManifestUrl: string } | null;
  persistError: string | null;
  error: string | null;
}

export class UploadClientError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: Record<string, unknown>) {
    super(message);
    this.name = 'UploadClientError';
  }
}

/** Largest chunk read into memory; bigger ones are streamed from disk. */
const BUFFERED_CHUNK_LIMIT = 256 * 1024 * 1024;

export function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/i, '');
  return url.toString().replace(/\/+$/, '');
}

function isRetryableStatus(status: number): boolean {
  // 422 = chunk checksum mismatch (corrupted in transit): sending again is the fix.
  return status === 408 || status === 422 || status === 429 || status >= 500;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Upload cancelled.'));
    }, { once: true });
  });
}

async function hashRange(file: string, start: number, length: number): Promise<string> {
  const hash = createHash('sha256');
  if (length === 0) return hash.digest('hex');
  for await (const chunk of fs.createReadStream(file, { start, end: start + length - 1, highWaterMark: 1024 * 1024 })) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

export class IndexUploadClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(serverUrl: string, private readonly apiKey: string, fetchImpl?: typeof fetch) {
    this.base = normalizeServerUrl(serverUrl);
    this.fetchImpl = fetchImpl ?? fetch;
  }

  async request(method: string, path: string, init: { json?: unknown; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          accept: 'application/json',
          ...(init.json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
        signal: init.signal,
      });
    } catch (err) {
      throw new UploadClientError(`${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await readJson(response);
    if (!response.ok) {
      const message = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      throw new UploadClientError(`${method} ${path}: ${message}`, response.status, body);
    }
    return body;
  }

  /** `GET /admin/index`: what the server serves and whether this key may upload. */
  info(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', '/admin/index', { signal });
  }

  async upload(options: UploadPackageOptions): Promise<UploadOutcome> {
    const { packed, signal } = options;
    const emit = options.onEvent ?? (() => {});
    const chunkSize = options.chunkSize === null ? packed.bytes : Math.min(options.chunkSize, packed.bytes);
    const created = await this.request('POST', '/admin/index/uploads', {
      signal,
      json: {
        encoding: packed.encoding,
        bytes: packed.bytes,
        sha256: packed.sha256,
        rawBytes: packed.rawBytes,
        rawSha256: packed.rawSha256,
        chunkSize,
        objects: options.objects,
      },
    });
    const uploadId = String(created.uploadId);
    const chunkCount = Number(created.chunkCount);
    const serverChunkSize = Number(created.chunkSize);

    try {
      await this.sendChunks(uploadId, serverChunkSize, chunkCount, options, emit);
    } catch (err) {
      await this.request('DELETE', `/admin/index/uploads/${uploadId}`).catch(() => undefined);
      throw err;
    }

    await this.request('POST', `/admin/index/uploads/${uploadId}/complete`, { signal });
    const status = await this.waitForResult(uploadId, options, emit);

    const checks = (status.checks as UploadCheck[] | undefined) ?? [];
    const transfer = checks.find((check) => check.name === 'transfer');
    const serverSha256 = transfer?.actual.split(' ')[0] ?? null;
    return {
      uploadId,
      state: status.state === 'completed' ? 'completed' : 'failed',
      serverSha256,
      checksumMatches: serverSha256 === packed.sha256,
      checks,
      index: (status.index as Record<string, unknown> | null) ?? null,
      persisted: (status.persisted as { latestManifestUrl: string } | null) ?? null,
      persistError: (status.persistError as string | null) ?? null,
      error: (status.error as string | null) ?? null,
    };
  }

  private async sendChunks(
    uploadId: string,
    chunkSize: number,
    chunkCount: number,
    options: UploadPackageOptions,
    emit: (event: UploadEvent) => void
  ): Promise<void> {
    const { packed, packageFile, signal } = options;
    const attempts = options.attempts ?? 5;
    const backoff = options.backoffMs ?? ((attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1)));
    let next = 0;
    let sentBytes = 0;
    let chunksDone = 0;
    const handle = await fs.promises.open(packageFile, 'r');

    const sendOne = async (index: number): Promise<void> => {
      const start = index * chunkSize;
      const length = Math.min(chunkSize, packed.bytes - start);
      const buffered = length <= (options.bufferedChunkLimit ?? BUFFERED_CHUNK_LIMIT);
      let data: Buffer | undefined;
      let sha256: string;
      if (buffered) {
        data = Buffer.alloc(length);
        const { bytesRead } = await handle.read(data, 0, length, start);
        if (bytesRead !== length) throw new UploadClientError(`Short read of chunk ${index} from ${packageFile}.`);
        sha256 = createHash('sha256').update(data).digest('hex');
      } else {
        sha256 = chunkCount === 1 ? packed.sha256 : await hashRange(packageFile, start, length);
      }

      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        let reason: string;
        let retryable = true;
        try {
          const body: BodyInit = data
            ? (data as unknown as BodyInit)
            : (Readable.toWeb(fs.createReadStream(packageFile, { start, end: start + length - 1, highWaterMark: 1024 * 1024 })) as unknown as BodyInit);
          const response = await this.fetchImpl(`${this.base}/admin/index/uploads/${uploadId}/chunks/${index}`, {
            method: 'PUT',
            headers: {
              'x-api-key': this.apiKey,
              'content-type': 'application/octet-stream',
              'content-length': String(length),
              'x-content-sha256': sha256,
            },
            body,
            signal,
            // Required by Node's fetch for a streamed request body.
            ...(data ? {} : { duplex: 'half' }),
          } as RequestInit);
          if (response.ok) {
            await response.body?.cancel();
            sentBytes += length;
            chunksDone++;
            emit({ type: 'upload', sentBytes, totalBytes: packed.bytes, chunksDone, chunkCount });
            return;
          }
          const failure = await readJson(response);
          reason = `HTTP ${response.status}: ${typeof failure.error === 'string' ? failure.error : 'no detail'}`;
          retryable = isRetryableStatus(response.status);
          if (!retryable) throw new UploadClientError(`Chunk ${index} rejected: ${reason}`, response.status, failure);
        } catch (err) {
          if (err instanceof UploadClientError || signal?.aborted) throw err;
          reason = err instanceof Error ? err.message : String(err);
        }
        if (attempt >= attempts) throw new UploadClientError(`Chunk ${index} failed after ${attempts} attempts: ${reason}`);
        emit({ type: 'retry', chunk: index, attempt, reason });
        await sleep(backoff(attempt), signal);
      }
    };

    try {
      const workers = Array.from({ length: Math.max(1, Math.min(options.parallel ?? 4, chunkCount)) }, async () => {
        while (next < chunkCount) {
          const index = next++;
          await sendOne(index);
        }
      });
      await Promise.all(workers);
    } finally {
      await handle.close();
    }
  }

  private async waitForResult(
    uploadId: string,
    options: UploadPackageOptions,
    emit: (event: UploadEvent) => void
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + (options.verifyTimeoutMs ?? 60 * 60_000);
    const interval = options.pollIntervalMs ?? 1000;
    let lastState = '';
    let reported = 0;
    for (;;) {
      const status = await this.request('GET', `/admin/index/uploads/${uploadId}`, { signal: options.signal });
      const state = String(status.state);
      if (state !== lastState) {
        emit({ type: 'state', state });
        lastState = state;
      }
      const checks = (status.checks as UploadCheck[] | undefined) ?? [];
      for (; reported < checks.length; reported++) emit({ type: 'check', ...checks[reported] });
      if (state === 'completed' || state === 'failed' || state === 'aborted') return status;
      if (Date.now() > deadline) throw new UploadClientError(`The server did not finish verifying upload ${uploadId} in time.`);
      await sleep(interval, options.signal);
    }
  }
}
