import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ARTIFACT_CONTRACT_NAME = 'd365-fno-index-bundle';
export const ARTIFACT_CONTRACT_VERSION = 1;
export const ARTIFACT_MANIFEST_FILE = 'manifest.json';
export const ARTIFACT_DATABASE_FILE = 'd365_index.db';
export const ARTIFACT_VALIDATION_FILE = 'validation-report.json';
export const ARTIFACT_POINTERS_FILE = 'deployment-pointers.json';

const IsoDateSchema = z.string().datetime({ offset: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const BundleIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const FourPartVersionSchema = z.string().regex(/^\d+\.\d+\.\d+\.\d+$/);
const VersionSchema = z.string().regex(/^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/);
const NonSecretIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

export const ARTIFACT_CAPABILITY_NAMES = [
  'codeMetadata',
  'dataModelMetadata',
  'uiFormPatterns',
  'workflowServiceMetadata',
  'reportingAnalytics',
  'labelsResources',
  'extensions',
  'reports',
  'securityGraphs',
] as const;

export const ArtifactCapabilityNameSchema = z.enum(ARTIFACT_CAPABILITY_NAMES);

export type ArtifactCapabilityName = z.infer<typeof ArtifactCapabilityNameSchema>;

const CapabilityStatusSchema = z
  .object({
    completeness: z.enum(['complete', 'partial', 'absent']),
    itemCount: z.number().int().nonnegative().optional(),
    note: z.string().min(1).max(500).optional(),
  })
  .strict();

export const CapabilityInventorySchema = z
  .object({
    codeMetadata: CapabilityStatusSchema,
    dataModelMetadata: CapabilityStatusSchema,
    uiFormPatterns: CapabilityStatusSchema,
    workflowServiceMetadata: CapabilityStatusSchema,
    reportingAnalytics: CapabilityStatusSchema,
    labelsResources: CapabilityStatusSchema,
    extensions: CapabilityStatusSchema,
    reports: CapabilityStatusSchema,
    securityGraphs: CapabilityStatusSchema,
  })
  .strict();

export type CapabilityInventory = z.infer<typeof CapabilityInventorySchema>;

const SourceProvenanceSchema = z
  .object({
    sourceId: NonSecretIdentifierSchema,
    version: z.string().min(1).max(100),
    acquiredAt: IsoDateSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().positive(),
  })
  .strict();

export const ArtifactProvenanceSchema = z
  .object({
    packagesLocalDirectory: SourceProvenanceSchema,
    vsixAssets: z.array(SourceProvenanceSchema).min(1).max(2),
    dbrefx: SourceProvenanceSchema,
    optionalInputs: z.array(SourceProvenanceSchema).max(100).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = [
      value.packagesLocalDirectory.sourceId,
      ...value.vsixAssets.map((asset) => asset.sourceId),
      value.dbrefx.sourceId,
      ...value.optionalInputs.map((input) => input.sourceId),
    ];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Every provenance sourceId must be unique.' });
    }
  });

export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

export const ArtifactValidationReportSchema = z
  .object({
    contract: z.literal(ARTIFACT_CONTRACT_NAME),
    contractVersion: z.literal(ARTIFACT_CONTRACT_VERSION),
    generatedAt: IsoDateSchema,
    status: z.enum(['passed', 'rejected']),
    checks: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            status: z.enum(['passed', 'failed']),
            detail: z.string().min(1).max(1000).optional(),
          })
          .strict()
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const failed = value.checks.some((check) => check.status === 'failed');
    if ((value.status === 'passed') === failed) {
      context.addIssue({
        code: 'custom',
        message: 'Validation status must be passed only when every check passed.',
      });
    }
    const ids = value.checks.map((check) => check.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'Validation check IDs must be unique.' });
    }
  });

export type ArtifactValidationReport = z.infer<typeof ArtifactValidationReportSchema>;

export const ArtifactManifestSchema = z
  .object({
    contract: z.literal(ARTIFACT_CONTRACT_NAME),
    contractVersion: z.literal(ARTIFACT_CONTRACT_VERSION),
    bundleId: BundleIdSchema,
    lifecycleState: z.literal('validated'),
    createdAt: IsoDateSchema,
    builtAt: IsoDateSchema,
    publishedAt: IsoDateSchema,
    d365: z
      .object({
        applicationVersion: FourPartVersionSchema,
        sdkVersion: FourPartVersionSchema,
        releaseId: NonSecretIdentifierSchema,
      })
      .strict(),
    generator: z
      .object({
        name: z.literal('d365-fno-mcp-server'),
        version: VersionSchema,
      })
      .strict(),
    index: z
      .object({
        schemaVersion: z.number().int().positive(),
        file: z.literal(ARTIFACT_DATABASE_FILE),
        bytes: z.number().int().positive(),
        sha256: Sha256Schema,
        stats: z
          .object({
            objects: z.number().int().positive(),
            labels: z.number().int().nonnegative(),
            usageRows: z.number().int().nonnegative(),
          })
          .strict(),
        xrefImportedAt: IsoDateSchema.nullable(),
      })
      .strict(),
    validationReport: z
      .object({
        file: z.literal(ARTIFACT_VALIDATION_FILE),
        bytes: z.number().int().positive(),
        sha256: Sha256Schema,
      })
      .strict(),
    provenance: ArtifactProvenanceSchema,
    capabilities: CapabilityInventorySchema,
    compatibility: z
      .object({
        minimumServerVersion: VersionSchema,
        maximumServerVersion: VersionSchema,
        indexSchemaVersion: z.number().int().positive(),
        requiredCapabilities: z.array(ArtifactCapabilityNameSchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.index.schemaVersion !== value.compatibility.indexSchemaVersion) {
      context.addIssue({
        code: 'custom',
        message: 'The compatibility index schema version must match the bundled index.',
      });
    }
    if (
      compareArtifactVersions(
        value.compatibility.minimumServerVersion,
        value.compatibility.maximumServerVersion
      ) > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Minimum server version cannot be greater than maximum server version.',
      });
    }
    if (
      new Set(value.compatibility.requiredCapabilities).size !==
      value.compatibility.requiredCapabilities.length
    ) {
      context.addIssue({ code: 'custom', message: 'Required capabilities must be unique.' });
    }
    for (const capability of value.compatibility.requiredCapabilities) {
      if (value.capabilities[capability].completeness !== 'complete') {
        context.addIssue({
          code: 'custom',
          message: `Required capability ${capability} must be complete.`,
        });
      }
    }
  });

export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

const ArtifactPointerSchema = z
  .object({
    bundleId: BundleIdSchema,
    promotedAt: IsoDateSchema,
  })
  .strict();

export const ArtifactPointersSchema = z
  .object({
    contract: z.literal(ARTIFACT_CONTRACT_NAME),
    contractVersion: z.literal(ARTIFACT_CONTRACT_VERSION),
    revision: z.number().int().nonnegative(),
    updatedAt: IsoDateSchema,
    active: ArtifactPointerSchema.nullable(),
    previous: ArtifactPointerSchema.nullable(),
  })
  .strict();

export type ArtifactPointers = z.infer<typeof ArtifactPointersSchema>;

export interface ArtifactCompatibilityPolicy {
  serverVersion: string;
  supportedContractVersions?: readonly number[];
  minimumIndexSchemaVersion: number;
  maximumIndexSchemaVersion: number;
  requiredCapabilities: readonly ArtifactCapabilityName[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, entry]) => [key, stableValue(entry)])
    );
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.max(leftPoints.length, rightPoints.length); index += 1) {
    const delta = (leftPoints[index] ?? -1) - (rightPoints[index] ?? -1);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`;
}

export function sha256Buffer(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read: number;
    while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

export function computeBundleId(manifest: Omit<ArtifactManifest, 'bundleId'>): string {
  return `sha256:${sha256Buffer(canonicalJson(manifest))}`;
}

export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const manifest = ArtifactManifestSchema.parse(value);
  const identity = { ...manifest };
  Reflect.deleteProperty(identity, 'bundleId');
  const expected = computeBundleId(identity);
  if (manifest.bundleId !== expected) {
    throw new Error(`Artifact bundle identity mismatch: expected ${expected}, received ${manifest.bundleId}.`);
  }
  return manifest;
}

export function parseValidationReport(value: unknown): ArtifactValidationReport {
  return ArtifactValidationReportSchema.parse(value);
}

export function parseArtifactPointers(value: unknown): ArtifactPointers {
  return ArtifactPointersSchema.parse(value);
}

function numericVersion(value: string): number[] {
  const core = value.split(/[-+]/, 1)[0];
  return core.split('.').map((part) => Number(part));
}

export function compareArtifactVersions(left: string, right: string): number {
  const a = numericVersion(left);
  const b = numericVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function assertArtifactCompatible(
  manifest: ArtifactManifest,
  policy: ArtifactCompatibilityPolicy
): void {
  const supported = policy.supportedContractVersions ?? [ARTIFACT_CONTRACT_VERSION];
  if (!supported.includes(manifest.contractVersion)) {
    throw new Error(`Artifact contract version ${manifest.contractVersion} is not supported.`);
  }
  if (
    manifest.index.schemaVersion < policy.minimumIndexSchemaVersion ||
    manifest.index.schemaVersion > policy.maximumIndexSchemaVersion
  ) {
    throw new Error(
      `Index schema ${manifest.index.schemaVersion} is outside the supported range ` +
        `${policy.minimumIndexSchemaVersion}-${policy.maximumIndexSchemaVersion}.`
    );
  }
  if (
    compareArtifactVersions(policy.serverVersion, manifest.compatibility.minimumServerVersion) < 0 ||
    compareArtifactVersions(policy.serverVersion, manifest.compatibility.maximumServerVersion) > 0
  ) {
    throw new Error(
      `Server version ${policy.serverVersion} is outside the bundle compatibility range ` +
        `${manifest.compatibility.minimumServerVersion}-${manifest.compatibility.maximumServerVersion}.`
    );
  }
  for (const capability of policy.requiredCapabilities) {
    if (manifest.capabilities[capability].completeness !== 'complete') {
      throw new Error(`Required artifact capability ${capability} is not complete.`);
    }
  }
}
