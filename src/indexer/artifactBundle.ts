import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { activateIndexFile } from './indexActivation.js';
import { snapshotIndex } from './indexSnapshot.js';
import {
  ARTIFACT_CONTRACT_NAME,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_DATABASE_FILE,
  ARTIFACT_MANIFEST_FILE,
  ARTIFACT_VALIDATION_FILE,
  type ArtifactCompatibilityPolicy,
  type ArtifactManifest,
  type ArtifactProvenance,
  type ArtifactValidationReport,
  type CapabilityInventory,
  assertArtifactCompatible,
  canonicalJson,
  computeBundleId,
  parseArtifactManifest,
  parseValidationReport,
  sha256Buffer,
  sha256File,
} from './artifactContract.js';
import { getMeta, META_KEYS } from './db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export interface CreateArtifactBundleOptions {
  applicationVersion: string;
  sdkVersion: string;
  releaseId: string;
  generatorVersion: string;
  minimumServerVersion: string;
  maximumServerVersion: string;
  requiredCapabilities: ArtifactManifest['compatibility']['requiredCapabilities'];
  capabilities: CapabilityInventory;
  provenance: ArtifactProvenance;
  createdAt?: string;
  relativePathsRoot?: string;
  integrityCheck?: boolean;
}

export interface ValidatedArtifactBundle {
  directory: string;
  manifest: ArtifactManifest;
  validationReport: ArtifactValidationReport;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function writeCanonicalJson(file: string, value: unknown): void {
  fs.writeFileSync(file, canonicalJson(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function assertIsoDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
}

function inspectBundledDatabase(file: string, manifest: ArtifactManifest): void {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const quickCheck = Object.values(
      database.prepare('PRAGMA quick_check').get() as Record<string, string>
    )[0];
    if (quickCheck !== 'ok') throw new Error(`Bundled SQLite quick_check reported: ${quickCheck}`);
    const objectCount = Number(
      (database.prepare('SELECT COUNT(*) AS count FROM ax_objects').get() as { count: number | bigint })
        .count
    );
    if (objectCount !== manifest.index.stats.objects) {
      throw new Error(
        `Bundled index object count ${objectCount} does not match manifest count ${manifest.index.stats.objects}.`
      );
    }
    const schemaVersion = Number(getMeta(database, META_KEYS.schemaVersion));
    if (schemaVersion !== manifest.index.schemaVersion) {
      throw new Error(
        `Bundled index schema ${schemaVersion} does not match manifest schema ${manifest.index.schemaVersion}.`
      );
    }
    const applicationVersion = getMeta(database, META_KEYS.appVersion);
    if (applicationVersion !== manifest.d365.applicationVersion) {
      throw new Error(
        `Bundled index application version ${applicationVersion ?? '<missing>'} does not match ` +
          `manifest version ${manifest.d365.applicationVersion}.`
      );
    }
  } finally {
    database.close();
  }
}

export function artifactBundleDirectory(storeRoot: string, bundleId: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(bundleId)) throw new Error(`Invalid artifact bundle ID: ${bundleId}`);
  return path.join(path.resolve(storeRoot), 'bundles', bundleId.slice('sha256:'.length));
}

export function createArtifactBundle(
  sourceDatabase: string,
  storeRoot: string,
  options: CreateArtifactBundleOptions
): ValidatedArtifactBundle {
  const now = options.createdAt ?? new Date().toISOString();
  assertIsoDate(now, 'createdAt');
  const bundlesRoot = path.join(path.resolve(storeRoot), 'bundles');
  fs.mkdirSync(bundlesRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(bundlesRoot, '.building-'));
  try {
    const databaseFile = path.join(staging, ARTIFACT_DATABASE_FILE);
    const snapshot = snapshotIndex(sourceDatabase, databaseFile, {
      relativePathsRoot: options.relativePathsRoot,
      integrityCheck: options.integrityCheck,
    });
    if (snapshot.applicationVersion && snapshot.applicationVersion !== options.applicationVersion) {
      throw new Error(
        `Requested application version ${options.applicationVersion} does not match index metadata ` +
          `${snapshot.applicationVersion}.`
      );
    }
    if (!snapshot.applicationVersion) {
      throw new Error('The source index does not record an authoritative D365 application version.');
    }
    if (snapshot.schemaVersion === null) {
      throw new Error('The source index does not record a valid index schema version.');
    }

    const report: ArtifactValidationReport = {
      contract: ARTIFACT_CONTRACT_NAME,
      contractVersion: ARTIFACT_CONTRACT_VERSION,
      generatedAt: now,
      status: 'passed',
      checks: [
        { id: 'sqlite-integrity', status: 'passed' },
        { id: 'index-metadata', status: 'passed' },
        { id: 'source-provenance', status: 'passed' },
        { id: 'capability-inventory', status: 'passed' },
      ],
    };
    const reportFile = path.join(staging, ARTIFACT_VALIDATION_FILE);
    writeCanonicalJson(reportFile, report);

    const manifestWithoutId: Omit<ArtifactManifest, 'bundleId'> = {
      contract: ARTIFACT_CONTRACT_NAME,
      contractVersion: ARTIFACT_CONTRACT_VERSION,
      lifecycleState: 'validated',
      createdAt: now,
      builtAt: snapshot.builtAt,
      publishedAt: now,
      d365: {
        applicationVersion: options.applicationVersion,
        sdkVersion: options.sdkVersion,
        releaseId: options.releaseId,
      },
      generator: { name: 'd365-fno-mcp-server', version: options.generatorVersion },
      index: {
        schemaVersion: snapshot.schemaVersion,
        file: ARTIFACT_DATABASE_FILE,
        bytes: fs.statSync(databaseFile).size,
        sha256: sha256File(databaseFile),
        stats: snapshot.stats,
        xrefImportedAt: snapshot.xrefImportedAt,
      },
      validationReport: {
        file: ARTIFACT_VALIDATION_FILE,
        bytes: fs.statSync(reportFile).size,
        sha256: sha256File(reportFile),
      },
      provenance: options.provenance,
      capabilities: options.capabilities,
      compatibility: {
        minimumServerVersion: options.minimumServerVersion,
        maximumServerVersion: options.maximumServerVersion,
        indexSchemaVersion: snapshot.schemaVersion,
        requiredCapabilities: options.requiredCapabilities,
      },
    };
    const manifest: ArtifactManifest = {
      ...manifestWithoutId,
      bundleId: computeBundleId(manifestWithoutId),
    };
    const checkedManifest = parseArtifactManifest(manifest);
    parseValidationReport(report);
    assertArtifactCompatible(checkedManifest, {
      serverVersion: options.generatorVersion,
      minimumIndexSchemaVersion: snapshot.schemaVersion,
      maximumIndexSchemaVersion: snapshot.schemaVersion,
      requiredCapabilities: options.requiredCapabilities,
    });
    const manifestFile = path.join(staging, ARTIFACT_MANIFEST_FILE);
    writeCanonicalJson(manifestFile, checkedManifest);

    const finalDirectory = artifactBundleDirectory(storeRoot, checkedManifest.bundleId);
    try {
      fs.renameSync(staging, finalDirectory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return validateArtifactBundle(finalDirectory, {
      serverVersion: options.generatorVersion,
      minimumIndexSchemaVersion: snapshot.schemaVersion,
      maximumIndexSchemaVersion: snapshot.schemaVersion,
      requiredCapabilities: options.requiredCapabilities,
    });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export function validateArtifactBundle(
  directory: string,
  policy: ArtifactCompatibilityPolicy
): ValidatedArtifactBundle {
  const resolved = path.resolve(directory);
  const manifestFile = path.join(resolved, ARTIFACT_MANIFEST_FILE);
  const reportFile = path.join(resolved, ARTIFACT_VALIDATION_FILE);
  const databaseFile = path.join(resolved, ARTIFACT_DATABASE_FILE);
  for (const required of [manifestFile, reportFile, databaseFile]) {
    if (!fs.statSync(required).isFile()) throw new Error(`Required artifact file is not a file: ${required}`);
  }

  const manifest = parseArtifactManifest(readJson(manifestFile));
  const expectedDirectory = manifest.bundleId.slice('sha256:'.length);
  if (path.basename(resolved) !== expectedDirectory) {
    throw new Error(`Artifact directory must be named ${expectedDirectory}.`);
  }
  assertArtifactCompatible(manifest, policy);
  const report = parseValidationReport(readJson(reportFile));
  if (report.status !== 'passed') throw new Error('Artifact validation report is not passing.');

  const databaseBytes = fs.statSync(databaseFile).size;
  const databaseHash = sha256File(databaseFile);
  if (databaseBytes !== manifest.index.bytes || databaseHash !== manifest.index.sha256) {
    throw new Error('Artifact database size or SHA-256 does not match the manifest.');
  }
  const reportBytes = fs.statSync(reportFile).size;
  const reportHash = sha256File(reportFile);
  if (reportBytes !== manifest.validationReport.bytes || reportHash !== manifest.validationReport.sha256) {
    throw new Error('Artifact validation report size or SHA-256 does not match the manifest.');
  }
  inspectBundledDatabase(databaseFile, manifest);
  return { directory: resolved, manifest, validationReport: report };
}

export function stageAndActivateArtifactBundle(
  directory: string,
  targetDatabase: string,
  policy: ArtifactCompatibilityPolicy
): ValidatedArtifactBundle {
  const validated = validateArtifactBundle(directory, policy);
  const target = path.resolve(targetDatabase);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const candidate = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.candidate`
  );
  try {
    fs.copyFileSync(path.join(validated.directory, ARTIFACT_DATABASE_FILE), candidate, fs.constants.COPYFILE_EXCL);
    if (sha256File(candidate) !== validated.manifest.index.sha256) {
      throw new Error('Staged artifact database SHA-256 changed during local copy.');
    }
    activateIndexFile(candidate, target);
  } finally {
    fs.rmSync(candidate, { force: true });
  }
  return validated;
}

export function hashArtifactManifestFile(directory: string): string {
  return sha256Buffer(fs.readFileSync(path.join(directory, ARTIFACT_MANIFEST_FILE)));
}
