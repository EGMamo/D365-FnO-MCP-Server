import { loadObjectXml } from '../indexer/sourceFiles.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import * as dbUtils from '../indexer/db.js';
import { bpSnapshotStatus, queryBpFindings } from '../indexer/bpFindings.js';
import {
  BP_ATTRIBUTION, BP_RULES, checkXppMethods, extensionTarget, severityAtLeast, type BpFinding, type BpSeverity,
} from '../xpp/bestPractices.js';
import { FIELD_ACCESS_ATTRIBUTION, findFieldAccess, type FieldAccess } from '../xpp/fieldAccess.js';
import { extractMethodSources, maskXpp, type XppMethodSource } from '../xpp/scanner.js';
import { fail, ok, type ToolResult } from './generators.js';

/** AOT element types that carry X++ method source. */
export const CODE_TYPES = ['Class', 'Table', 'Form', 'DataEntity'] as const;
const MAX_INLINE_SOURCE = 500_000;

interface CodeObject {
  type: string;
  name: string;
  raw_xml: string | null;
  file_path: string;
}

function findCodeObject(db: Database, name: string, type?: string): CodeObject | null {
  const types = type ? [type] : [...CODE_TYPES];
  for (const t of types) {
    const row = db.prepare('SELECT type, name, raw_xml, file_path FROM ax_objects WHERE name = ? AND type = ?').get(name, t) as unknown as CodeObject | undefined;
    if (row) return row;
  }
  return null;
}

const lowerMethodNames = (db: Database, name: string, type: string): Set<string> | null => {
  const obj = dbUtils.getObjectByName(db, name, type);
  return obj ? new Set<string>(obj.methods.map((m: { name: string }) => String(m.name).toLowerCase())) : null;
};

function sizeList<T>(items: T[]): { items: T[]; truncated: boolean } {
  return items.length <= 100 ? { items, truncated: false } : { items: items.slice(0, 20), truncated: true };
}

export interface BestPracticeArgs {
  objectName?: string;
  objectType?: string;
  source?: string;
  rules?: string[];
  minSeverity?: BpSeverity;
  methods?: string[];
}

export async function checkBestPractices(db: Database, args: BestPracticeArgs): Promise<ToolResult> {
  const notes: string[] = [
    'Heuristic checks over comment/string-masked X++ source; they approximate, not replace, the compiler best-practice checks (xppbp).',
  ];
  let methods: XppMethodSource[];
  let target: Record<string, unknown>;
  let wrappedMethods: Set<string> | undefined;

  if (args.source !== undefined) {
    if (args.source.length > MAX_INLINE_SOURCE) return fail(`source exceeds ${MAX_INLINE_SOURCE} characters; check an indexed object instead.`);
    const isXml = args.source.trimStart().startsWith('<');
    methods = isXml ? extractMethodSources(args.source) : [{ name: '(source)', source: args.source }];
    if (isXml && methods.length === 0) return fail('No X++ methods (<Method><Source>) or declaration found in the XML.');
    target = { source: isXml ? 'inline AOT XML' : 'inline X++' };
  } else if (args.objectName) {
    const obj = findCodeObject(db, args.objectName, args.objectType);
    if (!obj) return fail(`${args.objectType ?? 'Object'} ${args.objectName} not found in the index (types with code: ${CODE_TYPES.join(', ')}).`);
    const xml = await loadObjectXml(obj);
    if (!xml) return fail(`Source of ${obj.type} ${obj.name} is unavailable: raw XML was not stored and ${obj.file_path} is not readable.`);
    methods = extractMethodSources(xml);
    target = { type: obj.type, name: obj.name };
  } else {
    return fail('Provide objectName (an indexed class, table, form or data entity) or source (X++ or AOT XML).');
  }

  const decl = methods.find((m) => m.name === 'classDeclaration');
  const ext = decl ? extensionTarget(decl.source) : null;
  if (ext) {
    wrappedMethods = lowerMethodNames(db, ext.name, ext.type) ?? undefined;
    target.extensionOf = ext;
    if (!wrappedMethods) notes.push(`${ext.type} ${ext.name} is not indexed, so Chain of Command next() calls were not checked.`);
  }
  if (args.methods?.length) {
    const wanted = new Set(args.methods.map((m) => m.toLowerCase()));
    methods = methods.filter((m) => wanted.has(m.name.toLowerCase()) || m.name === 'classDeclaration');
  }

  const all = checkXppMethods(methods, { wrappedMethods, rules: args.rules })
    .filter((f) => severityAtLeast(f.severity, args.minSeverity ?? 'Info'));
  const summary = { Error: 0, Warning: 0, Info: 0 } as Record<BpSeverity, number>;
  const byRule: Record<string, number> = {};
  for (const f of all) {
    summary[f.severity]++;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }
  const { items, truncated } = sizeList<BpFinding>(all);
  if (truncated) notes.push(`Showing the first 20 of ${all.length} findings (errors first); filter with rules, methods or minSeverity.`);

  const result: Record<string, unknown> = {
    target,
    methodsChecked: methods.filter((m) => m.name !== 'classDeclaration').length,
    summary,
    byRule,
    findings: items,
    notes,
    attribution: BP_ATTRIBUTION,
  };
  if (target.name) {
    const status = bpSnapshotStatus(db);
    if (status.status === 'imported') {
      const n = queryBpFindings(db, { element: String(target.name), limit: 1 }).total;
      result.compilerBestPractice = { importedFindings: n, importedAt: status.importedAt, hint: n ? 'Use get_bp_findings for the compiler diagnostics of this element.' : undefined };
    }
  }
  return ok(JSON.stringify(result, null, 2));
}

export interface FieldAccessArgs {
  table: string;
  field: string;
  access?: 'Read' | 'Write';
  objectType?: string;
  maxObjects?: number;
}

export async function fieldAccessReport(db: Database, args: FieldAccessArgs): Promise<ToolResult> {
  const tableObj = dbUtils.getObjectByName(db, args.table, 'Table');
  const notes: string[] = [
    'Static text heuristic: buffers are resolved from local/member declarations; aliasing, macros, Common/generic buffers and dynamic field access (fieldId2Name, DictField) are not followed.',
  ];
  if (!tableObj) notes.push(`Table ${args.table} is not indexed; scanning by name only.`);
  const fieldIndexed = tableObj ? tableObj.fields.some((f: { name: string }) => f.name.toLowerCase() === args.field.toLowerCase()) : false;
  if (tableObj && !fieldIndexed) notes.push(`${args.field} is not a field of ${args.table} in the index (it may come from a table extension).`);

  const hasRaw = db.prepare('SELECT 1 FROM ax_objects WHERE raw_xml IS NOT NULL LIMIT 1').get();
  if (!hasRaw) return fail('The index was built without raw XML (D365_INDEX_STORE_RAW_XML=false), so source cannot be searched. Rebuild with raw XML stored.');

  const maxObjects = args.maxObjects ?? 200;
  const types = args.objectType ? [args.objectType] : [...CODE_TYPES];
  const like = `%${args.field.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // Names only: a short field name matches most of the index, and loading every
  // candidate's XML at once would hold gigabytes in memory before truncation.
  let candidates = db.prepare(`SELECT type, name FROM ax_objects
      WHERE type IN (${types.map(() => '?').join(',')}) AND raw_xml LIKE ? ESCAPE '\\' ORDER BY name`)
    .all(...types, like) as unknown as { type: string; name: string }[];

  let narrowed = false;
  const usageTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ax_usage_refs'`).get();
  if (usageTable) {
    const sources = db.prepare('SELECT DISTINCT source_name FROM ax_usage_refs WHERE target_name = ? COLLATE NOCASE').all(args.table) as { source_name: string }[];
    if (sources.length) {
      const names = new Set(sources.map((s) => s.source_name.toLowerCase()));
      names.add(args.table.toLowerCase());
      candidates = candidates.filter((c) => names.has(c.name.toLowerCase()));
      narrowed = true;
    }
  }
  const truncated = candidates.length > maxObjects;
  if (truncated) {
    notes.push(`${candidates.length} objects mention "${args.field}"; scanned the first ${maxObjects} by name. Raise maxObjects or filter objectType${narrowed ? '' : ', or import the XRef snapshot (index-xref) to narrow candidates'}.`);
    candidates = candidates.slice(0, maxObjects);
  }

  const accesses: (FieldAccess & { objectType: string; object: string })[] = [];
  const rawXml = db.prepare('SELECT raw_xml FROM ax_objects WHERE type = ? AND name = ?');
  for (const obj of candidates) {
    const row = rawXml.get(obj.type, obj.name) as { raw_xml: string | null } | undefined;
    const methods = extractMethodSources(row?.raw_xml ?? '');
    const decl = methods.find((m) => m.name === 'classDeclaration');
    const ext = decl ? extensionTarget(decl.source) : null;
    const thisIsTable = (obj.type === 'Table' && obj.name.toLowerCase() === args.table.toLowerCase()) ||
      (ext?.type === 'Table' && ext.name.toLowerCase() === args.table.toLowerCase());
    const declaration = decl ? maskXpp(decl.source).code : undefined;
    for (const method of methods) {
      if (method.name === 'classDeclaration') continue;
      for (const a of findFieldAccess(method, { table: args.table, field: args.field, thisIsTable, declaration })) {
        if (!args.access || a.access === args.access) accesses.push({ objectType: obj.type, object: obj.name, ...a });
      }
    }
  }

  const writes = accesses.filter((a) => a.access === 'Write');
  const reads = accesses.filter((a) => a.access === 'Read');
  const perMethod = new Map<string, { objectType: string; object: string; method: string; reads: number; writes: number }>();
  for (const a of accesses) {
    const key = `${a.objectType}|${a.object}|${a.method}`;
    const row = perMethod.get(key) ?? { objectType: a.objectType, object: a.object, method: a.method, reads: 0, writes: 0 };
    if (a.access === 'Write') row.writes++; else row.reads++;
    perMethod.set(key, row);
  }
  const shown = accesses.length <= 100 ? accesses : [...writes.slice(0, 50), ...reads.slice(0, 20)];
  if (accesses.length > 100) notes.push(`Showing up to 50 writes and 20 reads of ${accesses.length} accesses; see byMethod for the full distribution.`);

  return ok(JSON.stringify({
    table: args.table,
    field: args.field,
    fieldIndexed,
    scannedObjects: candidates.length,
    narrowedByUsageSnapshot: narrowed,
    summary: { writes: writes.length, reads: reads.length, methods: perMethod.size },
    byMethod: [...perMethod.values()].sort((a, b) => b.writes - a.writes || b.reads - a.reads).slice(0, 50),
    accesses: shown,
    notes,
    attribution: FIELD_ACCESS_ATTRIBUTION,
  }, null, 2));
}

export function registerCodeQualityTools(server: McpServer, db: Database): void {
  server.tool(
    'check_xpp_best_practices',
    'Static best-practice review of X++ code: an indexed class, table, form or data entity, or pasted X++/AOT XML. ' +
      `Rules (adapted from Microsoft Dynamics365FO-AppChecker, MIT): ${BP_RULES.map((r) => r.moniker).join(', ')}. ` +
      'Reports rule, severity, method and line. Heuristic; complements compiler BP results (get_bp_findings).',
    {
      objectName: z.string().min(1).optional().describe('Indexed element name.'),
      objectType: z.enum(CODE_TYPES).optional().describe('Element type (default: first match of Class, Table, Form, DataEntity).'),
      source: z.string().optional().describe('Pasted X++ code or AOT element XML instead of an indexed object.'),
      rules: z.array(z.string()).max(20).optional().describe('Only these rule monikers.'),
      minSeverity: z.enum(['Error', 'Warning', 'Info']).optional().describe('Lowest severity to report (default Info).'),
      methods: z.array(z.string()).max(50).optional().describe('Only these methods.'),
    },
    async (args) => checkBestPractices(db, args)
  );

  server.tool(
    'find_field_access',
    'Find where a table field is read vs written across indexed X++ (classes, tables, forms, data entities): assignments, +=/-=, ' +
      'setField(fieldNum()), update_recordset setting and insert_recordset targets are writes; everything else is a read. ' +
      'Uses the TRUDUtilsD365 read/write heuristic (MIT); narrowed by the XRef snapshot when imported.',
    {
      table: z.string().min(1),
      field: z.string().min(1),
      access: z.enum(['Read', 'Write']).optional().describe('Only reads or only writes.'),
      objectType: z.enum(CODE_TYPES).optional().describe('Only scan this element type.'),
      maxObjects: z.number().int().min(1).max(2000).optional().describe('Cap on objects scanned (default 200).'),
    },
    async (args) => fieldAccessReport(db, args)
  );

  server.tool(
    'get_bp_findings',
    'Query compiler best-practice diagnostics imported with `index-bp` from xppbp XML logs (Visual Studio BP build or d365fo.tools Invoke-D365BestPractice). ' +
      'Filter by element, type, rule moniker, severity or model; returns counts by severity, rule and element plus the findings.',
    {
      element: z.string().optional().describe('Element name, e.g. CustTable.'),
      elementType: z.string().optional().describe('Element type, e.g. Table, Class, Form.'),
      moniker: z.string().optional().describe('Rule moniker (substring match), e.g. BPErrorLabelIsText.'),
      severity: z.string().optional().describe('Error, Warning or Info.'),
      model: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    },
    async (args) => {
      const status = bpSnapshotStatus(db);
      if (status.status !== 'imported') return ok(JSON.stringify({ status }, null, 2));
      return ok(JSON.stringify({ status, ...queryBpFindings(db, args) }, null, 2));
    }
  );
}
