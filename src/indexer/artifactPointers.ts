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
  RollbackHoldError,
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
    // The rename is only durable once the directory entry itself is flushed.
    try {
      const directory = fs.openSync(root, 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } catch {
      // Best effort: some filesystems do not allow opening directories.
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** How old a pointer lock must be before a live-pid check can declare it stale. */
const POINTER_LOCK_STALE_AFTER_MS = 10 * 60 * 1000;

/** True when `pid` is not a running process. */
function processIsGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** A pointer lock older than the threshold whose writer process is gone, or null when it is live. */
function stalePointerLock(lock: string): { pid: number; createdAt: number } | null {
  let recorded: { pid?: unknown; createdAt?: unknown };
  try {
    recorded = JSON.parse(fs.readFileSync(lock, 'utf8')) as { pid?: unknown; createdAt?: unknown };
  } catch {
    return null; // Unreadable: never steal what cannot be proven stale.
  }
  const pid = typeof recorded.pid === 'number' ? recorded.pid : 0;
  const createdAt = typeof recorded.createdAt === 'number' ? recorded.createdAt : 0;
  if (Date.now() - createdAt >= POINTER_LOCK_STALE_AFTER_MS && processIsGone(pid)) {
    return { pid, createdAt };
  }
  return null;
}

function withPointerLock<T>(storeRoot: string, action: () => T): T {
  const root = path.resolve(storeRoot);
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `.${ARTIFACT_POINTERS_FILE}.lock`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // The update must be short, so a lock here means either a live update or a crash. A lock whose
    // recorded process is gone (and that is old enough) is taken over; anything else is refused.
    if (stalePointerLock(lock) === null) {
      throw new Error(
        `Artifact pointer update is already in progress. If no other update is running, delete ${lock}.`
      );
    }
    fs.rmSync(lock, { force: true });
    descriptor = fs.openSync(lock, 'wx', 0o600);
  }
  // The pid + timestamp let a later process tell a crashed writer's lock from a live one.
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
    encoding: 'utf8',
  });
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

export interface PromoteOptions {
  /**
   * True for a person's explicit promotion: it replaces a rolled-back bundle and clears the rollback
   * hold. False (the default, used by scheduled runs) throws RollbackHoldError while a hold is set.
   */
  intentional?: boolean;
}

export function promoteArtifactBundle(
  storeRoot: string,
  bundleId: string,
  expectedRevision: number,
  policy: ArtifactCompatibilityPolicy,
  promotedAt = new Date().toISOString(),
  options: PromoteOptions = {}
): ArtifactPointers {
  return withPointerLock(storeRoot, () => {
    const current = readArtifactPointers(storeRoot);
    requireRevision(current, expectedRevision);
    if (current.rollbackHold && !options.intentional) throw new RollbackHoldError(current.rollbackHold);
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
      ...(current.active ? { rollbackHold: { supersededBundleId: current.active.bundleId, heldAt: promotedAt } } : {}),
    };
    writePointersAtomic(storeRoot, next);
    return next;
  });
}

/** Removes a rollback hold so scheduled promotions resume. A no-op (no revision bump) without one. */
export function clearArtifactRollbackHold(
  storeRoot: string,
  expectedRevision: number,
  clearedAt = new Date().toISOString()
): ArtifactPointers {
  return withPointerLock(storeRoot, () => {
    const current = readArtifactPointers(storeRoot);
    requireRevision(current, expectedRevision);
    if (!current.rollbackHold) return current;
    const next: ArtifactPointers = { ...current, revision: current.revision + 1, updatedAt: clearedAt };
    delete next.rollbackHold;
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
