import { KeyRegistryConflictError, parseRegistryDocument, type RegistryStore } from './keyRegistry.js';

/** The registry blob's name inside its container. */
export const REGISTRY_BLOB_NAME = 'key-registry.json';

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
        const chunks: Buffer[] = [];
        for await (const chunk of response.readableStreamBody ?? []) chunks.push(Buffer.from(chunk as Uint8Array));
        return { body: Buffer.concat(chunks).toString('utf8'), etag: response.etag ?? '' };
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
