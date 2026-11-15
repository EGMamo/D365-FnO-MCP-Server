import fs from 'node:fs';
import path from 'node:path';

/** Best effort: fsync the directory so a rename of its children survives power loss. */
function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, 'r');
  } catch {
    return; // Some filesystems do not let directories be opened; the sync is best effort.
  }
  try {
    fs.fsyncSync(descriptor);
  } catch {
    // Best effort.
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Atomically replaces an index with a fully prepared sibling candidate.
 * Callers must close active database handles before activation and reopen the
 * target afterwards. The candidate file and its directory are fsynced so a
 * power loss right after the rename cannot leave the *new* name empty or
 * truncated (rename durability requires both).
 */
export function activateIndexFile(candidatePath: string, targetPath: string): void {
  const candidate = path.resolve(candidatePath);
  const target = path.resolve(targetPath);
  if (path.dirname(candidate) !== path.dirname(target)) {
    throw new Error('The index candidate must be staged next to the target for atomic activation.');
  }
  if (!fs.statSync(candidate).isFile()) throw new Error(`Index candidate is not a file: ${candidate}`);

  // Flush the candidate's own data before the rename exposes it under the target name.
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(candidate, 'r+');
    fs.fsyncSync(descriptor);
  } catch {
    // Read-only filesystems or exotic files; the rename proceeds either way.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }

  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  fs.renameSync(candidate, target);
  fsyncDirectory(path.dirname(target));
}
