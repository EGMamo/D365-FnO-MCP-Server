import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as dbUtils from '../../indexer/db.js';
import type { Database } from '../../indexer/db.js';
import { explainSearchHits } from '../../tools/impact.js';
import {
  dedupeBy,
  jsonResult,
  parsePayload,
  rankSearchHits,
  sanitizeReason,
  tag,
  withWarnings,
  type ContentItem,
  type TaggedRow,
} from '../merge.js';
import type { MergeFn, ResultSource, RouteContext } from '../types.js';

/** Hosted answer to one tool call; `result` is null when the call failed or was withheld. */
interface HostedLeg {
  result: CallToolResult | null;
  warnings: string[];
}

/** A name and how many objects carry it, as list_packages and list_models report them. */
interface CountRow {
  name: string;
  objectCount: number;
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Orders like SQLite's default BINARY collation, which the original tools sort by. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sideOf = (row: TaggedRow): number => (row.source === 'local' ? 0 : 1);

/** The router's own warnings already start with "hosted unavailable" or "hosted lookup skipped"; those pass through unchanged. */
const ROUTER_WARNING = /^hosted (unavailable|lookup skipped):/;

const hostedWarning = (reason: string): string => (ROUTER_WARNING.test(reason) ? reason : `hosted unavailable: ${reason}`);

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

/** Rows of a local list answer; the local handlers answer lists as JSON arrays. */
function localList(result: CallToolResult): unknown[] {
  const { json } = parsePayload(result);
  return Array.isArray(json) ? json : [];
}

/** `type|name` in lower case: the identity of an AOT object. */
const objectKey = (row: TaggedRow): string => `${textOf(row.type)}|${textOf(row.name)}`.toLowerCase();

/** A search hit as dbUtils.searchSymbols returns it. */
interface SymbolHit {
  name: string;
  type: string;
  package: string;
  id: number;
}

/**
 * Adds the match class and explanation search_symbols gives with explain=true to the rows that lack
 * them. Hosted rows arrive with both; local rows get the same text from the same function.
 */
function addExplanations(query: string, rows: TaggedRow[]): TaggedRow[] {
  const explained = explainSearchHits(
    query,
    rows.map((row) => ({ name: textOf(row.name), type: textOf(row.type), package: textOf(row.package) }))
  );
  return rows.map((row, index) =>
    typeof row.match === 'string' && typeof row.explanation === 'string'
      ? row
      : { ...row, match: explained[index].match, explanation: explained[index].explanation }
  );
}

/**
 * Hosted hits and local hits in one list: exact name first, then prefix, substring and other matches, a local
 * row ahead of a hosted one inside each class, and a local row replacing a hosted twin. The list is cut to `limit`
 * after merging, so a strong local hit is never lost to the cut.
 */
const searchSymbols: MergeFn = async (args, ctx, raw) => {
  // The router parsed args with the tool's zod shape, so these types hold.
  const { query, type, limit, explain } = args as { query: string; type?: string; limit: number; explain: boolean };
  const localHits = dbUtils.searchSymbols(ctx.localIndex.db, query, type, limit) as SymbolHit[];
  const hosted = await askHosted('search_symbols', raw, ctx);
  const { rows, extras } = hostedList(hosted);

  const merged = dedupeBy([...tag(localHits, 'local'), ...tag(rows, 'hosted')], objectKey);
  const hits = rankSearchHits(query, merged).slice(0, limit);
  return jsonResult(explain ? addExplanations(query, hits) : hits, extras, hosted.warnings);
};

const compareObjects = (a: TaggedRow, b: TaggedRow): number =>
  compareText(textOf(a.type), textOf(b.type)) || compareText(textOf(a.name), textOf(b.name)) || sideOf(a) - sideOf(b);

/** Whether the local index holds at least one object of the package (same exact match as the tool's filter). */
const ownsPackage = (db: Database, name: string): boolean => dbUtils.listPackages(db).some((entry) => entry.package === name);

/**
 * One page of objects from each side, merged and ordered by type and name.
 *
 * Paging is per side: `offset` and `limit` apply to the hosted list and, separately, to the local list, because
 * the gateway does not know how many hosted objects precede a local one. A page can therefore hold up to twice
 * `limit` rows while both sides still have rows; once the few custom objects run out, pages are hosted rows only.
 * Stepping `offset` by `limit` visits every row of both sides, but the order is only sorted within a page,
 * not across pages.
 *
 * A package filter goes to the side that owns the package. A package the local index holds is answered locally
 * and never sent upstream, so a custom package name stays on the machine. Any other package may be a hosted
 * one (the gateway does not ask the hosted server which packages exist), so the call is a union; the local
 * side contributes nothing to it.
 */
const listObjects: MergeFn = async (args, ctx, raw) => {
  const { type, package: pkg, offset, limit } = args as { type?: string; package?: string; offset: number; limit: number };
  const db = ctx.localIndex.db;
  const local = tag(dbUtils.getAllObjects(db, type, pkg, offset, limit), 'local');
  if (pkg && ownsPackage(db, pkg)) return jsonResult(local.sort(compareObjects));

  const hosted = await askHosted('list_objects', raw, ctx);
  const { rows, extras } = hostedList(hosted);
  const merged = dedupeBy([...local, ...tag(rows, 'hosted')], objectKey);
  return jsonResult(merged.sort(compareObjects), extras, hosted.warnings);
};

/**
 * Union of the names both sides report, ordered by name. A name on both sides gets the sum of the two
 * object counts and `source: 'both'`; otherwise the row says which side it came from.
 */
function unionCounts(tool: 'list_packages' | 'list_models', key: 'package' | 'model', readLocal: (db: Database) => CountRow[]): MergeFn {
  return async (_args, ctx, raw) => {
    const entries = new Map<string, { objectCount: number; local: boolean; hosted: boolean }>();
    const add = (name: string, objectCount: number, side: ResultSource) => {
      const entry = entries.get(name) ?? { objectCount: 0, local: false, hosted: false };
      entry.objectCount += objectCount;
      entry[side] = true;
      entries.set(name, entry);
    };

    for (const row of readLocal(ctx.localIndex.db)) add(row.name, row.objectCount, 'local');
    const hosted = await askHosted(tool, raw, ctx);
    const { rows, extras } = hostedList(hosted);
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const { [key]: name, objectCount } = row as Record<string, unknown>;
      if (typeof name === 'string' && name !== '') add(name, typeof objectCount === 'number' ? objectCount : 0, 'hosted');
    }

    const merged = [...entries]
      .sort(([a], [b]) => compareText(a, b))
      .map(([name, entry]) => ({
        [key]: name,
        objectCount: entry.objectCount,
        source: entry.local && entry.hosted ? 'both' : entry.local ? 'local' : 'hosted',
      }));
    return jsonResult(merged, extras, hosted.warnings);
  };
}

/** `label_id` plus language; label languages compare without regard to case, as the tools' own filters do. */
const labelKey = (row: TaggedRow): string => `${textOf(row.label_id)}|${textOf(row.language).toLowerCase()}`;

/**
 * Local labels first, then hosted ones, one row per (label_id, language) with the local row winning, cut to
 * `limit`. The local side runs through the local tool itself, which owns the answer for custom labels.
 */
function mergeLabelSearch(tool: 'search_labels' | 'search_labels_fts'): MergeFn {
  return async (args, ctx, raw) => {
    const { limit } = args as { limit: number };
    const local = await ctx.local.call(tool, args);
    if (local.isError) return local;
    const hosted = await askHosted(tool, raw, ctx);
    const { rows, extras } = hostedList(hosted);

    const merged = dedupeBy([...tag(localList(local), 'local'), ...tag(rows, 'hosted')], labelKey);
    return jsonResult(merged.slice(0, limit), extras, hosted.warnings);
  };
}

/**
 * The local label answers first. Only a local miss, the exact text the local tool gives for an unknown label,
 * goes upstream, and the hosted answer is returned as it came (plain text, knowledge item included).
 * If the hosted server cannot answer, the local miss is returned with a warning.
 */
function resolveLocalFirst(tool: 'resolve_label' | 'resolve_label_by_language', missText: string): MergeFn {
  return async (args, ctx, raw) => {
    const local = await ctx.local.call(tool, args);
    if (local.isError || parsePayload(local).text !== missText) return local;
    const hosted = await askHosted(tool, raw, ctx);
    return hosted.result ?? withWarnings(local, hosted.warnings);
  };
}

export const searchStrategies: Record<string, MergeFn> = {
  search_symbols: searchSymbols,
  list_objects: listObjects,
  list_packages: unionCounts('list_packages', 'package', (db) =>
    dbUtils.listPackages(db).map(({ package: name, objectCount }) => ({ name, objectCount }))
  ),
  list_models: unionCounts('list_models', 'model', (db) =>
    dbUtils.listModels(db).map(({ model: name, objectCount }) => ({ name, objectCount }))
  ),
  search_labels: mergeLabelSearch('search_labels'),
  search_labels_fts: mergeLabelSearch('search_labels_fts'),
  resolve_label: resolveLocalFirst('resolve_label', 'Label not found'),
  resolve_label_by_language: resolveLocalFirst('resolve_label_by_language', 'not found'),
};
