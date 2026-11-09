import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KeyRegistryConflictError, KeyRegistryError, parseRegistryDocument, type RegistryStore } from './keyRegistry.js';

/** The longest registry file read; a real one holds a few hundred bytes per key. */
const MAX_BYTES = 1024 * 1024;

/**
 * The key registry in a file, for Docker or a server on one machine. The version is the file's modification time
 * and size; a write goes to a temporary file in the same folder and is renamed into place, owner-only, so a reader
 * never sees half a document.
 */
export function createFileRegistryStore(file: string): RegistryStore {
  const target = path.resolve(file);

  const currentVersion = (): string | null => {
    try {
      const stat = fs.statSync(target);
      return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new KeyRegistryError(`The key registry file cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`);
    }
  };

  return {
    kind: 'file',
    async read() {
      const version = currentVersion();
      if (version === null) return { document: null, version: null };
      const stat = fs.statSync(target);
      if (stat.size > MAX_BYTES) throw new KeyRegistryError('The key registry file is larger than 1 MiB.');
      return { document: parseRegistryDocument(fs.readFileSync(target, 'utf8')), version };
    },
    async write(document, expected) {
      if (currentVersion() !== expected) throw new KeyRegistryConflictError();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const staging = `${target}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(staging, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        // Checked again right before the rename, which narrows the window a second writer could slip into.
        if (currentVersion() !== expected) throw new KeyRegistryConflictError();
        fs.renameSync(staging, target);
      } finally {
        fs.rmSync(staging, { force: true });
      }
      const written = currentVersion();
      if (written === null) throw new KeyRegistryError('The key registry file disappeared after it was written.');
      return written;
    },
  };
}
