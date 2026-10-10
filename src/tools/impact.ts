import type { Database } from '../indexer/db.js';
import { getObjectHeader, getXrefsTo } from '../indexer/db.js';

export interface ImpactNode {
  type: string;
  name: string;
  /** Relationship to the parent node, e.g. `extends`, `datasource`, `uses`. */
  via: string;
  /** The object this one depends on (one level closer to the root). */
  dependsOn: string;
}

export interface ImpactResult {
  root: { type: string; name: string };
  maxDepth: number;
  levels: { depth: number; items: ImpactNode[] }[];
  totals: { objects: number; byType: Record<string, number> };
  /** True when the node limit stopped the walk before every dependent was visited. */
  truncated: boolean;
  caveat: string;
}

const CAVEAT =
  'Dependents come from declared structural references (extends, implements, data sources, EDT use, ' +
  'extensions, security grants), not compiler call sites. Use find_usages for imported call-site usage.';

/**
 * Walks structural references backwards from an object to everything that depends on it,
 * breadth-first, to `maxDepth` levels and at most `limit` dependents. Cycles are visited once.
 * Returns null when the root is not in the index.
 */
export function analyzeImpact(db: Database, name: string, type: string, maxDepth: number, limit: number): ImpactResult | null {
  const header = getObjectHeader(db, name, type);
  if (!header) return null;

  const seen = new Set<string>([`${type}:${header.name.toLowerCase()}`]);
  const levels: ImpactResult['levels'] = [];
  const byType: Record<string, number> = {};
  let frontier = [{ type, name: header.name }];
  let total = 0;
  let truncated = false;

  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !truncated; depth++) {
    const items: ImpactNode[] = [];
    const next: { type: string; name: string }[] = [];
    for (const node of frontier) {
      // One extra row per node lets us tell "exactly at the limit" from "more exist".
      for (const x of getXrefsTo(db, node.name, node.type, limit + 1)) {
        const key = `${x.from_type}:${x.from_name.toLowerCase()}`;
        if (seen.has(key)) continue;
        if (total >= limit) {
          truncated = true;
          break;
        }
        seen.add(key);
        total++;
        byType[x.from_type] = (byType[x.from_type] ?? 0) + 1;
        items.push({ type: x.from_type, name: x.from_name, via: x.xref_kind ?? 'reference', dependsOn: `${node.type}:${node.name}` });
        next.push({ type: x.from_type, name: x.from_name });
      }
      if (truncated) break;
    }
    if (items.length > 0) levels.push({ depth, items });
    frontier = next;
  }

  return { root: { type, name: header.name }, maxDepth, levels, totals: { objects: total, byType }, truncated, caveat: CAVEAT };
}

export type MatchReason = 'exact' | 'prefix' | 'substring' | 'token';

export interface ExplainedHit<T extends { name: string; type: string; package: string }> {
  hit: T;
  match: MatchReason;
  explanation: string;
}

/**
 * Says why a search hit was returned for `query`. Search orders exact names first, then full-text
 * rank; this restates the name relationship so a caller can see why a result is where it is.
 * A hit that does not contain the query in its name matched on another indexed token (type or package).
 */
export function explainSearchHits<T extends { name: string; type: string; package: string }>(
  query: string,
  hits: readonly T[]
): ExplainedHit<T>[] {
  const q = query.trim().toLowerCase();
  return hits.map((hit) => {
    const n = hit.name.toLowerCase();
    if (n === q) return { hit, match: 'exact', explanation: `Name equals "${query}" (case-insensitive); exact matches rank first.` };
    if (n.startsWith(q)) return { hit, match: 'prefix', explanation: `Name starts with "${query}"; ranked by full-text relevance.` };
    if (n.includes(q)) return { hit, match: 'substring', explanation: `Name contains "${query}"; ranked by full-text relevance.` };
    return {
      hit,
      match: 'token',
      explanation: `Name does not contain "${query}"; matched an indexed token in its name, type (${hit.type}) or package (${hit.package}).`,
    };
  });
}
