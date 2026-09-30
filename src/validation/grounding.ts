import type { Database } from '../indexer/db.js';
import * as dbUtils from '../indexer/db.js';
import fs from 'fs';

export interface AxMethod {
  name: string;
  access_modifier?: string;
  return_type?: string;
  params?: unknown[];
  is_static?: number;
  is_abstract?: number;
  /** Name of the object the method was declared on, when inherited from a base class. */
  declaring_object?: string;
}

export interface AxObject {
  id: number;
  type: string;
  name: string;
  package: string;
  model: string;
  file_path: string;
  raw_xml?: string;
  fields: {
    name: string;
    type?: string;
    edt?: string;
    label_id?: string;
    mandatory?: number;
    allow_edit?: number;
  }[];
  methods: AxMethod[];
  properties: Record<string, string>;
}

/** X++ reserved words that may not be used as identifiers. */
export const XPP_RESERVED_WORDS = new Set([
  'abstract', 'anytype', 'as', 'asc', 'at', 'avg', 'break', 'by', 'byref', 'case', 'catch',
  'changecompany', 'class', 'client', 'container', 'continue', 'count', 'crosscompany',
  'date', 'default', 'delegate', 'delete_from', 'desc', 'display', 'div', 'do', 'edit',
  'else', 'enum', 'eventhandler', 'exists', 'extends', 'false', 'final', 'firstfast',
  'firstonly', 'flush', 'for', 'forceliterals', 'forcenestedloop', 'forceplaceholders',
  'forceselectorder', 'forupdate', 'from', 'group', 'if', 'implements', 'index', 'insert_recordset',
  'int', 'int64', 'interface', 'is', 'join', 'like', 'maxof', 'minof', 'mod', 'new', 'next',
  'nofetch', 'notexists', 'null', 'optimisticlock', 'order', 'outer', 'pause', 'pessimisticlock',
  'print', 'private', 'protected', 'public', 'real', 'repeatableread', 'retry', 'return',
  'reverse', 'select', 'server', 'setting', 'static', 'str', 'sum', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'ttsabort', 'ttsbegin', 'ttscommit', 'update_recordset', 'validtimestate',
  'void', 'where', 'while', 'window',
]);

const OBJECT_TYPES = ['Class', 'Table', 'Form', 'Enum', 'Query', 'DataEntity', 'Edt'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

function get(db: Database, name: string, type: string): AxObject | null {
  return dbUtils.getObjectByName(db, name, type) as AxObject | null;
}

/** Resolve a Class or Table (in that order) by name. Returns null when unknown. */
function resolveClassOrTable(db: Database, name: string): AxObject | null {
  if (!name) return null;
  return get(db, name, 'Class') ?? get(db, name, 'Table');
}

/** Resolve a Class by name. Returns null when the name is unknown or is not a class. */
export function resolveClass(db: Database, name: string): AxObject | null {
  if (!name) return null;
  return get(db, name, 'Class');
}

/** Resolve any indexable AOT object by name, trying each known type. */
export function resolveAnyObject(db: Database, name: string): AxObject | null {
  if (!name) return null;
  for (const type of OBJECT_TYPES) {
    const obj = get(db, name, type);
    if (obj) return obj;
  }
  return null;
}

/** Resolve an Extended Data Type by name. */
export function resolveEdt(db: Database, name: string): AxObject | null {
  if (!name) return null;
  return get(db, name, 'Edt');
}

/** Resolve a label id (with or without leading '@') to its value. */
export function resolveLabel(db: Database, labelId: string): string | null {
  if (!labelId) return null;
  const cleanId = labelId.startsWith('@') ? labelId.slice(1) : labelId;
  const row = db.prepare(`SELECT value FROM ax_labels WHERE label_id = ? LIMIT 1`).get(cleanId) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

/** Maximum number of base classes walked when resolving an inherited method. */
const MAX_INHERITANCE_DEPTH = 10;

function findMethodOn(obj: AxObject, methodName: string): AxMethod | undefined {
  return obj.methods?.find((m) => m.name.toLowerCase() === methodName.toLowerCase());
}

function baseNameOf(obj: AxObject): string {
  const value = obj.properties?.extends ?? obj.properties?.Extends ?? '';
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Find a method on a class or table, walking the `extends` chain (bounded depth)
 * so Chain of Command on inherited methods resolves. When expectedParamCount is
 * supplied the method only matches if its indexed parameter count agrees.
 */
export function validateMethodSignature(
  db: Database,
  classOrTableName: string,
  methodName: string,
  expectedParamCount?: number
): AxMethod | null {
  let obj = resolveClassOrTable(db, classOrTableName) ?? get(db, classOrTableName, 'Form');
  if (!obj) return null;

  let method: AxMethod | undefined;
  let declaringObject = obj.name;
  const visited = new Set<string>([obj.name.toLowerCase()]);

  for (let depth = 0; depth <= MAX_INHERITANCE_DEPTH; depth++) {
    const found = findMethodOn(obj, methodName);
    if (found) {
      method = found;
      declaringObject = obj.name;
      break;
    }
    const baseName = baseNameOf(obj);
    if (!baseName || visited.has(baseName.toLowerCase())) break;
    visited.add(baseName.toLowerCase());
    const base = resolveClassOrTable(db, baseName);
    if (!base) break;
    obj = base;
  }

  if (!method) return null;
  if (expectedParamCount !== undefined) {
    const actual = Array.isArray(method.params) ? method.params.length : 0;
    if (actual !== expectedParamCount) return null;
  }
  return {
    ...method,
    access_modifier: method.access_modifier || 'public',
    is_static: method.is_static ? 1 : 0,
    declaring_object: declaringObject,
  };
}

export interface CoCTargetResult {
  ok: boolean;
  object?: AxObject;
  error?: string;
}

/** Matches the X++ attribute form `[ExtensionOf(...)]` rather than any mention of the word. */
const EXTENSION_OF_ATTRIBUTE_RE = /\[\s*ExtensionOf\s*\(/i;

/** Remove XML, X++ line and block comments so attribute detection ignores commented-out code. */
function stripXppComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

function readSourceIfAvailable(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Split an X++ parameter list into its parameter identifiers, ignoring any
 * default values (`boolean _skip = false` yields `_skip`).
 */
export function extractParamNames(params: string): string[] {
  return (params || '')
    .split(',')
    .map((p) => p.split('=')[0].trim())
    .filter(Boolean)
    .map((p) => p.split(/\s+/).pop() as string)
    .filter(Boolean);
}

/**
 * Verify that a Chain of Command target exists and is a real base object,
 * not itself an extension class.
 */
export function validateCoCTarget(db: Database, className: string): CoCTargetResult {
  if (!className) return { ok: false, error: 'No target specified.' };
  if (/_Extension$/i.test(className)) {
    return {
      ok: false,
      error: `Target '${className}' looks like an extension class. Chain of Command must target the base object, not an existing extension.`,
    };
  }

  const obj =
    get(db, className, 'Class') ?? get(db, className, 'Table') ?? get(db, className, 'Form');
  if (!obj) {
    return {
      ok: false,
      error: `Target '${className}' was not found in the index as a Class, Table or Form. Cannot generate Chain of Command code that references a non-existent object.`,
    };
  }

  const isFinal = obj.properties?.isFinal === 'true' || obj.properties?.IsFinal === 'true';
  const declarationSource =
    obj.properties?.declaration || obj.properties?.Declaration || obj.raw_xml || readSourceIfAvailable(obj.file_path);
  const isExtensionOf =
    typeof declarationSource === 'string' &&
    EXTENSION_OF_ATTRIBUTE_RE.test(stripXppComments(declarationSource));
  if (isExtensionOf) {
    return {
      ok: false,
      error: `Target '${className}' is already an extension class (declares [ExtensionOf]). Target the base object instead.`,
    };
  }
  if (isFinal && obj.type === 'Class') {
    // Final classes are still extensible via CoC in D365; keep as informational only.
  }

  return { ok: true, object: obj };
}

export interface FieldSpec {
  name: string;
  edt?: string;
  label?: string;
}

export interface FieldValidationResult {
  ok: boolean;
  errors: string[];
}

/** Validate field names and, when provided, that each field's EDT exists. */
export function validateTableFieldEdts(db: Database, fields: FieldSpec[]): FieldValidationResult {
  const errors: string[] = [];
  for (const field of fields ?? []) {
    const naming = validateNaming(field.name);
    if (!naming.ok) errors.push(`Field '${field.name}': ${naming.error}`);
    if (field.edt !== undefined) {
      if (field.edt.trim() === '') {
        errors.push(
          `Field '${field.name}': EDT must not be empty. Supply a valid Extended Data Type name.`
        );
      } else if (!resolveEdt(db, field.edt)) {
        errors.push(`Field '${field.name}': EDT '${field.edt}' was not found in the index.`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export interface NamingResult {
  ok: boolean;
  error?: string;
}

/** Check X++ identifier rules: letter/underscore start, alphanumeric body, not reserved. */
export function validateNaming(name: string): NamingResult {
  if (!name || name.trim() === '') return { ok: false, error: 'Name must not be empty.' };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return {
      ok: false,
      error: `'${name}' is not a valid X++ identifier (must start with a letter or underscore and contain only letters, digits or underscores).`,
    };
  }
  if (XPP_RESERVED_WORDS.has(name.toLowerCase())) {
    return { ok: false, error: `'${name}' is a reserved X++ keyword.` };
  }
  if (name.length > 40) {
    return { ok: false, error: `'${name}' exceeds the 40 character AOT name limit.` };
  }
  return { ok: true };
}
