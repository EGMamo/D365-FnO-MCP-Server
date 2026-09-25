import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface XmlElement {
  qualifiedName: string;
  name: string;
  namespace: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

export interface XmlDocument {
  text: string;
  root: XmlElement;
  encode: (text: string) => Buffer;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid XML parser output.');
  }
  return value as Record<string, unknown>;
}

export function decodeText(bytes: Buffer): { text: string; encode: (text: string) => Buffer } {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let bom: Buffer = Buffer.alloc(0);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    bom = bytes.subarray(0, 3);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    encoding = 'utf-16le';
    bom = bytes.subarray(0, 2);
  } else if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    encoding = 'utf-16be';
    bom = bytes.subarray(0, 2);
  } else if (bytes.includes(0)) {
    throw new Error('Unsupported encoding: UTF-16 requires a BOM.');
  }
  const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true })
    .decode(bytes.subarray(bom.length));
  const declared = /^\s*<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(text)?.[1]
    .toLowerCase();
  if (declared && declared !== encoding && !(declared === 'utf-16' && encoding !== 'utf-8')) {
    throw new Error(`Unsupported or mismatched XML encoding: ${declared}.`);
  }
  return {
    text,
    encode: (value) => {
      const body = Buffer.from(value, encoding === 'utf-8' ? 'utf8' : 'utf16le');
      if (encoding === 'utf-16be') body.swap16();
      return Buffer.concat([bom, body]);
    },
  };
}

export function parseXml(bytes: Buffer, source: string): XmlDocument {
  if (bytes.length > 2 * 1024 * 1024) throw new Error(`XML exceeds 2 MiB limit: ${source}`);
  const document = decodeText(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(document.text)) {
    throw new Error(`DTD/entity declarations are unsupported: ${source}`);
  }
  const validCodePoint = (code: number) => code === 9 || code === 10 || code === 13 ||
    (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  for (const character of document.text) {
    if (!validCodePoint(character.codePointAt(0)!)) throw new Error(`Invalid XML character in ${source}`);
  }
  // fast-xml-parser validates structure but accepts undeclared/invalid character entities.
  const entityText = document.text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '');
  for (const match of entityText.matchAll(/&(?:[^&<\s;]*;)?/g)) {
    if (/^&(amp|lt|gt|apos|quot);$/.test(match[0])) continue;
    const numeric = /^&#(x[\da-fA-F]+|\d+);$/.exec(match[0]);
    const code = numeric ? numeric[1].startsWith('x')
      ? Number.parseInt(numeric[1].slice(1), 16) : Number(numeric[1]) : NaN;
    if (!validCodePoint(code)) throw new Error(`Undeclared or invalid XML entity in ${source}: ${match[0]}`);
  }
  const validated = XMLValidator.validate(document.text);
  if (validated !== true) {
    throw new Error(`Malformed XML in ${source}: ${validated.err.msg}`);
  }
  const parsed: unknown = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    commentPropName: '#comment',
    cdataPropName: '#cdata',
  }).parse(document.text);

  function elements(value: unknown, namespaces: Record<string, string>, depth: number): XmlElement[] {
    if (!Array.isArray(value) || depth > 100) throw new Error(`Unsupported XML structure: ${source}`);
    const result: XmlElement[] = [];
    for (const entry of value) {
      const node = record(entry);
      const qualifiedName = Object.keys(node).find((key) => key !== ':@');
      if (!qualifiedName || qualifiedName.startsWith('#') || qualifiedName.startsWith('?')) continue;
      const attributes: Record<string, string> = {};
      for (const [key, attr] of Object.entries(node[':@'] ? record(node[':@']) : {})) {
        if (typeof attr !== 'string') throw new Error(`Unsupported XML attribute in ${source}`);
        attributes[key] = attr;
      }
      const scope = { ...namespaces };
      for (const [key, attr] of Object.entries(attributes)) {
        if (key === 'xmlns') scope[''] = attr;
        if (key.startsWith('xmlns:')) scope[key.slice(6)] = attr;
      }
      const parts = qualifiedName.split(':');
      const prefix = parts.length === 2 ? parts[0] : '';
      if (parts.length > 2 || (prefix && !(prefix in scope))) {
        throw new Error(`Unbound XML namespace in ${source}: ${qualifiedName}`);
      }
      for (const attr of Object.keys(attributes)) {
        const attrPrefix = attr.includes(':') ? attr.split(':')[0] : '';
        if (attrPrefix && attrPrefix !== 'xmlns' && !(attrPrefix in scope)) {
          throw new Error(`Unbound XML attribute namespace in ${source}: ${attr}`);
        }
      }
      const children: unknown = node[qualifiedName];
      if (!Array.isArray(children)) throw new Error(`Invalid XML content in ${source}`);
      let text = '';
      for (const child of children) {
        const content = record(child);
        if (typeof content['#text'] === 'string') text += content['#text'];
        if (Array.isArray(content['#cdata'])) {
          for (const chunk of content['#cdata']) {
            const data = record(chunk)['#text'];
            if (typeof data === 'string') text += data;
          }
        }
      }
      result.push({
        qualifiedName,
        name: parts.at(-1)!,
        namespace: scope[prefix] || '',
        attributes,
        text,
        children: elements(children, scope, depth + 1),
      });
    }
    return result;
  }
  const roots = elements(parsed, { xml: 'http://www.w3.org/XML/1998/namespace' }, 0);
  if (roots.length !== 1) throw new Error(`Expected one XML root in ${source}`);
  return { ...document, root: roots[0] };
}

export function descendants(node: XmlElement): XmlElement[] {
  return [node, ...node.children.flatMap(descendants)];
}

export function literalText(node: XmlElement): string {
  if (node.children.length || Object.keys(node.attributes).some((key) => !key.startsWith('xmlns'))) {
    throw new Error(`Unsupported attributes or nested content on ${node.name}.`);
  }
  const text = node.text.trim();
  if (!text || /[$@%]\(|%[0-9a-f]{2}/i.test(text)) {
    throw new Error(`Expected a nonempty literal ${node.name}; dynamic values are unsupported.`);
  }
  return text;
}

export function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Locate the validated root's closing token, ignoring comments, CDATA and quoted attributes. */
export function rootClosingOffset(document: XmlDocument): number {
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  let depth = 0;
  for (const token of document.text.matchAll(tokens)) {
    const text = token[0];
    if (text.startsWith('<!') || text.startsWith('<?')) continue;
    if (text.startsWith('</')) {
      if (--depth === 0) return token.index;
    } else if (!text.endsWith('/>')) {
      depth++;
    }
  }
  throw new Error('A non-self-closing project root is required for a surgical edit.');
}
