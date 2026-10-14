import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import { fail, ok, type ToolResult } from './generators.js';

const NO_DOCS =
  'No documentation imported. Run `d365-fno-mcp-server index-docs --url <site>` (crawls the site) or ' +
  '`index-docs --from-dir <folder>` first.';

interface SourceInfo {
  source: string;
  origin: string;
  imported_at: string;
  page_count: number;
}

/** Imported sources, or null when the index predates the docs tables. */
function sources(db: Database): SourceInfo[] | null {
  try {
    return db.prepare('SELECT source, origin, imported_at, page_count FROM ax_doc_sources ORDER BY source').all() as unknown as SourceInfo[];
  } catch {
    return null;
  }
}

/** Every word as a quoted FTS5 term (so punctuation and operators in the query are literal). */
export function docsFtsQuery(query: string, mode: 'all' | 'any'): string | null {
  const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).slice(0, 12).map((t) => `"${t}"`);
  return terms.length ? terms.join(mode === 'all' ? ' ' : ' OR ') : null;
}

interface SectionHit {
  id: number;
  page_id: number;
  url: string;
  source: string;
  title: string;
  heading: string;
  snippet: string;
}

export interface SearchDocsArgs {
  query: string;
  source?: string;
  limit?: number;
}

export function searchDocs(db: Database, args: SearchDocsArgs): ToolResult {
  const info = sources(db);
  if (!info || info.length === 0) return fail(NO_DOCS);
  if (args.source && !info.some((s) => s.source === args.source)) {
    return fail(`No imported documentation source "${args.source}". Imported: ${info.map((s) => s.source).join(', ')}.`);
  }
  const limit = args.limit ?? 10;
  const run = (match: string) => {
    const params: SQLInputValue[] = [match];
    let where = 'ax_doc_sections_fts MATCH ?';
    if (args.source) {
      where += ' AND p.source = ?';
      params.push(args.source);
    }
    params.push(limit * 3);
    // Title and heading hits count more than body hits; several sections of one page are collapsed below.
    return db
      .prepare(`SELECT s.id, s.page_id, p.url, p.source, s.title, s.heading,
          snippet(ax_doc_sections_fts, 2, '«', '»', ' … ', 24) AS snippet
        FROM ax_doc_sections_fts
        JOIN ax_doc_sections s ON s.id = ax_doc_sections_fts.rowid
        JOIN ax_doc_pages p ON p.id = s.page_id
        WHERE ${where}
        ORDER BY bm25(ax_doc_sections_fts, 6.0, 3.0, 1.0)
        LIMIT ?`)
      .all(...params) as unknown as SectionHit[];
  };

  const all = docsFtsQuery(args.query, 'all');
  if (!all) return fail('The query has no searchable words.');
  let hits = run(all);
  let broadened = false;
  if (hits.length === 0) {
    const any = docsFtsQuery(args.query, 'any');
    if (any && any !== all) {
      hits = run(any);
      broadened = hits.length > 0;
    }
  }

  const perPage = new Map<number, SectionHit[]>();
  for (const hit of hits) {
    const list = perPage.get(hit.page_id) ?? [];
    if (list.length < 2) list.push(hit);
    perPage.set(hit.page_id, list);
  }
  const pages = [...perPage.values()].slice(0, limit);
  const lines = [
    pages.length === 0
      ? `No documentation matched "${args.query}".`
      : `${pages.length} page(s) matched "${args.query}"${broadened ? ' (no page had every word; showing pages with any of them)' : ''}.`,
  ];
  for (const sections of pages) {
    const first = sections[0];
    lines.push('', `- **${first.title}** (page ${first.page_id}, ${first.source})`, `  ${first.url}`);
    for (const s of sections) {
      lines.push(`  ${s.heading ? `§ ${s.heading}: ` : ''}${s.snippet.replace(/\s+/g, ' ').trim()}`);
    }
  }
  lines.push('', `Sources: ${info.map((s) => `${s.source} (${s.page_count} pages, imported ${s.imported_at.slice(0, 10)})`).join('; ')}.`);
  if (pages.length > 0) lines.push('Next: get_doc_page with a page number (or url) for the full text.');
  return ok(lines.join('\n'));
}

export interface GetDocPageArgs {
  pageId?: number;
  url?: string;
  fromSection?: number;
  maxChars?: number;
}

export function getDocPage(db: Database, args: GetDocPageArgs): ToolResult {
  const info = sources(db);
  if (!info || info.length === 0) return fail(NO_DOCS);
  if (args.pageId === undefined && !args.url) return fail('Pass pageId or url.');
  const page = (args.pageId !== undefined
    ? db.prepare('SELECT id, source, url, title FROM ax_doc_pages WHERE id = ?').get(args.pageId)
    : db.prepare('SELECT id, source, url, title FROM ax_doc_pages WHERE url = ? ORDER BY id LIMIT 1').get(args.url as string)) as
    { id: number; source: string; url: string; title: string } | undefined;
  if (!page) return fail(`Documentation page ${args.pageId ?? args.url} is not in the imported data. Use search_docs to find pages.`);

  const sections = db
    .prepare('SELECT ordinal, heading, body FROM ax_doc_sections WHERE page_id = ? ORDER BY ordinal')
    .all(page.id) as { ordinal: number; heading: string; body: string }[];
  const from = args.fromSection ?? 0;
  const maxChars = args.maxChars ?? 12_000;
  const lines = [`# ${page.title}`, `Source: ${page.source} | ${page.url}`];
  let used = 0;
  let next: number | null = null;
  let previousHeading: string | null = null;
  for (const section of sections.filter((s) => s.ordinal >= from)) {
    const block = `${section.heading && section.heading !== previousHeading ? `\n## ${section.heading}\n` : '\n'}${section.body}`;
    if (used > 0 && used + block.length > maxChars) {
      next = section.ordinal;
      break;
    }
    lines.push(block);
    used += block.length;
    previousHeading = section.heading;
  }
  if (next !== null) lines.push('', `(Page continues: call get_doc_page with pageId ${page.id} and fromSection ${next}.)`);
  return ok(lines.join('\n'));
}

export function registerDocsTools(server: McpServer, db: Database): void {
  server.tool(
    'search_docs',
    'Full-text search over documentation sites imported with `index-docs` (for example Dynamics 365 finance and ' +
      'operations development, integration and administration guides). Returns matching pages with the best sections. ' +
      'Documentation describes the product; resolve object names against the index before relying on them.',
    {
      query: z.string().min(1).describe('Words to find; pages containing every word rank first, with stemming (post/posting).'),
      source: z.string().optional().describe('Only this imported source (the label given to index-docs).'),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async (args) => searchDocs(db, args)
  );

  server.tool(
    'get_doc_page',
    'Read an imported documentation page found with search_docs, as markdown. Long pages are returned in parts.',
    {
      pageId: z.number().int().optional().describe('Page number from search_docs.'),
      url: z.string().optional().describe('Page URL from search_docs, instead of pageId.'),
      fromSection: z.number().int().min(0).optional().describe('Continue a long page from this section.'),
      maxChars: z.number().int().min(1000).max(50_000).default(12_000),
    },
    async (args) => getDocPage(db, args)
  );
}
