import fs from 'node:fs/promises';
import path from 'node:path';
import { openDb } from '../indexer/db.js';
import {
  fetchReleasePlans, FNO_RELEASE_PRODUCTS, normalizeReleasePlan, parseReleasePlansJson, publishReleasePlans,
  RELEASE_PLANS_URL, type ReleasePlanFeedItem,
} from '../indexer/releasePlans.js';

export interface IndexReleasePlansOptions {
  fromJson?: string;
  url?: string;
  allProducts?: boolean;
  products?: string[];
  dbPath?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export async function indexReleasePlansCommand(
  options: IndexReleasePlansOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Release plan import cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    let items: ReleasePlanFeedItem[];
    let origin: string;
    if (options.fromJson) {
      items = parseReleasePlansJson(await fs.readFile(options.fromJson, 'utf-8'));
      origin = `file:${path.basename(options.fromJson)}`;
    } else {
      const url = options.url ?? RELEASE_PLANS_URL;
      console.error(`Downloading release plans from ${url} ...`);
      items = await fetchReleasePlans({
        url,
        fetchImpl: options.fetchImpl,
        signal: options.signal ?? abort.signal,
        onPage: (page, count) => console.error(`  page ${page}: ${count} features`),
      });
      origin = url;
    }
    const wanted = options.allProducts
      ? null
      : new Set((options.products?.length ? options.products : FNO_RELEASE_PRODUCTS).map((p) => p.toLowerCase()));
    const plans = items
      .filter((item) => !wanted || wanted.has(item['Product name'].toLowerCase()))
      .map(normalizeReleasePlan);
    if (plans.length === 0) {
      throw new Error(
        `No release plans matched ${wanted ? `products: ${[...wanted].join(', ')}` : 'the feed'} (${items.length} read).`
      );
    }
    (options.signal ?? abort.signal).throwIfAborted();
    const db = openDb(path.resolve(dbPath));
    let stored: number;
    try {
      stored = publishReleasePlans(db, origin, plans);
    } finally {
      db.close();
    }
    console.log(`Imported ${stored} release plan features (${items.length} read) into ${dbPath}.`);
    return 0;
  } catch (err) {
    console.error(`Release plan import failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
