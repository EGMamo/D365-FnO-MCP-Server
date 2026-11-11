import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import type { ReleasePlan } from '../indexer/releasePlans.js';
import { READ_ONLY_TOOL } from './annotations.js';
import { fail, ok, type ToolResult } from './generators.js';

const NO_PLANS =
  'No release plans imported. Run `d365-fno-mcp-server index-release-plans` (downloads from ' +
  'releaseplans.microsoft.com) or `index-release-plans --from-json <file>` first.';

const SUNSET_NOTE =
  'Note: Microsoft plans to stop publishing release plans after September 2026 in favour of the ' +
  'Microsoft AI at Work roadmap; imported data is only as fresh as the last import.';

export type ReleaseStatus = 'ga' | 'public_preview' | 'early_access' | 'planned';

/** Status as of `today` (YYYY-MM-DD), from the dates that have already passed. */
export function releaseStatus(plan: Pick<ReleasePlan, 'ga_date' | 'public_preview_date' | 'early_access_date'>, today: string): ReleaseStatus {
  if (plan.ga_date && plan.ga_date <= today) return 'ga';
  if (plan.public_preview_date && plan.public_preview_date <= today) return 'public_preview';
  if (plan.early_access_date && plan.early_access_date <= today) return 'early_access';
  return 'planned';
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function importInfo(db: Database): { origin: string; imported_at: string; plan_count: number } | undefined {
  return db.prepare('SELECT origin, imported_at, plan_count FROM ax_release_plan_imports WHERE id = 1').get() as
    { origin: string; imported_at: string; plan_count: number } | undefined;
}

function excerpt(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function describeDates(p: ReleasePlan): string {
  const parts: string[] = [];
  if (p.early_access_date) parts.push(`early access ${p.early_access_date}`);
  if (p.public_preview_date) parts.push(`preview ${p.public_preview_date}${p.preview_wave ? ` (${p.preview_wave})` : ''}`);
  if (p.ga_date) parts.push(`GA ${p.ga_date}${p.ga_wave ? ` (${p.ga_wave})` : ''}`);
  else if (p.ga_wave) parts.push(`GA ${p.ga_wave}`);
  return parts.join(', ') || 'no dates published';
}

export interface SearchReleasePlansArgs {
  query?: string;
  product?: string;
  wave?: string;
  status?: ReleaseStatus | 'any';
  planId?: string;
  limit?: number;
  today?: string;
}

function searchReleasePlans(db: Database, args: SearchReleasePlansArgs): ToolResult {
  const info = importInfo(db);
  if (!info) return fail(NO_PLANS);
  const today = args.today ?? todayIso();

  if (args.planId) {
    const p = db.prepare('SELECT * FROM ax_release_plans WHERE plan_id = ?').get(args.planId) as ReleasePlan | undefined;
    if (!p) return fail(`Release plan ${args.planId} is not in the imported data.`);
    return ok([
      `# ${p.feature_name}`,
      `Product: ${p.product} | Area: ${p.investment_area || '-'} | Status: ${releaseStatus(p, today)} | Enabled for: ${p.enabled_for || '-'}`,
      `Dates: ${describeDates(p)}`,
      `Release Plan ID: ${p.plan_id}${p.last_updated ? ` | last updated ${p.last_updated}` : ''}`,
      '', '## Business value', p.business_value || '(none)',
      '', '## Feature details', p.feature_details || '(none)',
      '', 'Next: check_feature_impact with this planId to find affected objects in the index.',
    ].join('\n'));
  }

  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  for (const token of (args.query ?? '').split(/\s+/).filter(Boolean).slice(0, 8)) {
    clauses.push(`(feature_name LIKE ? ESCAPE '\\' OR investment_area LIKE ? ESCAPE '\\' OR business_value LIKE ? ESCAPE '\\' OR feature_details LIKE ? ESCAPE '\\')`);
    const like = `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like, like);
  }
  if (args.product) {
    clauses.push('product LIKE ?');
    params.push(`%${args.product}%`);
  }
  if (args.wave) {
    clauses.push('(ga_wave LIKE ? OR preview_wave LIKE ?)');
    params.push(`%${args.wave}%`, `%${args.wave}%`);
  }
  const rows = db
    .prepare(`SELECT * FROM ax_release_plans ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY COALESCE(ga_date, public_preview_date, early_access_date, '9999') DESC, feature_name`)
    .all(...params) as unknown as ReleasePlan[];
  const status = args.status ?? 'any';
  const matches = status === 'any' ? rows : rows.filter((r) => releaseStatus(r, today) === status);
  const limit = args.limit ?? 20;

  const lines = [
    `${matches.length} release plan feature(s)${matches.length > limit ? `, showing ${limit}` : ''}. ` +
      `Imported ${info.imported_at.slice(0, 10)} from ${info.origin} (${info.plan_count} features).`,
  ];
  if (matches.length === 0) {
    const products = (db.prepare('SELECT product, COUNT(*) AS n FROM ax_release_plans GROUP BY product ORDER BY n DESC').all() as
      { product: string; n: number }[]).map((p) => `${p.product} (${p.n})`);
    lines.push(`Imported products: ${products.join(', ')}.`);
  }
  for (const p of matches.slice(0, limit)) {
    lines.push('', `- **${p.feature_name}** — ${p.product}${p.investment_area ? ` / ${p.investment_area}` : ''}`,
      `  ${releaseStatus(p, today)}: ${describeDates(p)} | id ${p.plan_id}`);
    const summary = excerpt(p.feature_details || p.business_value, 220);
    if (summary) lines.push(`  ${summary}`);
  }
  lines.push('', SUNSET_NOTE);
  return ok(lines.join('\n'));
}

const STOPWORDS = new Set(`about above across after again against also among an and any are as at available based be
because been before being better between both but by can capabilities capability data dynamics each easier easily
enable enabled enables enhance enhanced enhancement enhancements ensure experience faster feature features finance
for from further get gives have help helps how improve improved improvement improvements in increase into is it its
make makes management manage microsoft more most new now of on operations or other over provide provides reduce
same see set should simplify so some streamline such supply chain support supports than that the their them then
there these they this through to under up use used user users using via was when where which while will with
within without you your`.split(/\s+/));

/** Business vocabulary → AOT name prefixes (Vend, Cust, Invent…). */
const AOT_ALIASES: Record<string, string[]> = {
  vendor: ['Vend'], supplier: ['Vend'], customer: ['Cust'], inventory: ['Invent'], item: ['Invent'],
  purchase: ['Purch'], procurement: ['Purch'], sales: ['Sales'], warehouse: ['WHS'], warehousing: ['WHS'],
  transportation: ['TMS'], production: ['Prod'], manufacturing: ['Prod'], project: ['Proj'],
  ledger: ['Ledger'], journal: ['Journal'], invoice: ['Invoice'], payment: ['Payment', 'Paym'],
  bank: ['Bank'], budget: ['Budget'], asset: ['Asset'], tax: ['Tax'], expense: ['TrvExp'],
  intercompany: ['InterCompany'], retail: ['Retail'], commerce: ['Retail'], worker: ['HcmWorker'],
  employee: ['HcmWorker'], planning: ['ReqPlan'], forecast: ['Forecast'], quality: ['InventQuality'],
  batch: ['Batch'], workflow: ['Workflow'], subscription: ['SubBill'], currency: ['Currency'],
  consolidation: ['Consolidat'], cost: ['Cost'], dimension: ['Dimension'],
};

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Candidate AOT name fragments from a feature's name and investment area. */
export function suggestImpactTerms(text: string, max = 6): string[] {
  const terms: string[] = [];
  const add = (t: string) => {
    if (!terms.some((x) => x.toLowerCase() === t.toLowerCase())) terms.push(t);
  };
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? []) {
    for (const part of raw.split('-')) {
      const word = singular(part);
      if (word.length < 3 || STOPWORDS.has(part) || STOPWORDS.has(word)) continue;
      const aliases = AOT_ALIASES[word];
      if (aliases) aliases.forEach(add);
      else if (word.length >= 4) add(word[0].toUpperCase() + word.slice(1));
    }
  }
  return terms.slice(0, max);
}

export interface CheckFeatureImpactArgs {
  planId?: string;
  terms?: string[];
  packages?: string[];
  types?: string[];
  limit?: number;
}

interface ObjectHit {
  type: string;
  name: string;
  package: string;
  model: string;
  matched: string[];
}

const DEFAULT_IMPACT_TYPES = [
  'Table', 'Class', 'Form', 'DataEntity', 'Query', 'Enum', 'Edt', 'MenuItemAction', 'MenuItemDisplay',
  'MenuItemOutput', 'SecurityPrivilege',
];

const likeFragment = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function checkFeatureImpact(db: Database, args: CheckFeatureImpactArgs): ToolResult {
  const lines: string[] = [];
  let terms = (args.terms ?? []).map((t) => t.trim()).filter((t) => /^[\w.]{3,}$/.test(t)).slice(0, 10);
  if (args.planId) {
    if (!importInfo(db)) return fail(NO_PLANS);
    const p = db.prepare('SELECT * FROM ax_release_plans WHERE plan_id = ?').get(args.planId) as ReleasePlan | undefined;
    if (!p) return fail(`Release plan ${args.planId} is not in the imported data.`);
    lines.push(`# Impact: ${p.feature_name}`, `${p.product}${p.investment_area ? ` / ${p.investment_area}` : ''} — ${describeDates(p)}`);
    if (terms.length === 0) terms = suggestImpactTerms(`${p.feature_name} ${p.investment_area}`);
  } else {
    lines.push('# Impact check');
  }
  if (args.terms?.length && terms.length === 0) {
    return fail('Terms must be AOT name fragments of at least 3 letters, digits, "_" or ".".');
  }
  if (terms.length === 0) {
    return fail(args.planId
      ? 'Could not derive search terms from this feature; pass terms (AOT name fragments such as "VendInvoice").'
      : 'Pass planId (from search_release_plans) or terms (AOT name fragments such as "VendInvoice").');
  }
  const types = args.types?.length ? args.types : DEFAULT_IMPACT_TYPES;
  const limit = args.limit ?? 30;
  lines.push(`Search terms: ${terms.join(', ')} (keyword heuristic on object names; refine with the terms parameter).`);

  const hits = new Map<string, ObjectHit>();
  const typeList = types.map(() => '?').join(',');
  const totals: string[] = [];
  for (const term of terms) {
    const rows = db
      .prepare(`SELECT type, name, package, model FROM ax_objects WHERE name LIKE ? ESCAPE '\\' AND type IN (${typeList}) LIMIT 5000`)
      .all(likeFragment(term), ...types) as { type: string; name: string; package: string; model: string }[];
    totals.push(`${term}: ${rows.length === 5000 ? '5000+' : rows.length}`);
    for (const r of rows) {
      const key = `${r.type}:${r.name}`;
      const hit = hits.get(key) ?? { ...r, matched: [] };
      hit.matched.push(term);
      hits.set(key, hit);
    }
  }
  lines.push(`Objects per term: ${totals.join(', ')}.`);
  if (hits.size === 0) {
    lines.push('', 'No indexed objects match these terms. Try AOT prefixes (Vend, Cust, Invent, Purch, WHS, Ledger…).');
    return ok(lines.join('\n'));
  }
  const ranked = [...hits.values()].sort(
    (a, b) => b.matched.length - a.matched.length || a.name.length - b.name.length || a.name.localeCompare(b.name)
  );

  const byPackage = new Map<string, number>();
  for (const h of ranked) byPackage.set(h.package, (byPackage.get(h.package) ?? 0) + 1);
  lines.push('', `## Matching objects (${ranked.length}; most terms first, showing ${Math.min(limit, ranked.length)})`);
  for (const h of ranked.slice(0, limit)) {
    lines.push(`- ${h.type} **${h.name}** (${h.package}${h.model && h.model !== h.package ? `/${h.model}` : ''}) — ${h.matched.join(', ')}`);
  }
  lines.push('', `Packages: ${[...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, n]) => `${p} (${n})`).join(', ')}`);

  const packages = (args.packages ?? []).map((p) => p.trim()).filter(Boolean);
  if (packages.length === 0) {
    lines.push('', 'Pass packages (your custom or ISV packages) to list your objects that extend or reference these objects.');
  } else {
    const pkgList = packages.map(() => '?').join(',');
    const own = ranked.filter((h) => packages.some((p) => p.toLowerCase() === h.package.toLowerCase()));
    const termClause = terms.map(() => `x.to_name LIKE ? ESCAPE '\\'`).join(' OR ');
    const refs = db
      .prepare(`SELECT DISTINCT o.package, x.from_type, x.from_name, x.to_type, x.to_name, x.xref_kind
        FROM ax_objects o JOIN ax_xref x ON x.from_type = o.type AND x.from_name = o.name
        WHERE o.package COLLATE NOCASE IN (${pkgList}) AND x.to_type IN (${typeList}) AND (${termClause})
        ORDER BY o.package, x.from_name LIMIT 500`)
      .all(...packages, ...types, ...terms.map(likeFragment)) as
      { package: string; from_type: string; from_name: string; to_type: string; to_name: string; xref_kind: string | null }[];
    const refsToHits = refs.filter((r) => hits.has(`${r.to_type}:${r.to_name}`));
    lines.push('', `## Your packages (${packages.join(', ')})`);
    if (own.length === 0 && refsToHits.length === 0) {
      lines.push('No objects in these packages match or reference the matching objects.');
    }
    if (own.length) {
      lines.push(`Matching objects in your packages (${own.length}):`);
      for (const h of own.slice(0, limit)) lines.push(`- ${h.type} ${h.name} (${h.package})`);
    }
    if (refsToHits.length) {
      lines.push(`References from your packages to matching objects (${refsToHits.length}${refs.length === 500 ? '+' : ''}):`);
      for (const r of refsToHits.slice(0, limit * 2)) {
        lines.push(`- ${r.from_type} ${r.from_name} (${r.package}) → ${r.to_type} ${r.to_name}${r.xref_kind ? ` [${r.xref_kind}]` : ''}`);
      }
    }
  }
  lines.push('', 'This is a name-based heuristic, not a Microsoft impact analysis. Review the feature details and test ' +
    'affected customizations in a sandbox with the feature enabled.');
  return ok(lines.join('\n'));
}

export function registerReleasePlanTools(server: McpServer, db: Database): void {
  server.tool(
    'search_release_plans',
    'Search Microsoft release plans (Dynamics 365 Finance, SCM, Commerce, Project Operations, HR) imported with ' +
      '`index-release-plans`. Filter by keywords, product, release wave (e.g. "2025 release wave 2") or status as of today. ' +
      'Pass planId for the full feature description.',
    {
      query: z.string().optional().describe('Keywords; every word must appear in the name, area or description.'),
      product: z.string().optional().describe('Product name fragment, e.g. "Supply Chain".'),
      wave: z.string().optional().describe('Release wave fragment, e.g. "2026 release wave 1".'),
      status: z.enum(['ga', 'public_preview', 'early_access', 'planned', 'any']).default('any'),
      planId: z.string().optional().describe('Release Plan ID for full details.'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    READ_ONLY_TOOL,
    async (args) => searchReleasePlans(db, args)
  );

  server.tool(
    'check_feature_impact',
    'Map a release plan feature (planId) or AOT name fragments (terms) to indexed objects, and with packages list ' +
      'your objects that match or reference them (extensions, usages). Keyword heuristic to prioritize regression testing.',
    {
      planId: z.string().optional().describe('Release Plan ID from search_release_plans.'),
      terms: z.array(z.string()).max(10).optional().describe('AOT name fragments, e.g. ["VendInvoice", "Tax"]. Overrides terms derived from the feature.'),
      packages: z.array(z.string()).max(20).optional().describe('Your custom/ISV packages to check for affected customizations.'),
      types: z.array(z.string()).max(20).optional().describe('AOT object types to consider (default: tables, classes, forms, data entities, queries, enums, EDTs, menu items, privileges).'),
      limit: z.number().int().min(1).max(200).default(30),
    },
    READ_ONLY_TOOL,
    async (args) => checkFeatureImpact(db, args)
  );
}
