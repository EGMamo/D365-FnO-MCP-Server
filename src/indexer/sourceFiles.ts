import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads an indexed object's source file when the index holds no raw XML.
 *
 * `file_path` comes from the index, so it is only as trustworthy as the index.
 * An index built elsewhere contains paths that mean nothing on this host, and
 * a crafted index could name any file the server can read (for example
 * `/proc/self/environ`, which holds the API keys). The server turns reads off
 * when no local packages tree is configured, and only `.xml` files are read.
 */

let sourceRoot: string | null = null;

/** Allow reads only from the real configured packages tree. */
export function setSourceFileReads(allowed: boolean, packagesRoot?: string): void {
  sourceRoot = null;
  if (!allowed || !packagesRoot) return;
  try {
    const realRoot = fs.realpathSync(packagesRoot);
    if (fs.statSync(realRoot).isDirectory()) sourceRoot = realRoot;
  } catch {
    sourceRoot = null;
  }
}

/** False when the server has no local packages tree. */
export function sourceFileReadsAllowed(): boolean {
  return sourceRoot !== null;
}

function readablePath(filePath: string | null | undefined): string | null {
  if (sourceRoot === null || typeof filePath !== 'string' || !/\.xml$/i.test(filePath)) return null;
  try {
    const realFile = fs.realpathSync(filePath);
    const relative = path.relative(sourceRoot, realFile);
    return relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
      ? realFile
      : null;
  } catch {
    return null;
  }
}

/** Stored XML, else the source file, else null. */
export async function loadObjectXml(obj: { raw_xml?: string | null; file_path?: string | null }): Promise<string | null> {
  if (obj.raw_xml !== null && obj.raw_xml !== undefined) return obj.raw_xml;
  const filePath = readablePath(obj.file_path);
  if (!filePath) return null;
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Synchronous `loadObjectXml` for callers that cannot await; '' when unavailable. */
export function loadObjectXmlSync(obj: { raw_xml?: string | null; file_path?: string | null }): string {
  if (obj.raw_xml !== null && obj.raw_xml !== undefined) return obj.raw_xml;
  const filePath = readablePath(obj.file_path);
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
