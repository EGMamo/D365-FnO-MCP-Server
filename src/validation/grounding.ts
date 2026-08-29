import { Database } from 'better-sqlite3';
import * as dbUtils from '../indexer/db.js';

export interface AxMethod {
  name: string;
  access_modifier?: string;
  return_type?: string;
  params?: unknown[];
  is_static?: number;
  is_abstract?: number;
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
export function resolveClassOrTable(db: Database, name: string): AxObject | null {
  if (!name) return null;
  return get(db, name, 'Class') ?? get(db, name, 'Table');
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

/**
 * Find a method on a class or table. When expectedParamCount is supplied the
 * method only matches if its indexed parameter count agrees.
 */
export function validateMethodSignature(
  db: Database,
  classOrTableName: string,
  methodName: string,
  expectedParamCount?: number
): AxMethod | null {
  const obj = resolveClassOrTable(db, classOrTableName) ?? get(db, classOrTableName, 'Form');
  if (!obj) return null;
  const method = obj.methods.find((m) => m.name.toLowerCase() === methodName.toLowerCase());
  if (!method) return null;
  if (expectedParamCount !== undefined) {
    const actual = Array.isArray(method.params) ? method.params.length : 0;
    if (actual !== expectedParamCount) return null;
  }
  return method;
}

export interface CoCTargetResult {
  ok: boolean;
  object?: AxObject;
  error?: string;
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
  const isExtensionOf = typeof obj.raw_xml === 'string' && /ExtensionOf/i.test(obj.raw_xml);
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
    if (field.edt) {
      if (!resolveEdt(db, field.edt)) {
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
