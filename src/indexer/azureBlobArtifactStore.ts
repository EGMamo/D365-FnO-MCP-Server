import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_CONTRACT_NAME,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_DATABASE_FILE,
  ARTIFACT_MANIFEST_FILE,
  ARTIFACT_POINTERS_FILE,
  ARTIFACT_VALIDATION_FILE,
  type ArtifactCompatibilityPolicy,
  type ArtifactPointers,
  canonicalJson,
  parseArtifactManifest,
  parseArtifactPointers,
  sha256File,
} from './artifactContract.js';
import {
  artifactBundleDirectory,
  publishStagedArtifactDirectory,
  type ValidatedArtifactBundle,
  validateArtifactBundle,
} from './artifactBundle.js';

const ACQUISITION_LOCK_BLOB = 'locks/acquisition';
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const LEASE_DURATION_SECONDS = 60;
const LEASE_RENEWAL_MILLISECONDS = 40_000;

interface BlobConditions {
  ifMatch?: string;
  ifNoneMatch?: string;
}

interface BlobProperties {
  contentLength?: number;
  etag?: string;
  metadata?: Record<string, string>;
}

interface UploadOptions {
  conditions?: BlobConditions;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface ArtifactBlobObject {
  getProperties(conditions?: BlobConditions): Promise<BlobProperties>;
  uploadFile(source: string, options: UploadOptions): Promise<void>;
  uploadBuffer(content: Buffer, options: UploadOptions): Promise<void>;
  downloadToFile(target: string, conditions?: BlobConditions): Promise<void>;
  downloadToBuffer(maxBytes: number, conditions?: BlobConditions): Promise<Buffer>;
  deleteIfExists(): Promise<void>;
  acquireLease(durationSeconds: number): Promise<ArtifactBlobLease>;
}

export interface ArtifactBlobLease {
  renew(): Promise<void>;
  release(): Promise<void>;
}

export interface ArtifactBlobContainer {
  getProperties(): Promise<void>;
  getBlob(name: string): ArtifactBlobObject;
  listBlobNames(prefix: string): AsyncIterable<string>;
}

export interface ArtifactPointerSnapshot {
  pointers: ArtifactPointers;
  etag: string | null;
}

export interface MaterializeArtifactBundleOptions {
  localStoreRoot: string;
  policy: ArtifactCompatibilityPolicy;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

function isConflict(error: unknown): boolean {
  return statusCode(error) === 409 || statusCode(error) === 412;
}

function isNotFound(error: unknown): boolean {
  return statusCode(error) === 404;
}

function requireEtag(etag: string | undefined, label: string): string {
  if (!etag) throw new Error(`${label} did not return an ETag.`);
  return etag;
}

function emptyPointers(now = new Date().toISOString()): ArtifactPointers {
  return {
    contract: ARTIFACT_CONTRACT_NAME,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    revision: 0,
    updatedAt: now,
    active: null,
    previous: null,
  };
}

function bundlePrefix(bundleId: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(bundleId)) throw new Error(`Invalid artifact bundle ID: ${bundleId}`);
  return `bundles/${bundleId.slice('sha256:'.length)}`;
}

function assertExpectedRevision(snapshot: ArtifactPointerSnapshot, expectedRevision: number): void {
  if (snapshot.pointers.revision !== expectedRevision) {
    throw new Error(
      `Artifact pointer revision changed: expected ${expectedRevision}, ` +
        `current ${snapshot.pointers.revision}.`
    );
  }
}

function contentType(file: string): string {
  if (file.endsWith('.json')) return 'application/json';
  return 'application/vnd.sqlite3';
}

export class AzureBlobArtifactStore {
  constructor(private readonly container: ArtifactBlobContainer) {}

  async verifyContainer(): Promise<void> {
    await this.container.getProperties();
  }

  async readPointers(): Promise<ArtifactPointerSnapshot> {
    const blob = this.container.getBlob(ARTIFACT_POINTERS_FILE);
    let properties: BlobProperties;
    try {
      properties = await blob.getProperties();
    } catch (error) {
      if (isNotFound(error)) return { pointers: emptyPointers(), etag: null };
      throw error;
    }
    const etag = requireEtag(properties.etag, 'Artifact pointer read');
    if (properties.contentLength === undefined) {
      throw new Error('Artifact pointer blob did not report a content length.');
    }
    if (properties.contentLength > MAX_POINTER_BYTES) {
      throw new Error(`Artifact pointer blob exceeds the ${MAX_POINTER_BYTES}-byte limit.`);
    }
    const content = await blob.downloadToBuffer(MAX_POINTER_BYTES, { ifMatch: etag });
    return {
      pointers: parseArtifactPointers(JSON.parse(content.toString('utf8')) as unknown),
      etag,
    };
  }

  async materializeBundle(
    bundleId: string,
    options: MaterializeArtifactBundleOptions
  ): Promise<ValidatedArtifactBundle> {
    const prefix = bundlePrefix(bundleId);
    const manifestBlob = this.container.getBlob(`${prefix}/${ARTIFACT_MANIFEST_FILE}`);
    const manifestProperties = await manifestBlob.getProperties();
    const manifestEtag = requireEtag(manifestProperties.etag, 'Artifact manifest read');
    const manifestBytes = await manifestBlob.downloadToBuffer(MAX_MANIFEST_BYTES, {
      ifMatch: manifestEtag,
    });
    const manifest = parseArtifactManifest(JSON.parse(manifestBytes.toString('utf8')) as unknown);
    if (manifest.bundleId !== bundleId) {
      throw new Error(
        `Requested artifact bundle ${bundleId} but the manifest identifies ${manifest.bundleId}.`
      );
    }

    const root = path.resolve(options.localStoreRoot);
    const bundles = path.join(root, 'bundles');
    fs.mkdirSync(bundles, { recursive: true });
    const staging = fs.mkdtempSync(path.join(bundles, '.downloading-'));
    try {
      fs.writeFileSync(path.join(staging, ARTIFACT_MANIFEST_FILE), manifestBytes, {
        flag: 'wx',
        mode: 0o600,
      });
      await this.downloadExactFile(
        `${prefix}/${ARTIFACT_VALIDATION_FILE}`,
        path.join(staging, ARTIFACT_VALIDATION_FILE),
        manifest.validationReport.bytes,
        manifest.validationReport.sha256
      );
      await this.downloadExactFile(
        `${prefix}/${ARTIFACT_DATABASE_FILE}`,
        path.join(staging, ARTIFACT_DATABASE_FILE),
        manifest.index.bytes,
        manifest.index.sha256
      );

      const finalDirectory = artifactBundleDirectory(root, bundleId);
      publishStagedArtifactDirectory(staging, finalDirectory);
      return validateArtifactBundle(finalDirectory, options.policy);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async withAcquisitionLease<T>(
    action: (writer: AzureBlobArtifactWriter) => Promise<T>
  ): Promise<T> {
    const lockBlob = this.container.getBlob(ACQUISITION_LOCK_BLOB);
    try {
      await lockBlob.uploadBuffer(Buffer.alloc(0), {
        conditions: { ifNoneMatch: '*' },
        contentType: 'application/octet-stream',
        metadata: { purpose: 'acquisition-serialization' },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }

    let lease: ArtifactBlobLease;
    try {
      lease = await lockBlob.acquireLease(LEASE_DURATION_SECONDS);
    } catch (error) {
      if (isConflict(error)) throw new Error('An artifact acquisition run is already in progress.');
      throw error;
    }

    let renewalError: unknown;
    let renewalInFlight: Promise<void> | undefined;
    const renewal = setInterval(() => {
      renewalInFlight = lease.renew().catch((error: unknown) => {
        renewalError = error;
      });
    }, LEASE_RENEWAL_MILLISECONDS);
    renewal.unref();

    const assertLeaseHealthy = (): void => {
      if (renewalError) {
        throw new Error('The Azure Blob acquisition lease could not be renewed.', {
          cause: renewalError,
        });
      }
    };

    try {
      return await action(new AzureBlobArtifactWriter(this, this.container, assertLeaseHealthy));
    } finally {
      clearInterval(renewal);
      await renewalInFlight;
      await lease.release();
    }
  }

  private async downloadExactFile(
    blobName: string,
    target: string,
    expectedBytes: number,
    expectedSha256: string
  ): Promise<void> {
    const blob = this.container.getBlob(blobName);
    const properties = await blob.getProperties();
    const etag = requireEtag(properties.etag, `Artifact blob ${blobName}`);
    if (properties.contentLength !== expectedBytes) {
      throw new Error(
        `Artifact blob ${blobName} is ${properties.contentLength ?? '<unknown>'} bytes; ` +
          `expected ${expectedBytes}.`
      );
    }
    await blob.downloadToFile(target, { ifMatch: etag });
    const actualBytes = fs.statSync(target).size;
    const actualSha256 = sha256File(target);
    if (actualBytes !== expectedBytes || actualSha256 !== expectedSha256) {
      throw new Error(`Artifact blob ${blobName} failed size or SHA-256 verification.`);
    }
  }
}

export class AzureBlobArtifactWriter {
  constructor(
    private readonly store: AzureBlobArtifactStore,
    private readonly container: ArtifactBlobContainer,
    private readonly assertLeaseHealthy: () => void
  ) {}

  async uploadBundle(
    directory: string,
    policy: ArtifactCompatibilityPolicy
  ): Promise<ValidatedArtifactBundle> {
    this.assertLeaseHealthy();
    const validated = validateArtifactBundle(directory, policy);
    const prefix = bundlePrefix(validated.manifest.bundleId);
    const files = [
      {
        name: ARTIFACT_DATABASE_FILE,
        bytes: validated.manifest.index.bytes,
        sha256: validated.manifest.index.sha256,
      },
      {
        name: ARTIFACT_VALIDATION_FILE,
        bytes: validated.manifest.validationReport.bytes,
        sha256: validated.manifest.validationReport.sha256,
      },
      {
        name: ARTIFACT_MANIFEST_FILE,
        bytes: fs.statSync(path.join(directory, ARTIFACT_MANIFEST_FILE)).size,
        sha256: sha256File(path.join(directory, ARTIFACT_MANIFEST_FILE)),
      },
    ];

    for (const file of files) {
      this.assertLeaseHealthy();
      const source = path.join(validated.directory, file.name);
      const blobName = `${prefix}/${file.name}`;
      const blob = this.container.getBlob(blobName);
      try {
        await blob.uploadFile(source, {
          conditions: { ifNoneMatch: '*' },
          contentType: contentType(file.name),
          metadata: {
            bundleid: validated.manifest.bundleId.slice('sha256:'.length),
            sha256: file.sha256,
            bytes: String(file.bytes),
            contractversion: String(validated.manifest.contractVersion),
          },
        });
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
      await this.verifyRemoteFile(blobName, file.bytes, file.sha256);
    }
    return validated;
  }

  async promote(
    bundleId: string,
    expectedRevision: number,
    policy: ArtifactCompatibilityPolicy,
    promotedAt = new Date().toISOString()
  ): Promise<ArtifactPointerSnapshot> {
    this.assertLeaseHealthy();
    await this.validateRemoteBundle(bundleId, policy);
    const current = await this.store.readPointers();
    assertExpectedRevision(current, expectedRevision);
    if (current.pointers.active?.bundleId === bundleId) return current;
    const next: ArtifactPointers = {
      contract: ARTIFACT_CONTRACT_NAME,
      contractVersion: ARTIFACT_CONTRACT_VERSION,
      revision: current.pointers.revision + 1,
      updatedAt: promotedAt,
      active: { bundleId, promotedAt },
      previous: current.pointers.active,
    };
    return this.writePointers(next, current.etag);
  }

  async rollback(
    expectedRevision: number,
    policy: ArtifactCompatibilityPolicy,
    promotedAt = new Date().toISOString()
  ): Promise<ArtifactPointerSnapshot> {
    this.assertLeaseHealthy();
    const current = await this.store.readPointers();
    assertExpectedRevision(current, expectedRevision);
    if (!current.pointers.previous) {
      throw new Error('No previous validated artifact bundle is available.');
    }
    await this.validateRemoteBundle(current.pointers.previous.bundleId, policy);
    const next: ArtifactPointers = {
      contract: ARTIFACT_CONTRACT_NAME,
      contractVersion: ARTIFACT_CONTRACT_VERSION,
      revision: current.pointers.revision + 1,
      updatedAt: promotedAt,
      active: {
        bundleId: current.pointers.previous.bundleId,
        promotedAt,
      },
      previous: current.pointers.active,
    };
    return this.writePointers(next, current.etag);
  }

  async deleteUnreferencedBundle(bundleId: string): Promise<boolean> {
    this.assertLeaseHealthy();
    const prefix = `${bundlePrefix(bundleId)}/`;
    const before = await this.store.readPointers();
    if (
      before.pointers.active?.bundleId === bundleId ||
      before.pointers.previous?.bundleId === bundleId
    ) {
      throw new Error(`Cannot delete active or previous artifact bundle ${bundleId}.`);
    }
    const blobNames: string[] = [];
    for await (const name of this.container.listBlobNames(prefix)) blobNames.push(name);
    const after = await this.store.readPointers();
    if (after.etag !== before.etag) {
      throw new Error('Artifact pointers changed while evaluating bundle retention.');
    }
    this.assertLeaseHealthy();
    for (const name of blobNames) await this.container.getBlob(name).deleteIfExists();
    return blobNames.length > 0;
  }

  private async validateRemoteBundle(
    bundleId: string,
    policy: ArtifactCompatibilityPolicy
  ): Promise<void> {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-azure-artifact-'));
    try {
      await this.store.materializeBundle(bundleId, { localStoreRoot: temporary, policy });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }

  private async verifyRemoteFile(
    blobName: string,
    expectedBytes: number,
    expectedSha256: string
  ): Promise<void> {
    const temporary = path.join(
      os.tmpdir(),
      `.d365-blob-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const blob = this.container.getBlob(blobName);
    try {
      const properties = await blob.getProperties();
      const etag = requireEtag(properties.etag, `Uploaded artifact blob ${blobName}`);
      if (properties.contentLength !== expectedBytes) {
        throw new Error(`Uploaded artifact blob ${blobName} has an unexpected size.`);
      }
      await blob.downloadToFile(temporary, { ifMatch: etag });
      if (fs.statSync(temporary).size !== expectedBytes || sha256File(temporary) !== expectedSha256) {
        throw new Error(`Uploaded artifact blob ${blobName} failed verification.`);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private async writePointers(
    pointers: ArtifactPointers,
    expectedEtag: string | null
  ): Promise<ArtifactPointerSnapshot> {
    this.assertLeaseHealthy();
    const checkedPointers = parseArtifactPointers(pointers);
    const blob = this.container.getBlob(ARTIFACT_POINTERS_FILE);
    try {
      await blob.uploadBuffer(Buffer.from(canonicalJson(checkedPointers)), {
        conditions: expectedEtag === null ? { ifNoneMatch: '*' } : { ifMatch: expectedEtag },
        contentType: 'application/json',
        metadata: {
          contractversion: String(checkedPointers.contractVersion),
          revision: String(checkedPointers.revision),
        },
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new Error('Artifact pointer ETag changed during conditional promotion.', {
          cause: error,
        });
      }
      throw error;
    }
    const properties = await blob.getProperties();
    return {
      pointers: checkedPointers,
      etag: requireEtag(properties.etag, 'Artifact pointer write'),
    };
  }
}
