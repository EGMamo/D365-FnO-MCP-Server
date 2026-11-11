import { z } from 'zod';
import type { Database } from './db.js';

/**
 * Microsoft release plans (releaseplans.microsoft.com), stored locally so the
 * server itself never calls out. Field names follow the public
 * `allreleaseplans` feed, as used by the Dynamics 365 FastTrack Release
 * Planner Helper (MIT, Copyright (c) Microsoft Corporation).
 */
export const RELEASE_PLANS_URL = 'https://releaseplans.microsoft.com/en-US/allreleaseplans/';

/** Products stored by default: the finance and operations apps. */
export const FNO_RELEASE_PRODUCTS = [
  'Dynamics 365 Finance',
  'Dynamics 365 Supply Chain Management',
  'Dynamics 365 Commerce',
  'Dynamics 365 Project Operations',
  'Dynamics 365 Human Resources',
  'Finance and Operations cross-app capabilities',
];

const MAX_PAGES = 100;
const text = z.preprocess((v) => (v === null || v === undefined ? '' : String(v)), z.string());

const releasePlanFeedItemSchema = z.object({
  'Release Plan ID': z.string().min(1),
  'Product name': text,
  'Feature name': z.string().min(1),
  'Investment area': text,
  'Business value': text,
  'Feature details': text,
  'Enabled for': text,
  'Early access date': text,
  'Public preview date': text,
  'GA date': text,
  'Public Preview Release Wave': text,
  'GA Release Wave': text,
  'Last Gitcommit date': text,
}).passthrough();

const feedPageSchema = z.object({
  morerecords: z.union([z.boolean(), z.string()]).optional(),
  totalrecords: z.union([z.number(), z.string()]).optional(),
  results: z.array(z.unknown()),
});

export type ReleasePlanFeedItem = z.infer<typeof releasePlanFeedItemSchema>;

export interface ReleasePlan {
  plan_id: string;
  product: string;
  feature_name: string;
  investment_area: string;
  business_value: string;
  feature_details: string;
  enabled_for: string;
  early_access_date: string | null;
  public_preview_date: string | null;
  ga_date: string | null;
  preview_wave: string;
  ga_wave: string;
  last_updated: string | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Feed descriptions are HTML fragments. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Feed dates are MM/DD/YYYY; stored as YYYY-MM-DD so they sort. */
export function toIsoDate(value: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!m) return /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? value.trim().slice(0, 10) : null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function normalizeReleasePlan(item: ReleasePlanFeedItem): ReleasePlan {
  return {
    plan_id: item['Release Plan ID'],
    product: item['Product name'],
    feature_name: item['Feature name'],
    investment_area: item['Investment area'],
    business_value: htmlToText(item['Business value']),
    feature_details: htmlToText(item['Feature details']),
    enabled_for: item['Enabled for'],
    early_access_date: toIsoDate(item['Early access date']),
    public_preview_date: toIsoDate(item['Public preview date']),
    ga_date: toIsoDate(item['GA date']),
    preview_wave: item['Public Preview Release Wave'],
    ga_wave: item['GA Release Wave'],
    last_updated: toIsoDate(item['Last Gitcommit date']),
  };
}

/** Accepts a feed page (`{results: [...]}`), several pages, or a bare array of feed items. */
export function parseReleasePlansJson(content: string): ReleasePlanFeedItem[] {
  const data: unknown = JSON.parse(content);
  const pages = Array.isArray(data) && data.every((d) => d && typeof d === 'object' && 'results' in d) ? data : [data];
  const items: unknown[] = [];
  for (const page of pages) {
    items.push(...(Array.isArray(page) ? page : feedPageSchema.parse(page).results));
  }
  return items.map((item, i) => {
    const parsed = releasePlanFeedItemSchema.safeParse(item);
    if (!parsed.success) {
      throw new Error(`Release plan item ${i} is invalid: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
  });
}

export interface FetchReleasePlansOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  onPage?: (page: number, count: number) => void;
}

/** Walks `?page=N` until the feed reports no more records. */
export async function fetchReleasePlans(options: FetchReleasePlansOptions = {}): Promise<ReleasePlanFeedItem[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = new URL(options.url ?? RELEASE_PLANS_URL);
  const items: ReleasePlanFeedItem[] = [];
  let expected: number | undefined;
  for (let page = 1; page <= MAX_PAGES; page++) {
    base.searchParams.set('page', String(page));
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 60_000)];
    if (options.signal) signals.push(options.signal);
    const response = await fetchImpl(base, { signal: AbortSignal.any(signals), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Release plans request failed: HTTP ${response.status} (page ${page}).`);
    const body = feedPageSchema.parse(await response.json());
    items.push(...parseReleasePlansJson(JSON.stringify(body.results)));
    if (body.totalrecords !== undefined) expected = Number(body.totalrecords);
    options.onPage?.(page, body.results.length);
    const more = body.morerecords === true || body.morerecords === 'true';
    if (!more || body.results.length === 0) {
      if (expected !== undefined && Number.isFinite(expected) && items.length < expected) {
        throw new Error(`Release plans feed ended after ${items.length} of ${expected} records.`);
      }
      return items;
    }
  }
  throw new Error(`Release plans feed did not finish within ${MAX_PAGES} pages.`);
}

export function createReleasePlanSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ax_release_plans (
      plan_id TEXT PRIMARY KEY,
      product TEXT NOT NULL,
      feature_name TEXT NOT NULL,
      investment_area TEXT NOT NULL,
      business_value TEXT NOT NULL,
      feature_details TEXT NOT NULL,
      enabled_for TEXT NOT NULL,
      early_access_date TEXT, public_preview_date TEXT, ga_date TEXT,
      preview_wave TEXT NOT NULL, ga_wave TEXT NOT NULL,
      last_updated TEXT
    );
    CREATE TABLE IF NOT EXISTS ax_release_plan_imports (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      origin TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      plan_count INTEGER NOT NULL,
      products TEXT NOT NULL
    );
  `);
}

/** Replaces the stored release plans in one transaction. Duplicate ids keep the last occurrence. */
export function publishReleasePlans(db: Database, origin: string, plans: ReleasePlan[]): number {
  const unique = [...new Map(plans.map((p) => [p.plan_id, p])).values()];
  const products = [...new Set(unique.map((p) => p.product))].sort();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM ax_release_plans; DELETE FROM ax_release_plan_imports;');
    const insert = db.prepare('INSERT INTO ax_release_plans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of unique) {
      insert.run(p.plan_id, p.product, p.feature_name, p.investment_area, p.business_value, p.feature_details,
        p.enabled_for, p.early_access_date, p.public_preview_date, p.ga_date, p.preview_wave, p.ga_wave, p.last_updated);
    }
    db.prepare('INSERT INTO ax_release_plan_imports VALUES (1, ?, ?, ?, ?)').run(
      origin, new Date().toISOString(), unique.length, JSON.stringify(products)
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return unique.length;
}
