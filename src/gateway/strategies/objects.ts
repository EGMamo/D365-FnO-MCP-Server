import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as dbUtils from '../../indexer/db.js';
import { capLists, type TruncationInfo } from '../../tools/bounds.js';
import { CODE_TYPES, fieldAccessReport } from '../../tools/codeQuality.js';
import {
  dedupeAcrossSides,
  dedupeBy,
  errorResult,
  jsonResult,
  parsePayload,
  sanitizeReason,
  tag,
  withWarnings,
  type ContentItem,
  type TaggedRow,
} from '../merge.js';
import type { MergeFn, ResultSource, RouteContext } from '../types.js';

// The router has already parsed the arguments with the local tool's zod shape. These schemas only narrow
// them to typed values for the strategy; the bounds are the ones in tools/metadata.ts and tools/codeQuality.ts.
const tableSchemaArgs = z.object({
  tableName: z.string(),
  xrefLimit: z.number().int().min(1).default(100),
  maxItems: z.number().int().min(1).default(1000),
});

const classHierarchyArgs = z.object({
  className: z.string(),
  childLimit: z.number().int().min(1).default(100),
});

const fieldAccessArgs = z.object({
  table: z.string(),
  field: z.string(),
  access: z.enum(['Read', 'Write']).optional(),
  objectType: z.enum(CODE_TYPES).optional(),
  maxObjects: z.number().int().min(1).optional(),
});

type FieldAccessArgs = z.infer<typeof fieldAccessArgs>;

/** The `truncated` map capLists adds to a result. */
const truncationSchema = z.record(z.string(), z.object({ returned: z.number(), total: z.number() }));

/** The router's own warnings already start with one of these; they pass through unchanged. */
const ROUTER_WARNING = /^hosted (unavailable|lookup skipped):/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isLocal = (row: { source?: unknown }): boolean => row.source === 'local';

/** "hosted unavailable: <reason>" for a failed hosted call, without the "MCP error -32000:" framing of the SDK. */
function hostedWarning(error: unknown): string {
  const reason = sanitizeReason(error).replace(/^MCP error -?\d+: /, '');
  return ROUTER_WARNING.test(reason) ? reason : `hosted unavailable: ${reason}`;
}

/** What the hosted server made of one call. */
type HostedLeg =
  /** A JSON object; `extras` are the items that followed it (the hosted knowledge item). */
  | { kind: 'answer'; payload: Record<string, unknown>; extras: ContentItem[] }
  /** It answered, but with nothing to merge: plain-text not found, a tool error, or something that is not a JSON object. */
  | { kind: 'miss'; result: CallToolResult }
  /** The call failed or was withheld; `warning` says why. */
  | { kind: 'down'; warning: string };

/**
 * The single hosted call of a strategy. Nothing here throws: a failed or withheld call is a `down` leg and
 * the caller carries on with the local answer.
 */
async function askHosted(tool: string, raw: Record<string, unknown>, ctx: RouteContext): Promise<HostedLeg> {
  try {
    const result = await ctx.upstream.callTool(tool, raw);
    const { json, extras } = parsePayload(result);
    return result.isError !== true && isRecord(json) ? { kind: 'answer', payload: json, extras } : { kind: 'miss', result };
  } catch (error) {
    return { kind: 'down', warning: hostedWarning(error) };
  }
}

/** The warning a leg that gave no data deserves: a failure, or a hosted tool error. A plain not-found is an answer, not a warning. */
function legWarnings(leg: HostedLeg): string[] {
  if (leg.kind === 'down') return [leg.warning];
  if (leg.kind === 'miss' && leg.result.isError === true) {
    return [`hosted unavailable: ${sanitizeReason(parsePayload(leg.result).text || 'the hosted server returned an error')}`];
  }
  return [];
}

/** The answer when the hosted leg gave nothing to merge and there is nothing local to add: the hosted not-found text, or the local answer plus the reason the hosted server was not heard. */
async function withoutMerge(leg: HostedLeg, tool: string, args: Record<string, unknown>, ctx: RouteContext): Promise<CallToolResult> {
  if (leg.kind === 'miss') return leg.result;
  const local = await ctx.local.call(tool, args);
  return leg.kind === 'down' ? withWarnings(local, [leg.warning]) : local;
}

/**
 * Cuts rows to `limit`, keeping their order, but takes the cut from the hosted rows first: a custom row is
 * what the developer needs the local index for and must not be crowded out by a long hosted list.
 */
function limitKeepingLocal<T extends { source?: unknown }>(rows: readonly T[], limit: number): T[] {
  if (rows.length <= limit) return [...rows];
  let localLeft = Math.min(rows.filter(isLocal).length, limit);
  let hostedLeft = limit - localLeft;
  return rows.filter((row) => (isLocal(row) ? localLeft-- > 0 : hostedLeft-- > 0));
}

const keyOf = (row: TaggedRow, ...parts: string[]): string =>
  parts.map((part) => String(row[part] ?? '').toLowerCase()).join('|');

const tagList = (value: unknown, source: ResultSource): TaggedRow[] => (Array.isArray(value) ? tag(value, source) : []);

/** The rows a capLists-style result says it cut from list `key`; 0 when it cut none. */
function clippedRows(truncated: Record<string, TruncationInfo>, key: string): number {
  const info = truncated[key];
  return info ? Math.max(0, info.total - info.returned) : 0;
}

/** A field row of an extension as the table's own `fields` list shows it, minus the local rowids. */
const extensionField = (field: dbUtils.FieldRow) => ({
  name: field.name,
  type: field.type,
  edt: field.edt,
  label_id: field.label_id,
  mandatory: field.mandatory,
  allow_edit: field.allow_edit,
  data_source: field.data_source,
  data_field: field.data_field,
});

/**
 * get_table_schema: a table of the local index is answered locally and never sent upstream. A standard
 * table comes from the hosted server, with the fields custom table extensions add (`localExtensions`) and the
 * custom objects that reference it merged into `xrefs`.
 */
const tableSchema: MergeFn = async (args, ctx, raw) => {
  const { tableName, xrefLimit, maxItems } = tableSchemaArgs.parse(args);
  const db = ctx.localIndex.db;
  if (dbUtils.getObjectHeader(db, tableName, 'Table')) return ctx.local.call('get_table_schema', args);

  const hosted = await askHosted('get_table_schema', raw, ctx);
  const answer = hosted.kind === 'answer' ? hosted.payload : undefined;
  const table = typeof answer?.name === 'string' ? answer.name : tableName;
  const extensions = dbUtils.getTableExtensions(db, table);
  const localXrefs = tag(dbUtils.getXrefsTo(db, table, 'Table', xrefLimit), 'local');
  if (!answer && extensions.length === 0 && localXrefs.length === 0) return withoutMerge(hosted, 'get_table_schema', args, ctx);

  // Without a hosted answer the table itself is unknown, so only what the custom models say about it is shown.
  const base = answer ?? {
    name: tableName,
    type: 'Table',
    notes: [`Table ${tableName} itself was not available from the hosted server; showing its custom table extensions and references from the local index only.`],
  };
  const truncated = { ...truncationSchema.catch({}).parse(base.truncated) };
  const merged = dedupeAcrossSides([...tagList(base.xrefs, 'hosted'), ...localXrefs], (row) => keyOf(row, 'from_type', 'from_name', 'xref_kind'));
  // xrefLimit is a query limit in the original tool (silent); only the maxItems cut is reported.
  const total = Math.min(xrefLimit, merged.length + clippedRows(truncated, 'xrefs'));
  const xrefs = limitKeepingLocal(merged, Math.min(xrefLimit, maxItems));
  delete truncated.xrefs;
  if (total > xrefs.length) truncated.xrefs = { returned: xrefs.length, total };

  const localExtensions = tag(
    extensions.map((extension) => capLists({ ...extension, fields: extension.fields.map(extensionField) }, ['fields'], maxItems)),
    'local'
  );
  const shownExtensions = localExtensions.slice(0, maxItems);
  if (localExtensions.length > shownExtensions.length) {
    truncated.localExtensions = { returned: shownExtensions.length, total: localExtensions.length };
  }

  const result: Record<string, unknown> = { ...base, xrefs, localExtensions: shownExtensions };
  if (Object.keys(truncated).length > 0) result.truncated = truncated;
  else delete result.truncated;
  return jsonResult(result, hosted.kind === 'answer' ? hosted.extras : [], legWarnings(hosted));
};

/**
 * get_class_hierarchy: a class of the local index is answered locally. For a standard class the hosted
 * children are joined by the custom classes that extend it, which only the local index knows.
 */
const classHierarchy: MergeFn = async (args, ctx, raw) => {
  const { className, childLimit } = classHierarchyArgs.parse(args);
  const db = ctx.localIndex.db;
  if (dbUtils.getObjectHeader(db, className, 'Class')) return ctx.local.call('get_class_hierarchy', args);

  const hosted = await askHosted('get_class_hierarchy', raw, ctx);
  const answer = hosted.kind === 'answer' ? hosted.payload : undefined;
  const name = typeof answer?.class === 'string' ? answer.class : className;
  const localChildren = tag(dbUtils.getXrefsTo(db, name, 'Class', childLimit, 'extends'), 'local');
  if (!answer && localChildren.length === 0) return withoutMerge(hosted, 'get_class_hierarchy', args, ctx);

  const base = answer ?? {
    class: className,
    notes: [`Class ${className} itself was not available from the hosted server; showing the subclasses from the local index only.`],
  };
  const merged = dedupeBy([...tagList(base.children, 'hosted'), ...localChildren], (row) => keyOf(row, 'from_type', 'from_name'));
  const children = limitKeepingLocal(merged, childLimit);
  return jsonResult({ ...base, children }, hosted.kind === 'answer' ? hosted.extras : [], legWarnings(hosted));
};

/** The report find_field_access prints. Unknown keys of a newer hosted server pass through; the rest is checked. */
const reportSchema = z.looseObject({
  fieldIndexed: z.boolean().catch(false),
  scannedObjects: z.number().catch(0),
  narrowedByUsageSnapshot: z.boolean().catch(false),
  summary: z.object({ writes: z.number(), reads: z.number(), methods: z.number().catch(0) }),
  byMethod: z.array(z.looseObject({ writes: z.number(), reads: z.number() })).catch([]),
  accesses: z.array(z.looseObject({ access: z.string() })),
  notes: z.array(z.string()).catch([]),
  attribution: z.string().optional().catch(undefined),
});

type FieldAccessReport = z.infer<typeof reportSchema>;

// The display rules of fieldAccessReport (tools/codeQuality.ts).
const SHOW_ALL_UP_TO = 100;
const WRITES_SHOWN = 50;
const READS_SHOWN = 20;
const BY_METHOD_SHOWN = 50;

// The notes fieldAccessReport writes about the indexed table; they are worked out again from both sides.
const TABLE_NOT_INDEXED = / is not indexed; scanning by name only\.$/;
const FIELD_NOT_INDEXED = / is not a field of .+ in the index \(it may come from a table extension\)\.$/;
const ACCESSES_CUT = /^Showing up to \d+ writes and \d+ reads of \d+ accesses;/;
const SCAN_CAPPED = /^\d+ objects mention /;

const NOTHING_TO_SCAN = 'The local index holds no custom objects to scan, and the hosted server gave no field access report.';

/**
 * The local scan of custom X++: a report, no report at all when the local index holds no objects, or the local
 * result that explains why the scan failed.
 */
async function scanLocal(
  args: FieldAccessArgs,
  ctx: RouteContext
): Promise<{ report?: FieldAccessReport } | { failed: CallToolResult }> {
  // fieldAccessReport reads an index without objects as one built without raw XML and says so; here there is just nothing to scan.
  if (ctx.localIndex.db.prepare('SELECT 1 FROM ax_objects LIMIT 1').get() === undefined) return {};
  let result: CallToolResult;
  try {
    result = await fieldAccessReport(ctx.localIndex.db, args);
  } catch (error) {
    return { failed: { content: [{ type: 'text', text: sanitizeReason(error) }], isError: true } };
  }
  const parsed = result.isError === true ? undefined : reportSchema.safeParse(parsePayload(result).json);
  return parsed?.success ? { report: parsed.data } : { failed: result };
}

/**
 * Joins the report of the hosted scan (standard code) with the report of the local scan (custom code).
 * The two scan disjoint sets of objects, so counts add up. Totals come from each summary, which counts every
 * access even when a side listed only some of them.
 */
function combineReports(
  args: FieldAccessArgs,
  hosted: FieldAccessReport | undefined,
  local: FieldAccessReport | undefined,
  extensionAddsField: boolean
): Record<string, unknown> {
  // Local goes first: custom code that touches a standard field is what the developer can change,
  // so it must survive the cut to 50 writes and 20 reads.
  const sides: [ResultSource, FieldAccessReport][] = [];
  if (local) sides.push(['local', local]);
  if (hosted) sides.push(['hosted', hosted]);
  const sum = (count: (report: FieldAccessReport) => number) => sides.reduce((total, [, report]) => total + count(report), 0);

  const writes = sum((report) => report.summary.writes);
  const reads = sum((report) => report.summary.reads);
  const everyAccess = sides.flatMap(([source, report]) => tag(report.accesses, source));
  const shown =
    writes + reads <= SHOW_ALL_UP_TO
      ? everyAccess
      : [
          ...everyAccess.filter((row) => row.access === 'Write').slice(0, WRITES_SHOWN),
          ...everyAccess.filter((row) => row.access === 'Read').slice(0, READS_SHOWN),
        ];
  const count = (row: TaggedRow, key: 'writes' | 'reads') => Number(row[key]);
  const byMethod = sides
    .flatMap(([source, report]) => tag(report.byMethod, source))
    .sort((a, b) => count(b, 'writes') - count(a, 'writes') || count(b, 'reads') - count(a, 'reads'))
    .slice(0, BY_METHOD_SHOWN);

  // Each side judges the table against its own index, and a standard table is only in the hosted one: the table
  // (and the field) count as indexed when either side, or a local table extension, says so.
  const tableIndexed = sides.some(([, report]) => !report.notes.some((note) => TABLE_NOT_INDEXED.test(note)));
  const fieldIndexed = extensionAddsField || sides.some(([, report]) => report.fieldIndexed);
  const notes = [
    ...new Set(
      sides.flatMap(([source, report]) =>
        report.notes
          .filter((note) => !TABLE_NOT_INDEXED.test(note) && !FIELD_NOT_INDEXED.test(note) && !ACCESSES_CUT.test(note))
          .map((note) => (SCAN_CAPPED.test(note) ? `(${source} index) ${note}` : note))
      )
    ),
  ];
  if (!tableIndexed) notes.push(`Table ${args.table} is not indexed; scanning by name only.`);
  else if (!fieldIndexed) notes.push(`${args.field} is not a field of ${args.table} in the index (it may come from a table extension).`);
  if (writes + reads > SHOW_ALL_UP_TO) {
    notes.push(
      `Showing up to ${WRITES_SHOWN} writes and ${READS_SHOWN} reads of ${writes + reads} accesses; see byMethod for the full distribution.`
    );
  }

  return {
    ...local,
    ...hosted,
    table: args.table,
    field: args.field,
    fieldIndexed,
    scannedObjects: sum((report) => report.scannedObjects),
    narrowedByUsageSnapshot: sides.some(([, report]) => report.narrowedByUsageSnapshot),
    summary: { writes, reads, methods: sum((report) => report.summary.methods) },
    byMethod,
    accesses: shown,
    notes,
    attribution: hosted?.attribution ?? local?.attribution,
  };
}

/**
 * find_field_access: the hosted scan covers standard X++ and the local scan covers custom X++, which is where
 * code that reads or writes a standard field lives. Both reports are joined into one in the original shape,
 * every access and method row tagged with the side it came from.
 */
const fieldAccess: MergeFn = async (args, ctx, raw) => {
  const parsed = fieldAccessArgs.parse(args);
  const [hosted, local] = await Promise.all([askHosted('find_field_access', raw, ctx), scanLocal(parsed, ctx)]);

  const warnings = legWarnings(hosted);
  let hostedReport: FieldAccessReport | undefined;
  if (hosted.kind === 'answer') {
    const checked = reportSchema.safeParse(hosted.payload);
    if (checked.success) hostedReport = checked.data;
    else warnings.push('hosted unavailable: the hosted answer is not a field access report');
  }

  if ('failed' in local) {
    const skipped = `local scan skipped: ${sanitizeReason(parsePayload(local.failed).text || 'no result')}`;
    // No report from either side: the hosted answer stands when the hosted server was heard, else the local failure does.
    if (!hostedReport) return hosted.kind === 'miss' ? withWarnings(hosted.result, [skipped]) : withWarnings(local.failed, warnings);
    warnings.push(skipped);
  }

  const localReport = 'failed' in local ? undefined : local.report;
  if (!hostedReport && !localReport) {
    // Nothing local to scan and no hosted report: the hosted answer stands when the hosted server was heard.
    return hosted.kind === 'miss' ? hosted.result : withWarnings(errorResult(NOTHING_TO_SCAN), warnings);
  }

  const fieldName = parsed.field.toLowerCase();
  const extensionAddsField = dbUtils.getTableExtensionFieldNames(ctx.localIndex.db, parsed.table).some((name) => name.toLowerCase() === fieldName);
  return jsonResult(
    combineReports(parsed, hostedReport, localReport, extensionAddsField),
    hosted.kind === 'answer' ? hosted.extras : [],
    warnings
  );
};

export const objectStrategies: Record<string, MergeFn> = {
  get_table_schema: tableSchema,
  get_class_hierarchy: classHierarchy,
  find_field_access: fieldAccess,
};
