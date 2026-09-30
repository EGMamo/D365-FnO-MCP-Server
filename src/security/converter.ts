/**
 * Converts security customizations exported from the D365 F&O Security configuration workspace
 * (a single XML document holding AxSecurityRole / AxSecurityDuty / AxSecurityPrivilege elements)
 * into one AOT XML file per element, with optional renaming and reference fix-up.
 * Approach adapted from D365FOSecurityConverter (https://github.com/ameyer505/D365FOSecurityConverter,
 * MIT, Copyright (c) 2018 Alex Meyer). Pure text transformation: nothing is written to disk.
 */
export const SECURITY_CONVERTER_ATTRIBUTION =
  'Approach adapted from D365FOSecurityConverter (https://github.com/ameyer505/D365FOSecurityConverter, MIT, Copyright (c) 2018 Alex Meyer).';

export type SecurityKind = 'Role' | 'Duty' | 'Privilege';

export const SECURITY_KIND_TO_AOT: Record<SecurityKind, string> = {
  Role: 'SecurityRole', Duty: 'SecurityDuty', Privilege: 'SecurityPrivilege',
};

export interface SecurityReference {
  kind: SecurityKind;
  name: string;
}

export interface SecurityElement {
  kind: SecurityKind;
  name: string;
  xml: string;
  references: SecurityReference[];
}

const ELEMENT_RE = /<AxSecurity(Role|Duty|Privilege)(\s[^>]*)?>[\s\S]*?<\/AxSecurity\1>/g;
const REFERENCE_RE = /<AxSecurity(Role|Duty|Privilege)Reference(?:\s[^>]*)?>([\s\S]*?)<\/AxSecurity\1Reference>/g;
const NAME_RE = /<Name>\s*([^<]*?)\s*<\/Name>/;

/** Offset range of the element's own <Name> (direct child of the root), or null. */
function ownNameRange(xml: string): { start: number; end: number; name: string } | null {
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let depth = 0;
  for (let m = tagRe.exec(xml); m; m = tagRe.exec(xml)) {
    const [whole, closing, tag, , selfClosing] = m;
    if (whole.startsWith('<?') || whole.startsWith('<!')) continue;
    if (closing) { depth--; continue; }
    if (selfClosing) continue;
    depth++;
    if (depth === 2 && tag === 'Name') {
      const close = xml.indexOf('</Name>', tagRe.lastIndex);
      if (close < 0) return null;
      return { start: tagRe.lastIndex, end: close, name: xml.slice(tagRe.lastIndex, close).trim() };
    }
  }
  return null;
}

/** Security elements in document order; nested reference elements are not elements. */
export function parseSecurityExport(xml: string): SecurityElement[] {
  const out: SecurityElement[] = [];
  for (const m of xml.matchAll(ELEMENT_RE)) {
    const kind = m[1] as SecurityKind;
    const elementXml = m[0];
    const own = ownNameRange(elementXml);
    if (!own?.name) continue;
    const references: SecurityReference[] = [];
    for (const r of elementXml.matchAll(REFERENCE_RE)) {
      const name = NAME_RE.exec(r[2])?.[1];
      if (name) references.push({ kind: r[1] as SecurityKind, name });
    }
    out.push({ kind, name: own.name, xml: elementXml, references });
  }
  return out;
}

const key = (kind: SecurityKind, name: string) => `${kind}:${name.toLowerCase()}`;
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface ConvertOptions {
  /** Prefix added to every exported element name (e.g. "Contoso"). */
  prefix?: string;
  /** Explicit old → new names; wins over prefix. */
  renames?: Record<string, string>;
  /** Only these element names (and, with includeDependencies, the exported elements they reference). */
  include?: string[];
  includeDependencies?: boolean;
  /** Returns true when a referenced element exists outside the export (e.g. in the AOT index). */
  existsInIndex?: (ref: SecurityReference) => boolean;
}

export interface ConvertedFile {
  path: string;
  kind: SecurityKind;
  originalName: string;
  name: string;
  content: string;
}

export interface ConvertResult {
  files: ConvertedFile[];
  renamed: { kind: SecurityKind; from: string; to: string }[];
  unresolvedReferences: { from: string; kind: SecurityKind; name: string }[];
  duplicates: string[];
  skipped: string[];
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function convertSecurityExport(xml: string, opts: ConvertOptions = {}): ConvertResult {
  const all = parseSecurityExport(xml);
  const byKey = new Map<string, SecurityElement>();
  const duplicates: string[] = [];
  for (const e of all) {
    const k = key(e.kind, e.name);
    if (byKey.has(k)) duplicates.push(`${e.kind} ${e.name}`); else byKey.set(k, e);
  }
  let selected = [...byKey.values()];
  const skipped: string[] = [];
  if (opts.include?.length) {
    const wanted = new Set(opts.include.map((n) => n.toLowerCase()));
    const keep = new Set<string>();
    const queue = selected.filter((e) => wanted.has(e.name.toLowerCase()));
    while (queue.length) {
      const e = queue.shift()!;
      const k = key(e.kind, e.name);
      if (keep.has(k)) continue;
      keep.add(k);
      if (opts.includeDependencies) {
        for (const r of e.references) {
          const dep = byKey.get(key(r.kind, r.name));
          if (dep) queue.push(dep);
        }
      }
    }
    for (const n of wanted) {
      if (![...keep].some((k) => k.endsWith(`:${n}`))) skipped.push(`${n} (not in export)`);
    }
    selected = selected.filter((e) => keep.has(key(e.kind, e.name)));
  }

  const renames = new Map(Object.entries(opts.renames ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const newName = new Map<string, string>();
  for (const e of selected) {
    const explicit = renames.get(e.name.toLowerCase());
    const target = explicit ?? (opts.prefix && !e.name.startsWith(opts.prefix) ? `${opts.prefix}${e.name}` : e.name);
    if (!NAME_PATTERN.test(target)) throw new Error(`Invalid AOT name "${target}" for ${e.kind} ${e.name}.`);
    newName.set(key(e.kind, e.name), target);
  }

  const renamed: ConvertResult['renamed'] = [];
  const unresolved: ConvertResult['unresolvedReferences'] = [];
  const files: ConvertedFile[] = [];
  for (const e of selected) {
    const name = newName.get(key(e.kind, e.name))!;
    if (name !== e.name) renamed.push({ kind: e.kind, from: e.name, to: name });
    const own = ownNameRange(e.xml)!;
    let body = `${e.xml.slice(0, own.start)}${escapeXml(name)}${e.xml.slice(own.end)}`;
    body = body.replace(REFERENCE_RE, (whole, kind: SecurityKind, inner: string) => {
      const refName = NAME_RE.exec(inner)?.[1];
      if (!refName) return whole;
      const mapped = newName.get(key(kind, refName));
      if (!mapped && !byKey.has(key(kind, refName)) && opts.existsInIndex && !opts.existsInIndex({ kind, name: refName })) {
        unresolved.push({ from: `${e.kind} ${e.name}`, kind, name: refName });
      }
      return mapped && mapped !== refName ? whole.replace(NAME_RE, `<Name>${escapeXml(mapped)}</Name>`) : whole;
    });
    if (/\bi:\w+=/.test(body) && !/xmlns:i=/.test(body.slice(0, body.indexOf('>')))) {
      body = body.replace(/^<AxSecurity(Role|Duty|Privilege)/, (m) => `${m} xmlns:i="http://www.w3.org/2001/XMLSchema-instance"`);
    }
    files.push({
      path: `AxSecurity${e.kind}/${name}.xml`,
      kind: e.kind,
      originalName: e.name,
      name,
      content: `<?xml version="1.0" encoding="utf-8"?>\n${body}\n`,
    });
  }
  return { files, renamed, unresolvedReferences: unresolved, duplicates, skipped };
}
