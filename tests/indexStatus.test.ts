import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { getMeta, META_KEYS, openDb } from '../src/indexer/db.js';
import { checkIndexStatus, servedIndexFromInfo, type ServedIndex } from '../src/indexer/indexStatus.js';
import { indexStatusCommand } from '../src/cli/index-status-command.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, 'fixtures');

let root: string;
let packagesDir: string;
let dbPath: string;
let builtAt: string;

function place(model: string, typeDir: string, fixture: string, name: string): string {
  const dir = path.join(packagesDir, 'TestPackage', model, typeDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.xml`);
  fs.copyFileSync(path.join(fixturesDir, fixture), file);
  return file;
}

/** Moves a file's modification time forward so it reads as edited after the index was built. */
function touchLater(file: string, seconds = 60): void {
  const later = new Date(Date.now() + seconds * 1000);
  fs.utimesSync(file, later, later);
}

function served(overrides: Partial<ServedIndex> = {}): ServedIndex {
  return { builtAt, version: 'v1', source: 'upload', objects: 3, xrefImportedAt: null, ...overrides };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(testDir, '.tmp-status-'));
  packagesDir = path.join(root, 'PackagesLocalDirectory');
  place('ModelA', 'AxTable', 'AxTableSample.xml', 'SampleTable');
  place('ModelA', 'AxClass', 'AxClassSample.xml', 'SampleClass');
  place('ModelB', 'AxEnum', 'AxEnumSample.xml', 'SampleEnum');
  const labelDir = path.join(packagesDir, 'TestPackage', 'ModelB', 'AxLabelFile');
  fs.mkdirSync(labelDir, { recursive: true });
  fs.writeFileSync(path.join(labelDir, 'SampleLabels_en-US.label.txt'), 'SYS1=Account\n');
  dbPath = path.join(root, 'index.db');
  const db = openDb(dbPath);
  try {
    await buildIndex(db, packagesDir, true);
    builtAt = getMeta(db, META_KEYS.builtAt)!;
  } finally {
    db.close();
  }
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkIndexStatus', () => {
  it('reports an unchanged folder as up to date against the local index', async () => {
    const status = await checkIndexStatus({ packagesDir, dbPath, server: served() });
    expect(status.basis).toBe('local-index');
    expect(status.upToDate).toBe(true);
    expect(status.reasons).toEqual([]);
    expect(status.scannedFiles).toBe(4);
    expect({ added: status.added, changed: status.changed, removed: status.removed }).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(status.local?.builtAt).toBe(builtAt);
  });

  it('finds added, changed and removed files per model', async () => {
    touchLater(path.join(packagesDir, 'TestPackage', 'ModelA', 'AxClass', 'SampleClass.xml'));
    place('ModelA', 'AxEdt', 'AxEdtSample.xml', 'SampleEdt');
    fs.rmSync(path.join(packagesDir, 'TestPackage', 'ModelB', 'AxEnum', 'SampleEnum.xml'));
    touchLater(path.join(packagesDir, 'TestPackage', 'ModelB', 'AxLabelFile', 'SampleLabels_en-US.label.txt'));

    const status = await checkIndexStatus({ packagesDir, dbPath, server: served() });
    expect(status.upToDate).toBe(false);
    expect({ added: status.added, changed: status.changed, removed: status.removed }).toEqual({ added: 1, changed: 2, removed: 1 });
    expect(status.models).toEqual([
      { model: 'ModelA', files: 2 },
      { model: 'ModelB', files: 2 },
    ]);
    expect(status.files.map((file) => `${file.kind} ${path.basename(file.path)}`).sort()).toEqual([
      'added SampleEdt.xml',
      'changed SampleClass.xml',
      'changed SampleLabels_en-US.label.txt',
      'removed SampleEnum.xml',
    ]);
    expect(status.reasons[0]).toContain('4 file(s) in 2 model(s)');
  });

  it('ignores a second file that loses a name collision, as the indexer does', async () => {
    place('ModelC', 'AxClass', 'AxClassSample.xml', 'SampleClass');
    const status = await checkIndexStatus({ packagesDir, dbPath, server: served() });
    expect(status.added).toBe(0);
    expect(status.upToDate).toBe(true);
  });

  it('asks for an upload when the local index is newer than the served one', async () => {
    const older = new Date(Date.parse(builtAt) - 86_400_000).toISOString();
    const status = await checkIndexStatus({ packagesDir, dbPath, server: served({ builtAt: older }) });
    expect(status.basis).toBe('local-index');
    expect(status.localNewerThanServer).toBe(true);
    expect(status.upToDate).toBe(false);
    expect(status.reasons).toEqual(['The local index is newer than the one the server serves and has not been uploaded.']);
  });

  it('falls back to the server build time without a usable local index', async () => {
    const serverBuilt = new Date(Date.now() - 3_600_000).toISOString();
    const hourAgo = new Date(Date.now() - 7_200_000);
    for (const file of ['AxTable/SampleTable.xml', 'AxClass/SampleClass.xml']) {
      fs.utimesSync(path.join(packagesDir, 'TestPackage', 'ModelA', file), hourAgo, hourAgo);
    }
    fs.utimesSync(path.join(packagesDir, 'TestPackage', 'ModelB', 'AxEnum', 'SampleEnum.xml'), hourAgo, hourAgo);
    fs.utimesSync(path.join(packagesDir, 'TestPackage', 'ModelB', 'AxLabelFile', 'SampleLabels_en-US.label.txt'), hourAgo, hourAgo);
    touchLater(path.join(packagesDir, 'TestPackage', 'ModelA', 'AxClass', 'SampleClass.xml'), 0);

    const status = await checkIndexStatus({ packagesDir, dbPath: path.join(root, 'missing.db'), server: served({ builtAt: serverBuilt }) });
    expect(status.basis).toBe('timestamp');
    expect(status.local).toBeNull();
    expect(status.changed).toBe(1);
    expect(status.removed).toBeNull();
    expect(status.models).toEqual([{ model: 'ModelA', files: 1 }]);
    expect(status.upToDate).toBe(false);
  });

  it('uses the server build time when someone else uploaded a newer index', async () => {
    const newer = new Date(Date.now() + 3_600_000).toISOString();
    const status = await checkIndexStatus({ packagesDir, dbPath, server: served({ builtAt: newer }) });
    expect(status.basis).toBe('timestamp');
    expect(status.upToDate).toBe(true);
  });

  it('refuses to guess with nothing to compare with', async () => {
    await expect(checkIndexStatus({ packagesDir, dbPath: path.join(root, 'missing.db'), server: null })).rejects.toThrow(/no local index and no server/);
    await expect(checkIndexStatus({ packagesDir, dbPath: path.join(root, 'missing.db'), server: served({ builtAt: null }) })).rejects.toThrow(
      /did not report when its index was built/
    );
  });

  it('reads the served index from GET /admin/index', () => {
    expect(
      servedIndexFromInfo({
        index: { builtAt: '2026-09-01T00:00:00.000Z', version: 'v9', source: 'manifest', objects: 12, usageSnapshot: { status: 'imported', importedAt: '2026-09-02T00:00:00.000Z' } },
      })
    ).toEqual({ builtAt: '2026-09-01T00:00:00.000Z', version: 'v9', source: 'manifest', objects: 12, xrefImportedAt: '2026-09-02T00:00:00.000Z' });
    expect(servedIndexFromInfo({})).toEqual({ builtAt: null, version: null, source: null, objects: null, xrefImportedAt: null });
  });
});

describe('index-status command', () => {
  function captureStdout(): { lines: () => string[]; restore: () => void } {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    return { lines: () => chunks.join('').split('\n').filter(Boolean), restore: () => spy.mockRestore() };
  }

  it('asks the server with the API key and prints one JSON object', async () => {
    const requests: { url: string; key: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requests.push({ url, key: new Headers(init?.headers).get('x-api-key') });
      return new Response(JSON.stringify({ index: { builtAt, source: 'upload', objects: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const out = captureStdout();
    let code: number;
    try {
      code = await indexStatusCommand(
        { packagesDir, dbPath, server: 'https://mcp.example.com/', json: true, fetchImpl },
        { D365_MCP_API_KEY: 'secret-key' }
      );
    } finally {
      out.restore();
    }
    expect(code).toBe(0);
    expect(requests).toEqual([{ url: 'https://mcp.example.com/admin/index', key: 'secret-key' }]);
    const lines = out.lines();
    expect(lines).toHaveLength(1);
    const status = JSON.parse(lines[0]);
    expect(status.upToDate).toBe(true);
    expect(status.server.builtAt).toBe(builtAt);
  });

  it('reports errors as JSON and never sends a request without a key', async () => {
    const out = captureStdout();
    let code: number;
    try {
      code = await indexStatusCommand({ packagesDir, dbPath, server: 'https://mcp.example.com', json: true }, {});
    } finally {
      out.restore();
    }
    expect(code).toBe(1);
    expect(JSON.parse(out.lines()[0]).error).toMatch(/D365_MCP_API_KEY/);
  });
});
