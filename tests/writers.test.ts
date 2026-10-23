import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../src/indexer/db.js';
import { registerWriterTools, type WriterOptions } from '../src/tools/writers.js';
import { parseRnrProject } from '../src/workspace/visualStudio.js';
import { literalText, parseXml } from '../src/workspace/xml.js';
import { fakeToolServer, seedDb, type ToolResult } from './helpers/toolHarness.js';
import { descriptorXml, projectXml, slnXml, treeSnapshot, workspaceFixture } from './workspaceFixtures.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
let db: Database;
let fixture: ReturnType<typeof workspaceFixture>;
let options: WriterOptions;

function tools(settings = options): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  registerWriterTools(fakeToolServer(handlers), db, settings);
  return handlers;
}

function payload(response: ToolResult) {
  return JSON.parse(response.content[0].text);
}

const goodArgs = {
  tableName: 'CustTable', extensionName: 'MyExt',
  fields: [{ name: 'MyNewField', edt: 'CustAccount' }],
};

async function preview(handlers: Map<string, Handler>, args: Record<string, unknown> = goodArgs) {
  return payload(await handlers.get('write_table_extension')!(args));
}

async function apply(handlers: Map<string, Handler>, changeId: string) {
  return payload(await handlers.get('apply_table_extension_change')!({ changeId, acknowledgeOfflineProject: true }));
}

beforeAll(() => {
  db = seedDb([
    { type: 'Table', name: 'CustTable', fields: [{ name: 'AccountNum', type: 'String', edt: 'CustAccount' }] },
    { type: 'Edt', name: 'CustAccount', properties: { edtType: 'String' } },
    { type: 'Class', name: 'ExistingObject' },
  ]);
});
beforeEach(() => {
  fixture = workspaceFixture();
  options = {
    enableWriteTools: true, projectDir: '', customMetadataDir: fixture.metadataDir,
    workspaceDir: fixture.workspaceDir, writableModels: ['MyPackage/My Model'],
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
afterAll(() => { db.close(); });

describe('staged table extension writes', () => {
  it('registers neither write tool when disabled', () => {
    expect(tools({ ...options, enableWriteTools: false }).size).toBe(0);
  });

  it('defaults to preview with no filesystem mutations, including no new type folder', async () => {
    const before = treeSnapshot(fixture.root);
    const response = await preview(tools());
    expect(response.state).toBe('preview');
    expect(response.written).toBe(false);
    expect(response.changeId).toBeTruthy();
    expect(response.target).toMatchObject({ package: 'MyPackage', model: 'My Model', projectPath: fixture.project });
    expect(response.target.path).toBe(path.join(fixture.modelDir, 'AxTableExtension', 'CustTable.MyExt.xml'));
    expect(response.metadataXml).toContain('<Name>CustTable.MyExt</Name>');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('requires explicit offline acknowledgement and applies exactly the previewed bytes once', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const before = treeSnapshot(fixture.root);
    const denied = payload(await handlers.get('apply_table_extension_change')!({
      changeId: prepared.changeId, acknowledgeOfflineProject: false,
    }));
    expect(denied.state).toBe('rejected');
    expect(treeSnapshot(fixture.root)).toEqual(before);
    const written = await apply(handlers, prepared.changeId);
    expect(written).toMatchObject({ state: 'applied', written: true, projectUpdated: true, recoveryRequired: false });
    const bytes = fs.readFileSync(written.path);
    expect(bytes.toString()).toBe(prepared.metadataXml);
    expect(literalText(parseXml(bytes, written.path).root.children.find((node) => node.name === 'Name')!)).toBe('CustTable.MyExt');
    expect(path.basename(written.path)).toBe('CustTable.MyExt.xml');
    expect(parseRnrProject(fixture.project).items).toContainEqual({ type: 'AxTableExtension', name: 'CustTable.MyExt' });
    expect(fs.existsSync(path.join(fixture.modelDir, '.d365-mcp-write.lock'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspaceDir, '.d365-mcp-write.lock'))).toBe(false);
    expect((await apply(handlers, prepared.changeId)).state).toBe('rejected');
  });

  it('supports the legacy D365_PROJECT_DIR alias with the same descriptor safety', async () => {
    const handlers = tools({ ...options, customMetadataDir: undefined, projectDir: fixture.metadataDir });
    const prepared = await preview(handlers);
    expect(prepared.state).toBe('preview');
    expect((await apply(handlers, prepared.changeId)).state).toBe('applied');
  });

  it('applies UTF16 project edits without altering original bytes, BOM or encoding', async () => {
    const original = projectXml().replace('encoding="utf-8"', 'encoding="utf-16"');
    fs.writeFileSync(fixture.project, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(original, 'utf16le')]));
    const handlers = tools();
    const prepared = await preview(handlers);
    expect((await apply(handlers, prepared.changeId)).state).toBe('applied');
    expect(fs.readFileSync(fixture.project).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(parseRnrProject(fixture.project).items).toContainEqual({ type: 'AxTableExtension', name: 'CustTable.MyExt' });
  });

  it('supports explicit existing metadata-only models without fabricating project membership', async () => {
    const handlers = tools({ ...options, workspaceDir: undefined, defaultModel: 'My Model' });
    const prepared = await preview(handlers);
    expect(prepared.target.membershipSource).toBe('metadata-only');
    expect((await apply(handlers, prepared.changeId)).projectUpdated).toBe(false);
    expect(parseRnrProject(fixture.project).items).toHaveLength(1);
  });

  it('supports no-solution fallback and explicit solution selection', async () => {
    fs.unlinkSync(fixture.solution);
    expect((await preview(tools())).target.membershipSource).toBe('no-solution-project-scan');
    fs.writeFileSync(fixture.solution, slnXml(['MyProject.rnrproj']));
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Other.slnx'), '<Solution/>');
    expect((await preview(tools())).state).toBe('rejected');
    expect((await preview(tools(), { ...goodArgs, solutionPath: 'Workspace.sln' })).state).toBe('preview');
    expect((await preview(tools({ ...options, defaultSolution: 'Workspace.sln' }))).state).toBe('preview');
  });

  it('rejects cross-session IDs and changed registration options', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    expect((await apply(tools(), prepared.changeId)).state).toBe('rejected');
    options.writableModels = ['Another/Model'];
    const response = await apply(handlers, prepared.changeId);
    expect(response.state).toBe('conflict');
    expect(response.error).toContain('options changed');
  });

  it('expires previews and bounds the number of retained changes', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
    expect((await apply(handlers, prepared.changeId)).state).toBe('expired');
    vi.restoreAllMocks();
    for (let index = 0; index < 8; index++) {
      expect((await preview(handlers, { ...goodArgs, extensionName: `Ext${index}` })).state).toBe('preview');
    }
    expect((await preview(handlers)).error).toContain('capacity exceeded');
  });

  it.each(['project', 'descriptor', 'solution'] as const)('rejects stale %s bytes without mutation', async (file) => {
    const handlers = tools();
    const prepared = await preview(handlers);
    fs.appendFileSync(fixture[file], file === 'solution' ? '\n# concurrent change\n' : '\n<!-- concurrent edit -->');
    const before = treeSnapshot(fixture.root);
    const response = await apply(handlers, prepared.changeId);
    expect(response.state).toBe('conflict');
    expect(response.error).toContain('Stale preview');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('rejects same-bytes replacement of a bound project', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const temporary = fixture.project + '.replacement';
    fs.writeFileSync(temporary, fs.readFileSync(fixture.project));
    fs.renameSync(temporary, fixture.project);
    expect((await apply(handlers, prepared.changeId)).state).toBe('conflict');
  });

  it('refuses existing metadata and files created between preview and apply, including case aliases', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    fs.mkdirSync(path.dirname(prepared.target.path));
    const alias = path.join(path.dirname(prepared.target.path), 'custtable.myext.XML');
    fs.writeFileSync(alias, 'other process');
    expect((await apply(handlers, prepared.changeId)).state).toBe('conflict');
    expect((await preview(handlers)).error).toContain('Refusing to overwrite');
    expect(fs.readFileSync(alias, 'utf8')).toBe('other process');
  });

  it.each([
    { packageName: '../../escape' },
    { modelName: '../Model' },
    { extensionName: '../Ext' },
    { tableName: '../Table' },
    { extensionName: 'ExistingObject' },
    { tableName: 'UnknownTable' },
    { fields: [{ name: 'MyNewField', edt: 'UnknownEdt' }] },
    { fields: [{ name: 'Field', edt: 'CustAccount' }, { name: 'field', edt: 'CustAccount' }] },
  ])('rejects unsafe or ungrounded input without writes: %j', async (args) => {
    const before = treeSnapshot(fixture.root);
    expect((await preview(tools(), { ...goodArgs, ...args })).state).toBe('rejected');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('rejects model/project mismatch and unavailable project targets', async () => {
    expect((await preview(tools(), { ...goodArgs, modelName: 'Wrong Model' })).error).toContain("belongs to model 'My Model'");
    expect((await preview(tools(), { ...goodArgs, projectName: 'Missing' })).error).toContain('no unambiguous target project');
    expect((await preview(tools({ ...options, workspaceDir: undefined, defaultProject: 'MyProject' }))).error)
      .toContain('requires D365_VISUAL_STUDIO_WORKSPACE_DIR');
  });
});

describe('descriptor authority and containment', () => {
  it.each([
    descriptorXml('Wrong Name'),
    descriptorXml('My Model', 'WrongPackage'),
    descriptorXml().replace('<Locked>false</Locked>', '<Locked>true</Locked>'),
    descriptorXml().replace('<Customization>Allow</Customization>', '<Customization>DoNotAllow</Customization>'),
    descriptorXml().replace('<Locked>false</Locked>', ''),
    descriptorXml().replace('<Name>My Model</Name>', '<Name>$(Model)</Name>'),
    '<AxModelInfo><Name>My Model</AxModelInfo>',
    '<AxModelInfo><Name>My Model</Name></AxModelInfo>',
  ])('rejects mismatched, read-only, unknown or malformed descriptors', async (descriptor) => {
    fs.writeFileSync(fixture.descriptor, descriptor);
    const before = treeSnapshot(fixture.root);
    expect((await preview(tools())).state).toBe('rejected');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('does not infer permission from writable directories, model names, layer or publisher', async () => {
    const response = await preview(tools({ ...options, writableModels: [] }));
    expect(response.error).toContain('D365_WRITABLE_MODELS');
    expect(fs.existsSync(path.join(fixture.modelDir, 'AxTableExtension'))).toBe(false);
  });

  it('fails ambiguous model identity across packages unless the package is explicit', async () => {
    const other = path.join(fixture.metadataDir, 'OtherPackage');
    fs.mkdirSync(path.join(other, 'My Model'), { recursive: true });
    fs.mkdirSync(path.join(other, 'Descriptor'));
    fs.writeFileSync(path.join(other, 'Descriptor', 'My Model.xml'), descriptorXml('My Model', 'OtherPackage'));
    expect((await preview(tools())).error).toContain('ambiguous descriptor');
    expect((await preview(tools(), { ...goodArgs, packageName: 'MyPackage' })).state).toBe('preview');
  });

  it('never creates a missing model, package or descriptor', async () => {
    fs.rmdirSync(fixture.modelDir);
    expect((await preview(tools())).state).toBe('rejected');
    expect(fs.existsSync(fixture.modelDir)).toBe(false);
    expect((await preview(tools(), { ...goodArgs, packageName: 'Phantom' })).state).toBe('rejected');
    expect(fs.existsSync(path.join(fixture.metadataDir, 'Phantom'))).toBe(false);
    fs.unlinkSync(fixture.descriptor);
    expect((await preview(tools())).state).toBe('rejected');
  });

  it('rejects a symlink/junction in the metadata destination and never writes outside the root', async () => {
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.modelDir, 'AxTableExtension'), process.platform === 'win32' ? 'junction' : 'dir');
    const response = await preview(tools());
    expect(response.error).toContain('Symlinks/junctions');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects symlinked descriptors and multi-link project files', async () => {
    const original = path.join(fixture.root, 'descriptor.xml');
    fs.renameSync(fixture.descriptor, original);
    fs.symlinkSync(original, fixture.descriptor, 'file');
    expect((await preview(tools())).state).toBe('rejected');
    fs.unlinkSync(fixture.descriptor);
    fs.renameSync(original, fixture.descriptor);
    fs.linkSync(fixture.project, path.join(fixture.root, 'project-hardlink'));
    expect((await preview(tools())).error).toContain('single-link');
  });

  it('rejects a destination junction introduced after preview', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.modelDir, 'AxTableExtension'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await apply(handlers, prepared.changeId)).state).toBe('conflict');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('rollback and fail-closed manual recovery', () => {
  it('rolls metadata and owned output directory back if project replacement fails', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const before = treeSnapshot(fixture.root);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('project locked'); });
    const response = await apply(handlers, prepared.changeId);
    expect(response).toMatchObject({ state: 'rolledBack', written: false, recoveryRequired: false });
    expect(response.error).toContain('project locked');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('retains backups and reports recoveryRequired when compensating deletion fails', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('project locked'); });
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (file === prepared.target.path) throw new Error('cleanup denied');
      unlink(file);
    });
    const response = await apply(handlers, prepared.changeId);
    expect(response.state).toBe('recoveryRequired');
    expect(response.cleanupErrors.join(' ')).toContain('cleanup denied');
    const journal = path.join(fixture.modelDir, '.d365-mcp-write.lock');
    expect(fs.readFileSync(path.join(journal, 'project.before'))).toEqual(fs.readFileSync(fixture.project));
    expect(fs.existsSync(path.join(journal, 'journal.json'))).toBe(true);
    expect((await preview(tools(), { ...goodArgs, extensionName: 'Another' })).state).toBe('rejected');
  });

  it('never deletes metadata replaced by another process during failed project commit', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      fs.unlinkSync(prepared.target.path);
      fs.writeFileSync(prepared.target.path, 'other process data');
      throw new Error('concurrent replacement');
    });
    const response = await apply(handlers, prepared.changeId);
    expect(response.state).toBe('recoveryRequired');
    expect(fs.readFileSync(prepared.target.path, 'utf8')).toBe('other process data');
  });

  it('never adopts foreign bytes as its rollback ownership immediately after writing metadata', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const open = fs.openSync.bind(fs);
    const write = fs.writeFileSync.bind(fs);
    let targetFd: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      const fd = open(file, flags, mode);
      if (file === prepared.target.path && flags === 'wx') targetFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      write(file, data, options);
      if (file === targetFd) {
        fs.unlinkSync(prepared.target.path);
        write(prepared.target.path, 'foreign replacement');
      }
    });
    const response = await apply(handlers, prepared.changeId);
    expect(response).toMatchObject({ state: 'recoveryRequired', written: null, projectUpdated: false });
    expect(fs.readFileSync(prepared.target.path, 'utf8')).toBe('foreign replacement');
  });

  it('does not erase concurrent project edits on rollback', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      fs.appendFileSync(fixture.project, '\n<!-- other editor -->');
      throw new Error('concurrent project edit');
    });
    const response = await apply(handlers, prepared.changeId);
    expect(response.state).toBe('recoveryRequired');
    expect(fs.readFileSync(fixture.project, 'utf8')).toContain('other editor');
    expect(fs.existsSync(prepared.target.path)).toBe(true);
  });

  it('does not steal or clean another process lock or its files', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const lock = path.join(fixture.workspaceDir, '.d365-mcp-write.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'other-data'), 'owned by another process');
    const before = treeSnapshot(fixture.root);
    expect((await apply(handlers, prepared.changeId)).state).toBe('conflict');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('reports committed changes honestly when final lock cleanup fails', async () => {
    const handlers = tools();
    const prepared = await preview(handlers);
    const rmdir = fs.rmdirSync.bind(fs);
    vi.spyOn(fs, 'rmdirSync').mockImplementation((directory) => {
      if (String(directory).endsWith('.d365-mcp-write.lock')) throw new Error('lock cleanup denied');
      rmdir(directory);
    });
    const response = await apply(handlers, prepared.changeId);
    expect(response).toMatchObject({ state: 'recoveryRequired', written: true, projectUpdated: true });
    expect(response.error).toContain('Changes applied');
  });

  it('rejects imported or conditional project Models even when the intended value looks literal', async () => {
    fs.writeFileSync(fixture.project, projectXml('MyProject', 'My Model', '<Import Project="Untrusted.targets"/>'));
    expect((await preview(tools())).error).toContain('Unsupported project');
  });
});
