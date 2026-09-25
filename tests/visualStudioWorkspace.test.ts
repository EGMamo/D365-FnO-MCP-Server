import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverVisualStudioWorkspace, parseRnrProject, prepareElementInRnrProject, selectVisualStudioProject,
} from '../src/workspace/visualStudio.js';
import { decodeText, parseXml } from '../src/workspace/xml.js';
import { safeSegment } from '../src/workspace/safety.js';
import { projectXml, slnXml, treeSnapshot, workspaceFixture } from './workspaceFixtures.js';

let fixture: ReturnType<typeof workspaceFixture>;
beforeEach(() => { fixture = workspaceFixture(); });
afterEach(() => { fs.rmSync(fixture.root, { recursive: true, force: true }); });

describe('actual solution membership and project identity', () => {
  it('parses a genuine .sln and ignores nearby non-member projects', () => {
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Stray.rnrproj'), projectXml('Stray'));
    const workspace = discoverVisualStudioWorkspace(fixture.workspaceDir);
    expect(workspace.membershipSource).toBe('sln');
    expect(workspace.projects.map((project) => project.path)).toEqual([fixture.project]);
    expect(workspace.projects[0].items).toEqual([{ type: 'AxClass', name: 'ExistingClass' }]);
    expect(workspace.projects[0].model).toBe('My Model');
  });

  it('parses nested .slnx membership and ignores non-members and solution-folder files', () => {
    fs.unlinkSync(fixture.solution);
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Stray.rnrproj'), projectXml('Stray'));
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Workspace.slnx'),
      '<Solution><Folder Name="/Custom/"><File Path="readme.txt"/><Project Path="MyProject.rnrproj" /></Folder></Solution>');
    const workspace = discoverVisualStudioWorkspace(fixture.workspaceDir);
    expect(workspace.membershipSource).toBe('slnx');
    expect(workspace.projects.map((project) => project.name)).toEqual(['MyProject']);
  });

  it('does not fall back to globbing when a selected solution has no projects', () => {
    fs.writeFileSync(fixture.solution, slnXml([]));
    expect(discoverVisualStudioWorkspace(fixture.workspaceDir).projects).toEqual([]);
  });

  it('reports a no-solution fallback and requires a selection for multiple projects', () => {
    fs.unlinkSync(fixture.solution);
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Second.rnrproj'), projectXml('Second'));
    const workspace = discoverVisualStudioWorkspace(fixture.workspaceDir);
    expect(workspace.membershipSource).toBe('no-solution-project-scan');
    expect(selectVisualStudioProject(workspace, undefined, undefined)).toBeNull();
    expect(selectVisualStudioProject(workspace, 'Second.rnrproj', undefined)?.name).toBe('Second');
    expect(selectVisualStudioProject(workspace, fixture.project, undefined)?.name).toBe('MyProject');
    expect(selectVisualStudioProject(workspace, 'myproject', undefined)?.name).toBe('MyProject');
  });

  it('requires an explicit solution path when .sln and .slnx coexist', () => {
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Workspace.slnx'), '<Solution/>');
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Ambiguous solutions');
    expect(discoverVisualStudioWorkspace(fixture.workspaceDir, 'Workspace.slnx').projects).toHaveLength(0);
    expect(discoverVisualStudioWorkspace(fixture.workspaceDir, fixture.solution).projects).toHaveLength(1);
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir, 'Missing.sln')).toThrow('not found');
  });

  it('uses unique relative paths for solutions with duplicate basenames', () => {
    fs.mkdirSync(path.join(fixture.workspaceDir, 'nested'));
    fs.writeFileSync(path.join(fixture.workspaceDir, 'nested', 'Workspace.sln'), slnXml(['..\\MyProject.rnrproj']));
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Ambiguous');
    const workspace = discoverVisualStudioWorkspace(fixture.workspaceDir, 'nested/Workspace.sln');
    expect(workspace.projects[0].path).toBe(fixture.project);
  });

  it('rejects duplicate project display names instead of selecting the first', () => {
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Second.rnrproj'), projectXml('myproject'));
    fs.writeFileSync(fixture.solution, slnXml(['MyProject.rnrproj', 'Second.rnrproj']));
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Duplicate project display names');
  });

  it('rejects duplicate canonical project membership', () => {
    fs.writeFileSync(fixture.solution, slnXml(['MyProject.rnrproj', '.\\MyProject.rnrproj']));
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Duplicate project path identity');
  });

  it('rejects duplicate .sln display names even when the project XML names differ', () => {
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Second.rnrproj'), projectXml('Second'));
    fs.writeFileSync(fixture.solution, slnXml(['MyProject.rnrproj', 'Second.rnrproj']).replace('"Project1"', '"Project0"'));
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Duplicate project display names');
  });

  it.each(['sln', 'slnx'])('rejects out-of-root %s members', (format) => {
    const outside = path.join(fixture.root, 'Outside.rnrproj');
    fs.writeFileSync(outside, projectXml('Outside'));
    fs.unlinkSync(fixture.solution);
    fs.writeFileSync(path.join(fixture.workspaceDir, `Workspace.${format}`),
      format === 'sln' ? slnXml(['..\\Outside.rnrproj'])
        : '<Solution><Project Path="../Outside.rnrproj"/></Solution>');
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('escapes configured root');
  });

  it('ignores .sln virtual solution folders but rejects malformed declarations', () => {
    fs.writeFileSync(fixture.solution, slnXml(['MyProject.rnrproj']).replace('Global\n',
      'Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Folder", "Folder", "{AA434A71-2E5B-40D8-BD73-C21DCD1077DD}"\nEndProject\nGlobal\n'));
    expect(discoverVisualStudioWorkspace(fixture.workspaceDir).projects).toHaveLength(1);
    fs.appendFileSync(fixture.solution, 'Project("bad") = nope');
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Malformed .sln');
  });

  it('supports spaces, Unicode and glob metacharacters in workspace paths', () => {
    const renamed = path.join(fixture.root, 'workspace [custom] \u00e9');
    fs.renameSync(fixture.workspaceDir, renamed);
    expect(discoverVisualStudioWorkspace(renamed).projects).toHaveLength(1);
  });

  it.each([true, false])('rejects %s external/in-root linked project files', (outside) => {
    const linked = path.join(fixture.workspaceDir, 'Linked.rnrproj');
    const source = outside ? path.join(fixture.root, 'Outside.rnrproj') : fixture.project;
    if (outside) fs.writeFileSync(source, projectXml('Outside'));
    fs.symlinkSync(source, linked, 'file');
    fs.writeFileSync(fixture.solution, slnXml(['Linked.rnrproj']));
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Symlinks/junctions');
  });

  it('rejects directory symlinks or Windows junction members', () => {
    const linked = path.join(fixture.workspaceDir, 'linked');
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'Outside.rnrproj'), projectXml('Outside'));
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(fixture.solution, slnXml(['linked\\Outside.rnrproj']));
    expect(() => discoverVisualStudioWorkspace(fixture.workspaceDir)).toThrow('Symlinks/junctions');
  });
});

describe('structured, conservative project XML', () => {
  it.each([
    '<Project><PropertyGroup><Model>My Model</PropertyGroup></Project>',
    '<Project/><Project/>',
    '<!DOCTYPE Project [<!ENTITY model "My Model">]><Project><Model>&model;</Model></Project>',
    '<p:Project><p:PropertyGroup><p:Model>My Model</p:Model></p:PropertyGroup></p:Project>',
    '<Project><PropertyGroup><Model>&undeclared;</Model></PropertyGroup></Project>',
    '<Project><PropertyGroup><Model>&#0;</Model></PropertyGroup></Project>',
  ])('rejects malformed or unsafe XML %s', (xml) => {
    fs.writeFileSync(fixture.project, xml);
    expect(() => parseRnrProject(fixture.project)).toThrow();
  });

  it.each([
    '<PropertyGroup Condition="true"><Model>My Model</Model></PropertyGroup>',
    '<PropertyGroup><Model Condition="true">My Model</Model></PropertyGroup>',
    '<Choose><When Condition="true"><PropertyGroup><Model>My Model</Model></PropertyGroup></When></Choose>',
    '<PropertyGroup><Model>$(ImportedModel)</Model></PropertyGroup>',
    '<PropertyGroup><Model>My Model</Model><Model>Other</Model></PropertyGroup>',
    '<PropertyGroup><Model>My Model</Model><model>Other</model></PropertyGroup>',
    '<Import Project="untrusted.targets"/><PropertyGroup><Model>My Model</Model></PropertyGroup>',
    '<PropertyGroup><Model>My Model</Model></PropertyGroup><Import Project="untrusted.targets"/>',
    '<Sdk Name="Untrusted"/><PropertyGroup><Model>My Model</Model></PropertyGroup>',
    '<PropertyGroup><Name>Only a name</Name></PropertyGroup>',
  ])('refuses unevaluated models/imports without executing anything: %s', (xml) => {
    fs.writeFileSync(fixture.project, `<Project>${xml}</Project>`);
    const parsed = parseRnrProject(fixture.project);
    expect(parsed.inspection).toBe('unsupported');
    expect(() => prepareElementInRnrProject(parsed, 'AxTableExtension', 'CustTable.MyExt')).toThrow('Unsupported');
  });

  it('adds a new unconditional group without changing conditional groups or unrelated bytes', () => {
    const original = projectXml('MyProject', 'My Model',
      '<!-- </Project> must not affect insertion -->\n<ItemGroup Condition="false"><Content Include="AxClass\\Conditional"/></ItemGroup>') +
      '\n<!-- trailing </Project> comment -->';
    fs.writeFileSync(fixture.project, original);
    const before = treeSnapshot(fixture.root);
    const updated = prepareElementInRnrProject(parseRnrProject(fixture.project), 'AxTableExtension', 'CustTable.MyExt');
    expect(treeSnapshot(fixture.root)).toEqual(before);
    const text = updated.toString('utf8');
    const insertion = text.slice(original.indexOf('</Project>\n<!-- trailing'), text.indexOf('</Project>\n<!-- trailing'));
    expect(insertion).toContain('<ItemGroup>');
    expect(insertion).not.toContain('Condition');
    expect(text.replace(insertion, '')).toBe(original);
    const root = parseXml(updated, 'updated').root;
    expect(root.children.at(-1)?.name).toBe('ItemGroup');
    expect(root.children.at(-1)?.attributes.Condition).toBeUndefined();
  });

  it('does not duplicate existing forward-slash or conditioned content', () => {
    fs.writeFileSync(fixture.project, projectXml('MyProject', 'My Model',
      '<ItemGroup Condition="false"><Content Include="AxTableExtension/CustTable.MyExt" /></ItemGroup>'));
    expect(() => prepareElementInRnrProject(parseRnrProject(fixture.project), 'AxTableExtension', 'CustTable.MyExt'))
      .toThrow('already contains');
  });

  it.each(['utf8', 'utf16le', 'utf16be'] as const)('preserves namespace prefixes, comments, CRLF and %s BOM', (encoding) => {
    const declared = encoding === 'utf8' ? 'utf-8' : 'utf-16';
    const original = `<?xml version="1.0" encoding="${declared}"?>\r\n` +
      '<m:Project xmlns:m="http://schemas.microsoft.com/developer/msbuild/2003">\r\n' +
      '  <!-- untouched -->\r\n<m:PropertyGroup><m:Name>MyProject</m:Name><m:Model>My Model</m:Model></m:PropertyGroup>\r\n</m:Project>';
    const body = Buffer.from(original, encoding === 'utf8' ? 'utf8' : 'utf16le');
    const bom = encoding === 'utf8' ? [0xef, 0xbb, 0xbf] : encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff];
    if (encoding === 'utf16be') body.swap16();
    const bytes = Buffer.concat([Buffer.from(bom), body]);
    fs.writeFileSync(fixture.project, bytes);
    const updated = prepareElementInRnrProject(parseRnrProject(fixture.project), 'AxTableExtension', 'CustTable.MyExt');
    expect(updated.subarray(0, bom.length)).toEqual(Buffer.from(bom));
    expect(updated.subarray(0, bytes.length - Buffer.byteLength('</m:Project>', encoding === 'utf8' ? 'utf8' : 'utf16le')))
      .toEqual(bytes.subarray(0, bytes.length - Buffer.byteLength('</m:Project>', encoding === 'utf8' ? 'utf8' : 'utf16le')));
    const text = decodeText(updated).text;
    expect(text).toContain('<m:ItemGroup>\r\n');
    expect(text).not.toMatch(/(?<!\r)\n/);
    fs.writeFileSync(fixture.project, updated);
    expect(parseRnrProject(fixture.project).items).toContainEqual({ type: 'AxTableExtension', name: 'CustTable.MyExt' });
  });

  it('refuses mismatched declarations and BOM-less UTF16', () => {
    expect(() => parseXml(Buffer.from('<Project/>', 'utf16le'), 'test')).toThrow('encoding');
    expect(() => parseXml(Buffer.from('<?xml version="1.0" encoding="windows-1252"?><Project/>'), 'test')).toThrow('encoding');
  });

  it('separates model filename checks from X++ identifier rules', () => {
    expect(() => safeSegment('My Model \u00e9')).not.toThrow();
    for (const invalid of ['../Model', 'x\\y', 'x:y', 'CON', 'model.', 'model ', '$(Model)']) {
      expect(() => safeSegment(invalid)).toThrow();
    }
  });
});
