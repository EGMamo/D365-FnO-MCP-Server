import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  cdataPropName: '__cdata',
});

/** Generic node produced by fast-xml-parser. */
export type XmlNode = Record<string, unknown>;

/**
 * fast-xml-parser collapses a single repeated child into an object and only
 * produces an array when there are 2+ occurrences. This normalizes both cases.
 */
function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function node(value: unknown): XmlNode {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as XmlNode) : {};
}

function nodes(value: unknown): XmlNode[] {
  return ensureArray(value as unknown[]).map(node);
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    const inner = (value as XmlNode)['__cdata'] ?? (value as XmlNode)['#text'];
    return inner === undefined || inner === null ? '' : String(inner);
  }
  return String(value);
}

function isYes(value: unknown): boolean {
  return text(value).toLowerCase() === 'yes';
}

function isNo(value: unknown): boolean {
  return text(value).toLowerCase() === 'no';
}

export interface AxField {
  name: string;
  type: string;
  edt: string;
  labelId: string;
  mandatory: boolean;
  allowEdit: boolean;
}

export interface AxParam {
  name: string;
  type: string;
}

export interface AxMethod {
  name: string;
  returnType: string;
  isStatic: boolean;
  isAbstract: boolean;
  accessModifier: string;
  params: AxParam[];
}

export interface AxEnumValue {
  name: string;
  value: number | string;
  labelId: string;
}

export interface AxDataSource {
  name: string;
  table: string;
}

export interface AxControl {
  name: string;
  type: string;
  children: AxControl[];
}

export interface AxDataEntityField {
  name: string;
  dataSource: string;
  dataField: string;
  labelId: string;
  mandatory: boolean;
  allowEdit: boolean;
}

const FIELD_TYPE_MAP: Record<string, string> = {
  AxTableFieldString: 'String',
  AxTableFieldInt: 'Int',
  AxTableFieldInt64: 'Int64',
  AxTableFieldReal: 'Real',
  AxTableFieldDate: 'Date',
  AxTableFieldTime: 'Time',
  AxTableFieldUtcDateTime: 'UtcDateTime',
  AxTableFieldEnum: 'Enum',
  AxTableFieldContainer: 'Container',
  AxTableFieldGuid: 'Guid',
  AxTableFieldMemo: 'Memo',
};

/** Map a raw XML type token (e.g. AxTableFieldString) to a canonical type name. */
export function canonicalFieldType(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'Unknown';
  if (FIELD_TYPE_MAP[trimmed]) return FIELD_TYPE_MAP[trimmed];
  if (trimmed.startsWith('AxTableField')) {
    return trimmed.slice('AxTableField'.length) || 'Unknown';
  }
  if (trimmed.startsWith('AxEdt')) {
    return trimmed.slice('AxEdt'.length) || 'Unknown';
  }
  return trimmed;
}

function typeAttr(n: XmlNode): unknown {
  return n['@_i:type'] ?? n['@_xsi:type'] ?? n['@_type'];
}

function mapField(f: XmlNode, typeHint?: string): AxField {
  const raw = typeHint ?? text(typeAttr(f) ?? f['Type'] ?? f['FieldType'] ?? f['ExtendedDataTypeKind']);
  return {
    name: text(f['Name']),
    type: canonicalFieldType(raw),
    edt: text(f['ExtendedDataType']),
    labelId: text(f['Label']),
    mandatory: isYes(f['Mandatory']),
    allowEdit: !isNo(f['AllowEdit']),
  };
}

export function parseAxTable(xml: string, _name?: string, _pkg?: string) {
  const parsed = parser.parse(xml) as XmlNode;
  const root = node(parsed['AxTable']);
  const fieldsNode = node(root['Fields']);

  const fields: AxField[] = [];
  // Generic form: <AxTableField i:type="AxTableFieldString">
  for (const f of nodes(fieldsNode['AxTableField'])) {
    fields.push(mapField(f));
  }
  // Typed-element form: <AxTableFieldString>...</AxTableFieldString>
  for (const key of Object.keys(fieldsNode)) {
    if (key === 'AxTableField' || !key.startsWith('AxTableField')) continue;
    for (const f of nodes(fieldsNode[key])) {
      fields.push(mapField(f, key));
    }
  }

  const methods: AxMethod[] = nodes(node(root['Methods'])['Method']).map((m) => {
    const source = collectSource(m['Source']);
    const fromSource = source ? parseXppMethods(source)[0] : undefined;
    return {
      name: text(m['Name']) || fromSource?.name || '',
      returnType: text(m['ReturnType']) || fromSource?.returnType || 'void',
      isStatic: isYes(m['IsStatic']) || fromSource?.isStatic === true,
      isAbstract: isYes(m['IsAbstract']) || fromSource?.isAbstract === true,
      accessModifier: text(m['AccessModifier']) || fromSource?.accessModifier || 'public',
      params: fromSource?.params ?? [],
    };
  });

  const indexes = nodes(node(root['Indexes'])['AxTableIndex']).map((i) => text(i['Name']));

  return {
    fields,
    methods,
    indexes,
    extends: text(root['Extends']),
    label: text(root['Label']),
    saveDataPerCompany: !isNo(root['SaveDataPerCompany']),
    properties: root,
  };
}

const ACCESS_MODIFIERS = new Set(['public', 'protected', 'private', 'internal', 'default']);
const KEYWORD_BLOCKLIST = new Set([
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'return',
  'new',
  'super',
  'else',
  'do',
  'using',
  'changecompany',
]);

/** Remove block and line comments while preserving line structure. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

function splitParams(raw: string): AxParam[] {
  const inner = raw.trim();
  if (!inner) return [];

  const chunks: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '<' || ch === '[' || ch === '(') depth++;
    else if (ch === '>' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      chunks.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  chunks.push(current);

  return chunks
    .map((p) => p.split('=')[0].trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const tokens = p.split(/\s+/).filter(Boolean);
      if (tokens.length === 1) return { name: tokens[0], type: '' };
      return { name: tokens[tokens.length - 1], type: tokens.slice(0, -1).join(' ') };
    })
    .filter((p) => p.name.length > 0);
}

const METHOD_RE =
  /^((?:(?:public|protected|private|internal|default|static|abstract|final|server|client|display|edit)\s+)*)([A-Za-z_][\w.]*(?:\s*<[^>]*>)?\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{?$/;

function matchMethodDeclaration(signature: string): AxMethod | null {
  const s = signature.replace(/\s+/g, ' ').trim();
  const m = METHOD_RE.exec(s);
  if (!m) return null;

  const modifiers = (m[1] || '').trim().split(/\s+/).filter(Boolean);
  let returnType = (m[2] || '').trim();
  const name = m[3];

  if (KEYWORD_BLOCKLIST.has(name.toLowerCase())) return null;
  if (returnType && KEYWORD_BLOCKLIST.has(returnType.toLowerCase())) return null;
  // A bare `foo(x)` with neither modifier nor return type is a call, not a declaration.
  if (modifiers.length === 0 && !returnType) return null;

  const accessModifier = modifiers.find((t) => ACCESS_MODIFIERS.has(t.toLowerCase())) ?? 'public';
  const isStatic = modifiers.some((t) => t.toLowerCase() === 'static');
  const isAbstract = modifiers.some((t) => t.toLowerCase() === 'abstract');
  if (!returnType) returnType = 'void';

  return { name, returnType, isStatic, isAbstract, accessModifier, params: splitParams(m[4] || '') };
}

/**
 * Line-based X++ method declaration scanner. Handles multi-line signatures,
 * comments, attributes, and optional access modifiers / return types.
 */
export function parseXppMethods(source: string): AxMethod[] {
  const cleaned = stripComments(source);
  const methods: AxMethod[] = [];
  const seen = new Set<string>();

  let buffer = '';
  let depth = 0; // brace depth; declarations only live at class-body level

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line && depth <= 1) {
      buffer = buffer ? `${buffer} ${line}` : line;
      const open = (buffer.match(/\(/g) || []).length;
      const close = (buffer.match(/\)/g) || []).length;
      if (open > 0 && open === close) {
        const decl = matchMethodDeclaration(buffer);
        if (decl && !seen.has(decl.name)) {
          seen.add(decl.name);
          methods.push(decl);
        }
        buffer = '';
      } else if (open === 0) {
        buffer = '';
      }
    }

    depth += (rawLine.match(/\{/g) || []).length;
    depth -= (rawLine.match(/\}/g) || []).length;
    if (depth < 0) depth = 0;
  }

  return methods;
}

function collectSource(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(collectSource).join('\n');
  return text(value);
}

export function parseAxClass(xml: string, _name?: string, _pkg?: string) {
  const parsed = parser.parse(xml) as XmlNode;
  const root = node(parsed['AxClass']);
  const sourceCode = node(root['SourceCode']);

  // Real D365 layout is <SourceCode><Methods><Method>; older/simplified files use <Methods>.
  const methodsContainer = node(sourceCode['Methods'] ?? root['Methods']);
  const methodNodes = nodes(methodsContainer['Method']);
  const methods: AxMethod[] = [];

  for (const m of methodNodes) {
    const msrc = collectSource(m['Source']);
    const parsedMethods = msrc ? parseXppMethods(msrc) : [];
    const declaredName = text(m['Name']);
    const match = parsedMethods.find((p) => !declaredName || p.name === declaredName) ?? parsedMethods[0];
    if (match) {
      methods.push({ ...match, name: declaredName || match.name });
    } else if (declaredName) {
      methods.push({
        name: declaredName,
        returnType: 'void',
        isStatic: false,
        isAbstract: false,
        accessModifier: 'public',
        params: [],
      });
    }
  }

  const classSource = collectSource(root['Source']);
  if (methods.length === 0 && classSource) {
    methods.push(...parseXppMethods(classSource));
  }

  const declarationSource = collectSource(sourceCode['Declaration']) || classSource;
  const declMatch = /\b(?:class|interface)\s+[\w.]+((?:\s+(?:extends|implements)\s+[\w.,\s]+?)?)\s*(?:\{|$)/m.exec(
    stripComments(declarationSource)
  );
  const declExtends = declMatch ? /\bextends\s+([\w.]+)/.exec(declMatch[1])?.[1] ?? '' : '';
  const declImplements = declMatch
    ? (/\bimplements\s+([\w.,\s]+)/.exec(declMatch[1])?.[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  const implementsRaw = root['Implements'];
  const implementsList = (
    typeof implementsRaw === 'object' && implementsRaw !== null
      ? nodes(node(implementsRaw)['AxClassImplement']).map((i) => text(i['Name']))
      : ensureArray(implementsRaw).map((i) => text(i))
  ).filter((v) => v.length > 0);

  return {
    methods,
    source:
      classSource ||
      [declarationSource, ...methodNodes.map((m) => collectSource(m['Source']))].filter(Boolean).join('\n'),
    extends: text(root['Extends']) || declExtends,
    implements: implementsList.length > 0 ? implementsList : declImplements,
    isAbstract: isYes(root['IsAbstract']),
    isFinal: isYes(root['IsFinal']),
    properties: root,
  };
}

export function parseAxEnum(xml: string, _name?: string, _pkg?: string) {
  const parsed = parser.parse(xml) as XmlNode;
  const root = node(parsed['AxEnum']);

  let nextImplicit = 0;
  const values: AxEnumValue[] = nodes(node(root['EnumValues'])['AxEnumValue']).map((v) => {
    const rawValue = text(v['Value']);
    let value: number | string;
    if (rawValue === '') {
      value = nextImplicit;
      nextImplicit += 1;
    } else if (Number.isNaN(Number(rawValue))) {
      value = rawValue;
      nextImplicit += 1;
    } else {
      value = Number(rawValue);
      nextImplicit = value + 1;
    }
    return {
      name: text(v['Name']),
      value,
      labelId: text(v['Label']),
    };
  });

  return {
    values,
    label: text(root['Label']),
    isExtensible: isYes(root['IsExtensible']),
    properties: root,
  };
}

function collectControls(container: unknown, depth = 0): AxControl[] {
  const c = node(container);
  const controls: AxControl[] = [];
  for (const key of Object.keys(c)) {
    if (!key.startsWith('AxFormControl')) continue;
    for (const ctrl of nodes(c[key])) {
      const t = text(typeAttr(ctrl) ?? ctrl['Type']);
      controls.push({
        name: text(ctrl['Name']),
        type: canonicalControlType(t || key),
        children: depth >= 2 ? [] : collectControls(ctrl['Controls'], depth + 1),
      });
    }
  }
  return controls;
}

function canonicalControlType(raw: string): string {
  const trimmed = (raw || '').trim();
  if (trimmed === 'AxFormControl') return 'Control';
  if (trimmed.startsWith('AxFormControl')) return trimmed.slice('AxFormControl'.length) || 'Control';
  return trimmed;
}

export function parseAxForm(xml: string, _name?: string, _pkg?: string) {
  const parsed = parser.parse(xml) as XmlNode;
  const root = node(parsed['AxForm']);

  const dataSources: AxDataSource[] = nodes(node(root['DataSources'])['AxFormDataSource']).map((ds) => ({
    name: text(ds['Name']),
    table: text(ds['Table']),
  }));

  const design = node(root['Design']);

  return {
    dataSources,
    controls: collectControls(design['Controls']),
    pattern: text(design['Pattern']),
    patternVersion: text(design['PatternVersion']),
    caption: text(design['Caption']),
    properties: root,
  };
}

export function parseAxQuery(xml: string, _name?: string, _pkg?: string) {
  const parsed = parser.parse(xml) as XmlNode;
  const root = node(parsed['AxQuery']);

  const dataSources: AxDataSource[] = [];
  const walk = (container: unknown, level: number) => {
    const dsNode = node(container);
    for (const key of Object.keys(dsNode)) {
      if (!key.startsWith('AxQuery')) continue;
      for (const ds of nodes(dsNode[key])) {
        dataSources.push({ name: text(ds['Name']), table: text(ds['Table']) });
        if (level < 3) walk(ds['DataSources'], level + 1);
      }
    }
  };
  walk(root['DataSources'], 0);

  return {
    dataSources,
    title: text(root['Title']),
    properties: root,
  };
}

export function parseAxDataEntity(xml: string, _name?: string, _pkg?: string) {
  const parsed = parser.parse(xml) as XmlNode;
  const root = node(parsed['AxDataEntityView']);
  const fieldsNode = node(root['Fields']);

  const fields: AxDataEntityField[] = [];
  for (const key of Object.keys(fieldsNode)) {
    if (!key.startsWith('AxDataEntityViewField')) continue;
    for (const f of nodes(fieldsNode[key])) {
      fields.push({
        name: text(f['Name']),
        dataSource: text(f['DataSource']),
        dataField: text(f['DataField']),
        labelId: text(f['Label']),
        mandatory: isYes(f['Mandatory']),
        allowEdit: !isNo(f['AllowEdit']),
      });
    }
  }

  const dataSources: AxDataSource[] = [];
  for (const vm of nodes(root['ViewMetadata'])) {
    const dsNode = node(vm['DataSources']);
    for (const key of Object.keys(dsNode)) {
      if (!key.startsWith('AxQuery')) continue;
      for (const ds of nodes(dsNode[key])) {
        dataSources.push({ name: text(ds['Name']), table: text(ds['Table']) });
      }
    }
  }

  return {
    fields,
    dataSources,
    publicEntityName: text(root['PublicEntityName']),
    publicCollectionName: text(root['PublicCollectionName']),
    stagingTable: text(root['DataManagementStagingTable']),
    primaryKey: text(root['PrimaryKey']),
    isPublic: isYes(root['IsPublic']),
    properties: root,
  };
}

export function parseAxEdt(xml: string, _name?: string, _pkg?: string) {
  const parsed = parser.parse(xml) as XmlNode;
  const root = node(parsed['AxEdt']);
  const rawSize = text(root['StringSize']);

  return {
    extends: text(root['Extends']),
    labelId: text(root['Label']),
    helpText: text(root['HelpText']),
    stringSize: rawSize === '' ? 0 : Number(rawSize) || 0,
    edtType: canonicalFieldType(text(typeAttr(root))),
    properties: root,
  };
}

export function parseLabels(content: string) {
  const labels: { labelId: string; value: string }[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.includes('=')) {
      const [key, ...valueParts] = line.split('=');
      if (key && !key.startsWith(' ')) {
        labels.push({ labelId: key.trim(), value: valueParts.join('=').trim() });
      }
    }
  }
  return labels;
}
