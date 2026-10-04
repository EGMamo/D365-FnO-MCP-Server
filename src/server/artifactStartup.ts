import fs from 'node:fs';
import path from 'node:path';
import type {
  ArtifactCapabilityName,
  ArtifactCompatibilityPolicy,
  ArtifactManifest,
} from '../indexer/artifactContract.js';
import { DEFAULT_REQUIRED_CAPABILITIES } from '../indexer/capabilityCoverage.js';
import {
  activateValidatedArtifactBundle,
  artifactBundleDirectory,
  stageAndActivateArtifactBundle,
  type ValidatedArtifactBundle,
  validateArtifactBundle,
} from '../indexer/artifactBundle.js';
import { readArtifactPointers, writePinnedArtifactPointers } from '../indexer/artifactPointers.js';
import type { AzureBlobArtifactStore } from '../indexer/azureBlobArtifactStore.js';

/** Headroom kept free on each filesystem after a bundle is materialized and activated. */
const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

export interface ArtifactStartupOptions {
  storePath: string;
  indexDbPath: string;
  serverVersion: string;
  indexSchemaVersion: number;
  /** Capabilities the bundle must declare complete; defaults to the ones the indexer covers completely. */
  requiredCapabilities?: readonly ArtifactCapabilityName[];
}

export interface PreparedArtifactIndex {
  bundle: ValidatedArtifactBundle;
  pointerRevision: number;
}

function startupPolicy(options: ArtifactStartupOptions): ArtifactCompatibilityPolicy {
  return {
    serverVersion: options.serverVersion,
    minimumIndexSchemaVersion: options.indexSchemaVersion,
    maximumIndexSchemaVersion: options.indexSchemaVersion,
    requiredCapabilities: options.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES,
  };
}

/** Validates and stages the active immutable bundle before the hosted DB is opened read-only. */
export function prepareArtifactBackedIndex(options: ArtifactStartupOptions): PreparedArtifactIndex {
  const pointers = readArtifactPointers(options.storePath);
  if (!pointers.active) {
    throw new Error('The configured artifact store has no active validated bundle.');
  }
  const bundle = stageAndActivateArtifactBundle(
    artifactBundleDirectory(options.storePath, pointers.active.bundleId),
    options.indexDbPath,
    startupPolicy(options)
  );
  return { bundle, pointerRevision: pointers.revision };
}

export interface AzureArtifactStartupOptions extends ArtifactStartupOptions {
  /** Read-only view of the remote store; `storePath` is the instance-local materialization root. */
  store: Pick<AzureBlobArtifactStore, 'readPointers' | 'materializeBundle'>;
  /** Free bytes on the filesystem holding `directory`. Overridable for tests. */
  freeBytes?: (directory: string) => number;
}

export interface MaterializedArtifactIndex extends PreparedArtifactIndex {
  pointerEtag: string;
  /** True when a previously materialized local copy of the same bundle validated and was reused. */
  reusedLocalBundle: boolean;
}

function filesystemFreeBytes(directory: string): number {
  const stats = fs.statfsSync(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function assertCapacity(
  manifest: ArtifactManifest,
  bundlesRoot: string,
  indexDirectory: string,
  freeBytes: (directory: string) => number
): void {
  const bundleBytes = manifest.index.bytes + manifest.validationReport.bytes;
  const sameFilesystem = fs.statSync(bundlesRoot).dev === fs.statSync(indexDirectory).dev;
  const requirements = sameFilesystem
    ? [{ directory: bundlesRoot, bytes: bundleBytes + manifest.index.bytes }]
    : [
        { directory: bundlesRoot, bytes: bundleBytes },
        { directory: indexDirectory, bytes: manifest.index.bytes },
      ];
  for (const requirement of requirements) {
    const available = freeBytes(requirement.directory);
    const needed = requirement.bytes + FREE_SPACE_MARGIN_BYTES;
    if (available < needed) {
      throw new Error(
        `Insufficient local disk for artifact ${manifest.bundleId}: ${requirement.directory} has ` +
          `${available} free bytes; ${needed} are required.`
      );
    }
  }
}

/** Removes interrupted downloads and every cached bundle other than `keepBundleId`. */
function pruneLocalBundles(bundlesRoot: string, keepBundleId: string | null): void {
  const keep = keepBundleId?.slice('sha256:'.length);
  for (const entry of fs.readdirSync(bundlesRoot, { withFileTypes: true })) {
    if (entry.name === keep) continue;
    // Touch only what this store writes: bundle directories and download staging.
    if (!/^[a-f0-9]{64}$/.test(entry.name) && !entry.name.startsWith('.downloading-')) continue;
    fs.rmSync(path.join(bundlesRoot, entry.name), { recursive: true, force: true });
  }
}

/**
 * Per-replica startup materialization from Azure Blob Storage:
 * read the active pointer with the configured identity and pin its ETag,
 * download the pinned immutable bundle into a staging directory on local disk,
 * validate manifest, hashes, compatibility, provenance and SQLite integrity,
 * atomically publish the local bundle directory, then activate its database
 * into `indexDbPath`. Callers open the index and report ready only afterwards.
 */
export async function materializeAzureArtifactIndex(
  options: AzureArtifactStartupOptions
): Promise<MaterializedArtifactIndex> {
  const snapshot = await options.store.readPointers();
  const active = snapshot.pointers.active;
  if (!active || snapshot.etag === null) {
    throw new Error('The configured Azure artifact store has no active validated bundle.');
  }
  const policy = startupPolicy(options);
  const localRoot = path.resolve(options.storePath);
  const bundlesRoot = path.join(localRoot, 'bundles');
  const indexDirectory = path.dirname(path.resolve(options.indexDbPath));
  fs.mkdirSync(bundlesRoot, { recursive: true });
  fs.mkdirSync(indexDirectory, { recursive: true });

  // Leftover staging directories and superseded bundles only consume disk.
  pruneLocalBundles(bundlesRoot, active.bundleId);

  const localDirectory = artifactBundleDirectory(localRoot, active.bundleId);
  let bundle: ValidatedArtifactBundle | null = null;
  if (fs.existsSync(localDirectory)) {
    try {
      bundle = validateArtifactBundle(localDirectory, policy);
    } catch {
      fs.rmSync(localDirectory, { recursive: true, force: true });
    }
  }
  const reusedLocalBundle = bundle !== null;
  if (!bundle) {
    bundle = await options.store.materializeBundle(active.bundleId, {
      localStoreRoot: localRoot,
      policy,
      beforeDownload: (manifest) =>
        assertCapacity(manifest, bundlesRoot, indexDirectory, options.freeBytes ?? filesystemFreeBytes),
    });
  }

  writePinnedArtifactPointers(localRoot, snapshot.pointers);
  activateValidatedArtifactBundle(bundle, options.indexDbPath);
  return {
    bundle,
    pointerRevision: snapshot.pointers.revision,
    pointerEtag: snapshot.etag,
    reusedLocalBundle,
  };
}
