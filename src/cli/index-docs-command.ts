import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../indexer/db.js';
import { crawlSite, publishDocs, readDocsFolder, type DocPage } from '../indexer/docs.js';

export interface IndexDocsOptions {
  url?: string;
  scope?: string;
  sitemap?: string;
  fromDir?: string;
  baseUrl?: string;
  source?: string;
  maxPages?: number;
  delayMs?: number;
  dbPath?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function indexDocsCommand(options: IndexDocsOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Documentation import cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (!options.url === !options.fromDir) throw new Error('Pass either --url <start page> or --from-dir <folder>.');
    for (const [flag, value] of [['--max-pages', options.maxPages], ['--delay-ms', options.delayMs]] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(`${flag} must be a whole number.`);
    }
    const signal = options.signal ?? abort.signal;
    let pages: DocPage[];
    let origin: string;
    let source: string;
    if (options.fromDir) {
      const dir = path.resolve(options.fromDir);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${options.fromDir}`);
      const folder = readDocsFolder(dir, options.baseUrl);
      console.error(`Read ${folder.read} file(s) from ${dir}; ${folder.pages.length} page(s) have content.`);
      pages = folder.pages;
      origin = options.baseUrl ?? `folder:${path.basename(dir)}`;
      source = options.source ?? path.basename(dir);
    } else {
      const url = options.url as string;
      console.error(`Crawling ${url} ...`);
      const crawl = await crawlSite({
        startUrl: url,
        scope: options.scope,
        sitemapUrl: options.sitemap,
        maxPages: options.maxPages,
        delayMs: options.delayMs,
        fetchImpl: options.fetchImpl,
        signal,
        onPage: (_page, _stored, done) => {
          if (done % 50 === 0) console.error(`  ${done} fetched`);
        },
      });
      console.error(`Fetched ${crawl.fetched} URL(s): ${crawl.pages.length} page(s) stored, ${crawl.skipped} skipped, ${crawl.failed.length} failed.`);
      for (const failure of crawl.failed.slice(0, 10)) console.error(`  failed: ${failure.url} (${failure.reason})`);
      if (crawl.truncated) console.error(`Stopped at --max-pages ${options.maxPages ?? 2000} with links left; raise it to import the rest.`);
      pages = crawl.pages;
      origin = url;
      source = options.source ?? new URL(url).host;
    }
    if (pages.length === 0) throw new Error('No pages with content were found; nothing was replaced.');
    signal.throwIfAborted();
    const db = openDb(path.resolve(dbPath));
    let stored: { pages: number; sections: number };
    try {
      stored = publishDocs(db, source, origin, pages);
    } finally {
      db.close();
    }
    console.log(`Imported ${stored.pages} documentation page(s) (${stored.sections} sections) as source "${source}" into ${dbPath}.`);
    return 0;
  } catch (err) {
    console.error(`Documentation import failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
