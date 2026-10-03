import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTIFACT_DATABASE_FILE,
  ARTIFACT_VALIDATION_FILE,
  type ArtifactCompatibilityPolicy,
  type ArtifactProvenance,
  type CapabilityInventory,
} from '../src/indexer/artifactContract.js';
import {
  artifactBundleDirectory,
  createArtifactBundle,
  stageAndActivateArtifactBundle,
  validateArtifactBundle,
} from '../src/indexer/artifactBundle.js';
import {
  promoteArtifactBundle,
  readArtifactPointers,
  rollbackArtifactBundle,
} from '../src/indexer/artifactPointers.js';
import {
  INDEX_SCHEMA_VERSION,
  META_KEYS,
  openDb,
  openDbReadOnly,
  setMeta,
  upsertObject,
} from '../src/indexer/db.js';
import { prepareArtifactBackedIndex } from '../src/server/artifactStartup.js';

const FIRST_TIME = '2026-10-03T10:00:00.000Z';
const SECOND_TIME = '2026-10-03T11:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

let root: string;
let sourceDatabase: string;

const provenance: ArtifactProvenance = {
  packagesLocalDirectory: {
    sourceId: 'packages-local-directory',
    version: '10.0.2500.1',
    acquiredAt: FIRST_TIME,
    sha256: HASH_A,
    bytes: 1000,
  },
  vsixAssets: [
    {
      sourceId: 'unified-developer-experience-tools-vsix',
      version: '10.0.2500.1',
      acquiredAt: FIRST_TIME,
      sha256: HASH_B,
      bytes: 2000,
    },
    {
      sourceId: 'power-platform-tools-vsix',
      version: '1.0.0.0',
      acquiredAt: FIRST_TIME,
      sha256: HASH_C,
      bytes: 3000,
    },
  ],
  dbrefx: {
    sourceId: 'dbrefx-xref',
    version: '10.0.2500.1',
    acquiredAt: FIRST_TIME,
    sha256: HASH_D,
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-artifact-contract-'));
  sourceDatabase = path.join(root, 'source.db');
  const database = openDb(sourceDatabase);
  upsertObject(database, {
    type: 'Class',
    name: 'ArtifactContractFixture',
    package: 'ApplicationSuite',
    model: 'ApplicationSuite',
    file_path: path.join(root, 'PackagesLocalDirectory', 'ApplicationSuite', 'Artifact.xml'),
    raw_xml: '<AxClass><Name>ArtifactContractFixture</Name></AxClass>',
    file_mtime: 1,
  });
  setMeta(database, META_KEYS.builtAt, FIRST_TIME);
  setMeta(database, META_KEYS.serverVersion, '0.1.0');
  setMeta(database, META_KEYS.appVersion, '10.0.2500.1');
  setMeta(database, META_KEYS.appVersionSource, 'configured');
  setMeta(database, META_KEYS.schemaVersion, String(INDEX_SCHEMA_VERSION));
  setMeta(database, META_KEYS.storeRawXml, '1');
  database.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function createBundle(createdAt = FIRST_TIME, inventory = capabilities) {
  return createArtifactBundle(sourceDatabase, root, {
    applicationVersion: '10.0.2500.1',
    sdkVersion: '10.0.2500.1',
    releaseId: 'service-update-2500',
    generatorVersion: '0.1.0',
    minimumServerVersion: '0.1.0',
    maximumServerVersion: '0.1.99',
    requiredCapabilities: ['codeMetadata', 'dataModelMetadata', 'securityGraphs'],
    capabilities: inventory,
    provenance,
    createdAt,
    relativePathsRoot: root,
    integrityCheck: true,
  });
}

describe('Azure artifact contract', () => {
  it('creates, validates, stages, and atomically activates a complete immutable bundle', () => {
    const bundle = createBundle();
    const target = path.join(root, 'runtime', 'active.db');

    const activated = stageAndActivateArtifactBundle(bundle.directory, target, policy);

    expect(activated.manifest.bundleId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(activated.manifest.index.stats.objects).toBe(1);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target).equals(
      fs.readFileSync(path.join(bundle.directory, ARTIFACT_DATABASE_FILE))
    )).toBe(true);
    const readOnly = openDbReadOnly(target);
    try {
      expect(() => readOnly.exec('DELETE FROM ax_objects')).toThrow();
    } finally {
      readOnly.close();
    }
  });

  it('rejects a database whose bytes no longer match the immutable manifest', () => {
    const bundle = createBundle();
    fs.appendFileSync(path.join(bundle.directory, ARTIFACT_DATABASE_FILE), 'corrupt');

    expect(() => validateArtifactBundle(bundle.directory, policy)).toThrow(/size or SHA-256/);
  });

  it('rejects a manifest whose content no longer matches its bundle identity', () => {
    const bundle = createBundle();
    const manifestFile = path.join(bundle.directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      d365: { releaseId: string };
    };
    manifest.d365.releaseId = 'tampered-release';
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest)}\n`);

    expect(() => validateArtifactBundle(bundle.directory, policy)).toThrow(/identity mismatch/);
  });

  it('treats creating the same content-addressed bundle as idempotent', () => {
    const first = createBundle();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('Windows directory collision'), { code: 'EPERM' });
    });
    const second = createBundle();

    expect(second.manifest.bundleId).toBe(first.manifest.bundleId);
    expect(second.directory).toBe(first.directory);
  });

  it('does not hide EPERM when the destination bundle does not exist', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
    });

    expect(() => createBundle()).toThrow(/Access denied/);
  });

  it('rejects incomplete and server-incompatible bundles', () => {
    const bundle = createBundle();
    const report = path.join(bundle.directory, ARTIFACT_VALIDATION_FILE);
    const saved = fs.readFileSync(report);
    fs.rmSync(report);
    expect(() => validateArtifactBundle(bundle.directory, policy)).toThrow();
    fs.writeFileSync(report, saved);

    expect(() =>
      validateArtifactBundle(bundle.directory, { ...policy, serverVersion: '0.2.0' })
    ).toThrow(/outside the bundle compatibility range/);
  });

  it('fails closed when the API requires a capability the bundle does not completely provide', () => {
    const bundle = createBundle();

    expect(() =>
      validateArtifactBundle(bundle.directory, {
        ...policy,
        requiredCapabilities: [...policy.requiredCapabilities, 'reports'],
      })
    ).toThrow(/reports is not complete/);
  });

  it('promotes only validated bundles, rejects stale revisions, and rolls back by pointer swap', () => {
    const first = createBundle(FIRST_TIME);
    const second = createBundle(SECOND_TIME);

    const revisionOne = promoteArtifactBundle(root, first.manifest.bundleId, 0, policy, FIRST_TIME);
    const revisionTwo = promoteArtifactBundle(root, second.manifest.bundleId, 1, policy, SECOND_TIME);

    expect(revisionOne.active?.bundleId).toBe(first.manifest.bundleId);
    expect(revisionTwo.active?.bundleId).toBe(second.manifest.bundleId);
    expect(revisionTwo.previous?.bundleId).toBe(first.manifest.bundleId);
    expect(() => promoteArtifactBundle(root, first.manifest.bundleId, 1, policy)).toThrow(
      /revision changed/
    );

    const rolledBack = rollbackArtifactBundle(root, 2, policy, '2026-10-03T12:00:00.000Z');
    expect(rolledBack.revision).toBe(3);
    expect(rolledBack.active?.bundleId).toBe(first.manifest.bundleId);
    expect(rolledBack.previous?.bundleId).toBe(second.manifest.bundleId);
    expect(readArtifactPointers(root)).toEqual(rolledBack);
  });

  it('never points active at an unknown bundle', () => {
    expect(() => promoteArtifactBundle(root, `sha256:${'e'.repeat(64)}`, 0, policy)).toThrow();
    expect(readArtifactPointers(root).active).toBeNull();
  });

  it('makes hosted startup require every advertised capability and an active pointer', () => {
    const target = path.join(root, 'runtime', 'active.db');
    expect(() =>
      prepareArtifactBackedIndex({
        storePath: root,
        indexDbPath: target,
        serverVersion: '0.1.0',
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
      })
    ).toThrow(/no active validated bundle/);

    const partialBundle = createBundle();
    promoteArtifactBundle(root, partialBundle.manifest.bundleId, 0, policy, FIRST_TIME);
    expect(() =>
      prepareArtifactBackedIndex({
        storePath: root,
        indexDbPath: target,
        serverVersion: '0.1.0',
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
      })
    ).toThrow(/reportingAnalytics is not complete/);
    expect(fs.existsSync(target)).toBe(false);

    const completeInventory = Object.fromEntries(
      Object.entries(capabilities).map(([name, value]) => [
        name,
        { ...value, completeness: 'complete' as const },
      ])
    ) as CapabilityInventory;
    const bundle = createBundle(SECOND_TIME, completeInventory);
    promoteArtifactBundle(
      root,
      bundle.manifest.bundleId,
      1,
      {
        ...policy,
        requiredCapabilities: Object.keys(completeInventory) as (keyof CapabilityInventory)[],
      },
      SECOND_TIME
    );

    const prepared = prepareArtifactBackedIndex({
      storePath: root,
      indexDbPath: target,
      serverVersion: '0.1.0',
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
    });
    expect(prepared.bundle.manifest.bundleId).toBe(bundle.manifest.bundleId);
    expect(prepared.pointerRevision).toBe(2);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('uses the bundle ID as the immutable directory name', () => {
    const bundle = createBundle();
    expect(bundle.directory).toBe(artifactBundleDirectory(root, bundle.manifest.bundleId));
    expect(path.basename(bundle.directory)).toBe(bundle.manifest.bundleId.slice('sha256:'.length));
  });
});
