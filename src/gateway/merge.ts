import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { explainSearchHits, type MatchReason } from '../tools/impact.js';
import type { ResultSource } from './types.js';

/** One item of a tool result's content array (text, image, resource, ...). */
export type ContentItem = CallToolResult['content'][number];

/** A result row that says which side produced it. */
export type TaggedRow = Record<string, unknown> & { source: ResultSource };

export interface ParsedPayload {
  /** The first text item parsed as JSON; undefined when there is none or it is not JSON (a miss). */
  json: unknown;
  /** Text of the first text item; '' when the result has none. */
  text: string;
  /** Every other content item in order, e.g. the {"knowledge": ...} item the hosted knowledge filter appends. */
  extras: ContentItem[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const contentOf = (result: CallToolResult): ContentItem[] => (Array.isArray(result.content) ? result.content : []);

/**
 * Splits a tool result into its parsed payload and the rest. Only the first text item is parsed:
 * later items are metadata of the caller's (knowledge hints, gateway warnings) and must pass through
 * untouched. A plain-text answer such as "Table Foo not found." is not JSON, so `json` is undefined.
 */
export function parsePayload(result: CallToolResult): ParsedPayload {
  const content = contentOf(result);
  const index = content.findIndex((item) => item.type === 'text');
  if (index < 0) return { json: undefined, text: '', extras: [...content] };
  const first = content[index];
  const text = first.type === 'text' ? first.text : '';
  const extras = content.filter((_, position) => position !== index);
  try {
    return { json: JSON.parse(text) as unknown, text, extras };
  } catch {
    return { json: undefined, text, extras };
  }
}

/**
 * True when a result carries no data to merge: the tool failed, or its first text item is not JSON.
 * Tools that answer in plain text (resolve_label) succeed with text; check `text` for those.
 */
export function isMiss(result: CallToolResult): boolean {
  return result.isError === true || parsePayload(result).json === undefined;
}

/**
 * Marks rows with the side they came from. Local rows lose their numeric `id`: it is a rowid of the
 * local database and collides with the hosted ids. Entries that are not objects cannot be tagged and are dropped.
 */
export function tag(rows: readonly unknown[], source: ResultSource): TaggedRow[] {
  return rows.filter(isRecord).map((row) => {
    const { id, ...rest } = row;
    const kept = source === 'local' && typeof id === 'number' ? rest : row;
    return { ...kept, source };
  });
}

/**
 * Removes rows with a repeated key. The first occurrence keeps its position, but a local row always
 * wins over a hosted one, and the surviving local row says it hides a hosted twin with `shadowedHosted: true`.
 * Rows without `source: 'local'` count as hosted.
 */
export function dedupeBy<T extends object>(rows: readonly T[], keyOf: (row: T) => string): (T & { shadowedHosted?: boolean })[] {
  const isLocal = (row: T) => (row as Record<string, unknown>).source === 'local';
  const kept: (T & { shadowedHosted?: boolean })[] = [];
  const positions = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, kept.length);
      kept.push(row);
      continue;
    }
    const existing = kept[position];
    if (isLocal(existing) && !isLocal(row)) {
      kept[position] = { ...existing, shadowedHosted: true };
    } else if (!isLocal(existing) && isLocal(row)) {
      kept[position] = { ...row, shadowedHosted: true };
    }
  }
  return kept;
}

/**
 * Removes the hosted row that has a twin on the local side, and says so on the local row with
 * `shadowedHosted: true`. Unlike dedupeBy, rows repeated within one side stay: a list from the index can hold
 * the same row several times (one reference per field with the same EDT, one per data source on the same
 * table), and the tool on that side lists them all. Rows without `source: 'local'` count as hosted; the order
 * is kept.
 */
export function dedupeAcrossSides<T extends object>(rows: readonly T[], keyOf: (row: T) => string): (T & { shadowedHosted?: boolean })[] {
  const isLocal = (row: T) => (row as Record<string, unknown>).source === 'local';
  const localKeys = new Set(rows.filter(isLocal).map(keyOf));
  const hostedKeys = new Set(rows.filter((row) => !isLocal(row)).map(keyOf));
  return rows
    .filter((row) => isLocal(row) || !localKeys.has(keyOf(row)))
    .map((row) => (isLocal(row) && hostedKeys.has(keyOf(row)) ? { ...row, shadowedHosted: true } : row));
}

const MATCH_RANK: Record<MatchReason, number> = { exact: 0, prefix: 1, substring: 2, token: 3 };

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Orders merged search hits exact name > prefix > substring > other token, the same classes
 * explainSearchHits reports. The sort is stable and a local row goes before a hosted one within a class,
 * so the order each side already had (full-text rank) survives inside a class.
 */
export function rankSearchHits<T extends object>(query: string, rows: readonly T[]): T[] {
  const named = rows.map((row) => {
    const fields = row as Record<string, unknown>;
    return { name: textOf(fields.name), type: textOf(fields.type), package: textOf(fields.package) };
  });
  const explained = explainSearchHits(query, named);
  return rows
    .map((row, index) => ({
      row,
      index,
      tier: MATCH_RANK[explained[index].match],
      side: (row as Record<string, unknown>).source === 'local' ? 0 : 1,
    }))
    .sort((a, b) => a.tier - b.tier || a.side - b.side || a.index - b.index)
    .map(({ row }) => row);
}

/** Text of the trailing item withWarnings appends, so a second call can extend it instead of adding another. */
const warningItem = (warnings: readonly string[]): ContentItem => ({
  type: 'text',
  text: JSON.stringify({ gateway: { warnings } }),
});

/** The warnings of an item written by withWarnings, or null when the item is something else. */
function warningsIn(item: ContentItem | undefined): string[] | null {
  if (!item || item.type !== 'text') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !isRecord(parsed.gateway)) return null;
  const { gateway } = parsed;
  if (Object.keys(gateway).length !== 1 || !Array.isArray(gateway.warnings)) return null;
  return gateway.warnings.every((entry) => typeof entry === 'string') ? (gateway.warnings as string[]) : null;
}

/** The gateway warnings a result already carries (empty when none). */
export function warningsOf(result: CallToolResult): string[] {
  return warningsIn(contentOf(result).at(-1)) ?? [];
}

/**
 * Appends a trailing {"gateway":{"warnings":[...]}} text item. Nothing changes when there are no warnings;
 * warnings the result already carries are kept once, in the same item.
 */
export function withWarnings(result: CallToolResult, warnings: readonly string[]): CallToolResult {
  const content = [...contentOf(result)];
  const existing = warningsIn(content.at(-1));
  const known = new Set(existing ?? []);
  const added = [...new Set(warnings)].filter((warning) => warning !== '' && !known.has(warning));
  if (added.length === 0) return result;
  if (existing) content[content.length - 1] = warningItem([...existing, ...added]);
  else content.push(warningItem(added));
  return { ...result, content };
}

/** A successful JSON result. extras (e.g. the hosted knowledge item) follow the payload; warnings come last. */
export function jsonResult(value: unknown, extras: readonly ContentItem[] = [], warnings: readonly string[] = []): CallToolResult {
  const payload: ContentItem = { type: 'text', text: JSON.stringify(value) ?? 'null' };
  return withWarnings({ content: [payload, ...extras] }, warnings);
}

/** A successful plain-text result. */
export function textResult(text: string, extras: readonly ContentItem[] = [], warnings: readonly string[] = []): CallToolResult {
  return withWarnings({ content: [{ type: 'text', text }, ...extras] }, warnings);
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Deeper than any tool argument; a value this nested is treated as private rather than walked. */
const MAX_SCAN_DEPTH = 32;

const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/gu;

/**
 * Whether any string inside `value` (nested objects and arrays included) has an identifier token that
 * starts with one of the prefixes, ignoring case. "Contoso" matches `ContosoCustTable`, `CustTable.Contoso`
 * and `@Contoso:Label` but not `NotContoso`. Object keys are not scanned.
 */
export function containsPrivateName(value: unknown, prefixes: readonly string[]): boolean {
  const wanted = prefixes.map((prefix) => prefix.trim().toLowerCase()).filter((prefix) => prefix !== '');
  if (wanted.length === 0) return false;
  const scan = (node: unknown, depth: number): boolean => {
    if (typeof node === 'string') {
      return (node.match(IDENTIFIER) ?? []).some((token) => {
        const lower = token.toLowerCase();
        return wanted.some((prefix) => lower.startsWith(prefix));
      });
    }
    if (typeof node !== 'object' || node === null) return false;
    if (depth >= MAX_SCAN_DEPTH) return true;
    const children = Array.isArray(node) ? node : Object.values(node);
    return children.some((child) => scan(child, depth + 1));
  };
  return scan(value, 0);
}

const MAX_REASON_LENGTH = 200;

/**
 * Reduces an error to one short line that is safe to show an agent: URLs, credentials, file
 * paths and long opaque tokens are replaced, and the text is capped.
 */
export function sanitizeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = raw
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\b(bearer|basic)\s+\S+/gi, '$1 <redacted>')
    .replace(/\b(authorization|x-api-key|api[-_ ]?key|token|secret|password)\b\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/[A-Za-z]:\\[^\s'"`<>|*?]*/g, '<path>')
    .replace(/\\\\[^\s'"`<>|*?]+/g, '<path>')
    .replace(/(?<![\w:/.~-])\/(?:[^\s/'"`<>|:*?]+\/)+[^\s/'"`<>|:*?]*/g, '<path>')
    .replace(/[A-Za-z0-9_+/=-]{32,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return 'unknown error';
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}
