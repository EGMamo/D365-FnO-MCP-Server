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
});
