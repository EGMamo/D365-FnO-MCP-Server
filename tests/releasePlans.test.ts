import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../src/indexer/db.js';
import { openDb } from '../src/indexer/db.js';
import { buildIndex } from '../src/indexer/buildIndex.js';
import {
  fetchReleasePlans, htmlToText, normalizeReleasePlan, parseReleasePlansJson, publishReleasePlans, toIsoDate,
} from '../src/indexer/releasePlans.js';
import { indexReleasePlansCommand } from '../src/cli/index-release-plans-command.js';
import { registerReleasePlanTools, releaseStatus, suggestImpactTerms } from '../src/tools/releasePlans.js';
import type { ToolResult } from './helpers/toolHarness.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function feedItem(id: string, product: string, name: string, extra: Record<string, string> = {}): Record<string, unknown> {
  return {
    ProductId: 'p',
    'Product name': product,
    'Feature name': name,
    'Investment area': 'Core financials',
    'Business value': '<p>Improves <b>vendor</b> invoices &amp; payments.</p>',
    'Feature details': '<ul><li>First</li><li>Second&nbsp;item</li></ul>',
    'Enabled for': 'Admins',
    'Early access date': '',
    'Public preview date': '',
    'GA date': '',
    'Public Preview Release Wave': '',
    'GA Release Wave': '',
    'Release Plan ID': id,
    GeographicAreasDetails: '',
    'Last Gitcommit date': '03/04/2026',
    ...extra,
  };
}

const ITEMS = [
  feedItem('rp-vend', 'Dynamics 365 Finance', 'Vendor invoice automation', {
    'Public preview date': '01/15/2026', 'GA date': '04/01/2026',
    'Public Preview Release Wave': '2025 release wave 2', 'GA Release Wave': '2026 release wave 1',
  }),
  feedItem('rp-whs', 'Dynamics 365 Supply Chain Management', 'Warehouse wave labels', {
    'Investment area': 'Warehouse management', 'Business value': 'Faster picking',
    'Public preview date': '10/01/2026', 'Public Preview Release Wave': '2026 release wave 2',
  }),
  feedItem('rp-sales', 'Dynamics 365 Sales', 'Copilot in Sales', { 'Business value': 'Sell more with vendor insights' }),
];

const page = (results: unknown[], more: boolean, total = ITEMS.length) => ({
  morerecords: more, 'paging-cookie-encoded': '', maxrecordsperpage: '100', totalrecords: String(total), results,
});

describe('release plan parsing', () => {
  it('converts HTML and dates', () => {
    expect(htmlToText('<p>A &amp; B</p><ul><li>x&#39;s</li><li>y&#x21;</li></ul>')).toBe("A & B\n- x's\n- y!");
    expect(toIsoDate('4/1/2026')).toBe('2026-04-01');
    expect(toIsoDate('2026-04-01T00:00:00Z')).toBe('2026-04-01');
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('TBD')).toBeNull();
  });

  it('normalizes feed items', () => {
    const plan = normalizeReleasePlan(parseReleasePlansJson(JSON.stringify([ITEMS[0]]))[0]);
    expect(plan).toMatchObject({
      plan_id: 'rp-vend', product: 'Dynamics 365 Finance', public_preview_date: '2026-01-15', ga_date: '2026-04-01',
      early_access_date: null, business_value: 'Improves vendor invoices & payments.', feature_details: '- First\n- Second item',
      last_updated: '2026-03-04',
    });
  });

  it('accepts a page, several pages or a bare array', () => {
    expect(parseReleasePlansJson(JSON.stringify(page(ITEMS, false)))).toHaveLength(3);
    expect(parseReleasePlansJson(JSON.stringify([page(ITEMS.slice(0, 1), true), page(ITEMS.slice(1), false)]))).toHaveLength(3);
    expect(parseReleasePlansJson(JSON.stringify(ITEMS))).toHaveLength(3);
    expect(() => parseReleasePlansJson(JSON.stringify([{ 'Feature name': 'x' }]))).toThrow(/item 0 is invalid/);
  });
});

describe('fetchReleasePlans', () => {
  const respond = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  it('walks pages until morerecords is false', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      urls.push(String(url));
      return respond(urls.length === 1 ? page(ITEMS.slice(0, 2), true) : page(ITEMS.slice(2), false));
    }) as unknown as typeof fetch;
    const pages: number[] = [];
    const items = await fetchReleasePlans({ url: 'https://example.test/plans/', fetchImpl, onPage: (p) => pages.push(p) });
    expect(items).toHaveLength(3);
    expect(urls).toEqual(['https://example.test/plans/?page=1', 'https://example.test/plans/?page=2']);
    expect(pages).toEqual([1, 2]);
  });

  it('fails on HTTP errors and short feeds', async () => {
    const httpError = (async () => respond({}, 503)) as unknown as typeof fetch;
    await expect(fetchReleasePlans({ fetchImpl: httpError })).rejects.toThrow(/HTTP 503/);
    const short = (async () => respond(page(ITEMS.slice(0, 1), false, 5))) as unknown as typeof fetch;
    await expect(fetchReleasePlans({ fetchImpl: short })).rejects.toThrow(/after 1 of 5/);
  });
});

describe('release plan storage and CLI', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plans-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('replaces previous imports', () => {
    const db = openDb(path.join(dir, 'store.db'));
    const plans = parseReleasePlansJson(JSON.stringify(ITEMS)).map(normalizeReleasePlan);
    expect(publishReleasePlans(db, 'a', plans)).toBe(3);
    expect(publishReleasePlans(db, 'b', [plans[0], plans[0]])).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ax_release_plans').get()).toMatchObject({ n: 1 });
    expect(db.prepare('SELECT origin, plan_count FROM ax_release_plan_imports').get()).toMatchObject({ origin: 'b', plan_count: 1 });
    db.close();
  });

  it('imports F&O products by default, or all/explicit products', async () => {
    const json = path.join(dir, 'feed.json');
    fs.writeFileSync(json, JSON.stringify(page(ITEMS, false)));
    const dbPath = path.join(dir, 'cli.db');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const count = () => {
        const db = openDb(dbPath);
        const row = db.prepare('SELECT COUNT(*) AS n FROM ax_release_plans').get() as { n: number };
        db.close();
        return row.n;
      };
      expect(await indexReleasePlansCommand({ fromJson: json, dbPath }, {})).toBe(0);
      expect(count()).toBe(2);
      expect(await indexReleasePlansCommand({ fromJson: json, dbPath, allProducts: true }, {})).toBe(0);
      expect(count()).toBe(3);
      expect(await indexReleasePlansCommand({ fromJson: json, dbPath, products: ['dynamics 365 sales'] }, {})).toBe(0);
      expect(count()).toBe(1);
      expect(await indexReleasePlansCommand({ fromJson: json, dbPath, products: ['Nope'] }, {})).toBe(1);
      expect(count()).toBe(1);
      expect(err.mock.calls.flat().join('\n')).toMatch(/No release plans matched/);

      const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => page(ITEMS, false) })) as unknown as typeof fetch;
      expect(await indexReleasePlansCommand({ url: 'https://example.test/', dbPath, fetchImpl }, {})).toBe(0);
      expect(count()).toBe(2);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });
});

describe('release plan tools', () => {
  let dir: string;
  let db: Database;
  const handlers = new Map<string, Handler>();
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handlers.get(name)!(args);
    return { text: res.content[0].text, isError: res.isError === true };
  };

  const axClass = (name: string, decl: string) =>
    `<?xml version="1.0" encoding="utf-8"?><AxClass xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name>` +
    `<SourceCode><Declaration><![CDATA[\n${decl}\n]]></Declaration><Methods /></SourceCode></AxClass>`;
  const axTable = (name: string) =>
    `<?xml version="1.0" encoding="utf-8"?><AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name>` +
    '<Fields /><Indexes /><Relations /></AxTable>';

  const stage = (root: string, pkg: string, folder: string, name: string, xml: string) => {
    const d = path.join(root, pkg, pkg, folder);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${name}.xml`), xml);
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-tools-'));
    const root = path.join(dir, 'packages');
    stage(root, 'ApplicationSuite', 'AxTable', 'VendInvoiceJour', axTable('VendInvoiceJour'));
    stage(root, 'ApplicationSuite', 'AxTable', 'CustInvoiceJour', axTable('CustInvoiceJour'));
    stage(root, 'ApplicationSuite', 'AxClass', 'VendInvoiceJourPost', axClass('VendInvoiceJourPost', 'class VendInvoiceJourPost\n{\n}'));
    stage(root, 'ContosoExt', 'AxClass', 'ContosoPostExt', axClass('ContosoPostExt', 'class ContosoPostExt extends VendInvoiceJourPost\n{\n}'));
    stage(root, 'ContosoExt', 'AxClass', 'ContosoVendInvoiceHelper', axClass('ContosoVendInvoiceHelper', 'class ContosoVendInvoiceHelper\n{\n}'));
    db = openDb(path.join(dir, 'idx.db'));
    await buildIndex(db, root, true);
    const server = {
      tool: (name: string, _d: string, _s: unknown, handler: Handler) => handlers.set(name, handler),
    } as unknown as McpServer;
    registerReleasePlanTools(server, db);
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('computes status from dates', () => {
    const p = { early_access_date: '2026-01-01', public_preview_date: '2026-02-01', ga_date: '2026-03-01' };
    expect(releaseStatus(p, '2025-12-31')).toBe('planned');
    expect(releaseStatus(p, '2026-01-01')).toBe('early_access');
    expect(releaseStatus(p, '2026-02-15')).toBe('public_preview');
    expect(releaseStatus(p, '2026-03-01')).toBe('ga');
  });

  it('suggests AOT-style terms', () => {
    const terms = suggestImpactTerms('Vendor invoice automation for warehouses');
    expect(terms).toContain('Vend');
    expect(terms).toContain('WHS');
    expect(terms.map((t) => t.toLowerCase())).not.toContain('for');
  });

  it('reports when nothing is imported', async () => {
    const r = await call('search_release_plans', { query: 'vendor' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/index-release-plans/);
  });

  it('searches, filters and shows details', async () => {
    publishReleasePlans(db, 'test', parseReleasePlansJson(JSON.stringify(ITEMS)).map(normalizeReleasePlan));

    const all = await call('search_release_plans', {});
    expect(all.text).toMatch(/^3 release plan feature/);
    expect(all.text).toMatch(/September 2026/);

    const vendor = await call('search_release_plans', { query: 'vendor invoices' });
    expect(vendor.text).toContain('Vendor invoice automation');
    expect(vendor.text).not.toContain('Warehouse wave labels');

    expect((await call('search_release_plans', { product: 'supply chain' })).text).toContain('Warehouse wave labels');
    expect((await call('search_release_plans', { wave: '2026 release wave 1' })).text).toMatch(/^1 release plan/);
    expect((await call('search_release_plans', { query: '100%_' })).text).toMatch(/^0 release plan/);

    const details = await call('search_release_plans', { planId: 'rp-vend' });
    expect(details.text).toContain('# Vendor invoice automation');
    expect(details.text).toContain('- Second item');
    expect((await call('search_release_plans', { planId: 'missing' })).isError).toBe(true);
  });

  it('maps a feature to indexed objects and custom packages', async () => {
    const broad = await call('check_feature_impact', { planId: 'rp-vend' });
    expect(broad.isError).toBe(false);
    expect(broad.text).toContain('VendInvoiceJour');
    expect(broad.text.indexOf('VendInvoiceJour')).toBeLessThan(broad.text.indexOf('CustInvoiceJour'));
    expect(broad.text).toMatch(/Pass packages/);

    const own = await call('check_feature_impact', { terms: ['VendInvoiceJour'], packages: ['contosoext'] });
    expect(own.text).toContain('Class ContosoPostExt (ContosoExt) → Class VendInvoiceJourPost [extends]');
    expect(own.text).not.toContain('ContosoVendInvoiceHelper');

    const byName = await call('check_feature_impact', { terms: ['VendInvoice'], packages: ['ContosoExt'] });
    expect(byName.text).toContain('Class ContosoVendInvoiceHelper (ContosoExt)');

    const none = await call('check_feature_impact', { terms: ['Zzzz'] });
    expect(none.text).toMatch(/No indexed objects/);

    expect((await call('check_feature_impact', {})).isError).toBe(true);
    expect((await call('check_feature_impact', { terms: ['a;'] })).isError).toBe(true);
    expect((await call('check_feature_impact', { planId: 'missing' })).isError).toBe(true);
  });
});
