import { ARTIFACT_CAPABILITY_NAMES, type ArtifactCapabilityName } from '../indexer/artifactContract.js';
import {
  artifactBundleDirectory,
  stageAndActivateArtifactBundle,
  type ValidatedArtifactBundle,
} from '../indexer/artifactBundle.js';
import { readArtifactPointers } from '../indexer/artifactPointers.js';

export interface ArtifactStartupOptions {
  storePath: string;
  indexDbPath: string;
  serverVersion: string;
  indexSchemaVersion: number;
  requiredCapabilities?: readonly ArtifactCapabilityName[];
}

export interface PreparedArtifactIndex {
  bundle: ValidatedArtifactBundle;
  pointerRevision: number;
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
    {
      serverVersion: options.serverVersion,
      minimumIndexSchemaVersion: options.indexSchemaVersion,
      maximumIndexSchemaVersion: options.indexSchemaVersion,
      requiredCapabilities: options.requiredCapabilities ?? ARTIFACT_CAPABILITY_NAMES,
    }
  );
  return { bundle, pointerRevision: pointers.revision };
}
