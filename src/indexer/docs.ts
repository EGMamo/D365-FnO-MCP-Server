import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Database } from './db.js';

/**
 * Documentation sites (development, integration, administration guides), stored locally so the
 * server itself never calls out. `index-docs` crawls a site or reads a folder of markdown/HTML
 * files, splits each page into heading sections and stores them with an FTS5 index that
 * `search_docs` and `get_doc_page` read. This is separate from the curated knowledge base in
 * `d365-fno-assistant-knowledge/`: imported pages are reference material, not topic notes, and
 * never shape other tools' results.
 */

export interface DocSection {
  heading: string;
  body: string;
}

export interface DocPage {
  url: string;
  title: string;
  sections: DocSection[];
}

/** Sections longer than this are split at paragraph boundaries so a search hit stays focused. */
const MAX_SECTION_CHARS = 2400;
/** Pages with less prose than this (index pages, redirects) are not stored. */
const MIN_PAGE_CHARS = 80;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, ''));

/** The page's main content: `<main>`, then `<article>`, then `<body>`, then the whole document. */
function mainContent(html: string): string {
  for (const tag of ['main', 'article', 'body']) {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*)</${tag}>`, 'i').exec(html);
    if (match) return match[1];
  }
  return html;
}

export function htmlTitle(html: string): string {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(mainContent(html));
  const title = h1 ? stripTags(h1[1]) : /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return decodeEntities(title ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Converts an HTML page to markdown-like text: headings, lists, tables and code blocks are kept,
 * navigation, scripts and page chrome are dropped. Links keep their text only.
 */
export function htmlToMarkdown(html: string): string {
  const fences: string[] = [];
  let out = mainContent(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|aside|form|button|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) => {
      const lang = /class="[^"]*lang(?:uage)?-([\w+#-]+)/i.exec(code)?.[1] ?? '';
      fences.push(`\n\n\`\`\`${lang}\n${stripTags(code.replace(/<br\s*\/?>/gi, '\n')).replace(/\n+$/, '')}\n\`\`\`\n\n`);
      return `\u0000${fences.length - 1}\u0000`;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) =>
      `\n\n${'#'.repeat(Number(level))} ${stripTags(text).replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, code: string) => `\`${stripTags(code)}\``)
    .replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
      const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => stripTags(c[1]).replace(/\s+/g, ' ').trim());
      return `\n| ${cells.join(' | ')} |\n`;
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|blockquote|dl|dd|dt)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  out = decodeEntities(out)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => fences[Number(i)]).replace(/\n{3,}/g, '\n\n').trim();
}

/** True when the page asks not to be indexed (`<meta name="robots" content="noindex">`). */
export function isNoIndex(html: string): boolean {
  return /<meta\b(?=[^>]*name=["']robots["'])(?=[^>]*content=["'][^"']*noindex)[^>]*>/i.test(html);
}

function splitLongSection(section: DocSection): DocSection[] {
  if (section.body.length <= MAX_SECTION_CHARS) return [section];
  const parts: DocSection[] = [];
  let current = '';
  for (const paragraph of section.body.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length > MAX_SECTION_CHARS) {
      parts.push({ heading: section.heading, body: current.trim() });
      current = '';
    }
    current += `${paragraph}\n\n`;
  }
  if (current.trim()) parts.push({ heading: section.heading, body: current.trim() });
  return parts;
}

/**
 * Splits markdown into a title and `##`/`###` sections (headings inside code fences do not count).
 * Text before the first section heading becomes a section headed by the title.
 */
export function markdownToPage(markdown: string, url: string, fallbackTitle = ''): DocPage | null {
  let text = markdown.replace(/\r\n/g, '\n');
  let title = '';
  const front = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (front) {
    try {
      const meta = parseYaml(front[1]) as Record<string, unknown> | null;
      if (meta && typeof meta.title === 'string') title = meta.title.trim();
    } catch {
      // Malformed front matter: the title comes from the first heading instead.
    }
    text = text.slice(front[0].length);
  }

  const sections: DocSection[] = [];
  let heading = '';
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    const body = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body) sections.push({ heading, body });
    buf = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match && match[1].length === 1 && !title) {
      title = match[2].trim();
      continue;
    }
    if (match && match[1].length > 1) {
      flush();
      heading = match[2].trim();
      continue;
    }
    buf.push(line);
  }
  flush();

  title = title || fallbackTitle;
  const chars = sections.reduce((n, s) => n + s.body.length, 0);
  if (!title || chars < MIN_PAGE_CHARS) return null;
  return { url, title, sections: sections.flatMap(splitLongSection) };
}

export function htmlToPage(html: string, url: string): DocPage | null {
  if (isNoIndex(html)) return null;
  return markdownToPage(htmlToMarkdown(html), url, htmlTitle(html));
}

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.html', '.htm']);

/** Reads every markdown/HTML file under `dir`. `baseUrl` turns relative paths into stored URLs. */
export function readDocsFolder(dir: string, baseUrl?: string): { pages: DocPage[]; read: number } {
  const pages: DocPage[] = [];
  let read = 0;
  const files = (fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile() && DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    read++;
    const relative = path.relative(dir, file).split(path.sep).join('/');
    const url = baseUrl
      ? new URL(relative.replace(/\.(md|markdown)$/i, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString()
      : `file:${relative}`;
    const content = fs.readFileSync(file, 'utf8');
    const fallback = path.basename(file).replace(/\.[^.]+$/, '');
    const page = /\.html?$/i.test(file) ? htmlToPage(content, url) : markdownToPage(content, url, fallback);
    if (page) pages.push(page);
  }
  return { pages, read };
}

/** Drops the fragment and query, so `page?tabs=x#y` and `page` are one page. */
export function normalizeDocUrl(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Links on a page, resolved against the page URL (or its `<base href>`). */
export function extractLinks(html: string, pageUrl: string): string[] {
  const base = /<base\b[^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
  const resolvedBase = base ? normalizeDocUrl(base, pageUrl) ?? pageUrl : pageUrl;
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["']/gi)) {
    const url = normalizeDocUrl(decodeEntities(match[1]), resolvedBase);
    if (url) links.add(url);
  }
  return [...links];
}

/** `Disallow` rules from robots.txt that apply to every crawler (`User-agent: *`). */
export function parseRobotsTxt(content: string): string[] {
  const rules: string[] = [];
  let applies = false;
  let inAgents = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === 'user-agent') {
      if (!inAgents) applies = false;
      inAgents = true;
      if (match[2].trim() === '*') applies = true;
      continue;
    }
    inAgents = false;
    if (key === 'disallow' && applies && match[2].trim()) rules.push(match[2].trim());
  }
  return rules;
}

export function robotsAllows(rules: string[], url: string): boolean {
  const { pathname } = new URL(url);
  return !rules.some((rule) => {
    const pattern = rule.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${pattern.endsWith('\\$') ? `${pattern.slice(0, -2)}$` : pattern}`).test(pathname);
  });
}

/** `<loc>` entries of a sitemap or sitemap index. */
export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
  return /<sitemapindex\b/i.test(xml) ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}

export interface CrawlOptions {
  startUrl: string;
  /** Only URLs starting with this are fetched (default: the start URL's folder). */
  scope?: string;
  /** Seeds the queue from this sitemap.xml (or sitemap index) as well as the start URL. */
  sitemapUrl?: string;
  maxPages?: number;
  delayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onPage?: (url: string, stored: boolean, done: number) => void;
}

export interface CrawlResult {
  pages: DocPage[];
  fetched: number;
  skipped: number;
  failed: { url: string; reason: string }[];
  /** True when the crawl stopped at `maxPages` with links still queued. */
  truncated: boolean;
}

export const DOCS_USER_AGENT = 'd365-fno-mcp-server-docs-import (+https://github.com/EGMamo/D365-FnO-MCP-Server)';
const DEFAULT_MAX_PAGES = 2000;
const MAX_SITEMAPS = 50;

export function defaultScope(startUrl: string): string {
  const url = new URL(startUrl);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/[^/]*$/, '');
  return url.toString();
}

/**
 * Breadth-first crawl of one site: same origin, under `scope`, allowed by robots.txt, HTML only,
 * one request at a time with `delayMs` between them.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const start = normalizeDocUrl(options.startUrl);
  if (!start) throw new Error(`Not an http(s) URL: ${options.startUrl}`);
  const scope = options.scope ? normalizeDocUrl(options.scope) ?? options.scope : defaultScope(start);
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const delayMs = options.delayMs ?? 500;
  const inScope = (url: string) => url.startsWith(scope);

  const get = async (url: string) => {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 30_000)];
    if (options.signal) signals.push(options.signal);
    return fetchImpl(url, {
      signal: AbortSignal.any(signals),
      headers: { 'user-agent': DOCS_USER_AGENT, accept: 'text/html,application/xhtml+xml,text/markdown;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
    });
  };
  const pause = () => (delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve());

  let robots: string[] = [];
  try {
    const response = await get(new URL('/robots.txt', start).toString());
    if (response.ok) robots = parseRobotsTxt(await response.text());
  } catch (err) {
    options.signal?.throwIfAborted();
    void err; // No robots.txt reachable: nothing is disallowed.
  }

  const queue: string[] = [start];
  const seen = new Set<string>([start]);
  const enqueue = (url: string) => {
    if (!seen.has(url) && inScope(url) && robotsAllows(robots, url)) {
      seen.add(url);
      queue.push(url);
    }
  };

  if (options.sitemapUrl) {
    const sitemaps = [options.sitemapUrl];
    for (let i = 0; i < sitemaps.length && i < MAX_SITEMAPS; i++) {
      const response = await get(sitemaps[i]);
      if (!response.ok) throw new Error(`Sitemap request failed: HTTP ${response.status} (${sitemaps[i]}).`);
      const { pages, sitemaps: nested } = parseSitemap(await response.text());
      sitemaps.push(...nested);
      for (const page of pages) {
        const url = normalizeDocUrl(page);
        if (url) enqueue(url);
      }
    }
  }

  const result: CrawlResult = { pages: [], fetched: 0, skipped: 0, failed: [], truncated: false };
  const stored = new Set<string>();
  while (queue.length > 0) {
    if (result.fetched >= maxPages) {
      result.truncated = true;
      break;
    }
    options.signal?.throwIfAborted();
    const url = queue.shift() as string;
    if (result.fetched > 0) await pause();
    result.fetched++;
    let response: Response;
    try {
      response = await get(url);
    } catch (err) {
      options.signal?.throwIfAborted();
      result.failed.push({ url, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!response.ok) {
      result.failed.push({ url, reason: `HTTP ${response.status}` });
      continue;
    }
    // A redirect can leave the site or the scope; the final URL is what gets stored.
    const finalUrl = normalizeDocUrl(response.url || url) ?? url;
    const type = response.headers.get('content-type') ?? '';
    if (!inScope(finalUrl) || stored.has(finalUrl) || !/html|markdown|text\/plain/i.test(type)) {
      result.skipped++;
      options.onPage?.(url, false, result.fetched);
      continue;
    }
    const body = await response.text();
    const isHtml = /html/i.test(type);
    for (const link of isHtml ? extractLinks(body, finalUrl) : []) enqueue(link);
    const page = isHtml ? htmlToPage(body, finalUrl) : markdownToPage(body, finalUrl);
    if (page) {
      stored.add(finalUrl);
      result.pages.push(page);
    } else {
      result.skipped++;
    }
    options.onPage?.(url, page !== null, result.fetched);
  }
  return result;
}

export function createDocsSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ax_doc_sources (
      source TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      section_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ax_doc_pages (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      UNIQUE (source, url)
    );
    CREATE TABLE IF NOT EXISTS ax_doc_sections (
      id INTEGER PRIMARY KEY,
      page_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      title TEXT NOT NULL,
      heading TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ax_doc_sections_page ON ax_doc_sections(page_id, ordinal);
    CREATE VIRTUAL TABLE IF NOT EXISTS ax_doc_sections_fts
      USING fts5(title, heading, body, content=ax_doc_sections, content_rowid=id, tokenize='porter unicode61');
  `);
}

/** Replaces one source's pages in one transaction. Duplicate URLs keep the last occurrence. */
export function publishDocs(db: Database, source: string, origin: string, pages: DocPage[]): { pages: number; sections: number } {
  const unique = [...new Map(pages.map((p) => [p.url, p])).values()];
  let sections = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM ax_doc_sections WHERE page_id IN (SELECT id FROM ax_doc_pages WHERE source = ?)').run(source);
    db.prepare('DELETE FROM ax_doc_pages WHERE source = ?').run(source);
    db.prepare('DELETE FROM ax_doc_sources WHERE source = ?').run(source);
    const insertPage = db.prepare('INSERT INTO ax_doc_pages (source, url, title) VALUES (?, ?, ?)');
    const insertSection = db.prepare('INSERT INTO ax_doc_sections (page_id, ordinal, title, heading, body) VALUES (?, ?, ?, ?, ?)');
    for (const page of unique) {
      const pageId = Number(insertPage.run(source, page.url, page.title).lastInsertRowid);
      page.sections.forEach((section, i) => insertSection.run(pageId, i, page.title, section.heading, section.body));
      sections += page.sections.length;
    }
    db.prepare('INSERT INTO ax_doc_sources VALUES (?, ?, ?, ?, ?)').run(source, origin, new Date().toISOString(), unique.length, sections);
    db.exec("INSERT INTO ax_doc_sections_fts(ax_doc_sections_fts) VALUES ('rebuild')");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { pages: unique.length, sections };
}
