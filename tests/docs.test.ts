import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, type Database } from '../src/indexer/db.js';
import {
  cleanDocsMarkdown, crawlSite, extractLinks, htmlToMarkdown, htmlToPage, markdownToPage, parseRobotsTxt, parseSitemap, publishDocs,
  readDocsFolder, robotsAllows,
} from '../src/indexer/docs.js';
import { indexDocsCommand } from '../src/cli/index-docs-command.js';
import { docsFtsQuery, registerDocsTools } from '../src/tools/docs.js';
import { fakeToolServer, type ToolResult } from './helpers/toolHarness.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

const PROSE = 'Data entities provide a conceptual abstraction over underlying tables and are used for integration. ';

function html(title: string, body: string, links: string[] = [], head = ''): string {
  return `<!doctype html><html><head><title>${title} | Docs</title>${head}<script>var x = "<h2>no</h2>";</script></head>
<body><header><nav><a href="/nav-only">Nav</a></nav></header>
<main><h1>${title}</h1>${body}${links.map((l) => `<a href="${l}">link</a>`).join(' ')}</main>
<footer>Footer text</footer></body></html>`;
}

function tools(db: Database): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerDocsTools(fakeToolServer(handlers), db);
  return handlers;
}

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

describe('page conversion', () => {
  it('keeps headings, lists, tables and code, and drops page chrome', () => {
    const md = htmlToMarkdown(html('Entities', `<p>Intro &amp; more.</p><h2>Keys</h2><ul><li>One</li><li>Two</li></ul>
      <table><tr><th>Name</th><th>Type</th></tr><tr><td>Id</td><td>String</td></tr></table>
      <pre><code class="lang-xpp">if (a &lt; b)\n{\n    info("x");\n}</code></pre>`));
    expect(md).toContain('# Entities');
    expect(md).toContain('## Keys');
    expect(md).toContain('- One\n- Two');
    expect(md).toContain('| Name | Type |');
    expect(md).toContain('```xpp\nif (a < b)\n{\n    info("x");\n}\n```');
    expect(md).not.toMatch(/Nav|Footer|var x/);
  });

  it('splits markdown into sections, ignoring headings inside code', () => {
    const page = markdownToPage(
      `---\ntitle: From front matter\n---\n# Heading title\n\n${PROSE}\n\n## Setup\n\n\`\`\`sh\n## not a heading\n\`\`\`\n\n${PROSE}\n\n### Detail\n\nMore text here.`,
      'https://x/doc'
    );
    expect(page?.title).toBe('From front matter');
    expect(page?.sections.map((s) => s.heading)).toEqual(['', 'Setup', 'Detail']);
    expect(page?.sections[1].body).toContain('## not a heading');
  });

  it('splits long sections and skips pages without content or marked noindex', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${PROSE}`).join('\n\n');
    const page = markdownToPage(`# Long\n\n## Part\n\n${long}`, 'u');
    expect(page?.sections.length).toBeGreaterThan(1);
    expect(page?.sections.every((s) => s.heading === 'Part' && s.body.length <= 2600)).toBe(true);
    expect(markdownToPage('# Tiny\n\nshort', 'u')).toBeNull();
    expect(htmlToPage(html('Hidden', `<p>${PROSE}</p>`, [], '<meta name="robots" content="noindex, nofollow">'), 'u')).toBeNull();
  });

  it('removes Learn markup outside code fences', () => {
    const md = [
      '[!INCLUDE [banner](../includes/banner.md)]',
      '> [!NOTE]',
      '> Read this first.',
      ':::image type="content" source="media/a.png" alt-text="A":::',
      ':::image type="complex" source="media/b.png" alt-text="B":::',
      'Long description of B.',
      ':::image-end:::',
      '> [!div class="nextstepaction"]',
      'See ![icon](media/i.png) here.',
      '```text',
      ':::kept in code:::',
      '```',
    ].join('\n');
    expect(cleanDocsMarkdown(md)).toBe(['> **Note:**', '> Read this first.', 'See  here.', '```text', ':::kept in code:::', '```'].join('\n'));
  });

  it('resolves links and reads robots.txt and sitemaps', () => {
    expect(extractLinks('<a href="b?x=1#y">b</a><a href="#top">t</a><a href="mailto:a@b.c">m</a><a href="/c/">c</a>', 'https://s.test/a/page'))
      .toEqual(['https://s.test/a/b', 'https://s.test/c/']);
    const rules = parseRobotsTxt('User-agent: other\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nDisallow: /*.pdf$\nAllow: /');
    expect(rules).toEqual(['/private', '/*.pdf$']);
    expect(robotsAllows(rules, 'https://s.test/private/x')).toBe(false);
    expect(robotsAllows(rules, 'https://s.test/a/file.pdf')).toBe(false);
    expect(robotsAllows(rules, 'https://s.test/a/file.pdf.html')).toBe(true);
    expect(parseSitemap('<urlset><url><loc>https://s.test/a/1</loc></url></urlset>').pages).toEqual(['https://s.test/a/1']);
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://s.test/s2.xml</loc></sitemap></sitemapindex>').sitemaps)
      .toEqual(['https://s.test/s2.xml']);
  });
});

describe('crawlSite', () => {
  const SITE: Record<string, { body: string; type?: string; status?: number }> = {
    'https://s.test/robots.txt': { body: 'User-agent: *\nDisallow: /docs/private', type: 'text/plain' },
    'https://s.test/docs/': { body: html('Home', `<p>${PROSE}</p>`, ['intro', 'private/x', '/blog/post', 'https://other.test/docs/a', 'missing', 'file.pdf']) },
    'https://s.test/docs/intro': { body: html('Intro', `<h2>Integration</h2><p>${PROSE}</p>`, ['/docs/', 'deep/page']) },
    'https://s.test/docs/deep/page': { body: html('Deep', `<p>${PROSE}</p>`) },
    'https://s.test/docs/file.pdf': { body: '%PDF', type: 'application/pdf' },
    'https://s.test/docs/from-sitemap': { body: html('Sitemap page', `<p>${PROSE}</p>`) },
    'https://s.test/sitemap.xml': { body: '<urlset><url><loc>https://s.test/docs/from-sitemap</loc></url><url><loc>https://s.test/blog/x</loc></url></urlset>', type: 'application/xml' },
  };
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const page = SITE[url];
    const response = new Response(page?.body ?? 'not found', {
      status: page ? page.status ?? 200 : 404,
      headers: { 'content-type': page?.type ?? 'text/html; charset=utf-8' },
    });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  }) as unknown as typeof fetch;

  it('stays on the site and under the scope, honours robots.txt and skips non-HTML', async () => {
    const result = await crawlSite({ startUrl: 'https://s.test/docs/', delayMs: 0, fetchImpl, sitemapUrl: 'https://s.test/sitemap.xml' });
    expect(result.pages.map((p) => p.url).sort()).toEqual([
      'https://s.test/docs/', 'https://s.test/docs/deep/page', 'https://s.test/docs/from-sitemap', 'https://s.test/docs/intro',
    ]);
    expect(result.failed).toEqual([{ url: 'https://s.test/docs/missing', reason: 'HTTP 404' }]);
    expect(result.skipped).toBe(1);
    const requested = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(requested.some((u) => u.includes('private') || u.includes('blog') || u.includes('other.test'))).toBe(false);
  });

  it('stores only included folders but follows links through the rest of the scope', async () => {
    const result = await crawlSite({ startUrl: 'https://s.test/docs/', delayMs: 0, fetchImpl, include: ['deep'] });
    expect(result.pages.map((p) => p.url)).toEqual(['https://s.test/docs/deep/page']);
  });

  it('stops at maxPages and reports it', async () => {
    const result = await crawlSite({ startUrl: 'https://s.test/docs/', delayMs: 0, fetchImpl, maxPages: 2 });
    expect(result.fetched).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe('docs store and tools', () => {
  let tmp: string;
  let db: Database;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
    db = openDb(path.join(tmp, 'index.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('tells the client to import first', async () => {
    const result = await tools(db).get('search_docs')!({ query: 'entity' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('index-docs');
  });

  it('searches with stemming, ranks titles first, and reads pages in parts', async () => {
    publishDocs(db, 'learn', 'https://s.test/docs/', [
      { url: 'https://s.test/a', title: 'Posting arrival journals', sections: [{ heading: '', body: 'How to post an arrival journal in batch.' }] },
      { url: 'https://s.test/b', title: 'Warehouse overview', sections: [
        { heading: 'Receiving', body: 'Receipts mention posting of journals in passing.' },
        { heading: 'Setup', body: 'x'.repeat(1500) },
        { heading: 'More', body: 'y'.repeat(1500) },
      ] },
    ]);
    const handlers = tools(db);
    const found = text(await handlers.get('search_docs')!({ query: 'posted journal' }));
    expect(found.indexOf('Posting arrival journals')).toBeGreaterThan(-1);
    expect(found.indexOf('Posting arrival journals')).toBeLessThan(found.indexOf('Warehouse overview'));
    expect(found).toContain('§ Receiving');

    const broadened = text(await handlers.get('search_docs')!({ query: 'arrival nonexistentword' }));
    expect(broadened).toContain('showing pages with any of them');

    const pageId = Number(/page (\d+), learn\)\n {2}https:\/\/s\.test\/b/.exec(found)?.[1]);
    const part = text(await handlers.get('get_doc_page')!({ pageId, maxChars: 1000 }));
    expect(part).toContain('## Receiving');
    expect(part).toContain(`fromSection 1`);
    const rest = text(await handlers.get('get_doc_page')!({ url: 'https://s.test/b', fromSection: 1 }));
    expect(rest).toContain('## Setup');
    expect(rest).not.toContain('## Receiving');
  });

  it('replaces only the re-imported source', async () => {
    const page = (url: string, title: string) => ({ url, title, sections: [{ heading: '', body: `${title} body text` }] });
    publishDocs(db, 'one', 'o1', [page('u1', 'Alpha topic')]);
    publishDocs(db, 'two', 'o2', [page('u2', 'Beta topic')]);
    publishDocs(db, 'one', 'o1', [page('u3', 'Gamma topic')]);
    const search = tools(db).get('search_docs')!;
    expect(text(await search({ query: 'alpha' }))).toContain('No documentation matched');
    expect(text(await search({ query: 'beta' }))).toContain('Beta topic');
    expect(text(await search({ query: 'gamma', source: 'one' }))).toContain('Gamma topic');
    expect((await search({ query: 'gamma', source: 'three' })).isError).toBe(true);
  });

  it('builds FTS queries from words only', () => {
    expect(docsFtsQuery('OData "entity" -x', 'all')).toBe('"OData" "entity" "x"');
    expect(docsFtsQuery('a b', 'any')).toBe('"a" OR "b"');
    expect(docsFtsQuery('!!', 'all')).toBeNull();
  });

  it('maps a docs repository folder to site URLs, skipping includes and media and honouring --include', () => {
    const dir = path.join(tmp, 'repo');
    for (const sub of ['dev-tools', 'sysadmin', 'analytics', 'dev-tools/includes', 'media']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    const article = (title: string) => `---\ntitle: ${title}\nms.date: 01/01/2026\n---\n\n# ${title}\n\n${PROSE}`;
    fs.writeFileSync(path.join(dir, 'dev-tools', 'index.md'), article('Developer home'));
    fs.writeFileSync(path.join(dir, 'dev-tools', 'build.md'), article('Build'));
    fs.writeFileSync(path.join(dir, 'dev-tools', 'includes', 'banner.md'), article('Banner'));
    fs.writeFileSync(path.join(dir, 'sysadmin', 'batch.md'), article('Batch'));
    fs.writeFileSync(path.join(dir, 'analytics', 'reports.md'), article('Reports'));
    fs.writeFileSync(path.join(dir, 'media', 'note.md'), article('Media note'));
    const { pages, unmatched } = readDocsFolder(dir, 'https://s.test/dev-itpro', ['dev-tools', './sysadmin/', 'missing']);
    expect(unmatched).toEqual(['missing/']);
    expect(pages.map((p) => [p.url, p.title])).toEqual([
      ['https://s.test/dev-itpro/dev-tools/build', 'Build'],
      ['https://s.test/dev-itpro/dev-tools/', 'Developer home'],
      ['https://s.test/dev-itpro/sysadmin/batch', 'Batch'],
    ]);
  });

  it('imports a folder through the CLI command', async () => {
    const dir = path.join(tmp, 'site');
    fs.mkdirSync(path.join(dir, 'dev'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dev', 'entities.md'), `# Data entities\n\n${PROSE}`);
    fs.writeFileSync(path.join(dir, 'index.html'), html('Welcome', `<p>${PROSE}</p>`));
    fs.writeFileSync(path.join(dir, 'empty.md'), '# Empty');
    expect(readDocsFolder(dir, 'https://s.test/docs').pages.map((p) => p.url))
      .toEqual(['https://s.test/docs/dev/entities', 'https://s.test/docs/index.html']);

    const dbPath = path.join(tmp, 'cli.db');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await indexDocsCommand({ fromDir: dir, dbPath }, {})).toBe(0);
      expect(log.mock.calls.flat().join(' ')).toContain('Imported 2 documentation page(s)');
      expect(await indexDocsCommand({ dbPath }, {})).toBe(1);
      expect(await indexDocsCommand({ fromDir: path.join(tmp, 'nope'), dbPath }, {})).toBe(1);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const cliDb = openDb(dbPath);
    try {
      expect(text(await tools(cliDb).get('search_docs')!({ query: 'conceptual abstraction', source: 'site' }))).toContain('Data entities');
    } finally {
      cliDb.close();
    }
  });
});
