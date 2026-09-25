import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function safeSegment(value: string): void {
  if (!value || value !== value.trim() || value === '.' || value === '..' ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) ||
      /[$@%]\(|%[0-9a-f]{2}/i.test(value)) {
    throw new Error(`Unsafe filename path segment: '${value}'.`);
  }
}

export function canonicalRoot(root: string): string {
  if (!root) throw new Error('A configured root directory is required.');
  const resolved = fs.realpathSync(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${root}`);
  return resolved;
}

export function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Reject links/junctions below the configured root, including dangling destination links. */
export function checkedPath(root: string, target: string, allowMissing = false): string {
  const absolute = path.resolve(target);
  if (!contained(root, absolute)) throw new Error(`Path escapes configured root: ${target}`);
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissing && isMissing(error)) return absolute;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlinks/junctions below the root are unsupported: ${current}`);
    if (!contained(root, fs.realpathSync(current))) throw new Error(`Real path escapes configured root: ${current}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
  }
  return fs.realpathSync(absolute);
}

export function childDirectory(root: string, parent: string, name: string, allowMissing = false): string {
  safeSegment(name);
  const matches = fs.readdirSync(parent).filter((entry) => entry.toLowerCase() === name.toLowerCase());
  if (!matches.length && allowMissing) return checkedPath(root, path.join(parent, name), true);
  if (matches.length !== 1) throw new Error(`Missing or ambiguous directory '${name}' in ${parent}.`);
  const result = checkedPath(root, path.join(parent, matches[0]));
  if (!fs.statSync(result).isDirectory()) throw new Error(`Not a directory: ${result}`);
  return result;
}

export function assertAbsent(root: string, file: string): void {
  checkedPath(root, file, true);
  const parent = path.dirname(file);
  try {
    if (fs.readdirSync(parent).some((entry) => entry.toLowerCase() === path.basename(file).toLowerCase())) {
      throw new Error(`'${file}' already exists. Refusing to overwrite (including case aliases).`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export interface FileSnapshot {
  path: string;
  bytes: Buffer;
  hash: string;
  fileId: string;
  identity: string;
}

export function identity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}`;
}

export function snapshot(root: string, file: string): FileSnapshot {
  const resolved = checkedPath(root, file);
  const before = fs.statSync(resolved);
  if (!before.isFile() || before.nlink !== 1 || before.size > 2 * 1024 * 1024) {
    throw new Error(`Expected a single-link regular file no larger than 2 MiB: ${file}`);
  }
  const bytes = fs.readFileSync(resolved);
  const after = fs.statSync(resolved);
  const signature = (stat: fs.Stats) =>
    `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
  if (signature(before) !== signature(after)) throw new Error(`Concurrent edit while reading ${file}`);
  return { path: resolved, bytes, hash: hash(bytes), fileId: identity(after), identity: signature(after) };
}

export function assertSnapshot(root: string, expected: FileSnapshot): void {
  const actual = snapshot(root, expected.path);
  if (expected.identity !== actual.identity || expected.hash !== actual.hash) {
    throw new Error(`Stale preview: concurrent edit or replacement of ${expected.path}`);
  }
}
