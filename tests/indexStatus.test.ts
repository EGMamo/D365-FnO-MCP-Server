import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildIndex } from '../src/indexer/buildIndex.js';
import { getMeta, META_KEYS, openDb, setMeta } from '../src/indexer/db.js';
import { checkIndexStatus } from '../src/indexer/indexStatus.js';
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

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(testDir, '.tmp-status-'));
  packagesDir = path.join(root, 'PackagesLocalDirectory');
  place('ModelA', 'AxTable', 'AxTableSample.xml', 'SampleTable');
  place('ModelA', 'AxClass', 'AxClassSample.xml', 'SampleClass');
  place('ModelB', 'AxEnum', 'AxEnumSample.xml', 'SampleEnum');
  const labelDir = path.join(packagesDir, 'TestPackage', 'ModelB', 'AxLabelFile', 'LabelResources', 'en-US');
  fs.mkdirSync(labelDir, { recursive: true });
  fs.writeFileSync(path.join(labelDir, 'SampleLabels.en-US.label.txt'), '@SYS1=Account\n');
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
  it('reports a file whose modification time went back as changed', async () => {
    const file = path.join(packagesDir, 'TestPackage', 'ModelA', 'AxClass', 'SampleClass.xml');
    const earlier = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(file, earlier, earlier);
    const status = await checkIndexStatus({ packagesDir, dbPath });
    expect(status.changed).toBe(1);
  });

  it('reports a local index built by an older schema as out of date', async () => {
    const db = openDb(dbPath);
    try {
      setMeta(db, META_KEYS.schemaVersion, '2');
    } finally {
      db.close();
    }
    const status = await checkIndexStatus({ packagesDir, dbPath });
    expect(status.upToDate).toBe(false);
    expect(status.local?.schemaVersion).toBe(2);
    expect(status.reasons).toEqual([expect.stringContaining('built by an older version (schema 2')]);
  });

  it('attributes a removed label file to its model', async () => {
    fs.rmSync(path.join(packagesDir, 'TestPackage', 'ModelB', 'AxLabelFile', 'LabelResources', 'en-US', 'SampleLabels.en-US.label.txt'));
    const status = await checkIndexStatus({ packagesDir, dbPath });
    expect(status.removed).toBe(1);
    expect(status.models).toEqual([{ model: 'ModelB', files: 1 }]);
  });

  it('reports an unchanged folder as up to date against the local index', async () => {
    const status = await checkIndexStatus({ packagesDir, dbPath });
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
    touchLater(path.join(packagesDir, 'TestPackage', 'ModelB', 'AxLabelFile', 'LabelResources', 'en-US', 'SampleLabels.en-US.label.txt'));

    const status = await checkIndexStatus({ packagesDir, dbPath });
    expect(status.upToDate).toBe(false);
    expect({ added: status.added, changed: status.changed, removed: status.removed }).toEqual({ added: 1, changed: 2, removed: 1 });
    expect(status.models).toEqual([
      { model: 'ModelA', files: 2 },
      { model: 'ModelB', files: 2 },
    ]);
    expect(status.files.map((file) => `${file.kind} ${path.basename(file.path)}`).sort()).toEqual([
      'added SampleEdt.xml',
      'changed SampleClass.xml',
      'changed SampleLabels.en-US.label.txt',
      'removed SampleEnum.xml',
    ]);
    expect(status.reasons[0]).toContain('4 file(s) in 2 model(s)');
  });

  it('ignores a second file that loses a name collision, as the indexer does', async () => {
    place('ModelC', 'AxClass', 'AxClassSample.xml', 'SampleClass');
    const status = await checkIndexStatus({ packagesDir, dbPath });
    expect(status.added).toBe(0);
    expect(status.upToDate).toBe(true);
  });

  it('requires a local index', async () => {
    await expect(checkIndexStatus({ packagesDir, dbPath: path.join(root, 'missing.db') })).rejects.toThrow(/no local index/);
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

  it('prints one JSON object for the local index', async () => {
    const out = captureStdout();
    let code: number;
    try {
      code = await indexStatusCommand(
        { packagesDir, dbPath, json: true },
        {}
      );
    } finally {
      out.restore();
    }
    expect(code).toBe(0);
    const lines = out.lines();
    expect(lines).toHaveLength(1);
    const status = JSON.parse(lines[0]);
    expect(status.upToDate).toBe(true);
    expect(status.local.builtAt).toBe(builtAt);
  });

  it('reports a missing local index as JSON', async () => {
    const out = captureStdout();
    let code: number;
    try {
      code = await indexStatusCommand({ packagesDir, dbPath: path.join(root, 'missing.db'), json: true }, {});
    } finally {
      out.restore();
    }
    expect(code).toBe(1);
    expect(JSON.parse(out.lines()[0]).error).toMatch(/no local index/i);
  });
});
