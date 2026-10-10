import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanPackagesDir } from '../src/indexer/scanner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('scanPackagesDir', () => {
  it('returns metadata and modification times collected during the glob walk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-scanner-'));
    roots.push(root);
    const table = path.join(root, 'ApplicationSuite', 'Foundation', 'AxTable', 'CustTable.xml');
    const label = path.join(
      root,
      'ApplicationPlatform',
      'Platform',
      'AxLabelFile',
      'LabelResources',
      'en-US',
      'SYS.en-US.label.txt'
    );
    fs.mkdirSync(path.dirname(table), { recursive: true });
    fs.mkdirSync(path.dirname(label), { recursive: true });
    fs.writeFileSync(table, '<AxTable/>');
    fs.writeFileSync(label, 'SYS1=Customer');
    const tableMtime = fs.statSync(table).mtimeMs;
    const labelMtime = fs.statSync(label).mtimeMs;

    const files = [];
    for await (const file of scanPackagesDir(root)) files.push(file);

    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'Table',
        name: 'CustTable',
        package: 'ApplicationSuite',
        model: 'Foundation',
        filePath: table,
        mtime: tableMtime,
      }),
      expect.objectContaining({
        type: 'Label',
        name: 'SYS.en-US',
        package: 'ApplicationPlatform',
        model: 'Platform',
        filePath: label,
        mtime: labelMtime,
      }),
    ]));
  });

  it('reads only the package/model/type depth, skipping build output folders', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-scanner-'));
    roots.push(root);
    const put = (...parts: string[]) => {
      const file = path.join(root, ...parts);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '<AxClass/>');
      return file;
    };
    const real = put('ApplicationSuite', 'Foundation', 'AxClass', 'Real.xml');
    put('ApplicationSuite', 'XppMetadata', 'Foundation', 'AxClass', 'Real.xml');
    put('ApplicationSuite', 'bin', 'Nested', 'AxClass', 'Compiled.xml');

    const files = [];
    for await (const file of scanPackagesDir(root)) files.push(file.filePath);

    expect(files).toEqual([real]);
  });

  it('searches the whole tree when pointed at a single package folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-scanner-'));
    roots.push(root);
    const file = path.join(root, 'ApplicationSuite', 'Foundation', 'AxClass', 'Real.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '<AxClass/>');

    const files = [];
    for await (const scanned of scanPackagesDir(path.join(root, 'ApplicationSuite'))) files.push(scanned);

    expect(files).toEqual([
      expect.objectContaining({ type: 'Class', name: 'Real', package: 'ApplicationSuite', model: 'Foundation', filePath: file }),
    ]);
  });
});
