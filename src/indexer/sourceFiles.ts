import fs from 'node:fs';

/**
 * Reads an indexed object's source file when the index holds no raw XML.
 *
 * `file_path` comes from the index, so it is only as trustworthy as the index.
 * An index built elsewhere contains paths that mean nothing on this host, and
 * a crafted index could name any file the server can read (for example
 * `/proc/self/environ`, which holds the API keys). The server turns reads off
 * when no local packages tree is configured, and only `.xml` files are read.
 */

let sourceReadsAllowed = true;

/** Allow or forbid reading source files named by the index. */
export function setSourceFileReads(allowed: boolean): void {
  sourceReadsAllowed = allowed;
}

/** False when the server has no local packages tree. */
export function sourceFileReadsAllowed(): boolean {
  return sourceReadsAllowed;
}

function readable(filePath: string | null | undefined): filePath is string {
  return sourceReadsAllowed && typeof filePath === 'string' && /\.xml$/i.test(filePath);
}

/** Stored XML, else the source file, else null. */
export async function loadObjectXml(obj: { raw_xml?: string | null; file_path?: string | null }): Promise<string | null> {
  if (obj.raw_xml) return obj.raw_xml;
  if (!readable(obj.file_path)) return null;
  try {
    return await fs.promises.readFile(obj.file_path, 'utf-8');
  } catch {
    return null;
  }
}

/** Synchronous `loadObjectXml` for callers that cannot await; '' when unavailable. */
export function loadObjectXmlSync(obj: { raw_xml?: string | null; file_path?: string | null }): string {
  if (obj.raw_xml) return obj.raw_xml;
  if (!readable(obj.file_path)) return '';
  try {
    return fs.readFileSync(obj.file_path, 'utf-8');
  } catch {
    return '';
  }
}
