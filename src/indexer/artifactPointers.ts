import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACT_CONTRACT_NAME,
  ARTIFACT_CONTRACT_VERSION,
  ARTIFACT_MANIFEST_FILE,
  ARTIFACT_POINTERS_FILE,
  type ArtifactCompatibilityPolicy,
  type ArtifactPointers,
  canonicalJson,
  parseArtifactManifest,
  parseArtifactPointers,
} from './artifactContract.js';
import { artifactBundleDirectory, validateArtifactBundle } from './artifactBundle.js';

function pointerFile(storeRoot: string): string {
  return path.join(path.resolve(storeRoot), ARTIFACT_POINTERS_FILE);
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

export function readArtifactPointers(storeRoot: string): ArtifactPointers {
  const file = pointerFile(storeRoot);
  if (!fs.existsSync(file)) return emptyPointers();
  return parseArtifactPointers(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}

function writePointersAtomic(storeRoot: string, pointers: ArtifactPointers): void {
  const root = path.resolve(storeRoot);
  fs.mkdirSync(root, { recursive: true });
  const target = pointerFile(root);
  const temporary = path.join(root, `.${ARTIFACT_POINTERS_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, canonicalJson(pointers), { encoding: 'utf8' });
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function withPointerLock<T>(storeRoot: string, action: () => T): T {
  const root = path.resolve(storeRoot);
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `.${ARTIFACT_POINTERS_FILE}.lock`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Artifact pointer update is already in progress.');
    }
    throw error;
  }
  try {
    return action();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

function requireRevision(current: ArtifactPointers, expectedRevision: number): void {
  if (current.revision !== expectedRevision) {
    throw new Error(
      `Artifact pointer revision changed: expected ${expectedRevision}, current ${current.revision}.`
    );
  }
}

function bundleTimestamp(bundle: { manifest: { createdAt: string; builtAt: string; publishedAt: string } }): number {
  return Math.max(
    Date.parse(bundle.manifest.createdAt),
    Date.parse(bundle.manifest.builtAt),
    Date.parse(bundle.manifest.publishedAt)
  );
}

export function promoteArtifactBundle(
  storeRoot: string,
  bundleId: string,
  expectedRevision: number,
  policy: ArtifactCompatibilityPolicy,
  promotedAt = new Date().toISOString()
): ArtifactPointers {
  return withPointerLock(storeRoot, () => {
    const current = readArtifactPointers(storeRoot);
    requireRevision(current, expectedRevision);
    const candidate = validateArtifactBundle(artifactBundleDirectory(storeRoot, bundleId), policy);
    if (current.active?.bundleId === bundleId) return current;
    if (current.active) {
      const activeManifest = parseArtifactManifest(JSON.parse(
        fs.readFileSync(
          path.join(artifactBundleDirectory(storeRoot, current.active.bundleId), ARTIFACT_MANIFEST_FILE),
          'utf8'
        )
      ) as unknown);
      if (bundleTimestamp(candidate) <= bundleTimestamp({ manifest: activeManifest })) {
        throw new Error(
          `Refusing to promote artifact ${candidate.manifest.bundleId}: it is not newer than ` +
            `the active bundle ${activeManifest.bundleId}.`
        );
      }
    }
    const next: ArtifactPointers = {
      contract: ARTIFACT_CONTRACT_NAME,
      contractVersion: ARTIFACT_CONTRACT_VERSION,
      revision: current.revision + 1,
      updatedAt: promotedAt,
      active: { bundleId, promotedAt },
      previous: current.active,
    };
    writePointersAtomic(storeRoot, next);
    return next;
  });
}

export function rollbackArtifactBundle(
  storeRoot: string,
  expectedRevision: number,
  policy: ArtifactCompatibilityPolicy,
  promotedAt = new Date().toISOString()
): ArtifactPointers {
  return withPointerLock(storeRoot, () => {
    const current = readArtifactPointers(storeRoot);
    requireRevision(current, expectedRevision);
    if (!current.previous) throw new Error('No previous validated artifact bundle is available.');
    validateArtifactBundle(artifactBundleDirectory(storeRoot, current.previous.bundleId), policy);
    const next: ArtifactPointers = {
      contract: ARTIFACT_CONTRACT_NAME,
      contractVersion: ARTIFACT_CONTRACT_VERSION,
      revision: current.revision + 1,
      updatedAt: promotedAt,
      active: { bundleId: current.previous.bundleId, promotedAt },
      previous: current.active,
    };
    writePointersAtomic(storeRoot, next);
    return next;
  });
}

/**
 * Records a pointer snapshot pinned from a remote store as this replica's local
 * pointers. Only for an instance-local materialization cache that no other
 * process promotes into, so it takes no pointer lock.
 */
export function writePinnedArtifactPointers(storeRoot: string, pointers: ArtifactPointers): void {
  writePointersAtomic(storeRoot, parseArtifactPointers(pointers));
}
