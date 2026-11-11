import fs from 'node:fs';
import path from 'node:path';
import {
  assertAbsent, assertSnapshot, checkedPath, errorMessage, hash, identity, isMissing, snapshot,
  type FileSnapshot,
} from './safety.js';

export interface OfflineChange {
  id: string;
  metadataRoot: string;
  modelDir: string;
  targetPath: string;
  metadata: Buffer;
  workspaceRoot?: string;
  project?: { before: FileSnapshot; after: Buffer };
  inputs: { root: string; file: FileSnapshot }[];
  directories: { root: string; path: string; identity: string }[];
}

export const offlineWriteLimitations = [
  'Native IDE bridge unavailable; unsaved/loaded IDE state cannot be inspected.',
  'MSBuild/property evaluation and compiler validation are not run.',
  'Locks serialize cooperating writers only. Offline acknowledgement requires other editors/builds to be stopped.',
  'Portable Node filesystems provide no atomic multi-file transaction or external-writer compare-and-swap.',
  'On process/power loss, retained lock/journal paths require manual reconciliation; automatic crash recovery is unsupported.',
] as const;

export function changeLockPaths(change: Pick<OfflineChange, 'modelDir' | 'workspaceRoot'>): string[] {
  return [...new Set([
    path.join(change.modelDir, '.d365-mcp-write.lock'),
    ...(change.workspaceRoot ? [path.join(change.workspaceRoot, '.d365-mcp-write.lock')] : []),
  ])].sort();
}

function assertChangeInputs(change: OfflineChange, projectInstalled = false): void {
  for (const directory of change.directories) {
    checkedPath(directory.root, directory.path);
    if (identity(fs.statSync(directory.path)) !== directory.identity) {
      throw new Error(`Stale preview: directory replaced: ${directory.path}`);
    }
  }
  for (const input of change.inputs) {
    if (projectInstalled && input.file.path === change.project?.before.path) continue;
    assertSnapshot(input.root, input.file);
  }
  checkedPath(change.metadataRoot, change.targetPath, true);
}

export function captureDirectories(root: string, target: string): OfflineChange['directories'] {
  const result: OfflineChange['directories'] = [];
  let current = root;
  for (const segment of ['', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    try {
      checkedPath(root, current);
      const stat = fs.statSync(current);
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
      result.push({ root, path: current, identity: identity(stat) });
    } catch (error) {
      if (isMissing(error)) break;
      throw error;
    }
  }
  return result;
}

export interface OfflineWriteResult {
  state: 'applied' | 'rolledBack' | 'conflict' | 'recoveryRequired';
  written: boolean | null;
  projectUpdated: boolean;
  recoveryRequired: boolean;
  error?: string;
  cleanupErrors?: string[];
  recoveryPaths?: string[];
  steps: string[];
}

/** Bounded, one-change journal. Never steals stale locks or automatically recovers another process. */
export function applyOfflineChange(change: OfflineChange, revalidate: () => void): OfflineWriteResult {
  const steps: string[] = [];
  const locks: { path: string; identity: string }[] = [];
  const ownedFiles: { root: string; file: FileSnapshot }[] = [];
  let metadataFile: FileSnapshot | undefined;
  let metadataOpened = false;
  let projectInstalled = false;
  let outputDirectory: { path: string; identity: string } | undefined;
  let journalComplete = false;

  function writeOwned(root: string, file: string, bytes: Buffer): FileSnapshot {
    checkedPath(root, file, true);
    const fd = fs.openSync(file, 'wx', 0o600);
    let createdId: string;
    try {
      createdId = identity(fs.fstatSync(fd));
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const saved = snapshot(root, file);
    if (saved.fileId !== createdId || saved.hash !== hash(bytes)) {
      throw new Error(`Concurrent replacement of journal/staging file: ${file}`);
    }
    ownedFiles.push({ root, file: saved });
    return saved;
  }

  function cleanJournal(): string[] {
    const errors: string[] = [];
    for (const entry of ownedFiles.slice().reverse()) {
      try {
        assertSnapshot(entry.root, entry.file);
        fs.unlinkSync(entry.file.path);
      } catch (error) {
        errors.push(`Journal cleanup ${entry.file.path}: ${errorMessage(error)}`);
      }
    }
    for (const lock of locks.slice().reverse()) {
      try {
        const stat = fs.lstatSync(lock.path);
        if (stat.isSymbolicLink() || identity(stat) !== lock.identity) {
          throw new Error('Lock ownership changed; refusing cleanup.');
        }
        fs.rmdirSync(lock.path);
      } catch (error) {
        errors.push(`Lock cleanup ${lock.path}: ${errorMessage(error)}`);
      }
    }
    return errors;
  }

  function recovery(error: string, cleanupErrors: string[] = []): OfflineWriteResult {
    let written: boolean | null = metadataOpened ? null : false;
    if (metadataOpened && metadataFile) {
      try {
        assertSnapshot(change.metadataRoot, metadataFile);
        written = true;
      } catch (stateError) {
        cleanupErrors.push(`Metadata outcome cannot be verified: ${errorMessage(stateError)}`);
      }
    }
    return {
      state: 'recoveryRequired', written, projectUpdated: projectInstalled,
      recoveryRequired: true, error, cleanupErrors, steps,
      recoveryPaths: [...locks.map((lock) => lock.path), change.targetPath,
        ...(change.project ? [change.project.before.path] : [])],
    };
  }

  try {
    revalidate();
    assertChangeInputs(change);
    assertAbsent(change.metadataRoot, change.targetPath);
    for (const lock of changeLockPaths(change)) {
      const root = lock.startsWith(change.modelDir + path.sep) ? change.metadataRoot : change.workspaceRoot!;
      assertAbsent(root, lock);
      fs.mkdirSync(lock, { mode: 0o700 });
      locks.push({ path: lock, identity: identity(fs.lstatSync(lock)) });
    }
    steps.push('exclusive-locks-acquired');
    revalidate();
    assertChangeInputs(change);

    const journalDir = path.join(change.modelDir, '.d365-mcp-write.lock');
    // Flush immutable intent and backups before touching either destination.
    writeOwned(change.metadataRoot, path.join(journalDir, 'journal.json'), Buffer.from(JSON.stringify({
      version: 1, changeId: change.id, pid: process.pid, createdAt: new Date().toISOString(),
      targetPath: change.targetPath, metadataHash: hash(change.metadata),
      projectPath: change.project?.before.path ?? null,
      projectBeforeHash: change.project?.before.hash ?? null,
      projectAfterHash: change.project ? hash(change.project.after) : null,
      recovery: 'Stop all writers. Compare destinations to these hashes/backups; reconcile manually before removing locks. Never blindly replay.',
    }, null, 2)));
    writeOwned(change.metadataRoot, path.join(journalDir, 'metadata.after'), change.metadata);
    if (change.project) {
      writeOwned(change.metadataRoot, path.join(journalDir, 'project.before'), change.project.before.bytes);
      writeOwned(change.metadataRoot, path.join(journalDir, 'project.after'), change.project.after);
    }
    journalComplete = true;
    steps.push('journal-and-backups-flushed');
    assertChangeInputs(change);
    const parent = path.dirname(change.targetPath);
    try {
      fs.mkdirSync(parent);
      outputDirectory = { path: parent, identity: identity(fs.statSync(parent)) };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      checkedPath(change.metadataRoot, parent);
      if (!fs.statSync(parent).isDirectory()) throw new Error(`Not a directory: ${parent}`);
    }
    assertAbsent(change.metadataRoot, change.targetPath);
    const fd = fs.openSync(change.targetPath, 'wx', 0o600);
    metadataOpened = true;
    let createdId: string;
    try {
      createdId = identity(fs.fstatSync(fd));
      fs.writeFileSync(fd, change.metadata);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const savedMetadata = snapshot(change.metadataRoot, change.targetPath);
    if (savedMetadata.fileId !== createdId || savedMetadata.hash !== hash(change.metadata)) {
      throw new Error('Metadata changed during write; ownership cannot be established.');
    }
    metadataFile = savedMetadata;
    steps.push('metadata-created-exclusively');

    if (change.project) {
      const stageDir = path.join(change.workspaceRoot!, '.d365-mcp-write.lock');
      const staged = writeOwned(change.workspaceRoot!, path.join(stageDir, 'project.next'), change.project.after);
      fs.chmodSync(staged.path, fs.statSync(change.project.before.path).mode & 0o777);
      // chmod changes ctime; refresh our cleanup ownership record.
      const chmodSnapshot = snapshot(change.workspaceRoot!, staged.path);
      if (chmodSnapshot.fileId !== staged.fileId || chmodSnapshot.hash !== staged.hash) {
        throw new Error('Staged project was concurrently replaced.');
      }
      ownedFiles[ownedFiles.length - 1].file = chmodSnapshot;
      assertChangeInputs(change);
      assertSnapshot(change.metadataRoot, metadataFile);
      assertSnapshot(change.workspaceRoot!, chmodSnapshot);
      fs.renameSync(staged.path, change.project.before.path);
      projectInstalled = true;
      ownedFiles.pop();
      const installed = snapshot(change.workspaceRoot!, change.project.before.path);
      if (installed.hash !== hash(change.project.after)) throw new Error('Project changed during commit.');
      steps.push('project-replaced');
    }
    assertChangeInputs(change, true);
    assertSnapshot(change.metadataRoot, metadataFile);
    steps.push('destinations-verified');
  } catch (error) {
    const message = errorMessage(error);
    if (projectInstalled || (metadataOpened && !metadataFile)) {
      return recovery(message);
    }
    const cleanupErrors: string[] = [];
    if (metadataFile) {
      try {
        // No compensating deletion unless this is still exactly our file.
        assertSnapshot(change.metadataRoot, metadataFile);
        if (change.project) assertSnapshot(change.workspaceRoot!, change.project.before);
        fs.unlinkSync(metadataFile.path);
        metadataOpened = false;
        steps.push('metadata-rolled-back');
      } catch (cleanupError) {
        cleanupErrors.push(`Metadata rollback: ${errorMessage(cleanupError)}`);
      }
    }
    if (!cleanupErrors.length && outputDirectory) {
      try {
        checkedPath(change.metadataRoot, outputDirectory.path);
        if (identity(fs.statSync(outputDirectory.path)) !== outputDirectory.identity) {
          throw new Error('Output directory ownership changed.');
        }
        fs.rmdirSync(outputDirectory.path);
      } catch (cleanupError) {
        cleanupErrors.push(`Directory rollback: ${errorMessage(cleanupError)}`);
      }
    }
    if (cleanupErrors.length) return recovery(message, cleanupErrors);
    cleanupErrors.push(...cleanJournal());
    if (cleanupErrors.length) return recovery(message, cleanupErrors);
    return {
      state: journalComplete ? 'rolledBack' : 'conflict', written: false, projectUpdated: false,
      recoveryRequired: false, error: message, steps,
    };
  }
  const cleanupErrors = cleanJournal();
  if (cleanupErrors.length) return recovery('Changes applied, but journal/lock cleanup failed.', cleanupErrors);
  return { state: 'applied', written: true, projectUpdated: projectInstalled, recoveryRequired: false, steps };
}
