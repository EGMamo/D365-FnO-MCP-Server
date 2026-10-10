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
  ArtifactProvenanceSchema,
  CapabilityInventorySchema,
  assertArtifactCompatible,
  canonicalJson,
  computeBundleId,
  parseArtifactManifest,
  parseValidationReport,
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

function isExistingDirectoryCollision(error: unknown, destination: string): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(code ?? '')) return false;
  try {
    return fs.lstatSync(destination).isDirectory();
  } catch {
    return false;
  }
}

export function publishStagedArtifactDirectory(staging: string, destination: string): void {
  try {
    fs.renameSync(staging, destination);
  } catch (error) {
    if (!isExistingDirectoryCollision(error, destination)) throw error;
    fs.rmSync(staging, { recursive: true, force: true });
  }
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

interface BundleValidationCheck {
  id: string;
  run: () => string;
}

function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message || 'failed';
}

/** Runs every check, records its outcome, and never reports a check it did not run. */
function runBundleValidationChecks(
  generatedAt: string,
  checks: readonly BundleValidationCheck[]
): ArtifactValidationReport {
  const results = checks.map((check): ArtifactValidationReport['checks'][number] => {
    try {
      return { id: check.id, status: 'passed', detail: failureDetail(check.run()) };
    } catch (error) {
      return { id: check.id, status: 'failed', detail: failureDetail(error) };
    }
  });
  return parseValidationReport({
    contract: ARTIFACT_CONTRACT_NAME,
    contractVersion: ARTIFACT_CONTRACT_VERSION,
    generatedAt,
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'rejected',
    checks: results,
  });
}

function inspectSqliteIntegrity(
  file: string,
  pragma: 'integrity_check' | 'quick_check',
  expectedObjects: number
): string {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const verdict = Object.values(database.prepare(`PRAGMA ${pragma}`).get() as Record<string, string>)[0];
    if (verdict !== 'ok') throw new Error(`SQLite ${pragma} reported: ${verdict}`);
    const objects = Number(
      (database.prepare('SELECT COUNT(*) AS count FROM ax_objects').get() as { count: number | bigint }).count
    );
    if (objects !== expectedObjects) {
      throw new Error(`Bundled index has ${objects} objects but the source reported ${expectedObjects}.`);
    }
    return verdict;
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
      verify: false,
    });
    const integrityPragma = options.integrityCheck ? 'integrity_check' : 'quick_check';
    const report = runBundleValidationChecks(now, [
      {
        id: 'sqlite-integrity',
        run: () => {
          const verdict = inspectSqliteIntegrity(databaseFile, integrityPragma, snapshot.stats.objects);
          return `PRAGMA ${integrityPragma}=${verdict}; ${snapshot.stats.objects} objects match the source index.`;
        },
      },
      {
        id: 'index-metadata',
        run: () => {
          if (!snapshot.applicationVersion) {
            throw new Error('The source index does not record an authoritative D365 application version.');
          }
          if (snapshot.applicationVersion !== options.applicationVersion) {
            throw new Error(
              `Requested application version ${options.applicationVersion} does not match index metadata ` +
                `${snapshot.applicationVersion}.`
            );
          }
          if (snapshot.schemaVersion === null) {
            throw new Error('The source index does not record a valid index schema version.');
          }
          assertIsoDate(snapshot.builtAt, 'Index builtAt');
          return `Application ${snapshot.applicationVersion}, schema ${snapshot.schemaVersion}, built ${snapshot.builtAt}.`;
        },
      },
      {
        id: 'source-provenance',
        run: () => {
          const provenance = ArtifactProvenanceSchema.parse(options.provenance);
          const sources = [
            provenance.packagesLocalDirectory,
            ...provenance.vsixAssets,
            provenance.dbrefx,
            ...provenance.optionalInputs,
          ];
          const future = sources.find((source) => Date.parse(source.acquiredAt) > Date.parse(now));
          if (future) throw new Error(`Source ${future.sourceId} was acquired after the bundle creation time.`);
          return `${sources.length} sources with SHA-256 and size recorded.`;
        },
      },
      {
        id: 'capability-inventory',
        run: () => {
          const inventory = CapabilityInventorySchema.parse(options.capabilities);
          const incomplete = options.requiredCapabilities.filter(
            (capability) => inventory[capability].completeness !== 'complete'
          );
          if (incomplete.length > 0) {
            throw new Error(`Required capabilities are not complete: ${incomplete.join(', ')}.`);
          }
          return `${options.requiredCapabilities.length} required capabilities complete.`;
        },
      },
    ]);
    if (report.status !== 'passed') {
      const failures = report.checks
        .filter((check) => check.status === 'failed')
        .map((check) => `${check.id}: ${check.detail ?? 'failed'}`);
      throw new Error(`Artifact validation failed. ${failures.join(' ')}`);
    }
    // The schema version was checked above; narrow it for the manifest.
    const schemaVersion = snapshot.schemaVersion as number;
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
        schemaVersion: schemaVersion,
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
        indexSchemaVersion: schemaVersion,
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
      minimumIndexSchemaVersion: schemaVersion,
      maximumIndexSchemaVersion: schemaVersion,
      requiredCapabilities: options.requiredCapabilities,
    });
    const manifestFile = path.join(staging, ARTIFACT_MANIFEST_FILE);
    writeCanonicalJson(manifestFile, checkedManifest);

    const finalDirectory = artifactBundleDirectory(storeRoot, checkedManifest.bundleId);
    publishStagedArtifactDirectory(staging, finalDirectory);
    return validateArtifactBundle(finalDirectory, {
      serverVersion: options.generatorVersion,
      minimumIndexSchemaVersion: schemaVersion,
      maximumIndexSchemaVersion: schemaVersion,
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
  return activateValidatedArtifactBundle(validateArtifactBundle(directory, policy), targetDatabase);
}

export interface ActivateArtifactBundleOptions {
  /**
   * Hard-link the bundle's database into place instead of copying it, so the
   * bundle and the active index share one file on disk. Only for bundles that
   * nothing ever writes to: SQLite names its journal after the path it opened,
   * so a writer through one link would hide its journal from readers of the
   * other. Falls back to a verified copy when the filesystem cannot link.
   */
  link?: boolean;
  /** Runs before the database is copied (never before a link), e.g. to check free space. */
  beforeCopy?: () => void;
}

/** Link errors that mean this filesystem or file cannot be hard-linked, so a copy is needed. */
const LINK_UNSUPPORTED_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS']);

function tryHardLink(source: string, destination: string): boolean {
  try {
    fs.linkSync(source, destination);
    return true;
  } catch (error) {
    if (LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/**
 * Places an already validated bundle's database next to `targetDatabase`,
 * by hard link when `options.link` allows it or else by a re-verified copy,
 * and atomically activates it.
 */
export function activateValidatedArtifactBundle(
  validated: ValidatedArtifactBundle,
  targetDatabase: string,
  options: ActivateArtifactBundleOptions = {}
): ValidatedArtifactBundle {
  const target = path.resolve(targetDatabase);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const source = path.join(validated.directory, ARTIFACT_DATABASE_FILE);
  const candidate = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.candidate`
  );
  try {
    if (options.link && tryHardLink(source, candidate)) {
      // A link shares the bytes validation just hashed, so the multi-GB re-hash is skipped;
      // the size check is a cheap guard against the bundle file being rewritten since.
      if (fs.statSync(candidate).size !== validated.manifest.index.bytes) {
        throw new Error('Artifact database size changed after validation.');
      }
    } else {
      options.beforeCopy?.();
      fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
      if (sha256File(candidate) !== validated.manifest.index.sha256) {
        throw new Error('Staged artifact database SHA-256 changed during local copy.');
      }
    }
    activateIndexFile(candidate, target);
  } finally {
    // Also covers rename() leaving the candidate in place when it is already a link to the target.
    fs.rmSync(candidate, { force: true });
  }
  return validated;
}
