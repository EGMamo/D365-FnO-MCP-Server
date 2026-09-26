import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compressFile, hashFile, parseCompressionLevel, parseEncoding, type CompressedFile, type CompressionLevel, type IndexEncoding,
} from '../indexer/compression.js';
import { snapshotIndex } from '../indexer/publishIndex.js';
import { redactUrl } from '../indexer/remoteIndex.js';
import { IndexUploadClient, normalizeServerUrl, UploadClientError, type UploadEvent } from '../indexer/uploadClient.js';

/**
 * Packages the local index and uploads it to a running server:
 *
 *   snapshot  compact, verified copy (as publish-index makes)
 *   compress  gzip | brotli | none, hashing the database and the package
 *   upload    one request, or chunks sent in parallel with per-chunk SHA-256 and retries
 *   verify    the server re-hashes the assembled package and the decoded
 *             database, checks it, swaps it in; the client compares SHA-256s
 *
 * `--progress json` prints one JSON event per line on stdout for tools such as
 * the Visual Studio extension; errors are events too, with exit code 1.
 */

export interface UploadIndexCommandOptions {
  server?: string;
  dbPath?: string;
  compression?: string;
  level?: string;
  /** Chunk size in MiB. */
  chunkSizeMb?: string;
  noChunks?: boolean;
  parallel?: string;
  retries?: string;
  relativePaths?: boolean;
  allowNoRawXml?: boolean;
  integrityCheck?: boolean;
  workDir?: string;
  progress?: string;
}

export type ProgressEvent =
  | { event: 'stage'; stage: 'preflight' | 'snapshot' | 'compress' | 'upload' | 'verify' | 'done'; message: string }
  | { event: 'progress'; stage: 'compress' | 'upload'; done: number; total: number }
  | { event: 'retry'; chunk: number; attempt: number; reason: string }
  | { event: 'check'; name: string; ok: boolean; expected: string; actual: string }
  | { event: 'result'; ok: boolean; [key: string]: unknown }
  | { event: 'error'; message: string };

const DEFAULT_CHUNK_MB = 32;

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive whole number (got '${value}').`);
  return parsed;
}

/** Human output prints stages and whole-percent steps; JSON output prints every event. */
function createReporter(json: boolean): (event: ProgressEvent) => void {
  const lastPercent = new Map<string, number>();
  return (event) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    switch (event.event) {
      case 'stage':
        console.log(`\n[${event.stage}] ${event.message}`);
        break;
      case 'progress': {
        const percent = event.total === 0 ? 100 : Math.floor((event.done / event.total) * 100);
        const step = Math.floor(percent / 10) * 10;
        if ((lastPercent.get(event.stage) ?? -1) < step) {
          lastPercent.set(event.stage, step);
          console.log(`  ${event.stage} ${step}% (${formatBytes(event.done)} / ${formatBytes(event.total)})`);
        }
        break;
      }
      case 'retry':
        console.log(`  retrying chunk ${event.chunk} (attempt ${event.attempt}): ${event.reason}`);
        break;
      case 'check':
        console.log(`  ${event.ok ? 'OK  ' : 'FAIL'} ${event.name}: expected ${event.expected}, got ${event.actual}`);
        break;
      case 'result':
        break;
      case 'error':
        console.error(`Upload failed: ${event.message}`);
        break;
    }
  };
}

export async function uploadIndexCommand(
  options: UploadIndexCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const json = options.progress === 'json';
  const report = createReporter(json);
  const fail = (message: string): number => {
    report({ event: 'error', message });
    return 1;
  };

  const server = options.server ?? env.D365_MCP_SERVER_URL;
  if (!server) return fail('No server. Pass --server <https://host> or set D365_MCP_SERVER_URL.');
  const apiKey = env.D365_MCP_API_KEY;
  if (!apiKey) return fail('Set D365_MCP_API_KEY to an API key the server lists in D365_INDEX_UPLOAD_KEYS (never pass it on the command line).');

  let encoding: IndexEncoding;
  let level: CompressionLevel;
  let chunkBytes: number | null;
  let parallel: number;
  let attempts: number;
  let serverUrl: string;
  try {
    encoding = parseEncoding(options.compression ?? 'gzip');
    level = parseCompressionLevel(options.level ?? 'balanced');
    chunkBytes = options.noChunks ? null : positiveInt(options.chunkSizeMb, DEFAULT_CHUNK_MB, 'chunk-size') * 1024 * 1024;
    parallel = positiveInt(options.parallel, 4, 'parallel');
    attempts = positiveInt(options.retries, 4, 'retries') + 1;
    serverUrl = normalizeServerUrl(server);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  let relativePathsRoot: string | undefined;
  if (options.relativePaths) {
    if (!env.D365_PACKAGES_DIR) return fail('--relative-paths needs D365_PACKAGES_DIR so the prefix to strip is known.');
    relativePathsRoot = env.D365_PACKAGES_DIR;
  }

  const dbPath = path.resolve(options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db');
  if (!fs.existsSync(dbPath)) return fail(`Index database not found at ${dbPath}. Run \`index\` first.`);

  const client = new IndexUploadClient(serverUrl, apiKey);
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Upload cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);

  const staging = fs.mkdtempSync(path.join(options.workDir ? path.resolve(options.workDir) : os.tmpdir(), 'd365-index-upload-'));
  try {
    // Fail before spending minutes on compression when the key or server cannot take the upload.
    report({ event: 'stage', stage: 'preflight', message: `Checking ${redactUrl(serverUrl)}` });
    const info = await client.info(abort.signal);
    const upload = info.upload as { enabled?: boolean; allowed?: boolean; maxChunkBytes?: number | null; maxBytes?: number | null };
    if (!upload?.enabled) return fail('The server does not accept index uploads (D365_INDEX_UPLOAD_KEYS is empty).');
    if (!upload.allowed) return fail(`The API key '${String(info.apiKey)}' is not allowed to upload (add it to D365_INDEX_UPLOAD_KEYS).`);
    if (chunkBytes !== null && upload.maxChunkBytes && chunkBytes > upload.maxChunkBytes) {
      return fail(`--chunk-size exceeds the server limit of ${formatBytes(upload.maxChunkBytes)}.`);
    }

    report({ event: 'stage', stage: 'snapshot', message: `Copying and verifying ${dbPath}` });
    const snapshot = snapshotIndex(dbPath, path.join(staging, 'd365_index.db'), {
      allowNoRawXml: options.allowNoRawXml === true,
      integrityCheck: options.integrityCheck === true,
      relativePathsRoot,
    });
    const rawBytes = fs.statSync(snapshot.file).size;

    let packageFile: string;
    let packed: CompressedFile;
    if (encoding === 'identity') {
      report({ event: 'stage', stage: 'compress', message: 'No compression: hashing the database' });
      const hashed = await hashFile(snapshot.file);
      packageFile = snapshot.file;
      packed = { encoding, sha256: hashed.sha256, bytes: hashed.bytes, rawSha256: hashed.sha256, rawBytes: hashed.bytes };
    } else {
      report({ event: 'stage', stage: 'compress', message: `Compressing ${formatBytes(rawBytes)} with ${encoding === 'br' ? 'brotli' : encoding} (${level})` });
      packageFile = path.join(staging, `package.${encoding}`);
      packed = await compressFile(snapshot.file, packageFile, encoding, level, (done) =>
        report({ event: 'progress', stage: 'compress', done, total: rawBytes })
      );
      fs.rmSync(snapshot.file, { force: true });
      const ratio = packed.rawBytes === 0 ? 0 : (1 - packed.bytes / packed.rawBytes) * 100;
      report({ event: 'stage', stage: 'compress', message: `Package ${formatBytes(packed.bytes)} (${ratio.toFixed(0)}% smaller), sha256 ${packed.sha256}` });
    }
    if (upload.maxBytes && packed.bytes > upload.maxBytes) {
      return fail(`The package is ${formatBytes(packed.bytes)}; the server accepts at most ${formatBytes(upload.maxBytes)}.`);
    }

    const chunkCount = chunkBytes === null ? 1 : Math.ceil(packed.bytes / chunkBytes);
    report({
      event: 'stage',
      stage: 'upload',
      message: chunkBytes === null
        ? `Sending ${formatBytes(packed.bytes)} in one request`
        : `Sending ${formatBytes(packed.bytes)} as ${chunkCount} chunk(s) of ${formatBytes(Math.min(chunkBytes, packed.bytes))}, ${Math.min(parallel, chunkCount)} at a time`,
    });
    const outcome = await client.upload({
      serverUrl,
      apiKey,
      packageFile,
      packed,
      objects: snapshot.stats.objects,
      chunkSize: chunkBytes,
      parallel,
      attempts,
      signal: abort.signal,
      onEvent: (event: UploadEvent) => {
        switch (event.type) {
          case 'upload':
            report({ event: 'progress', stage: 'upload', done: event.sentBytes, total: event.totalBytes });
            if (event.chunksDone === event.chunkCount) {
              report({ event: 'stage', stage: 'verify', message: 'Upload complete; the server is verifying checksums' });
            }
            break;
          case 'retry':
            report({ event: 'retry', chunk: event.chunk, attempt: event.attempt, reason: event.reason });
            break;
          case 'check':
            report({ event: 'check', name: event.name, ok: event.ok, expected: event.expected, actual: event.actual });
            break;
          case 'state':
            break;
        }
      },
    });

    report({
      event: 'check',
      name: 'checksum',
      ok: outcome.checksumMatches,
      expected: `local ${packed.sha256}`,
      actual: `server ${outcome.serverSha256 ?? 'not computed'}`,
    });
    const ok = outcome.state === 'completed' && outcome.checksumMatches;
    report({
      event: 'result',
      ok,
      uploadId: outcome.uploadId,
      encoding: packed.encoding,
      bytes: packed.bytes,
      rawBytes: packed.rawBytes,
      sha256: packed.sha256,
      serverSha256: outcome.serverSha256,
      index: outcome.index,
      persisted: outcome.persisted,
      persistError: outcome.persistError,
      error: outcome.error,
    });
    if (!ok) return fail(outcome.error ?? 'The server SHA-256 does not match the local package.');

    const version = outcome.index?.version ?? 'unknown';
    report({ event: 'stage', stage: 'done', message: `Checksums verified; the server now serves ${String(version)}` });
    if (!json) {
      if (outcome.persisted) console.log(`  published to ${outcome.persisted.latestManifestUrl}`);
      else if (outcome.persistError) console.log(`  WARNING: live, but not persisted: ${outcome.persistError}`);
      else console.log('  note: the server keeps the index on local disk (no D365_INDEX_PUBLISH_URL).');
    }
    return 0;
  } catch (err) {
    if (err instanceof UploadClientError || err instanceof Error) return fail(err.message);
    return fail(String(err));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
