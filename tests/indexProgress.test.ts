import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexProgress } from '../src/indexer/buildIndex.js';
import { runIndexPass } from '../src/cli/index-command.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let root: string;
let packagesDir: string;

/** A tiny PackagesLocalDirectory: three objects and one label file. */
function stagePackages(directory: string): void {
  const layout: [string, string, string][] = [
    ['AxTable', 'AxTableSample.xml', 'SampleTable'],
    ['AxClass', 'AxClassSample.xml', 'SampleClass'],
    ['AxEnum', 'AxEnumSample.xml', 'SampleEnum'],
  ];
  for (const [typeDir, fixture, name] of layout) {
    const dir = path.join(directory, 'TestPackage', 'TestModel', typeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(fixturesDir, fixture), path.join(dir, `${name}.xml`));
  }
  const labelDir = path.join(directory, 'TestPackage', 'TestModel', 'AxLabelFile', 'LabelResources', 'en-US');
  fs.mkdirSync(labelDir, { recursive: true });
  fs.writeFileSync(path.join(labelDir, 'SampleLabels.en-US.label.txt'), 'Account=Account\nAmount=Amount\n');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-index-progress-cli-'));
  packagesDir = path.join(root, 'PackagesLocalDirectory');
  stagePackages(packagesDir);
  // runIndexPass prints nothing itself; anything a dependency logs stays out of the test output.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runIndexPass progress', () => {
  it('passes the callback to the scan', async () => {
    const calls: IndexProgress[] = [];

    const { stats } = await runIndexPass(packagesDir, ':memory:', true, (progress) => calls.push({ ...progress }));

    expect(calls[0]).toEqual({ files: 0, done: false });
    expect(calls[calls.length - 1]).toEqual({ files: stats.total, done: true });
  });

  it('writes nothing to stdout, which prepare-bundle needs for its one JSON line', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runIndexPass(packagesDir, ':memory:', true);

    expect(write).not.toHaveBeenCalled();
  });
});
