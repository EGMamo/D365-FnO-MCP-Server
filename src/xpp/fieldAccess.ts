import { lineAt, maskXpp, matchBrace, type XppMethodSource } from './scanner.js';

/**
 * Read/write classification of table-field references in X++ source.
 * The per-line heuristic follows TRUDUtilsD365 "Show cross-reference with read/write access"
 * (DetermineAccessType, https://github.com/TrudAX/TRUDUtilsD365, MIT, Copyright (c) Denis Trunin):
 * `.setField(fieldNum(T, F), …)` is a write; `F` left of `=`, `+=`, `-=` (or `F++`/`F--`) is a write;
 * everything else, including `==`, `!=`, `<=`, `>=` comparisons, is a read. Set-based
 * `update_recordset … setting F = …` and `insert_recordset T (F, …)` targets are writes.
 */
export const FIELD_ACCESS_ATTRIBUTION =
  'Read/write heuristic adapted from TRUDUtilsD365 (https://github.com/TrudAX/TRUDUtilsD365, MIT, Copyright (c) Denis Trunin).';

export type FieldAccessKind = 'Read' | 'Write';
/** declared: buffer variable declared with the table type; this: table/extension code; fieldNum: fieldNum(Table, Field); name-match: buffer named like the table (form data source); unknown: buffer type not resolved. */
export type FieldAccessConfidence = 'declared' | 'this' | 'fieldNum' | 'set-based' | 'name-match' | 'unknown';

export interface FieldAccess {
  method: string;
  line: number;
  access: FieldAccessKind;
  confidence: FieldAccessConfidence;
  code: string;
}

export interface FieldAccessContext {
  table: string;
  field: string;
  /** True when `this` refers to a buffer of the table (table methods or a table extension class). */
  thisIsTable: boolean;
  /** Masked class/table declaration, for member variable types. */
  declaration?: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Variable name → declared type (lowercase), from declarations and parameters. */
function declaredTypes(code: string): Map<string, string> {
  const vars = new Map<string, string>();
  const skip = new Set(['return', 'new', 'else', 'case', 'throw', 'next', 'select', 'while', 'if', 'public', 'private', 'protected', 'static', 'final', 'server', 'client']);
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?=[;,=)])/g)) {
    const [, type, name] = m;
    if (skip.has(type.toLowerCase())) continue;
    if (!vars.has(name.toLowerCase())) vars.set(name.toLowerCase(), type.toLowerCase());
  }
  return vars;
}

function assignmentKind(line: string, accessEnd: number): FieldAccessKind {
  const tail = line.slice(accessEnd);
  if (/^\s*(\+\+|--|\+=|-=|\*=|\/=)/.test(tail)) return 'Write';
  if (/^\s*=(?!=)/.test(tail)) return 'Write';
  return 'Read';
}

export function findFieldAccess(method: XppMethodSource, ctx: FieldAccessContext): FieldAccess[] {
  const { code } = maskXpp(method.source);
  const lines = method.source.split('\n');
  const field = esc(ctx.field);
  const table = ctx.table.toLowerCase();
  const types = declaredTypes((ctx.declaration ?? '') + '\n' + code);
  const out: FieldAccess[] = [];
  const seen = new Set<number>();
  const push = (offset: number, access: FieldAccessKind, confidence: FieldAccessConfidence) => {
    const line = lineAt(code, offset);
    if (seen.has(offset)) return;
    seen.add(offset);
    out.push({ method: method.name, line, access, confidence, code: (lines[line - 1] ?? '').trim().slice(0, 200) });
  };

  for (const m of code.matchAll(new RegExp(`\\bfieldNum\\s*\\(\\s*${esc(ctx.table)}\\s*,\\s*${field}\\s*\\)`, 'gi'))) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!);
    push(m.index!, /\.\s*setField\s*\(\s*$/i.test(before) ? 'Write' : 'Read', 'fieldNum');
  }

  for (const m of code.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s*\\.\\s*(${field})\\b(?!\\s*\\()`, 'gi'))) {
    const buffer = m[1].toLowerCase();
    let confidence: FieldAccessConfidence;
    if (buffer === 'this') {
      if (!ctx.thisIsTable) continue;
      confidence = 'this';
    } else if (types.has(buffer)) {
      if (types.get(buffer) !== table) continue;
      confidence = 'declared';
    } else {
      confidence = buffer === table ? 'name-match' : 'unknown';
    }
    const end = m.index! + m[0].length;
    const lineStart = code.lastIndexOf('\n', m.index!) + 1;
    const lineEnd = code.indexOf('\n', end);
    const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd);
    push(m.index!, assignmentKind(line, end - lineStart), confidence);
  }

  for (const m of code.matchAll(/\bupdate_recordset\b\s+(?:\w+\s+)*?([A-Za-z_]\w*)\s+setting\b/gi)) {
    const buffer = m[1].toLowerCase();
    const type = types.get(buffer);
    if (type ? type !== table : buffer !== table) continue;
    const start = m.index! + m[0].length;
    const stop = code.slice(start).search(/\b(where|join|exists|notexists|outer)\b|;/i);
    const setting = code.slice(start, stop === -1 ? code.length : start + stop);
    for (const s of setting.matchAll(new RegExp(`(^|,)\\s*(${field})\\s*=(?!=)`, 'gi'))) {
      push(start + s.index! + s[0].indexOf(s[2]), 'Write', 'set-based');
    }
  }

  for (const m of code.matchAll(/\binsert_recordset\b\s+([A-Za-z_]\w*)\s*\(/gi)) {
    const buffer = m[1].toLowerCase();
    const type = types.get(buffer);
    if (type ? type !== table : buffer !== table) continue;
    const open = m.index! + m[0].length - 1;
    const list = code.slice(open, matchBrace(code, open, '(', ')'));
    const hit = new RegExp(`\\b${field}\\b`, 'i').exec(list);
    if (hit) push(open + hit.index, 'Write', 'set-based');
  }

  return out.sort((a, b) => a.line - b.line);
}
