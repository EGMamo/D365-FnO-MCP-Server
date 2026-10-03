import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically replaces an index with a fully prepared sibling candidate.
 * Callers must close active database handles before activation and reopen the
 * target afterwards.
 */
export function activateIndexFile(candidatePath: string, targetPath: string): void {
  const candidate = path.resolve(candidatePath);
  const target = path.resolve(targetPath);
  if (path.dirname(candidate) !== path.dirname(target)) {
    throw new Error('The index candidate must be staged next to the target for atomic activation.');
  }
  if (!fs.statSync(candidate).isFile()) throw new Error(`Index candidate is not a file: ${candidate}`);

  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
  fs.renameSync(candidate, target);
}
