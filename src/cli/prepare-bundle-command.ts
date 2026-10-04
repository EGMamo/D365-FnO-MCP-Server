import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { VERSION } from '../version.js';
import type { CreateArtifactBundleOptions } from '../indexer/artifactBundle.js';
import {
  ArtifactManifestSchema,
  ArtifactProvenanceSchema,
  CapabilityInventorySchema,
  type ArtifactProvenance,
  type CapabilityInventory,
} from '../indexer/artifactContract.js';
import { detectAppVersionFromPackagesDir } from '../indexer/appVersion.js';
import { computeCapabilityInventory, DEFAULT_REQUIRED_CAPABILITIES } from '../indexer/capabilityCoverage.js';
import { getMeta, INDEX_SCHEMA_VERSION, META_KEYS, openDb } from '../indexer/db.js';
import { runIndexPass } from './index-command.js';

export interface PrepareBundleOptions {
  sources?: string;
  dbPath?: string;
  bundleOptions?: string;
  releaseId?: string;
}

const manifest = ArtifactManifestSchema.shape;

/** One file the acquire step downloaded. */
const AcquiredFileSchema = z
  .object({
    fileName: z.string().min(1),
    // Get-FileHash prints upper-case hex; the contract stores lower case.
    sha256: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/)
      .transform((value) => value.toLowerCase()),
    bytes: z.number().int().positive(),
    // .NET round-trip timestamps carry seven fractional digits; the contract stores milliseconds.
    acquiredAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  })
  .strict();

type AcquiredFile = z.infer<typeof AcquiredFileSchema>;

/**
 * `sources.json` (schema version 1) as the acquire step writes it. Every level
 * is strict except `sources`, which may list further downloads (the acquire
 * script can also fetch `finopsvsix`, for example). Those must be well-formed
 * but are ignored: only the three named sources become bundle provenance.
 */
const SourcesFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    applicationVersion: manifest.d365.shape.applicationVersion,
    dataverseEnvironmentUri: z.url({ protocol: /^https$/ }),
    packagesLocalDirectory: z
      .string()
      .min(1)
      .refine((value) => path.isAbsolute(value), 'must be an absolute path'),
    sources: z
      .object({
        systemmetadata: AcquiredFileSchema,
        finopsvsix22: AcquiredFileSchema,
        crossreference: AcquiredFileSchema,
      })
      .catchall(AcquiredFileSchema),
  })
  .strict();

export type AcquiredSources = z.infer<typeof SourcesFileSchema>;

function describeIssues(error: z.ZodError, prefix?: string): string {
  return error.issues
    .map((issue) => {
      const where = [...(prefix ? [prefix] : []), ...issue.path.map(String)].join('.');
      return `${where || '(root)'}: ${issue.message}`;
    })
    .join('; ');
}

/** Reads and validates `sources.json`; Windows PowerShell 5.1 writes it with a UTF-8 BOM. */
export function readSourcesFile(file: string): AcquiredSources {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = SourcesFileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${file} is invalid: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

function versionMismatch(subject: string, found: string | null, declared: string): string {
  return (
    `${subject} application version ${found ?? '<none>'}, but sources.json declares ${declared}. ` +
    'The acquire step must extract the SDK to <cache root>\\<applicationVersion>\\PackagesLocalDirectory.'
  );
}

function provenanceEntry(
  sourceId: string,
  file: AcquiredFile,
  version: string
): ArtifactProvenance['packagesLocalDirectory'] {
  return { sourceId, version, acquiredAt: file.acquiredAt, sha256: file.sha256, bytes: file.bytes };
}

/** The bundle options for an index built from `sources`, declaring what the indexer covers. */
export function createBundleOptions(
  sources: AcquiredSources,
  capabilities: CapabilityInventory,
  releaseId = `ude-${sources.applicationVersion}`
): CreateArtifactBundleOptions {
  const version = sources.applicationVersion;
  return {
    applicationVersion: version,
    sdkVersion: version,
    releaseId,
    generatorVersion: VERSION,
    minimumServerVersion: VERSION,
    maximumServerVersion: VERSION,
    requiredCapabilities: [...DEFAULT_REQUIRED_CAPABILITIES],
    capabilities,
    provenance: {
      packagesLocalDirectory: provenanceEntry('systemmetadata', sources.sources.systemmetadata, version),
      vsixAssets: [provenanceEntry('finopsvsix22', sources.sources.finopsvsix22, version)],
      dbrefx: provenanceEntry('crossreference', sources.sources.crossreference, version),
      optionalInputs: [],
    },
    relativePathsRoot: path.resolve(sources.packagesLocalDirectory),
    integrityCheck: true,
  };
}

/** Checks the options against the contract schemas the bundle manifest is validated with. */
function checkBundleOptions(options: CreateArtifactBundleOptions): void {
  const checks: [string, z.ZodSafeParseResult<unknown>][] = [
    ['d365', manifest.d365.safeParse({
      applicationVersion: options.applicationVersion,
      sdkVersion: options.sdkVersion,
      releaseId: options.releaseId,
    })],
    ['generator', manifest.generator.safeParse({ name: 'd365-fno-mcp-server', version: options.generatorVersion })],
    ['compatibility', manifest.compatibility.safeParse({
      minimumServerVersion: options.minimumServerVersion,
      maximumServerVersion: options.maximumServerVersion,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
      requiredCapabilities: options.requiredCapabilities,
    })],
    ['provenance', ArtifactProvenanceSchema.safeParse(options.provenance)],
    ['capabilities', CapabilityInventorySchema.safeParse(options.capabilities)],
  ];
  for (const [prefix, result] of checks) {
    if (!result.success) throw new Error(`The bundle options are invalid: ${describeIssues(result.error, prefix)}`);
  }
  const incomplete = options.requiredCapabilities.filter(
    (capability) => options.capabilities[capability].completeness !== 'complete'
  );
  if (incomplete.length > 0) {
    throw new Error(`The index does not completely provide required capabilities: ${incomplete.join(', ')}.`);
  }
}

function requiredFlag(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required.`);
  return value.trim();
}

/**
 * Worker build step: indexes the PackagesLocalDirectory that `sources.json`
 * describes and writes the `CreateArtifactBundleOptions` the acquisition
 * worker bundles it with. Stdout carries only the one-line JSON summary.
 */
export async function prepareBundleCommand(options: PrepareBundleOptions): Promise<number> {
  try {
    const sourcesFile = path.resolve(requiredFlag(options.sources, '--sources'));
    const dbPath = requiredFlag(options.dbPath, '--db-path');
    const outputFile = path.resolve(requiredFlag(options.bundleOptions, '--bundle-options'));
    const sources = readSourcesFile(sourcesFile);
    const declared = sources.applicationVersion;
    if (fs.existsSync(outputFile)) {
      throw new Error(`Refusing to overwrite the existing bundle options file ${outputFile}.`);
    }
    const packagesDir = path.resolve(sources.packagesLocalDirectory);
    if (!fs.statSync(packagesDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`packagesLocalDirectory "${packagesDir}" is not a directory.`);
    }
    // The index records the version an ancestor folder names; fail before a long indexing pass.
    const detected = detectAppVersionFromPackagesDir(packagesDir);
    if (detected !== declared) {
      throw new Error(versionMismatch(`packagesLocalDirectory "${packagesDir}" names`, detected, declared));
    }

    console.error(`Indexing ${packagesDir} -> ${dbPath} (force)`);
    const { stats, summary } = await runIndexPass(packagesDir, dbPath, true);
    if (stats.errors > 0) {
      console.error(`Warning: ${stats.errors} files could not be indexed; their objects are missing from the index.`);
    }
    const db = openDb(dbPath);
    let recorded: string | null;
    let capabilities: CapabilityInventory;
    try {
      recorded = getMeta(db, META_KEYS.appVersion);
      capabilities = computeCapabilityInventory(db);
    } finally {
      db.close();
    }
    if (recorded !== declared) {
      throw new Error(versionMismatch(`The index at "${dbPath}" records`, recorded, declared));
    }

    const bundleOptions = createBundleOptions(sources, capabilities, options.releaseId?.trim() || undefined);
    checkBundleOptions(bundleOptions);
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${JSON.stringify(bundleOptions, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(
      JSON.stringify({
        applicationVersion: declared,
        objects: summary.totalObjects,
        releaseId: bundleOptions.releaseId,
        bundleOptionsFile: outputFile,
      })
    );
    return 0;
  } catch (err) {
    console.error(`prepare-bundle failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
