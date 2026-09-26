import fs from 'node:fs';
import { redactUrl, type IndexManifest } from './remoteIndex.js';

/**
 * Minimal Azure Blob Storage writer over the REST API, authorised by a
 * container SAS URL (`https://<account>.blob.core.windows.net/<container>?<sas>`
 * with create and write permissions). Only `fetch` is used, like the reader in
 * `remoteIndex.ts`; no URL is logged or reported with its query string.
 */

const API_VERSION = '2021-08-06';
/** Blocks are read into memory one at a time; 32 MiB keeps that bounded. */
export const DEFAULT_BLOCK_BYTES = 32 * 1024 * 1024;

export interface BlobWriteOptions {
  fetchImpl?: typeof fetch;
  blockBytes?: number;
  contentType?: string;
}

/** URL of blob `name` inside the container, carrying the container's SAS. */
export function blobUrl(containerUrl: string, name: string): URL {
  const url = new URL(containerUrl);
  const encoded = name.split('/').map(encodeURIComponent).join('/');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encoded}`;
  return url;
}

function withParams(url: URL, params: Record<string, string>): URL {
  const copy = new URL(url);
  for (const [key, value] of Object.entries(params)) copy.searchParams.set(key, value);
  return copy;
}

async function put(fetchImpl: typeof fetch, url: URL, body: Uint8Array | string, headers: Record<string, string>): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      headers: { 'x-ms-version': API_VERSION, ...headers },
      // Buffers are valid fetch bodies; the DOM typings only accept ArrayBuffer-backed views.
      body: body as BodyInit,
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch (err) {
    throw new Error(`Blob write to ${redactUrl(url)} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new Error(`Blob write to ${redactUrl(url)} failed with HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
  }
}

/** Writes a small blob in one request. */
export async function putBlobText(containerUrl: string, name: string, text: string, options: BlobWriteOptions = {}): Promise<void> {
  await put(options.fetchImpl ?? fetch, blobUrl(containerUrl, name), text, {
    'x-ms-blob-type': 'BlockBlob',
    'content-type': options.contentType ?? 'application/json',
  });
}

/** Uploads a file of any size as staged blocks committed by one block list. */
export async function putBlobFile(containerUrl: string, name: string, file: string, options: BlobWriteOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const blockBytes = options.blockBytes ?? DEFAULT_BLOCK_BYTES;
  const target = blobUrl(containerUrl, name);
  const size = fs.statSync(file).size;
  const ids: string[] = [];
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(blockBytes, Math.max(size, 1)));
    for (let offset = 0, index = 0; offset < size; offset += blockBytes, index++) {
      const length = Math.min(blockBytes, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error(`Short read from ${file} at ${offset}`);
      // Block IDs must be base64 and all the same length within a blob.
      const id = Buffer.from(`block-${String(index).padStart(8, '0')}`).toString('base64');
      await put(fetchImpl, withParams(target, { comp: 'block', blockid: id }), buffer.subarray(0, length), {
        'content-length': String(length),
      });
      ids.push(id);
    }
  } finally {
    await handle.close();
  }
  const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
  await put(fetchImpl, withParams(target, { comp: 'blocklist' }), list, {
    'content-type': 'application/xml',
    'x-ms-blob-content-type': options.contentType ?? 'application/octet-stream',
  });
}

/**
 * Publishes a packaged index into the container with the same layout as
 * `publish-index` + `scripts/publish-index.ps1`: the version folder first and
 * `latest/manifest.json` last, so readers never follow a half-written version.
 * `manifest.db.url` must be the bare file name of the package.
 */
export async function publishToContainer(
  containerUrl: string,
  packageFile: string,
  manifest: IndexManifest,
  options: BlobWriteOptions = {}
): Promise<{ latestManifestUrl: string }> {
  const fileName = manifest.db.url;
  if (fileName.includes('/')) throw new Error('The manifest must name the package by its bare file name.');
  const { version } = manifest;
  await putBlobFile(containerUrl, `${version}/${fileName}`, packageFile, options);
  await putBlobText(containerUrl, `${version}/manifest.json`, JSON.stringify(manifest, null, 2), options);
  const latest: IndexManifest = { ...manifest, db: { ...manifest.db, url: `../${version}/${fileName}` } };
  await putBlobText(containerUrl, 'latest/manifest.json', JSON.stringify(latest, null, 2), options);
  return { latestManifestUrl: redactUrl(blobUrl(containerUrl, 'latest/manifest.json')) };
}
