import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob, globIterate } from 'glob';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCustomMetadataDir, checkPackagesDir, firstProblem, type CheckResult } from '../src/cli/checks.js';

// The real glob, wrapped so a test can see whether the packages check walked the tree with it.
vi.mock('glob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('glob')>();
  return { ...actual, glob: vi.fn(actual.glob), globIterate: vi.fn(actual.globIterate) };
});

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testDir, 'fixtures');

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd365-checks-')));
  vi.mocked(glob).mockClear();
  vi.mocked(globIterate).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Puts one fixture XML file at `<base>/<pkg>/<model>/<typeDir>/<name>.xml` and returns its path. */
function stageObject(
  base: string,
  options: { pkg?: string; model?: string; typeDir?: string; fixture?: string; name?: string } = {}
): string {
  const { pkg = 'Package', model = 'Model', typeDir = 'AxTable', fixture = 'AxTableSample.xml', name = 'X' } = options;
  const dir = path.join(base, pkg, model, typeDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.xml`);
  fs.copyFileSync(path.join(fixturesDir, fixture), file);
  return file;
}

const byName = (results: CheckResult[], name: string): CheckResult | undefined =>
  results.find((result) => result.name === name);

describe('checkPackagesDir', () => {
  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '   '],
  ])('fails packages-dir for %s', async (_label, value) => {
    const results = await checkPackagesDir(value);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'packages-dir', status: 'fail' });
  });

  it('fails packages-dir for a path that does not exist', async () => {
    const results = await checkPackagesDir(path.join(root, 'missing'));
    expect(results).toEqual([expect.objectContaining({ name: 'packages-dir', status: 'fail' })]);
    expect(results[0].message).toContain('does not exist or is not a directory');
  });

  it('fails packages-dir for a file', async () => {
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'not a folder');
    const results = await checkPackagesDir(file);
    expect(results).toEqual([expect.objectContaining({ name: 'packages-dir', status: 'fail' })]);
  });

  it('fails packages-dir for a path still wrapped in quotes', async () => {
    const results = await checkPackagesDir(`"${root}"`);
    expect(results).toEqual([expect.objectContaining({ name: 'packages-dir', status: 'fail' })]);
  });

  it('passes packages-dir and fails metadata-files for an empty folder', async () => {
    const results = await checkPackagesDir(root);
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['packages-dir', 'pass'],
      ['metadata-files', 'fail'],
    ]);
    expect(results[1].message).toContain('Point D365_PACKAGES_DIR at PackagesLocalDirectory');
  });

  it('passes every check for Package/Model/AxTable/X.xml', async () => {
    stageObject(root);
    const results = await checkPackagesDir(root);
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['packages-dir', 'pass'],
      ['metadata-files', 'pass'],
      ['sample-parse', 'pass'],
    ]);
  });

  it.each(['[x]', '{a,b}'])('treats glob characters in the folder name (%s) literally', async (folderName) => {
    const packages = path.join(root, folderName);
    stageObject(packages);
    const results = await checkPackagesDir(packages);
    expect(results.map((result) => [result.name, result.status])).toEqual([
      ['packages-dir', 'pass'],
      ['metadata-files', 'pass'],
      ['sample-parse', 'pass'],
    ]);
  });

  it('treats glob characters in the folder name literally on the fallback walk too', async () => {
    const packages = path.join(root, '[x]');
    stageObject(packages, { pkg: 'deep', model: path.join('a', 'b') });
    const results = await checkPackagesDir(packages);
    expect(byName(results, 'metadata-files')).toMatchObject({ status: 'pass' });
  });

  describe('metadata probe', () => {
    it('finds the sample at the fixed depth without walking the tree with glob', async () => {
      stageObject(root);
      const results = await checkPackagesDir(root);
      expect(byName(results, 'metadata-files')).toEqual({
        name: 'metadata-files',
        status: 'pass',
        message: `D365 metadata XML found (e.g. ${path.join('Package', 'Model', 'AxTable', 'X.xml')})`,
      });
      expect(byName(results, 'sample-parse')).toMatchObject({ status: 'pass', message: 'Parsed X.xml' });
      expect(glob).not.toHaveBeenCalled();
      expect(globIterate).not.toHaveBeenCalled();
    });

    it.each([
      ['AxTable', 'AxTableSample.xml'],
      ['AxClass', 'AxClassSample.xml'],
      ['AxEnum', 'AxEnumSample.xml'],
      ['AxForm', 'AxFormSample.xml'],
      ['AxQuery', 'AxQuerySample.xml'],
      ['AxDataEntityView', 'AxDataEntityViewSample.xml'],
      ['AxEdt', 'AxEdtSample.xml'],
    ])('recognises %s at the fixed depth', async (typeDir, fixture) => {
      stageObject(root, { typeDir, fixture, name: 'Sample' });
      const results = await checkPackagesDir(root);
      expect(byName(results, 'metadata-files')).toMatchObject({ status: 'pass' });
      expect(byName(results, 'sample-parse')).toMatchObject({ status: 'pass' });
      expect(glob).not.toHaveBeenCalled();
      expect(globIterate).not.toHaveBeenCalled();
    });

    it('falls back to a first-hit walk for a layout the probe does not see', async () => {
      stageObject(root, { pkg: 'deep', model: path.join('a', 'b'), typeDir: 'AxClass', fixture: 'AxClassSample.xml', name: 'Y' });
      const results = await checkPackagesDir(root);
      expect(results.map((result) => [result.name, result.status])).toEqual([
        ['packages-dir', 'pass'],
        ['metadata-files', 'pass'],
        ['sample-parse', 'pass'],
      ]);
      expect(byName(results, 'metadata-files')?.message).toBe(
        `D365 metadata XML found (e.g. ${path.join('deep', 'a', 'b', 'AxClass', 'Y.xml')})`
      );
      expect(globIterate).toHaveBeenCalledTimes(1);
      // The fallback stops at its first hit; it does not collect every match.
      expect(glob).not.toHaveBeenCalled();
    });

    it('finds metadata when the chosen folder is a single model', async () => {
      stageObject(root, { pkg: '.', model: '.' });
      const results = await checkPackagesDir(root);
      expect(byName(results, 'metadata-files')).toMatchObject({ status: 'pass' });
      expect(byName(results, 'metadata-files')?.message).toContain(path.join('AxTable', 'X.xml'));
    });

    it('still fails when only folder types outside the seven checked ones exist', async () => {
      stageObject(root, { typeDir: 'AxSecurityRole', fixture: 'AxSecurityRoleSample.xml' });
      const results = await checkPackagesDir(root);
      expect(byName(results, 'metadata-files')).toMatchObject({ status: 'fail' });
      expect(byName(results, 'sample-parse')).toBeUndefined();
    });

    it('does not take a file that is not XML as metadata', async () => {
      const dir = path.join(root, 'Package', 'Model', 'AxTable');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'not metadata');
      fs.mkdirSync(path.join(root, 'Package', 'Model', 'AxLabelFile', 'LabelResources', 'en-US'), { recursive: true });
      fs.writeFileSync(path.join(root, 'Package', 'Model', 'AxLabelFile', 'LabelResources', 'en-US', 'X.en-US.label.txt'), 'A=B');
      const results = await checkPackagesDir(root);
      expect(byName(results, 'metadata-files')).toMatchObject({ status: 'fail' });
    });

    it('warns when the sample cannot be parsed', async () => {
      const file = stageObject(root);
      fs.writeFileSync(file, '<AxTable><Name>X</Name></Ax');
      const results = await checkPackagesDir(root);
      expect(byName(results, 'metadata-files')).toMatchObject({ status: 'pass' });
      expect(byName(results, 'sample-parse')).toMatchObject({ status: 'warn' });
      expect(byName(results, 'sample-parse')?.message).toContain('Sample metadata file could not be parsed');
    });

    it('picks the same sample on every run: the first in name order, never a label file', async () => {
      // Created out of order, so neither creation order nor directory order can explain the pick.
      stageObject(root, { pkg: 'ZPackage', name: 'Z' });
      stageObject(root, { pkg: 'APackage', model: 'BModel', name: 'B' });
      stageObject(root, { pkg: 'APackage', model: 'AModel', typeDir: 'AxTable', name: 'B' });
      stageObject(root, { pkg: 'APackage', model: 'AModel', typeDir: 'AxTable', name: 'A' });
      const labels = path.join(root, 'APackage', 'AModel', 'AxLabelFile', 'LabelResources', 'en-US');
      fs.mkdirSync(labels, { recursive: true });
      fs.writeFileSync(path.join(labels, 'A.en-US.label.txt'), 'Key=Value');

      const expected = `D365 metadata XML found (e.g. ${path.join('APackage', 'AModel', 'AxTable', 'A.xml')})`;
      for (let run = 0; run < 3; run++) {
        expect(byName(await checkPackagesDir(root), 'metadata-files')?.message).toBe(expected);
      }
    });
  });
});

describe('firstProblem', () => {
  const pass: CheckResult = { name: 'a', status: 'pass', message: 'fine' };
  const warn: CheckResult = { name: 'b', status: 'warn', message: 'careful' };
  const fail: CheckResult = { name: 'c', status: 'fail', message: 'broken' };
  const secondFail: CheckResult = { name: 'd', status: 'fail', message: 'also broken' };

  it('returns the message of the first failure and skips warnings before it', () => {
    expect(firstProblem([pass, warn, fail, secondFail])).toBe('broken');
  });

  it('returns null when nothing failed, whatever the warnings', () => {
    expect(firstProblem([pass, pass])).toBeNull();
    expect(firstProblem([pass, warn])).toBeNull();
    expect(firstProblem([])).toBeNull();
  });

  it('returns the first result that is not a pass when warnings are rejected', () => {
    expect(firstProblem([pass, warn, fail], { rejectWarnings: true })).toBe('careful');
    expect(firstProblem([pass, fail, warn], { rejectWarnings: true })).toBe('broken');
  });

  it('returns null when everything passed and warnings are rejected', () => {
    expect(firstProblem([pass, pass], { rejectWarnings: true })).toBeNull();
    expect(firstProblem([], { rejectWarnings: true })).toBeNull();
  });

  it('treats an explicit rejectWarnings: false like the default', () => {
    expect(firstProblem([warn], { rejectWarnings: false })).toBeNull();
    expect(firstProblem([warn, fail], { rejectWarnings: false })).toBe('broken');
  });
});

describe('checkCustomMetadataDir', () => {
  it('fails for a folder that does not exist', async () => {
    const result = await checkCustomMetadataDir(path.join(root, 'missing'));
    expect(result).toMatchObject({ name: 'gateway-custom-dir', status: 'fail' });
    expect(result.message).toContain('is not readable (ENOENT)');
  });

  it('warns for an empty readable folder', async () => {
    const result = await checkCustomMetadataDir(root);
    expect(result).toMatchObject({ name: 'gateway-custom-dir', status: 'warn' });
    expect(result.message).toContain('the local index would be empty');
  });

  it('passes for the Package/Model/AxTable layout and names the object it found', async () => {
    stageObject(root, { pkg: 'MyPackage', model: 'My Model', name: 'SampleTable' });
    const result = await checkCustomMetadataDir(root);
    expect(result).toMatchObject({ name: 'gateway-custom-dir', status: 'pass' });
    expect(result.message).toMatch(/found Table SampleTable in MyPackage\/My Model/);
  });
});
