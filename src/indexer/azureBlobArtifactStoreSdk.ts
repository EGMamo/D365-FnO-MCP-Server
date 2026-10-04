import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobServiceClient,
  type BlockBlobClient,
  type ContainerClient,
} from '@azure/storage-blob';
import {
  type ArtifactBlobContainer,
  type ArtifactBlobLease,
  type ArtifactBlobObject,
  AzureBlobArtifactStore,
} from './azureBlobArtifactStore.js';

interface BlobConditions {
  ifMatch?: string;
  ifNoneMatch?: string;
}

interface UploadOptions {
  conditions?: BlobConditions;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface AzureBlobArtifactStoreOptions {
  accountUrl: string;
  containerName: string;
  managedIdentityClientId?: string;
}

class AzureSdkBlobLease implements ArtifactBlobLease {
  constructor(private readonly lease: ReturnType<BlockBlobClient['getBlobLeaseClient']>) {}

  async renew(): Promise<void> {
    await this.lease.renewLease();
  }

  async release(): Promise<void> {
    await this.lease.releaseLease();
  }
}

class AzureSdkBlobObject implements ArtifactBlobObject {
  constructor(private readonly blob: BlockBlobClient) {}

  async getProperties(conditions?: BlobConditions) {
    const properties = await this.blob.getProperties({ conditions });
    return {
      contentLength: properties.contentLength,
      etag: properties.etag,
      metadata: properties.metadata,
    };
  }

  async uploadFile(source: string, options: UploadOptions): Promise<void> {
    await this.blob.uploadFile(source, {
      conditions: options.conditions,
      blobHTTPHeaders: { blobContentType: options.contentType },
      metadata: options.metadata,
    });
  }

  async uploadBuffer(content: Buffer, options: UploadOptions): Promise<void> {
    await this.blob.uploadData(content, {
      conditions: options.conditions,
      blobHTTPHeaders: { blobContentType: options.contentType },
      metadata: options.metadata,
    });
  }

  async downloadToFile(target: string, conditions?: BlobConditions): Promise<void> {
    await this.blob.downloadToFile(target, 0, undefined, {
      conditions,
      maxRetryRequests: 5,
    });
  }

  async downloadToBuffer(maxBytes: number, conditions?: BlobConditions): Promise<Buffer> {
    const properties = await this.getProperties(conditions);
    if (properties.contentLength === undefined) throw new Error('Blob did not report a content length.');
    if (properties.contentLength > maxBytes) {
      throw new Error(`Blob size ${properties.contentLength} exceeds the ${maxBytes}-byte limit.`);
    }
    return this.blob.downloadToBuffer(0, properties.contentLength, { conditions });
  }

  async deleteIfExists(): Promise<void> {
    await this.blob.deleteIfExists({ deleteSnapshots: 'include' });
  }

  async acquireLease(durationSeconds: number): Promise<ArtifactBlobLease> {
    const lease = this.blob.getBlobLeaseClient();
    await lease.acquireLease(durationSeconds);
    return new AzureSdkBlobLease(lease);
  }
}

class AzureSdkBlobContainer implements ArtifactBlobContainer {
  constructor(private readonly container: ContainerClient) {}

  async getProperties(): Promise<void> {
    await this.container.getProperties();
  }

  getBlob(name: string): ArtifactBlobObject {
    return new AzureSdkBlobObject(this.container.getBlockBlobClient(name));
  }

  async *listBlobNames(prefix: string): AsyncIterable<string> {
    for await (const blob of this.container.listBlobsFlat({ prefix })) yield blob.name;
  }
}

export function createAzureBlobArtifactStore(
  options: AzureBlobArtifactStoreOptions
): AzureBlobArtifactStore {
  const accountUrl = new URL(options.accountUrl);
  if (
    accountUrl.protocol !== 'https:' ||
    accountUrl.username ||
    accountUrl.password ||
    accountUrl.search ||
    accountUrl.hash
  ) {
    throw new Error(
      'Azure Storage account URL must be an HTTPS origin without credentials or query parameters.'
    );
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(options.containerName)) {
    throw new Error(`Invalid Azure Blob container name: ${options.containerName}`);
  }
  const credential = new DefaultAzureCredential({
    managedIdentityClientId: options.managedIdentityClientId,
  });
  const service = new BlobServiceClient(accountUrl.toString(), credential);
  return new AzureBlobArtifactStore(
    new AzureSdkBlobContainer(service.getContainerClient(options.containerName))
  );
}
