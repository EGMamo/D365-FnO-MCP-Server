import { KeyRegistryConflictError, KeyRegistryError, parseRegistryDocument, type RegistryStore } from './keyRegistry.js';

/** The registry blob's name inside its container. */
const REGISTRY_BLOB_NAME = 'key-registry.json';

/** Largest registry body a replica reads, matching the file store's cap (a hostile blob must not exhaust memory). */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads a registry blob body into memory with a hard cap. The declared length is checked first, and
 * the accumulated bytes again while streaming, so a planted multi-gigabyte blob is refused instead
 * of buffered. Exported for tests.
 */
export async function collectRegistryBody(
  declaredLength: number | undefined,
  stream: AsyncIterable<string | Uint8Array>,
  maxBytes: number = MAX_BODY_BYTES
): Promise<Buffer> {
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    throw new KeyRegistryError('The key registry blob is larger than 1 MiB.');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new KeyRegistryError('The key registry blob is larger than 1 MiB.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** The two operations the store needs from a blob, so tests can stand in for Azure. */
export interface RegistryBlob {
  /** The body and its ETag, or null when the blob does not exist. */
  download(): Promise<{ body: string; etag: string } | null>;
  /** Uploads under the condition; `'conflict'` when it does not hold (HTTP 409 or 412). */
  upload(body: string, condition: { ifMatch?: string; ifNoneMatch?: '*' }): Promise<{ etag: string } | 'conflict'>;
}

/** The key registry in an Azure blob. The version is the blob's ETag; writes are conditional on it. */
export function createBlobRegistryStore(blob: RegistryBlob): RegistryStore {
  return {
    kind: 'azure-blob',
    async read() {
      const downloaded = await blob.download();
      return downloaded === null
        ? { document: null, version: null }
        : { document: parseRegistryDocument(downloaded.body), version: downloaded.etag };
    },
    async write(document, expected) {
      const result = await blob.upload(
        `${JSON.stringify(document, null, 2)}\n`,
        expected === null ? { ifNoneMatch: '*' } : { ifMatch: expected }
      );
      if (result === 'conflict') throw new KeyRegistryConflictError();
      return result.etag;
    },
  };
}

/**
 * The real blob: `https://<account>.blob.core.windows.net/<container>/key-registry.json` through
 * `DefaultAzureCredential` (the server's managed identity on Azure, the Azure CLI sign-in on an operator's machine).
 */
export async function azureRegistryBlob(accountUrl: string, container: string, managedIdentityClientId?: string): Promise<RegistryBlob> {
  const [{ DefaultAzureCredential }, { BlobServiceClient, RestError }] = await Promise.all([
    import('@azure/identity'),
    import('@azure/storage-blob'),
  ]);
  const credential = new DefaultAzureCredential(managedIdentityClientId ? { managedIdentityClientId } : {});
  const client = new BlobServiceClient(accountUrl, credential).getContainerClient(container).getBlockBlobClient(REGISTRY_BLOB_NAME);
  const statusOf = (error: unknown): number | undefined => (error instanceof RestError ? error.statusCode : undefined);
  return {
    async download() {
      try {
        // One response carries both the body and its ETag, so the two always belong together.
        const response = await client.download();
        // A size check before reading, so a planted multi-gigabyte blob is refused instead of buffered.
        const body = await collectRegistryBody(
          response.contentLength,
          response.readableStreamBody ?? (async function* () {})()
        );
        return { body: body.toString('utf8'), etag: response.etag ?? '' };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
    async upload(body, condition) {
      try {
        const response = await client.upload(body, Buffer.byteLength(body), {
          conditions: condition,
          blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' },
        });
        return { etag: response.etag ?? '' };
      } catch (error) {
        const status = statusOf(error);
        if (status === 409 || status === 412) return 'conflict';
        throw error;
      }
    },
  };
}

export { KeyRegistryConflictError };
