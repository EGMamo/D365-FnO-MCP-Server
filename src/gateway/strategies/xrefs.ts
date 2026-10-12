import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import * as dbUtils from '../../indexer/db.js';
import type { Database } from '../../indexer/db.js';
import { findUsageRefs } from '../../indexer/xrefUsage.js';
import { analyzeImpact } from '../../tools/impact.js';
import {
  dedupeAcrossSides,
  dedupeBy,
  jsonResult,
  parsePayload,
  sanitizeReason,
  tag,
  withWarnings,
  type ContentItem,
  type TaggedRow,
} from '../merge.js';
import type { MergeFn, RouteContext } from '../types.js';

// The router has already parsed the arguments with the local tool's zod shape. These schemas only narrow
// them to typed values for the strategy; the bounds are the ones in tools/metadata.ts.
const referencesArgs = z.object({
  name: z.string(),
  type: z.enum(['Table', 'Class', 'Enum', 'Form', 'Edt']).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const usagesArgs = z.object({
  name: z.string(),
  type: z.string().optional(),
  method: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const impactArgs = z.object({
  name: z.string(),
  type: z.string(),
  maxDepth: z.number().int().min(1).max(4).default(2),
  limit: z.number().int().min(1).max(500).default(200),
});

/** Hosted answer to the strategy's one call; `result` is null when the call failed, was withheld or the hosted tool reported an error. */
interface HostedLeg {
  result: CallToolResult | null;
  warnings: string[];
}

/** The router's own warnings already start with one of these; they pass through unchanged. */
const ROUTER_WARNING = /^hosted (unavailable|lookup skipped):/;

/** "hosted unavailable: <reason>", without the "MCP error -32000:" framing of the SDK. */
function hostedWarning(reason: string): string {
  const text = reason.replace(/^MCP error -?\d+: /, '');
  return ROUTER_WARNING.test(text) ? text : `hosted unavailable: ${text}`;
}

/**
 * The single hosted call of a strategy. Nothing here throws: a refused, failed or withheld call becomes
 * a warning and the caller carries on with the local answer.
 */
async function askHosted(tool: string, raw: Record<string, unknown>, ctx: RouteContext): Promise<HostedLeg> {
  try {
    const result = await ctx.upstream.callTool(tool, raw);
    if (result.isError) return { result: null, warnings: [hostedWarning(sanitizeReason(parsePayload(result).text))] };
    return { result, warnings: [] };
  } catch (error) {
    return { result: null, warnings: [hostedWarning(sanitizeReason(error))] };
  }
}

/**
 * The rows of a hosted list answer and the items that followed the payload (the knowledge item). Plain text
 * such as a "not found" message, or anything else that is not a JSON list, has no rows: it is a miss, not a failure.
 */
function hostedList(leg: HostedLeg): { rows: unknown[]; extras: ContentItem[] } {
  if (leg.result === null) return { rows: [], extras: [] };
  const { json, extras } = parsePayload(leg.result);
  return { rows: Array.isArray(json) ? json : [], extras };
}

const keyPart = (value: unknown): string => (value === undefined || value === null ? '' : String(value)).toLowerCase();

/** The identity of a row: the named fields, compared without regard to case as X++ names are. */
const keyOf = (row: Record<string, unknown>, fields: readonly string[]): string => fields.map((field) => keyPart(row[field])).join('|');

// The types find_references walks when no type is given, in the tool's order.
const REFERENCE_TYPES = ['Table', 'Class', 'Enum', 'Form', 'Edt'] as const;

const REFERENCE_KEY = ['from_type', 'from_name', 'xref_kind', 'to_type', 'to_name'];

/** The per-type loop of find_references, run against the local index (the tool's own handler would do the same). */
function localReferences(db: Database, name: string, type: (typeof REFERENCE_TYPES)[number] | undefined, limit: number): dbUtils.Xref[] {
  if (type) return dbUtils.getXrefsTo(db, name, type, limit);
  let xrefs: dbUtils.Xref[] = [];
  for (const t of REFERENCE_TYPES) {
    if (xrefs.length >= limit) break;
    xrefs = xrefs.concat(dbUtils.getXrefsTo(db, name, t, limit - xrefs.length));
  }
  return xrefs;
}

/**
 * find_references: the hosted list and the custom objects of the local index that reference the same object.
 * A reference both sides report (same (from_type, from_name, xref_kind, to_type, to_name)) is listed once, the
 * local row; rows an index repeats within one side stay, as the original tool lists them. Local rows come
 * first, so a long hosted list never pushes the custom references out of the `limit` the list is cut to.
 */
const findReferences: MergeFn = async (args, ctx, raw) => {
  const { name, type, limit } = referencesArgs.parse(args);
  const local = tag(localReferences(ctx.localIndex.db, name, type, limit), 'local');
  const hosted = await askHosted('find_references', raw, ctx);
  const { rows, extras } = hostedList(hosted);

  const merged = dedupeAcrossSides([...local, ...tag(rows, 'hosted')], (row) => keyOf(row, REFERENCE_KEY));
  return jsonResult(merged.slice(0, limit), extras, hosted.warnings);
};

const USAGE_KEY = [
  'sourceType',
  'sourceName',
  'sourceMethod',
  'targetType',
  'targetName',
  'targetMethod',
  'referenceKind',
  'sourceLine',
  'sourceColumn',
  'sourceTable',
];

/**
 * find_usages: hosted call sites joined by the ones in the local index. The local table holds rows only when the
 * developer imported a local XRef snapshot, so usually this adds nothing. Local rows come first, a repeated usage
 * is listed once (the local row wins) and the list is cut to `limit`.
 */
const findUsages: MergeFn = async (args, ctx, raw) => {
  const { name, type, method, limit } = usagesArgs.parse(args);
  const local = tag(findUsageRefs(ctx.localIndex.db, name, type, method, limit), 'local');
  const hosted = await askHosted('find_usages', raw, ctx);
  const { rows, extras } = hostedList(hosted);

  const merged = dedupeBy([...local, ...tag(rows, 'hosted')], (row) => keyOf(row, USAGE_KEY));
  return jsonResult(merged.slice(0, limit), extras, hosted.warnings);
};

/** A dependent in an impact result, as the tool lists it, plus the side that found it. */
type ImpactRow = TaggedRow & { type: string; name: string };

interface ImpactLevel {
  depth: number;
  items: ImpactRow[];
}

/** The parts of a hosted ImpactResult the merge reads; unknown keys of a newer hosted server pass through. */
const impactSchema = z.looseObject({
  root: z.looseObject({ type: z.string(), name: z.string() }),
  levels: z.array(z.looseObject({ depth: z.number().int().min(1), items: z.array(z.looseObject({ type: z.string(), name: z.string() })) })),
  truncated: z.boolean().catch(false),
  caveat: z.string().catch(''),
});

type HostedImpact = z.infer<typeof impactSchema>;

/** The keys of an ImpactResult, which the merge writes itself. */
const IMPACT_KEYS: ReadonlySet<string> = new Set(['root', 'maxDepth', 'levels', 'totals', 'truncated', 'caveat']);

const MERGE_NOTE =
  'Custom (local) dependents from the local index were merged in and are tagged source "local". ' +
  'Chains standard to standard to custom beyond maxDepth can be under-reported.';

const PARTIAL_CAVEAT =
  'The hosted server did not provide this object, so only custom (local) dependents from the local index are listed and standard dependents are missing. ' +
  'Dependents come from declared structural references, not compiler call sites. Use find_usages for imported call-site usage. ' +
  'Chains standard to standard to custom beyond maxDepth can be under-reported.';

/** `type:name` in lower case: the identity of a dependent, whichever side reports it. */
const impactKey = (type: unknown, name: unknown): string => `${keyPart(type)}:${keyPart(name)}`;

/**
 * Walks the dependents of `root` breadth-first, like analyzeImpact, over two sources: the hosted levels (standard
 * and ISV objects, as reported) and the local index. The walk is seeded with the root and every hosted node, so a
 * custom object that references a standard one is found even though the standard object is not in the local
 * index (xrefs are read straight from the database for that reason). A local dependent of a node at depth d sits
 * at depth d + 1, up to `maxDepth`, and is walked further in turn.
 *
 * An object is listed once, at the shallowest depth any side reports it; on the same depth the local row wins and
 * says it hides a hosted twin. At most `limit` dependents are kept: inside a level the local ones come first, and
 * `truncated` is set when another one exists, in which case the deeper levels are not listed at all.
 */
function mergeLevels(
  db: Database,
  root: { type: string; name: string },
  hostedLevels: HostedImpact['levels'],
  maxDepth: number,
  limit: number
): { levels: ImpactLevel[]; totals: { objects: number; byType: Record<string, number> }; truncated: boolean } {
  const hostedAt = new Map<number, ImpactRow[]>();
  for (const level of hostedLevels) {
    hostedAt.set(level.depth, [...(hostedAt.get(level.depth) ?? []), ...(tag(level.items, 'hosted') as ImpactRow[])]);
  }

  const seen = new Set<string>([impactKey(root.type, root.name)]);
  const levels: ImpactLevel[] = [];
  const byType: Record<string, number> = {};
  let frontier: { type: string; name: string }[] = [root];
  let total = 0;
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && !truncated; depth++) {
    // Only `room` more dependents may be listed; one candidate beyond that tells "exactly at the limit" from "more exist".
    const room = limit - total;
    const found: ImpactRow[] = [];
    const foundKeys = new Set<string>();
    collect: for (const node of frontier) {
      for (const x of dbUtils.getXrefsTo(db, node.name, node.type, limit + 1)) {
        const key = impactKey(x.from_type, x.from_name);
        if (seen.has(key) || foundKeys.has(key)) continue;
        foundKeys.add(key);
        found.push({
          type: x.from_type,
          name: x.from_name,
          via: x.xref_kind ?? 'reference',
          dependsOn: `${node.type}:${node.name}`,
          source: 'local',
        });
        if (found.length > room) break collect;
      }
    }

    const hostedNew = (hostedAt.get(depth) ?? []).filter((row) => !seen.has(impactKey(row.type, row.name)));
    const candidates = dedupeBy([...found, ...hostedNew], (row) => impactKey(row.type, row.name));
    const items = candidates.slice(0, room);
    truncated = candidates.length > room;

    for (const item of items) {
      seen.add(impactKey(item.type, item.name));
      byType[item.type] = (byType[item.type] ?? 0) + 1;
    }
    total += items.length;
    if (items.length > 0) levels.push({ depth, items });
    frontier = items.map(({ type, name }) => ({ type, name }));
  }

  return { levels, totals: { objects: total, byType }, truncated };
}

/** What the hosted server made of analyze_impact. */
interface HostedImpactLeg {
  /** The parsed ImpactResult. */
  answer?: HostedImpact;
  /** The hosted result when it answered in plain text, e.g. "Object (Table) Foo not found." */
  miss?: CallToolResult;
  /** The items that followed the payload (the hosted knowledge item). */
  extras: ContentItem[];
  warnings: string[];
}

function readImpact(leg: HostedLeg): HostedImpactLeg {
  if (leg.result === null) return { extras: [], warnings: leg.warnings };
  const { json, extras } = parsePayload(leg.result);
  if (json === undefined) return { miss: leg.result, extras, warnings: [] };
  const parsed = impactSchema.safeParse(json);
  if (parsed.success) return { answer: parsed.data, extras, warnings: [] };
  return { extras, warnings: ['hosted unavailable: the hosted answer is not an impact result'] };
}

/**
 * analyze_impact: the hosted levels (standard dependents) extended by the custom dependents only the local index
 * knows. Totals and `truncated` are worked out again over the merged list; a hosted `truncated` stays true.
 *
 * When the hosted server has nothing to merge, a root that is in the local index is walked locally with the tool's
 * own function. Any other root is still walked in the local index, because custom objects that reference a standard
 * object exist there even while the hosted server is down or does not know the object; if that finds nothing the
 * answer is the hosted not-found text, or the local not-found text with the reason the hosted server was not heard.
 */
const impact: MergeFn = async (args, ctx, raw) => {
  const { name, type, maxDepth, limit } = impactArgs.parse(args);
  const db = ctx.localIndex.db;
  const hosted = readImpact(await askHosted('analyze_impact', raw, ctx));

  if (!hosted.answer) {
    const localRoot = dbUtils.getObjectHeader(db, name, type) ? analyzeImpact(db, name, type, maxDepth, limit) : null;
    if (localRoot) {
      const levels = localRoot.levels.map((level) => ({ ...level, items: tag(level.items, 'local') }));
      return jsonResult({ ...localRoot, levels }, hosted.extras, hosted.warnings);
    }
  }

  const root = hosted.answer?.root ?? { type, name };
  const merged = mergeLevels(db, root, hosted.answer?.levels ?? [], maxDepth, limit);
  if (!hosted.answer && merged.totals.objects === 0) {
    return hosted.miss ?? withWarnings(await ctx.local.call('analyze_impact', args), hosted.warnings);
  }

  // Keys the hosted server adds beyond the tool's own result survive the merge.
  const extraKeys = Object.entries(hosted.answer ?? {}).filter(([key]) => !IMPACT_KEYS.has(key));
  const result = {
    root,
    maxDepth,
    levels: merged.levels,
    totals: merged.totals,
    truncated: (hosted.answer?.truncated ?? false) || merged.truncated,
    caveat: hosted.answer ? [hosted.answer.caveat, MERGE_NOTE].filter((text) => text !== '').join(' ') : PARTIAL_CAVEAT,
    ...Object.fromEntries(extraKeys),
  };
  return jsonResult(result, hosted.extras, hosted.warnings);
};

export const xrefStrategies: Record<string, MergeFn> = {
  find_references: findReferences,
  analyze_impact: impact,
  find_usages: findUsages,
};
