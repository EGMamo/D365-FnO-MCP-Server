import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { openDb } from '../src/indexer/db.js';
import { CUSTOM_ID_OFFSET, LAYERED_TABLES, openLayeredIndex, type LayeredIndex } from '../src/gateway/layeredIndex.js';
import { openLocalIndex } from '../src/gateway/localIndex.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import { executeToolCall, layerableToolNames } from '../src/gateway/router.js';
import type { GatewayWorkspaceConfig, LocalIndex, RouteContext, UpstreamPort } from '../src/gateway/types.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(fixturesDir, name), 'utf-8');

const refs = (container: string, refType: string, names: string[]) =>
  `<${container}>${names.map((n) => `<${refType}><Name>${n}</Name></${refType}>`).join('')}</${container}>`;
const role = (name: string, duties: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><AxSecurityRole><Name>${name}</Name>${refs('Duties', 'AxSecurityDutyReference', duties)}</AxSecurityRole>`;
const table = (name: string, fields: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?><AxTable xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Name>${name}</Name><Fields>${fields
    .map((field) => `<AxTableField i:type="AxTableFieldString"><Name>${field}</Name></AxTableField>`)
    .join('')}</Fields></AxTable>`;

/** Writes <root>/<Package>/<Model>/<AxType>/<Name>.xml */
function stage(root: string, pkg: string, files: [string, string, string][]) {
  for (const [typeDir, name, xml] of files) {
    const dir = path.join(root, pkg, pkg, typeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.xml`), xml);
  }
}

const workspace = (customDir: string): GatewayWorkspaceConfig => ({
  workspaceDir: '',
  customMetadataDir: customDir,
  targetProject: '',
  targetPackage: '',
  targetModel: '',
  targetSolution: '',
});

const textOf = (result: CallToolResult): string => {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('Expected a text item.');
  return first.text;
};

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

let root: string;
let standardDb: string;
let standardHash: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-layered-'));
  const standardDir = path.join(root, 'standard');
  // A standard role, duty, privilege and menu item, plus a table the custom models overlayer.
  stage(standardDir, 'ApplicationSuite', [
    ['AxSecurityRole', 'SampleAuditorRole', role('SampleAuditorRole', ['SampleMaintainDuty'])],
    ['AxSecurityDuty', 'SampleMaintainDuty', fixture('AxSecurityDutySample.xml')],
    ['AxSecurityPrivilege', 'SampleFormMaintain', fixture('AxSecurityPrivilegeSample.xml')],
    ['AxMenuItemDisplay', 'SampleForm', fixture('AxMenuItemDisplaySample.xml')],
    ['AxTable', 'SampleOverlayTable', table('SampleOverlayTable', ['StandardField'])],
    ['AxTable', 'SampleStandardTable', table('SampleStandardTable', ['AccountNum', 'Name'])],
  ]);
  standardDb = path.join(root, 'standard.db');
  const db = openDb(standardDb);
  await buildIndex(db, standardDir, true);
  db.close();
  standardHash = sha256(standardDb);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each([
  ['an in-memory custom index', ':memory:'],
  ['a custom index file', 'custom_index.db'],
])('layered index over %s', (_label, dbName) => {
  let customDir: string;
  let localIndex: LocalIndex;
  let layered: LayeredIndex;

  beforeAll(async () => {
    customDir = fs.mkdtempSync(path.join(root, 'custom-'));
    stage(customDir, 'ContosoExt', [
      // A custom role holding a standard duty: only the layered index joins the two.
      ['AxSecurityRole', 'ContosoClerkRole', role('ContosoClerkRole', ['SampleMaintainDuty'])],
      ['AxTable', 'SampleOverlayTable', table('SampleOverlayTable', ['CustomField'])],
      ['AxTable', 'ContosoLoyaltyTable', table('ContosoLoyaltyTable', ['Points'])],
    ]);
    localIndex = await openLocalIndex({
      customDir,
      dbPath: dbName === ':memory:' ? dbName : path.join(root, `${path.basename(customDir)}.db`),
      ttlMs: 0,
      debounceMs: 0,
    });
    layered = openLayeredIndex(standardDb, localIndex.attachUri);
  });

  afterAll(() => {
    layered.close();
    localIndex.close();
  });

  const fieldsOf = (name: string) =>
    (
      layered.db
        .prepare(`SELECT f.name FROM ax_fields f JOIN ax_objects o ON o.id = f.object_id WHERE o.name = ? ORDER BY f.name`)
        .all(name) as { name: string }[]
    ).map((row) => row.name);

  it('shows standard and custom objects as one index, custom ids offset', () => {
    const rows = layered.db
      .prepare(`SELECT name, package, id FROM ax_objects WHERE type = 'Table' ORDER BY name`)
      .all() as { name: string; package: string; id: number }[];
    expect(rows.map((row) => [row.name, row.package])).toEqual([
      ['ContosoLoyaltyTable', 'ContosoExt'],
      ['SampleOverlayTable', 'ContosoExt'],
      ['SampleStandardTable', 'ApplicationSuite'],
    ]);
    expect(rows.find((row) => row.package === 'ContosoExt')!.id).toBeGreaterThan(CUSTOM_ID_OFFSET);
    expect(rows.find((row) => row.package === 'ApplicationSuite')!.id).toBeLessThan(CUSTOM_ID_OFFSET);
  });

  it('joins child rows to their own layer, and an overlayered object hides the standard rows', () => {
    expect(fieldsOf('SampleStandardTable')).toEqual(['AccountNum', 'Name']);
    expect(fieldsOf('ContosoLoyaltyTable')).toEqual(['Points']);
    expect(fieldsOf('SampleOverlayTable')).toEqual(['CustomField']);
  });

  it('answers a forwarded security tool across both layers', async () => {
    const tools = captureLocalTools(layered.db, localIndex, workspace(customDir));
    const result = await tools.call('find_security_path', { objectType: 'Form', objectName: 'SampleForm' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).roles).toEqual(['ContosoClerkRole', 'SampleAuditorRole']);
  });

  it('sees custom changes after the custom index refreshes', async () => {
    stage(customDir, 'ContosoExt', [['AxTable', 'ContosoLateTable', table('ContosoLateTable', ['Late'])]]);
    localIndex.markDirty();
    await localIndex.ensureFresh();
    expect(fieldsOf('ContosoLateTable')).toEqual(['Late']);
  });

  it('never writes to the standard index', () => {
    expect(() => layered.db.exec(`INSERT INTO std.ax_meta (key, value, updated_at) VALUES ('x', 'y', 'z')`)).toThrow(/readonly/);
    expect(() => layered.db.exec(`DELETE FROM ax_objects`)).toThrow();
    expect(sha256(standardDb)).toBe(standardHash);
  });

  it('reports the standard index by file name only', () => {
    expect(layered.status()).toMatchObject({ fileName: 'standard.db', objects: 6, schemaVersion: expect.any(String) });
    expect(JSON.stringify(layered.status())).not.toContain(root);
  });
});

describe('openLayeredIndex', () => {
  it('lays every table it names', () => {
    expect(LAYERED_TABLES).toEqual(
      expect.arrayContaining(['ax_objects', 'ax_fields', 'ax_methods', 'ax_labels', 'ax_xref', 'ax_security_grants'])
    );
  });

  it('refuses a file that is not an index', () => {
    const notAnIndex = path.join(root, 'empty.db');
    fs.writeFileSync(notAnIndex, '');
    expect(() => openLayeredIndex(notAnIndex, 'file:nothing?mode=memory&cache=shared')).toThrow(/no ax_objects table/);
  });
});

describe('router with a standard index', () => {
  let customDir: string;
  let localIndex: LocalIndex;
  let layered: LayeredIndex;
  let ctx: RouteContext;
  let upstream: UpstreamPort & { callTool: Mock<UpstreamPort['callTool']> };

  beforeAll(async () => {
    customDir = fs.mkdtempSync(path.join(root, 'router-'));
    stage(customDir, 'ContosoExt', [['AxSecurityRole', 'ContosoClerkRole', role('ContosoClerkRole', ['SampleMaintainDuty'])]]);
    localIndex = await openLocalIndex({ customDir, dbPath: ':memory:', ttlMs: 60_000, debounceMs: 0 });
    layered = openLayeredIndex(standardDb, localIndex.attachUri);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    layered.close();
    localIndex.close();
  });

  const setup = (skewed: string[] = []) => {
    upstream = {
      isAvailable: () => true,
      listTools: async () => [],
      callTool: vi.fn<UpstreamPort['callTool']>(async () => ({ content: [{ type: 'text', text: '{"hosted":true}' }] })),
      serverVersion: '1.0.0',
    };
    ctx = {
      local: captureLocalTools(localIndex.db, localIndex, workspace(customDir)),
      localIndex,
      upstream,
      hostedTools: new Map(),
      privatePrefixes: [],
      skewedTools: new Set(skewed),
      layered: captureLocalTools(layered.db, localIndex, workspace(customDir)),
    };
  };

  it('runs a forwarded tool locally and sends nothing upstream', async () => {
    setup();
    const result = await executeToolCall('diff_roles', { roleA: 'ContosoClerkRole', roleB: 'SampleAuditorRole' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).duties.shared.items).toEqual(['SampleMaintainDuty']);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments with the local schema', async () => {
    setup();
    const result = await executeToolCall('diff_roles', { roleA: 'ContosoClerkRole' }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Input validation error: Invalid arguments for tool diff_roles/);
    expect(upstream.callTool).not.toHaveBeenCalled();
  });

  it('forwards a tool whose hosted schema differs, and the hosted index tools', async () => {
    setup(['diff_roles']);
    await executeToolCall('diff_roles', { roleA: 'A', roleB: 'B' }, ctx);
    await executeToolCall('get_index_stats', {}, ctx);
    expect(upstream.callTool.mock.calls.map(([name]) => name)).toEqual(['diff_roles', 'get_index_stats']);
  });

  it('lists the forwarded tools it can run, without the hosted index tools', () => {
    setup();
    const names = layerableToolNames(ctx.layered!);
    expect(names).toEqual(expect.arrayContaining(['find_security_path', 'analyze_sod_conflicts', 'diff_roles', 'get_bp_findings']));
    expect(names).not.toContain('get_index_stats');
    expect(names).not.toContain('search_symbols');
  });
});
