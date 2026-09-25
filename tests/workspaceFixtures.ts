import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const msbuildNamespace = 'http://schemas.microsoft.com/developer/msbuild/2003';

export function projectXml(name = 'MyProject', model = 'My Model', extra = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="14.0" xmlns="${msbuildNamespace}">
  <PropertyGroup>
    <ProjectGuid>{AA434A71-2E5B-40D8-BD73-C21DCD1077DF}</ProjectGuid>
    <Name>${name}</Name>
    <Model>${model}</Model>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)' == 'Debug'"><OutputPath>bin\\Debug</OutputPath></PropertyGroup>
  <ItemGroup><Content Include="AxClass\\ExistingClass"><Name>ExistingClass</Name></Content></ItemGroup>
  ${extra}
</Project>`;
}

export function slnXml(members: string[]): string {
  return `Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.14.0.0
${members.map((member, index) => `Project("{FC65038C-1B2F-41E1-A81F-498D75F7D908}") = "Project${index}", "${member}", "{AA434A71-2E5B-40D8-BD73-C21DCD1077D${index}}"
EndProject`).join('\n')}
Global
EndGlobal
`;
}

export function descriptorXml(model = 'My Model', module = 'MyPackage', extra = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<AxModelInfo xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Customization>Allow</Customization>
  <Description>Synthetic custom-model fixture</Description>
  <DisplayName>${model}</DisplayName>
  <Id>4242</Id>
  <Layer>14</Layer>
  <Locked>false</Locked>
  <ModelModule>${module}</ModelModule>
  <ModelReferences xmlns:d2p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
    <d2p1:string>ApplicationPlatform</d2p1:string>
  </ModelReferences>
  <Name>${model}</Name>
  <Publisher>Fixture</Publisher>
  ${extra}
</AxModelInfo>`;
}

export function workspaceFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'd365-workspace-safety-')));
  const workspaceDir = path.join(root, 'workspace');
  const metadataDir = path.join(root, 'metadata');
  const modelDir = path.join(metadataDir, 'MyPackage', 'My Model');
  const descriptor = path.join(metadataDir, 'MyPackage', 'Descriptor', 'My Model.xml');
  const project = path.join(workspaceDir, 'MyProject.rnrproj');
  const solution = path.join(workspaceDir, 'Workspace.sln');
  fs.mkdirSync(workspaceDir);
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(path.dirname(descriptor), { recursive: true });
  fs.writeFileSync(project, projectXml());
  fs.writeFileSync(solution, slnXml(['MyProject.rnrproj']));
  fs.writeFileSync(descriptor, descriptorXml());
  return { root, workspaceDir, metadataDir, modelDir, descriptor, project, solution };
}

export function treeSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(file)}`;
      else if (entry.isDirectory()) {
        result[relative] = 'directory';
        visit(file);
      } else result[relative] = fs.readFileSync(file).toString('base64');
    }
  }
  visit(root);
  return result;
}
