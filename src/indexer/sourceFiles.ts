import fs from 'node:fs';

/**
 * Reads an indexed object's source file when the index holds no raw XML.
 *
 * `file_path` comes from the index, so it is only as trustworthy as the index.
 * A local index was built on this machine from its own packages folder, but a
 * published or uploaded one was built elsewhere: its paths mean nothing here
 * and a crafted index could name any file the server can read (for example
 * `/proc/self/environ`, which holds the API keys). The server turns reads off
 * whenever it serves such an index, and only `.xml` files are ever read.
 */

let sourceReadsAllowed = true;

/** Allow or forbid reading source files named by the index; the server forbids it for transferred indexes. */
export function setSourceFileReads(allowed: boolean): void {
  sourceReadsAllowed = allowed;
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
