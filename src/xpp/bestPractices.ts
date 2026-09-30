import { findLoops, findSelects, lineAt, maskXpp, type XppMethodSource } from './scanner.js';

/**
 * X++ best-practice checks. Rule monikers, intent and messages are adapted from the
 * X++ rules of Microsoft Dynamics 365 FO AppChecker (rules/X++, MIT, Copyright (c) Microsoft Corporation):
 * https://github.com/microsoft/Dynamics365FO-AppChecker. AppChecker evaluates XQuery over a full
 * X++ AST; these are line/statement heuristics over comment- and string-masked source.
 */
export const BP_ATTRIBUTION =
  'Rules adapted from Microsoft Dynamics365FO-AppChecker (https://github.com/microsoft/Dynamics365FO-AppChecker, MIT, Copyright (c) Microsoft Corporation).';

export type BpSeverity = 'Error' | 'Warning' | 'Info';

export interface BpFinding {
  rule: string;
  severity: BpSeverity;
  method: string;
  /** 1-based line within the method source (or within the pasted source). */
  line: number;
  message: string;
}

export interface BpRule {
  moniker: string;
  severity: BpSeverity;
  description: string;
}

export const BP_RULES: BpRule[] = [
  { moniker: 'BalancedTtsStatement', severity: 'Error', description: 'ttsBegin and ttsCommit must be balanced in the same method.' },
  { moniker: 'Breakpoint', severity: 'Error', description: 'breakpoint statements must not be checked in.' },
  { moniker: 'CallsNext', severity: 'Error', description: 'Chain of Command wrappers must call next.' },
  { moniker: 'DirectSQL', severity: 'Error', description: 'Direct SQL through Statement.executeQuery/executeUpdate bypasses security and caching.' },
  { moniker: 'InsertInLoop', severity: 'Warning', description: 'Record-by-record insert inside a loop; use insert_recordset or RecordInsertList.' },
  { moniker: 'NestedSearch', severity: 'Warning', description: 'Nested while select; use a join instead.' },
  { moniker: 'DeleteFromNotUsed', severity: 'Warning', description: 'while select that only deletes each record; use delete_from.' },
  { moniker: 'SelectForUpdateAbsent', severity: 'Warning', description: 'select forupdate on a buffer that is never updated, deleted or written in the method.' },
  { moniker: 'CatchAllWithEmptyHandlers', severity: 'Warning', description: 'Empty catch block swallows errors.' },
  { moniker: 'SelectUsingFirstOnly', severity: 'Info', description: 'Single-record select without firstonly or a field list.' },
  { moniker: 'BooleanExpressionWithLiteral', severity: 'Info', description: 'Comparison with a boolean literal (== true / != false).' },
  { moniker: 'TODOComments', severity: 'Info', description: 'TODO/FIXME/HACK comment left in code.' },
  { moniker: 'MissingMethodDocumentation', severity: 'Info', description: 'Public method without a /// XML documentation comment.' },
];

const SEVERITY_RANK: Record<BpSeverity, number> = { Error: 3, Warning: 2, Info: 1 };
export const severityAtLeast = (s: BpSeverity, min: BpSeverity) => SEVERITY_RANK[s] >= SEVERITY_RANK[min];
const RULE = new Map(BP_RULES.map((r) => [r.moniker, r]));

export interface BpOptions {
  /**
   * For extension classes ([ExtensionOf]): lowercase method names of the augmented element.
   * Methods present there are treated as Chain of Command wrappers. Undefined skips CallsNext.
   */
  wrappedMethods?: Set<string>;
  /** Restrict to these monikers (case-insensitive). */
  rules?: string[];
}

function check(method: XppMethodSource, opts: BpOptions): BpFinding[] {
  const { code, comments } = maskXpp(method.source);
  const findings: BpFinding[] = [];
  const add = (moniker: string, offset: number, message: string, line?: number) => {
    const rule = RULE.get(moniker)!;
    findings.push({ rule: moniker, severity: rule.severity, method: method.name, line: line ?? lineAt(code, offset), message });
  };
  const isDecl = method.name === 'classDeclaration';

  const begins = [...code.matchAll(/\bttsbegin\b/gi)];
  const commits = [...code.matchAll(/\bttscommit\b/gi)];
  if (begins.length !== commits.length) {
    add('BalancedTtsStatement', (begins[0] ?? commits[0]).index!,
      `ttsBegin (${begins.length}) and ttsCommit (${commits.length}) are not balanced; each ttsBegin should have a matching ttsCommit in the same method and scope.`);
  }

  for (const m of code.matchAll(/\bbreakpoint\s*;/gi)) add('Breakpoint', m.index!, 'Remove the breakpoint statement.');

  for (const m of code.matchAll(/\.\s*(executeUpdate|executeQuery|executeQueryWithParameters|executeUpdateWithParameters)\s*\(/gi)) {
    add('DirectSQL', m.index!, `Direct SQL via ${m[1]}; prefer X++ set-based statements or a view/query. If unavoidable, assert SqlStatementExecutePermission and parameterize input.`);
  }

  const loops = findLoops(code);
  const reported = new Set<number>();
  for (const loop of loops) {
    const body = code.slice(loop.bodyStart, loop.bodyEnd);
    for (const m of body.matchAll(/\.\s*(insert|doInsert)\s*\(/gi)) {
      const at = loop.bodyStart + m.index!;
      if (reported.has(at)) continue;
      reported.add(at);
      add('InsertInLoop', at, `${m[1]}() inside a ${loop.kind === 'whileSelect' ? 'while select' : loop.kind} loop; consider insert_recordset or RecordInsertList to reduce round trips.`);
    }
  }

  const whileSelects = loops.filter((l) => l.kind === 'whileSelect');
  for (const inner of whileSelects) {
    const outer = whileSelects.find((o) => o !== inner && o.bodyStart < inner.start && inner.start < o.bodyEnd && code[o.bodyStart] === '{');
    if (outer) add('NestedSearch', inner.start, 'Nested while select statements issue one query per outer row; use a join.');
  }

  const selects = findSelects(code);
  for (const loop of whileSelects) {
    const sel = selects.find((s) => s.offset > loop.start && s.offset < loop.start + 12);
    const braced = code[loop.bodyStart] === '{';
    const del = braced
      ? /^\s*(\w+)\s*\.\s*delete\s*\(\s*\)\s*;\s*$/i.exec(code.slice(loop.bodyStart + 1, loop.bodyEnd - 1))
      : /\b(\w+)\s*\.\s*delete\s*\(\s*\)\s*;\s*$/i.exec(loop.header);
    if (del && sel && del[1].toLowerCase() === sel.buffer.toLowerCase()) {
      add('DeleteFromNotUsed', loop.start, `The loop only deletes each ${sel.buffer} record; use delete_from (set-based) unless delete() is overridden and must run per record.`);
    }
  }

  for (const sel of selects) {
    if (!sel.buffer) continue;
    const buf = sel.buffer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (sel.keywords.has('forupdate')) {
      const written = new RegExp(`\\b${buf}\\s*\\.\\s*(update|doUpdate|delete|doDelete|write)\\s*\\(`, 'i').test(code);
      if (!written) add('SelectForUpdateAbsent', sel.offset, `${sel.buffer} is selected forupdate but never updated, deleted or written in this method; drop forupdate to avoid unnecessary locking.`);
    }
    const aggregate = ['count', 'sum', 'avg', 'minof', 'maxof'].some((k) => sel.keywords.has(k));
    const firstOnly = [...sel.keywords].some((k) => k.startsWith('firstonly'));
    const usedAsCursor = new RegExp(`\\bnext\\s+${buf}\\b`, 'i').test(code);
    if (!sel.isWhile && !firstOnly && !sel.hasFieldList && !aggregate && !usedAsCursor && !isDecl) {
      add('SelectUsingFirstOnly', sel.offset, `select on ${sel.buffer} fetches a single record; add firstonly (or a field list) so the kernel fetches one row.`);
    }
  }

  for (const m of code.matchAll(/(==|!=)\s*(true|false)\b|\b(true|false)\s*(==|!=)/gi)) {
    add('BooleanExpressionWithLiteral', m.index!, 'Comparing with a boolean literal is redundant; use the expression (or !expression) directly.');
  }

  for (const m of code.matchAll(/\bcatch\b\s*(\([^)]*\))?\s*\{\s*\}/gi)) {
    add('CatchAllWithEmptyHandlers', m.index!, 'Empty catch block silently swallows errors; handle, log, or rethrow.');
  }

  for (const c of comments) {
    const t = /\b(TODO|FIXME|HACK)\b/.exec(c.text);
    if (t) add('TODOComments', 0, `${t[1]} comment: ${c.text.trim().slice(0, 120)}`, c.line + (c.text.slice(0, t.index).match(/\n/g) ?? []).length);
  }

  if (!isDecl) {
    const brace = code.indexOf('{');
    const signature = brace === -1 ? code : code.slice(0, brace);
    if (/\bpublic\b/i.test(signature) && !/^\s*\/\/\//.test(method.source)) {
      add('MissingMethodDocumentation', signature.search(/\bpublic\b/i), 'Public method has no /// XML documentation comment.');
    }
    if (opts.wrappedMethods?.has(method.name.toLowerCase())) {
      const name = method.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`\\bnext\\s+${name}\\s*\\(`, 'i').test(code)) {
        add('CallsNext', Math.max(0, signature.search(new RegExp(`\\b${name}\\b`, 'i'))),
          `${method.name} wraps a method of the augmented element (Chain of Command) but never calls next ${method.name}(); only [Replaceable] methods may skip next.`);
      }
    }
  }
  return findings;
}

export function checkXppMethods(methods: XppMethodSource[], opts: BpOptions = {}): BpFinding[] {
  const wanted = opts.rules?.length ? new Set(opts.rules.map((r) => r.toLowerCase())) : null;
  return methods
    .flatMap((m) => check(m, opts))
    .filter((f) => !wanted || wanted.has(f.rule.toLowerCase()))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.method.localeCompare(b.method) || a.line - b.line);
}

const EXTENSION_OF_RE = /\[\s*ExtensionOf\s*\(\s*(class|table|form|dataEntityView|view|map)Str\s*\(\s*(\w+)\s*\)/i;
const EXTENSION_TYPE: Record<string, string> = {
  class: 'Class', table: 'Table', form: 'Form', dataentityview: 'DataEntity', view: 'View', map: 'Map',
};

/** Target of an [ExtensionOf(xxxStr(Name))] attribute, if the declaration has one. */
export function extensionTarget(declaration: string): { type: string; name: string } | null {
  const m = EXTENSION_OF_RE.exec(maskXpp(declaration).code);
  return m ? { type: EXTENSION_TYPE[m[1].toLowerCase()], name: m[2] } : null;
}
