import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ArtifactBlobContainer,
  type ArtifactBlobLease,
  type ArtifactBlobObject,
  AzureBlobArtifactStore,
} from '../src/indexer/azureBlobArtifactStore.js';
import {
  type ArtifactCompatibilityPolicy,
  RollbackHoldError,
  type ArtifactProvenance,
  type CapabilityInventory,
} from '../src/indexer/artifactContract.js';
import { AzureArtifactPublisher } from '../src/indexer/acquisitionWorker.js';
import { createArtifactBundle } from '../src/indexer/artifactBundle.js';
import { readArtifactPointers } from '../src/indexer/artifactPointers.js';
import { materializeAzureArtifactIndex } from '../src/server/artifactStartup.js';
import {
  INDEX_SCHEMA_VERSION,
  META_KEYS,
  openDb,
  openDbReadOnly,
  setMeta,
  upsertObject,
} from '../src/indexer/db.js';

const FIRST_TIME = '2026-10-03T10:00:00.000Z';
const SECOND_TIME = '2026-10-03T11:00:00.000Z';
const THIRD_TIME = '2026-10-03T12:00:00.000Z';

interface MemoryBlob {
  content: Buffer;
  etag: string;
  metadata?: Record<string, string>;
}

function storageError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`Storage request failed with ${statusCode}.`), { statusCode });
}

class MemoryBlobContainer implements ArtifactBlobContainer {
  readonly blobs = new Map<string, MemoryBlob>();
  readonly uploads: Array<{ name: string; conditions?: { ifMatch?: string; ifNoneMatch?: string } }> = [];
  failNextPointerCondition = false;
  failLeaseRenewal = false;
  private etag = 0;
  private leased = false;

  async getProperties(): Promise<void> {}

  getBlob(name: string): ArtifactBlobObject {
    return {
      getProperties: async (conditions) => {
        const blob = this.requireBlob(name);
        this.assertConditions(blob, conditions);
        return {
          contentLength: blob.content.length,
          etag: blob.etag,
          metadata: blob.metadata,
        };
      },
      uploadFile: async (source, options) => {
        this.upload(name, fs.readFileSync(source), options.conditions, options.metadata);
      },
      uploadBuffer: async (content, options) => {
        this.upload(name, content, options.conditions, options.metadata);
      },
      downloadToFile: async (target, conditions) => {
        const blob = this.requireBlob(name);
        this.assertConditions(blob, conditions);
        fs.writeFileSync(target, blob.content, { flag: 'wx' });
      },
      downloadToBuffer: async (maxBytes, conditions) => {
        const blob = this.requireBlob(name);
        this.assertConditions(blob, conditions);
        if (blob.content.length > maxBytes) throw new Error('Blob exceeds requested bound.');
        return Buffer.from(blob.content);
      },
      deleteIfExists: async () => {
        this.blobs.delete(name);
      },
      acquireLease: async () => {
        if (this.leased) throw storageError(409);
        this.leased = true;
        let released = false;
        const lease: ArtifactBlobLease = {
          renew: async () => {
            if (released || !this.leased || this.failLeaseRenewal) throw storageError(409);
          },
          release: async () => {
            if (!released) {
              released = true;
              this.leased = false;
            }
          },
        };
        return lease;
      },
    };
  }

  async *listBlobNames(prefix: string): AsyncIterable<string> {
    for (const name of [...this.blobs.keys()].sort()) {
      if (name.startsWith(prefix)) yield name;
    }
  }

  corrupt(name: string): void {
    const blob = this.requireBlob(name);
    blob.content = Buffer.concat([blob.content, Buffer.from('corrupt')]);
    blob.etag = this.nextEtag();
  }

  private upload(
    name: string,
    content: Buffer,
    conditions?: { ifMatch?: string; ifNoneMatch?: string },
    metadata?: Record<string, string>
  ): void {
    const existing = this.blobs.get(name);
    this.uploads.push({ name, conditions });
    if (name === 'deployment-pointers.json' && this.failNextPointerCondition) {
      this.failNextPointerCondition = false;
      throw storageError(412);
    }
    if (conditions?.ifNoneMatch === '*' && existing) throw storageError(412);
    if (conditions?.ifMatch !== undefined && existing?.etag !== conditions.ifMatch) {
      throw storageError(412);
    }
    if (conditions?.ifMatch !== undefined && !existing) throw storageError(412);
    this.blobs.set(name, {
      content: Buffer.from(content),
      etag: this.nextEtag(),
      metadata,
    });
  }

  private requireBlob(name: string): MemoryBlob {
    const blob = this.blobs.get(name);
    if (!blob) throw storageError(404);
    return blob;
  }

  private assertConditions(
    blob: MemoryBlob,
    conditions?: { ifMatch?: string; ifNoneMatch?: string }
  ): void {
    if (conditions?.ifMatch !== undefined && conditions.ifMatch !== blob.etag) {
      throw storageError(412);
    }
    if (conditions?.ifNoneMatch === '*') throw storageError(412);
  }

  private nextEtag(): string {
    this.etag += 1;
    return `"etag-${this.etag}"`;
  }
}

const provenance: ArtifactProvenance = {
  packagesLocalDirectory: {
    sourceId: 'packages-local-directory',
    version: '10.0.2500.1',
    acquiredAt: FIRST_TIME,
    sha256: 'a'.repeat(64),
    bytes: 1000,
  },
  vsixAssets: [
    {
      sourceId: 'unified-developer-experience-tools-vsix',
      version: '10.0.2500.1',
      acquiredAt: FIRST_TIME,
      sha256: 'b'.repeat(64),
      bytes: 2000,
    },
    {
      sourceId: 'power-platform-tools-vsix',
      version: '1.0.0.0',
      acquiredAt: FIRST_TIME,
      sha256: 'c'.repeat(64),
      bytes: 3000,
    },
  ],
  dbrefx: {
    sourceId: 'dbrefx-xref',
    version: '10.0.2500.1',
    acquiredAt: FIRST_TIME,
    sha256: 'd'.repeat(64),
    bytes: 4000,
  },
  optionalInputs: [],
};

const capabilities: CapabilityInventory = {
  codeMetadata: { completeness: 'complete', itemCount: 1 },
  dataModelMetadata: { completeness: 'complete', itemCount: 1 },
  uiFormPatterns: { completeness: 'complete', itemCount: 0 },
  workflowServiceMetadata: { completeness: 'complete', itemCount: 0 },
  reportingAnalytics: { completeness: 'partial', itemCount: 0 },
  labelsResources: { completeness: 'complete', itemCount: 0 },
  extensions: { completeness: 'complete', itemCount: 0 },
  reports: { completeness: 'partial', itemCount: 0 },
  securityGraphs: { completeness: 'complete', itemCount: 0 },
};

const policy: ArtifactCompatibilityPolicy = {
  serverVersion: '0.1.0',
  minimumIndexSchemaVersion: INDEX_SCHEMA_VERSION,
  maximumIndexSchemaVersion: INDEX_SCHEMA_VERSION,
  requiredCapabilities: ['codeMetadata', 'dataModelMetadata', 'securityGraphs'],
};

let root: string;
let sourceDatabase: string;
let container: MemoryBlobContainer;
let store: AzureBlobArtifactStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-azure-blob-'));
  sourceDatabase = path.join(root, 'source.db');
  const database = openDb(sourceDatabase);
  upsertObject(database, {
    type: 'Class',
    name: 'AzureBlobFixture',
    package: 'ApplicationSuite',
    model: 'ApplicationSuite',
    file_path: path.join(root, 'PackagesLocalDirectory', 'ApplicationSuite', 'Artifact.xml'),
    raw_xml: '<AxClass><Name>AzureBlobFixture</Name></AxClass>',
    file_mtime: 1,
  });
  setMeta(database, META_KEYS.builtAt, FIRST_TIME);
  setMeta(database, META_KEYS.serverVersion, '0.1.0');
  setMeta(database, META_KEYS.appVersion, '10.0.2500.1');
  setMeta(database, META_KEYS.appVersionSource, 'configured');
  setMeta(database, META_KEYS.schemaVersion, String(INDEX_SCHEMA_VERSION));
  setMeta(database, META_KEYS.storeRawXml, '1');
  database.close();
  container = new MemoryBlobContainer();
  store = new AzureBlobArtifactStore(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function createBundle(createdAt: string, serverVersion = '0.1') {
  return createArtifactBundle(sourceDatabase, root, {
    applicationVersion: '10.0.2500.1',
    sdkVersion: '10.0.2500.1',
    releaseId: `service-update-${createdAt.slice(11, 13)}`,
    generatorVersion: `${serverVersion}.0`,
    minimumServerVersion: `${serverVersion}.0`,
    maximumServerVersion: `${serverVersion}.99`,
    requiredCapabilities: ['codeMetadata', 'dataModelMetadata', 'securityGraphs'],
    capabilities,
    provenance,
    createdAt,
    relativePathsRoot: root,
    integrityCheck: true,
  });
}

describe('Azure Blob artifact adapter', () => {
  it('uploads immutable files with create-only conditions and materializes a validated bundle', async () => {
    const bundle = createBundle(FIRST_TIME);

    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(bundle.directory, policy);
      await writer.uploadBundle(bundle.directory, policy);
    });

    const artifactUploads = container.uploads.filter((upload) => upload.name.startsWith('bundles/'));
    expect(artifactUploads).toHaveLength(6);
    expect(artifactUploads.every((upload) => upload.conditions?.ifNoneMatch === '*')).toBe(true);

    const materialized = await store.materializeBundle(bundle.manifest.bundleId, {
      localStoreRoot: path.join(root, 'downloaded'),
      policy,
    });
    const materializedAgain = await store.materializeBundle(bundle.manifest.bundleId, {
      localStoreRoot: path.join(root, 'downloaded'),
      policy,
    });
    expect(materialized.manifest.bundleId).toBe(bundle.manifest.bundleId);
    expect(materializedAgain.directory).toBe(materialized.directory);
  });

  it('promotes and rolls back with ETag conditions while retaining active and previous bundles', async () => {
    const first = createBundle(FIRST_TIME);
    const second = createBundle(SECOND_TIME);
    const third = createBundle(THIRD_TIME);

    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(first.directory, policy);
      await writer.uploadBundle(second.directory, policy);
      await writer.uploadBundle(third.directory, policy);
      const revisionOne = await writer.promote(first.manifest.bundleId, 0, policy, FIRST_TIME);
      const revisionTwo = await writer.promote(second.manifest.bundleId, 1, policy, SECOND_TIME);
      expect(revisionOne.etag).not.toBeNull();
      expect(revisionTwo.pointers.previous?.bundleId).toBe(first.manifest.bundleId);

      await expect(writer.deleteUnreferencedBundle(first.manifest.bundleId)).rejects.toThrow(
        /active or previous/
      );
      expect(await writer.deleteUnreferencedBundle(third.manifest.bundleId)).toBe(true);

      const rolledBack = await writer.rollback(2, policy, THIRD_TIME);
      expect(rolledBack.pointers.revision).toBe(3);
      expect(rolledBack.pointers.active?.bundleId).toBe(first.manifest.bundleId);
      expect(rolledBack.pointers.previous?.bundleId).toBe(second.manifest.bundleId);
    });

    const pointerUploads = container.uploads.filter(
      (upload) => upload.name === 'deployment-pointers.json'
    );
    expect(pointerUploads[0]?.conditions).toEqual({ ifNoneMatch: '*' });
    expect(pointerUploads[1]?.conditions?.ifMatch).toMatch(/^"etag-/);
    expect(pointerUploads[2]?.conditions?.ifMatch).toMatch(/^"etag-/);
  });

  it('promotes past an active bundle the upgraded server no longer accepts, reading only its manifest', async () => {
    const first = createBundle(FIRST_TIME);
    const upgraded = createBundle(SECOND_TIME, '0.2');
    const upgradedPolicy = { ...policy, serverVersion: '0.2.0' };
    const getBlob = vi.spyOn(container, 'getBlob');

    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(first.directory, policy);
      await writer.promote(first.manifest.bundleId, 0, policy, FIRST_TIME);
      await writer.uploadBundle(upgraded.directory, upgradedPolicy);
      getBlob.mockClear();
      const promoted = await writer.promote(upgraded.manifest.bundleId, 1, upgradedPolicy, SECOND_TIME);
      expect(promoted.pointers.active?.bundleId).toBe(upgraded.manifest.bundleId);
      expect(promoted.pointers.previous?.bundleId).toBe(first.manifest.bundleId);
    });

    const firstPrefix = `bundles/${first.manifest.bundleId.slice('sha256:'.length)}/`;
    const firstReads = getBlob.mock.calls.map(([name]) => String(name)).filter((name) => name.startsWith(firstPrefix));
    expect(firstReads).toEqual([`${firstPrefix}manifest.json`]);
  });

  it('fails closed on conditional pointer conflicts without changing the active pointer', async () => {
    const bundle = createBundle(FIRST_TIME);

    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(bundle.directory, policy);
      container.failNextPointerCondition = true;
      await expect(writer.promote(bundle.manifest.bundleId, 0, policy, FIRST_TIME)).rejects.toThrow(
        /ETag changed/
      );
    });

    expect((await store.readPointers()).pointers.active).toBeNull();
  });

  it('renews the lease immediately before writing artifact pointers', async () => {
    const bundle = createBundle(FIRST_TIME);

    await store.uploadBundle(bundle.directory, policy);
    await expect(
      store.withAcquisitionLease(async (writer) => {
        container.failLeaseRenewal = true;
        await writer.promote(bundle.manifest.bundleId, 0, policy, FIRST_TIME);
      })
    ).rejects.toThrow(/lease could not be renewed/);

    expect((await store.readPointers()).pointers.active).toBeNull();
  });

  it('rejects corrupt remote content before promotion', async () => {
    const bundle = createBundle(FIRST_TIME);
    const databaseBlob =
      `bundles/${bundle.manifest.bundleId.slice('sha256:'.length)}/d365_index.db`;

    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(bundle.directory, policy);
      container.corrupt(databaseBlob);
      await expect(writer.promote(bundle.manifest.bundleId, 0, policy, FIRST_TIME)).rejects.toThrow(
        /expected/
      );
    });

    expect((await store.readPointers()).pointers.active).toBeNull();
  });

  it('rejects an incomplete remote upload before promotion', async () => {
    const bundle = createBundle(FIRST_TIME);
    const validationBlob =
      `bundles/${bundle.manifest.bundleId.slice('sha256:'.length)}/validation-report.json`;

    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(bundle.directory, policy);
      container.blobs.delete(validationBlob);
      await expect(writer.promote(bundle.manifest.bundleId, 0, policy, FIRST_TIME)).rejects.toThrow(
        /404/
      );
    });

    expect((await store.readPointers()).pointers.active).toBeNull();
  });

  it('rejects stale pointer revisions before promotion or rollback', async () => {
    const first = createBundle(FIRST_TIME);
    const second = createBundle(SECOND_TIME);

    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(first.directory, policy);
      await writer.uploadBundle(second.directory, policy);
      await writer.promote(first.manifest.bundleId, 0, policy, FIRST_TIME);
      await expect(writer.promote(second.manifest.bundleId, 0, policy, SECOND_TIME)).rejects.toThrow(
        /expected 0, current 1/
      );
      await expect(writer.rollback(0, policy, SECOND_TIME)).rejects.toThrow(/expected 0, current 1/);
    });

    expect((await store.readPointers()).pointers.active?.bundleId).toBe(first.manifest.bundleId);
  });

  it('serializes writers with the acquisition lease and releases it after failures', async () => {
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.withAcquisitionLease(async () => holdFirst);
    await expect(store.withAcquisitionLease(async () => undefined)).rejects.toThrow(
      /already in progress/
    );
    releaseFirst();
    await first;

    await expect(
      store.withAcquisitionLease(async () => {
        throw new Error('worker failed');
      })
    ).rejects.toThrow('worker failed');
    await expect(store.withAcquisitionLease(async () => 'reacquired')).resolves.toBe('reacquired');
  }, 15_000);
});

describe('Azure startup materialization', () => {
  const plenty = () => Number.MAX_SAFE_INTEGER;
  let localStore: string;
  let indexDbPath: string;

  beforeEach(() => {
    localStore = path.join(root, 'replica', 'artifacts');
    indexDbPath = path.join(root, 'replica', 'data', 'd365_index.db');
  });

  function startup(freeBytes: (directory: string) => number = plenty) {
    return materializeAzureArtifactIndex({
      store,
      storePath: localStore,
      indexDbPath,
      serverVersion: policy.serverVersion,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
      requiredCapabilities: policy.requiredCapabilities,
      freeBytes,
    });
  }

  async function publishAndPromote(...bundles: Array<ReturnType<typeof createBundle>>) {
    await store.withAcquisitionLease(async (writer) => {
      for (const [revision, bundle] of bundles.entries()) {
        await writer.uploadBundle(bundle.directory, policy);
        await writer.promote(bundle.manifest.bundleId, revision, policy, bundle.manifest.createdAt);
      }
    });
  }

  function downloadedBlobs(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map(([name]) => String(name)).filter((name) => name.endsWith('d365_index.db'));
  }

  /** The active index is the bundle's own file, and activation left no candidate behind. */
  function expectSingleLinkedCopy(prepared: Awaited<ReturnType<typeof startup>>) {
    const bundled = fs.statSync(path.join(prepared.bundle.directory, 'd365_index.db'));
    const active = fs.statSync(indexDbPath);
    expect(active.ino).toBe(bundled.ino);
    expect(active.dev).toBe(bundled.dev);
    expect(active.nlink).toBe(2);
    expect(fs.readdirSync(path.dirname(indexDbPath))).toEqual(['d365_index.db']);
  }

  function readFixtureName(): string {
    const database = openDbReadOnly(indexDbPath);
    try {
      return (database.prepare('SELECT name FROM ax_objects').get() as { name: string }).name;
    } finally {
      database.close();
    }
  }

  it('downloads, validates and activates the pinned active bundle on instance-local disk', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const pinnedEtag = (await store.readPointers()).etag;

    const prepared = await startup();

    expect(prepared.bundle.manifest.bundleId).toBe(bundle.manifest.bundleId);
    expect(prepared.pointerRevision).toBe(1);
    expect(prepared.pointerEtag).toBe(pinnedEtag);
    expect(prepared.reusedLocalBundle).toBe(false);
    expect(prepared.bundle.directory.startsWith(path.join(localStore, 'bundles'))).toBe(true);
    expect(readArtifactPointers(localStore).active?.bundleId).toBe(bundle.manifest.bundleId);
    expect(fs.readdirSync(path.join(localStore, 'bundles'))).toEqual([
      bundle.manifest.bundleId.slice('sha256:'.length),
    ]);
    expectSingleLinkedCopy(prepared);
    expect(readFixtureName()).toBe('AzureBlobFixture');
  });

  it('refuses to activate while another process holds the activation lock', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    fs.mkdirSync(path.dirname(indexDbPath), { recursive: true });
    fs.writeFileSync(`${indexDbPath}.lock`, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    await expect(startup()).rejects.toThrow(/being activated by another process/);
    // Nothing was activated, and the live lock is untouched.
    expect(fs.existsSync(indexDbPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${indexDbPath}.lock`, 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('takes over an activation lock left by a crashed process and proceeds', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    fs.mkdirSync(path.dirname(indexDbPath), { recursive: true });
    fs.writeFileSync(`${indexDbPath}.lock`, JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 20 * 60 * 1000 }));

    const prepared = await startup();
    expect(prepared.bundle.manifest.bundleId).toBe(bundle.manifest.bundleId);
    expect(readFixtureName()).toBe('AzureBlobFixture');
    expect(fs.existsSync(`${indexDbPath}.lock`)).toBe(false);
  });

  it('fails closed when the Azure store never answers (startup deadline)', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const hanging = {
      readPointers: () => new Promise<never>(() => undefined),
      materializeBundle: (...args: Parameters<typeof store.materializeBundle>) => store.materializeBundle(...args),
    };
    await expect(
      materializeAzureArtifactIndex({
        store: hanging as never,
        storePath: localStore,
        indexDbPath,
        serverVersion: policy.serverVersion,
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
        requiredCapabilities: policy.requiredCapabilities,
        freeBytes: plenty,
        timeoutMs: 50,
      })
    ).rejects.toThrow(/Timed out after/);
    // Nothing was activated.
    expect(fs.existsSync(indexDbPath)).toBe(false);
  });

  it('reuses a validated local copy and prunes superseded bundles and interrupted downloads', async () => {
    const first = createBundle(FIRST_TIME);
    const second = createBundle(SECOND_TIME);
    await publishAndPromote(first);
    await startup();
    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(second.directory, policy);
      await writer.promote(second.manifest.bundleId, 1, policy, SECOND_TIME);
    });
    fs.mkdirSync(path.join(localStore, 'bundles', '.downloading-crashed'));
    fs.writeFileSync(path.join(localStore, 'bundles', '.link-probe-1-1'), '');

    const getBlob = vi.spyOn(container, 'getBlob');
    const upgraded = await startup();
    expect(upgraded.bundle.manifest.bundleId).toBe(second.manifest.bundleId);
    expect(upgraded.reusedLocalBundle).toBe(false);
    expect(downloadedBlobs(getBlob)).toHaveLength(1);
    expect(fs.readdirSync(path.join(localStore, 'bundles'))).toEqual([
      second.manifest.bundleId.slice('sha256:'.length),
    ]);

    getBlob.mockClear();
    const restarted = await startup();
    expect(restarted.reusedLocalBundle).toBe(true);
    expect(downloadedBlobs(getBlob)).toHaveLength(0);
    // Re-activating a file over a link to itself keeps one copy and leaves no candidate.
    expectSingleLinkedCopy(restarted);
    expect(readFixtureName()).toBe('AzureBlobFixture');
  });

  it('replaces a corrupt local copy with a fresh download', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const first = await startup();
    fs.appendFileSync(path.join(first.bundle.directory, 'd365_index.db'), 'corrupt');

    const again = await startup();
    expect(again.reusedLocalBundle).toBe(false);
    expect(again.bundle.manifest.bundleId).toBe(bundle.manifest.bundleId);
    expectSingleLinkedCopy(again);
    expect(readFixtureName()).toBe('AzureBlobFixture');
  });

  it('copies and re-verifies the database when the filesystem cannot hard-link it', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });

    const prepared = await startup();

    // The capacity probe and the activation both try to link.
    expect(link).toHaveBeenCalledTimes(2);
    const bundled = path.join(prepared.bundle.directory, 'd365_index.db');
    expect(fs.statSync(indexDbPath).ino).not.toBe(fs.statSync(bundled).ino);
    expect(fs.readFileSync(indexDbPath).equals(fs.readFileSync(bundled))).toBe(true);
    expect(fs.readdirSync(path.dirname(indexDbPath))).toEqual(['d365_index.db']);
    expect(readFixtureName()).toBe('AzureBlobFixture');
  });

  it('fails closed on an unexpected hard-link error without activating anything', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const realLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync')
      .mockImplementationOnce((from, to) => realLink(from, to))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EIO: i/o error, link'), { code: 'EIO' });
      });

    await expect(startup()).rejects.toThrow(/EIO/);
    expect(fs.readdirSync(path.dirname(indexDbPath))).toEqual([]);
    expect(fs.readdirSync(path.join(localStore, 'bundles'))).toEqual([
      bundle.manifest.bundleId.slice('sha256:'.length),
    ]);
  });

  it('fails closed when the remote store has no active bundle', async () => {
    await expect(startup()).rejects.toThrow(/no active validated bundle/);
    expect(fs.existsSync(indexDbPath)).toBe(false);
  });

  it('fails closed on corrupt remote content without activating or caching it', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    container.corrupt(`bundles/${bundle.manifest.bundleId.slice('sha256:'.length)}/d365_index.db`);

    await expect(startup()).rejects.toThrow(/bytes; expected|SHA-256/);
    expect(fs.existsSync(indexDbPath)).toBe(false);
    expect(fs.readdirSync(path.join(localStore, 'bundles'))).toEqual([]);
    expect(fs.existsSync(path.join(localStore, 'deployment-pointers.json'))).toBe(false);
  });

  it('refuses to download a bundle that does not fit on local disk', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const getBlob = vi.spyOn(container, 'getBlob');

    await expect(startup(() => bundle.manifest.index.bytes)).rejects.toThrow(/Insufficient local disk/);
    expect(downloadedBlobs(getBlob)).toHaveLength(0);
    expect(fs.existsSync(indexDbPath)).toBe(false);
  });

  it('needs room for one database copy when the bundle and the index share a filesystem', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const margin = 256 * 1024 * 1024;
    const oneCopy = bundle.manifest.index.bytes + bundle.manifest.validationReport.bytes + margin;

    await expect(startup(() => oneCopy - 1)).rejects.toThrow(/Insufficient local disk/);
    const prepared = await startup(() => oneCopy);
    expectSingleLinkedCopy(prepared);
  });

  it('needs room for a second copy when the paths cannot be hard-linked, also when reusing a bundle', async () => {
    const bundle = createBundle(FIRST_TIME);
    await publishAndPromote(bundle);
    const margin = 256 * 1024 * 1024;
    const oneCopy = bundle.manifest.index.bytes + bundle.manifest.validationReport.bytes + margin;
    // Same st_dev but link(2) refuses, as across two mounts of one disk.
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    });
    const getBlob = vi.spyOn(container, 'getBlob');

    await expect(startup(() => oneCopy)).rejects.toThrow(/Insufficient local disk/);
    expect(downloadedBlobs(getBlob)).toHaveLength(0);
    await startup(() => oneCopy + bundle.manifest.index.bytes);

    // A restart reuses the local bundle without downloading, and the copy still checks its room.
    const reused = startup(() => bundle.manifest.index.bytes + margin - 1);
    await expect(reused).rejects.toThrow(/Insufficient local disk/);
    expect(fs.readdirSync(path.dirname(indexDbPath))).toEqual(['d365_index.db']);
    expect(fs.readdirSync(path.join(localStore, 'bundles'))).toEqual([
      bundle.manifest.bundleId.slice('sha256:'.length),
    ]);
  });

  it('rolls back to the first acquisition after a second one, end to end through restarts', async () => {
    // Acquisition 1 publishes and promotes; with no previous bundle there is nothing to roll back to.
    const first = createBundle(FIRST_TIME);
    await publishAndPromote(first);
    await expect(
      store.withAcquisitionLease((writer) => writer.rollback(1, policy, FIRST_TIME))
    ).rejects.toThrow(/No previous validated artifact bundle/);
    expect((await startup()).bundle.manifest.bundleId).toBe(first.manifest.bundleId);
    expect(readFixtureName()).toBe('AzureBlobFixture');

    // Acquisition 2 indexes different content, so the served index visibly changes.
    const database = openDb(sourceDatabase);
    database.prepare("UPDATE ax_objects SET name = 'SecondAcquisitionFixture'").run();
    database.close();
    const second = createBundle(SECOND_TIME);
    expect(second.manifest.bundleId).not.toBe(first.manifest.bundleId);
    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(second.directory, policy);
      await writer.promote(second.manifest.bundleId, 1, policy, SECOND_TIME);
    });
    // Promotion alone changes nothing on disk until the replica restarts.
    expect(readFixtureName()).toBe('AzureBlobFixture');
    const afterSecond = await startup();
    expect(afterSecond.bundle.manifest.bundleId).toBe(second.manifest.bundleId);
    expect(afterSecond.pointerRevision).toBe(2);
    expect(readFixtureName()).toBe('SecondAcquisitionFixture');

    // Roll back. A stale revision is refused first, then the real one swaps active and previous.
    await expect(
      store.withAcquisitionLease((writer) => writer.rollback(1, policy, THIRD_TIME))
    ).rejects.toThrow(/expected 1, current 2/);
    const rolledBack = await store.withAcquisitionLease((writer) =>
      writer.rollback(2, policy, THIRD_TIME)
    );
    expect(rolledBack.pointers.active?.bundleId).toBe(first.manifest.bundleId);
    expect(rolledBack.pointers.previous?.bundleId).toBe(second.manifest.bundleId);
    expect(readFixtureName()).toBe('SecondAcquisitionFixture');

    // The restart pulls the first bundle again (its local copy was pruned) and serves its content.
    const getBlob = vi.spyOn(container, 'getBlob');
    const afterRollback = await startup();
    expect(afterRollback.bundle.manifest.bundleId).toBe(first.manifest.bundleId);
    expect(afterRollback.pointerRevision).toBe(3);
    expect(afterRollback.reusedLocalBundle).toBe(false);
    expect(downloadedBlobs(getBlob)).toHaveLength(1);
    expectSingleLinkedCopy(afterRollback);
    expect(readFixtureName()).toBe('AzureBlobFixture');
    expect(fs.readdirSync(path.join(localStore, 'bundles'))).toEqual([
      first.manifest.bundleId.slice('sha256:'.length),
    ]);

    // Rolling back again rolls forward to the second bundle, without rebuilding anything.
    const rolledForward = await store.withAcquisitionLease((writer) =>
      writer.rollback(3, policy, THIRD_TIME)
    );
    expect(rolledForward.pointers.active?.bundleId).toBe(second.manifest.bundleId);
    expect(rolledForward.pointers.previous?.bundleId).toBe(first.manifest.bundleId);
    expect((await startup()).bundle.manifest.bundleId).toBe(second.manifest.bundleId);
    expect(readFixtureName()).toBe('SecondAcquisitionFixture');
  });

  it('keeps a rollback in place when the scheduled run promotes, until promote or clear-rollback', async () => {
    const first = createBundle(FIRST_TIME);
    const second = createBundle(SECOND_TIME);
    const third = createBundle(THIRD_TIME);
    const fourth = createBundle('2026-10-03T13:00:00.000Z');

    await store.withAcquisitionLease(async (writer) => {
      for (const bundle of [first, second, third, fourth]) await writer.uploadBundle(bundle.directory, policy);
      await writer.promote(first.manifest.bundleId, 0, policy, FIRST_TIME);
      await writer.promote(second.manifest.bundleId, 1, policy, SECOND_TIME);
      const rolledBack = await writer.rollback(2, policy, THIRD_TIME);
      expect(rolledBack.pointers.rollbackHold?.supersededBundleId).toBe(second.manifest.bundleId);

      await expect(writer.promote(third.manifest.bundleId, 3, policy)).rejects.toThrow(RollbackHoldError);
      expect((await store.readPointers()).pointers).toEqual(rolledBack.pointers);

      await expect(writer.clearRollbackHold(2)).rejects.toThrow(/expected 2, current 3/);
      const cleared = await writer.clearRollbackHold(3);
      expect(cleared.pointers.revision).toBe(4);
      expect(cleared.pointers.rollbackHold).toBeUndefined();
      expect((await writer.promote(third.manifest.bundleId, 4, policy)).pointers.active?.bundleId).toBe(
        third.manifest.bundleId
      );

      await writer.rollback(5, policy);
      const intentional = await writer.promote(fourth.manifest.bundleId, 6, policy, undefined, {
        intentional: true,
      });
      expect(intentional.pointers.active?.bundleId).toBe(fourth.manifest.bundleId);
      expect(intentional.pointers.rollbackHold).toBeUndefined();
    });
  });

  it('uploads but does not promote when the nightly publisher meets a rollback hold', async () => {
    const first = createBundle(FIRST_TIME);
    const second = createBundle(SECOND_TIME);
    const nightly = createBundle(THIRD_TIME);
    await store.withAcquisitionLease(async (writer) => {
      await writer.uploadBundle(first.directory, policy);
      await writer.uploadBundle(second.directory, policy);
      await writer.promote(first.manifest.bundleId, 0, policy, FIRST_TIME);
      await writer.promote(second.manifest.bundleId, 1, policy, SECOND_TIME);
      await writer.rollback(2, policy, THIRD_TIME);
    });

    const result = await new AzureArtifactPublisher(store).publish(nightly, policy, new AbortController().signal);

    expect(result).toEqual({ revision: 3, heldByRollback: true });
    const pointers = (await store.readPointers()).pointers;
    expect(pointers.active?.bundleId).toBe(first.manifest.bundleId);
    expect([...container.blobs.keys()].some((name) => name.includes(nightly.manifest.bundleId.slice(7)))).toBe(true);
  });

  it('prunes old bundles but always keeps active, previous and the rolled-back-from bundle', async () => {
    const hour = (n: number) => `2026-10-03T${String(n).padStart(2, '0')}:00:00.000Z`;
    const bundles = [10, 11, 12, 13, 14, 15].map((n) => createBundle(hour(n)));
    const [b0, b1, b2, b3, b4, b5] = bundles;
    const now = new Date('2026-10-10T00:00:00.000Z');

    await store.withAcquisitionLease(async (writer) => {
      for (const bundle of bundles) await writer.uploadBundle(bundle.directory, policy);
      await writer.promote(b0.manifest.bundleId, 0, policy, hour(10));
      await writer.promote(b1.manifest.bundleId, 1, policy, hour(11));
      await writer.promote(b2.manifest.bundleId, 2, policy, hour(12));
      await writer.rollback(3, policy, hour(13)); // active b1, previous b2 (bad), hold on b2

      const dry = await writer.pruneBundles({ keepRecent: 1, now, dryRun: true });
      expect(dry.deleted.sort()).toEqual([b0, b3, b4].map((b) => b.manifest.bundleId).sort());
      expect(container.blobs.size).toBeGreaterThan(0);

      const pruned = await writer.pruneBundles({ keepRecent: 1, now });
      expect(pruned.deleted.sort()).toEqual([b0, b3, b4].map((b) => b.manifest.bundleId).sort());
      expect(pruned.kept).toEqual(expect.arrayContaining([b1, b2, b5].map((b) => b.manifest.bundleId)));
    });

    const remaining = (id: string) =>
      [...container.blobs.keys()].some((name) => name.startsWith(`bundles/${id.slice(7)}/`));
    expect(remaining(b1.manifest.bundleId)).toBe(true);
    expect(remaining(b2.manifest.bundleId)).toBe(true);
    expect(remaining(b0.manifest.bundleId)).toBe(false);
    expect(remaining(b3.manifest.bundleId)).toBe(false);
    expect(remaining(b5.manifest.bundleId)).toBe(true);
    // Rollback still works after pruning: the bundle it needs was kept.
    await store.withAcquisitionLease(async (writer) => {
      expect((await writer.rollback(4, policy)).pointers.active?.bundleId).toBe(b2.manifest.bundleId);
    });
  });

  it('does not prune a bundle younger than the minimum age', async () => {
    const old = createBundle(FIRST_TIME);
    const recent = createBundle(SECOND_TIME);
    const active = createBundle(THIRD_TIME);
    await store.withAcquisitionLease(async (writer) => {
      for (const bundle of [old, recent, active]) await writer.uploadBundle(bundle.directory, policy);
      await writer.promote(active.manifest.bundleId, 0, policy, THIRD_TIME);
      const result = await writer.pruneBundles({
        keepRecent: 0,
        minAgeHours: 24,
        now: new Date('2026-10-04T10:30:00.000Z'), // old is 24.5h, recent is 23.5h
      });
      expect(result.deleted).toEqual([old.manifest.bundleId]);
    });
  });
});
