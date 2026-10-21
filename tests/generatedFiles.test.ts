import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/indexer/db.js';
import { axClassFile, readGeneratedFiles, withGeneratedFiles, type GeneratedFile } from '../src/tools/generatedFiles.js';
import { addFileTargets, type FileTarget, type FileTargetOptions } from '../src/workspace/fileTargets.js';
import { parseXml } from '../src/workspace/xml.js';
import { collectGeneratorTools, seedDb, type ToolResult } from './helpers/toolHarness.js';
import { projectXml, workspaceFixture } from './workspaceFixtures.js';

let db: Database;
let tools: ReturnType<typeof collectGeneratorTools>;

beforeAll(() => {
  db = seedDb(
    [
      {
        type: 'Class',
        name: 'SalesLineType',
        methods: [{ name: 'insert', accessModifier: 'public', returnType: 'void', params: [] }],
      },
      {
        type: 'Table',
        name: 'CustTable',
        fields: [{ name: 'AccountNum', type: 'String', edt: 'CustAccount' }],
        methods: [{ name: 'insert', accessModifier: 'public', returnType: 'void', params: [] }],
      },
      { type: 'Edt', name: 'CustAccount', properties: { edtType: 'String' } },
    ],
    []
  );
  tools = collectGeneratorTools(db);
});

afterAll(() => db.close());

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return tools.get(name)!(args);
}

function filesOf(result: ToolResult): (GeneratedFile & { target?: FileTarget })[] {
  const found = readGeneratedFiles(result as Parameters<typeof readGeneratedFiles>[0]);
  if (!found) throw new Error('No generated files in the result.');
  return found.payload.generatedFiles as (GeneratedFile & { target?: FileTarget })[];
}

function wellFormed(xml: string): string {
  return parseXml(Buffer.from(xml), 'generated').root.name;
}

describe('generated files', () => {
  it('keeps the X++ listing as the text and adds an AxClass file with one entry per method', async () => {
    const result = await call('create_coc_extension', {
      targetClass: 'SalesLineType',
      extensionName: 'SalesLineType_Extension',
      methods: [{ name: 'insert' }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('final class SalesLineType_Extension');
    expect(result.content[0].text).toContain('next insert();');

    const [file] = filesOf(result);
    expect(file).toMatchObject({ aotType: 'AxClass', name: 'SalesLineType_Extension' });
    expect(wellFormed(file.content)).toBe('AxClass');
    expect(file.content).toContain('<Name>SalesLineType_Extension</Name>');
    expect(file.content).toContain('[ExtensionOf(classStr(SalesLineType))]');
    expect(file.content).toMatch(/<Method>\s*<Name>insert<\/Name>\s*<Source><!\[CDATA\[/);
    // Methods live in their own entries, not in the declaration.
    const declaration = /<Declaration><!\[CDATA\[([\s\S]*?)\]\]><\/Declaration>/.exec(file.content)![1];
    expect(declaration).not.toContain('next insert');
  });

  it('returns four class files for SysOperation and a table extension file named Table.Extension', async () => {
    const sysOp = filesOf(await call('create_sys_operation', { baseName: 'MyJob', description: 'Job' }));
    expect(sysOp.map((f) => f.name)).toEqual(['MyJobContract', 'MyJobService', 'MyJobController', 'MyJobUIBuilder']);
    sysOp.forEach((f) => expect(wellFormed(f.content)).toBe('AxClass'));

    const ext = await call('create_table_extension', {
      targetTable: 'CustTable',
      extensionName: 'MyExt',
      fields: [{ name: 'MyField', edt: 'CustAccount' }],
    });
    const [file] = filesOf(ext);
    expect(file).toMatchObject({ aotType: 'AxTableExtension', name: 'CustTable.MyExt' });
    expect(file.content).toBe(ext.content[0].text);
  });

  it('adds nothing to a failed result', async () => {
    const result = await call('generate_xpp_class', { className: 'X', extends: 'GhostBase' });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
  });

  it('keeps a literal ]]> in X++ inside CDATA', () => {
    const file = axClassFile({
      name: 'Tricky',
      declaration: ['/// <summary>', '/// a ]]> b', '/// </summary>', 'class Tricky'],
    });
    expect(wellFormed(file.content)).toBe('AxClass');
    expect(file.content).toContain('a ]]]]><![CDATA[> b');
  });

  it('rejects an AOT type that is not an Ax folder name', () => {
    expect(() =>
      withGeneratedFiles({ content: [{ type: 'text', text: 'x' }] }, [{ aotType: '../x', name: 'y', content: '' }])
    ).toThrow(/Invalid AOT type/);
  });
});

describe('file targets', () => {
  function options(fixture: ReturnType<typeof workspaceFixture>, extra: Partial<FileTargetOptions> = {}): FileTargetOptions {
    return {
      customMetadataDir: fixture.metadataDir,
      targetModel: 'My Model',
      targetPackage: '',
      writableModels: ['MyPackage/My Model'],
      workspaceDir: '',
      targetSolution: '',
      targetProject: '',
      ...extra,
    };
  }

  it('leaves results alone without a custom metadata folder (the hosted server)', async () => {
    const result = await call('generate_xpp_class', { className: 'MyClass' });
    const fixture = workspaceFixture();
    expect(addFileTargets(result as never, options(fixture, { customMetadataDir: '' }))).toBe(result);
  });

  it('gives each file its path, package, model and project item without writing anything', async () => {
    const fixture = workspaceFixture();
    const before = fs.readdirSync(fixture.modelDir);
    const result = addFileTargets(
      (await call('generate_xpp_class', { className: 'MyClass' })) as never,
      options(fixture, { workspaceDir: fixture.workspaceDir })
    );
    const [file] = filesOf(result as ToolResult);
    expect(file.target).toEqual({
      path: path.join(fixture.modelDir, 'AxClass', 'MyClass.xml'),
      package: 'MyPackage',
      model: 'My Model',
      projectItem: 'AxClass\\MyClass',
      project: fixture.project,
      exists: false,
      inProject: false,
      writable: true,
      issues: [],
    });
    expect(fs.readdirSync(fixture.modelDir)).toEqual(before);
  });

  it('reports an existing file, a project that already lists it and a model that is not writable', async () => {
    const fixture = workspaceFixture();
    fs.mkdirSync(path.join(fixture.modelDir, 'AxClass'));
    fs.writeFileSync(path.join(fixture.modelDir, 'AxClass', 'existingclass.xml'), '<AxClass />');
    fs.writeFileSync(fixture.project, projectXml());
    const result = addFileTargets(
      (await call('generate_xpp_class', { className: 'ExistingClass' })) as never,
      options(fixture, { workspaceDir: fixture.workspaceDir, writableModels: [] })
    );
    const [file] = filesOf(result as ToolResult);
    expect(file.target).toMatchObject({ exists: true, inProject: true, writable: false });
    expect(file.target!.issues.join(' ')).toMatch(/already exists/);
    expect(file.target!.issues.join(' ')).toMatch(/D365_WRITABLE_MODELS/);
  });

  it('explains why targets are unavailable instead of failing the call', async () => {
    const fixture = workspaceFixture();
    const result = addFileTargets(
      (await call('generate_xpp_class', { className: 'MyClass' })) as never,
      options(fixture, { targetModel: '' })
    );
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as { text: string }[]).at(-1)!.text);
    expect(payload.targets).toEqual({ available: false, reason: expect.stringMatching(/No target model/) });
    expect(payload.generatedFiles[0].target).toBeUndefined();
  });
});
