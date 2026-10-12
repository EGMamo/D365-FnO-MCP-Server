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
  it.each(['proj [Main]', 'proj {a,b}', 'proj +(x)'])(
    'finds objects when the folder name contains glob syntax: %s',
    async (folderName) => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-scanner-'));
      roots.push(parent);
      const root = path.join(parent, folderName);
      const klass = path.join(root, 'PkgA', 'ModelA', 'AxClass', 'Foo.xml');
      fs.mkdirSync(path.dirname(klass), { recursive: true });
      fs.writeFileSync(klass, '<AxClass/>');

      const found: string[] = [];
      for await (const file of scanPackagesDir(root)) found.push(`${file.type}:${file.name}`);
      // Also the fallback depth, where the folder given is a single package.
      const inner: string[] = [];
      for await (const file of scanPackagesDir(path.join(root, 'PkgA'))) inner.push(`${file.type}:${file.name}`);

      expect(found).toEqual(['Class:Foo']);
      expect(inner).toEqual(['Class:Foo']);
    }
  );

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

  describe.skipIf(process.platform === 'win32')('confined to the scanned folder', () => {
    function tree() {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-scanner-'));
      roots.push(root);
      const outside = path.join(root, 'outside');
      const packages = path.join(root, 'packages');
      fs.mkdirSync(path.join(outside, 'classes'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.xml'), '<AxClass/>');
      fs.writeFileSync(path.join(outside, 'classes', 'Foreign.xml'), '<AxClass/>');
      const model = path.join(packages, 'Pkg', 'Model');
      fs.mkdirSync(path.join(model, 'AxClass'), { recursive: true });
      fs.writeFileSync(path.join(model, 'AxClass', 'Real.xml'), '<AxClass/>');
      return { packages, outside, model };
    }

    async function names(dir: string, confined: boolean): Promise<string[]> {
      const found = [];
      for await (const file of scanPackagesDir(dir, { confined })) found.push(`${file.type}:${file.name}`);
      return found.sort();
    }

    it('skips a file or a folder whose real path is elsewhere, and a link that leads nowhere', async () => {
      const { packages, outside, model } = tree();
      fs.symlinkSync(path.join(outside, 'secret.xml'), path.join(model, 'AxClass', 'Linked.xml'));
      fs.symlinkSync(path.join(outside, 'missing.xml'), path.join(model, 'AxClass', 'Dangling.xml'));
      fs.symlinkSync(path.join(outside, 'classes'), path.join(model, 'AxEnum'));

      expect(await names(packages, true)).toEqual(['Class:Real']);
      // The scan alone follows links, which is why the gateway asks for the confined one.
      expect(await names(packages, false)).toEqual(['Class:Dangling', 'Class:Linked', 'Class:Real', 'Enum:Foreign']);
    });

    it('keeps a link that stays inside the folder, whether the folder itself is reached through a link', async () => {
      const { packages, model } = tree();
      fs.symlinkSync(path.join(model, 'AxClass', 'Real.xml'), path.join(model, 'AxClass', 'Alias.xml'));
      const viaLink = path.join(path.dirname(packages), 'packages-link');
      fs.symlinkSync(packages, viaLink);

      expect(await names(packages, true)).toEqual(['Class:Alias', 'Class:Real']);
      expect(await names(viaLink, true)).toEqual(['Class:Alias', 'Class:Real']);
    });

    it('yields nothing for a folder that does not exist', async () => {
      expect(await names(path.join(os.tmpdir(), 'd365-scanner-missing-folder'), true)).toEqual([]);
    });
  });
});
