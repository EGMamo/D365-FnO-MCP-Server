import path from 'node:path';
import { globSync } from 'glob';
import { canonicalRoot, checkedPath, snapshot, type FileSnapshot } from './safety.js';
import { decodeText, descendants, literalText, parseXml, rootClosingOffset, xmlEscape } from './xml.js';

const MSBUILD_NAMESPACE = 'http://schemas.microsoft.com/developer/msbuild/2003';

export interface VisualStudioProject {
  name: string;
  model: string;
  path: string;
  items: { type: string; name: string; conditional?: boolean }[];
  inspection: 'literal' | 'unsupported';
  issues: string[];
  snapshot: FileSnapshot;
}

export interface VisualStudioWorkspace {
  root: string;
  solutions: string[];
  selectedSolution: string | null;
  solutionSnapshot: FileSnapshot | null;
  membershipSource: 'sln' | 'slnx' | 'no-solution-project-scan';
  projects: VisualStudioProject[];
}

export function parseRnrProject(projectPath: string, root = path.dirname(projectPath)): VisualStudioProject {
  const source = snapshot(canonicalRoot(root), projectPath);
  const document = parseXml(source.bytes, projectPath);
  const project = document.root;
  if (project.name !== 'Project' || !['', MSBUILD_NAMESPACE].includes(project.namespace)) {
    throw new Error(`Unsupported .rnrproj root/namespace: ${projectPath}`);
  }
  const issues: string[] = [];
  const nodes = descendants(project);
  if (nodes.some((node) => node.namespace !== project.namespace)) {
    issues.push('Mixed project element namespaces are unsupported.');
  }
  if (nodes.some((node) => ['Import', 'ImportGroup', 'Sdk'].includes(node.name) || 'Sdk' in node.attributes)) {
    issues.push('Imported/SDK project evaluation is unavailable; imported Model overrides cannot be ruled out.');
  }
  const property = (name: string, required: boolean): string => {
    const matches = nodes.filter((node) => node.name.toLowerCase() === name.toLowerCase() &&
      (name === 'Model' || project.children.some((group) =>
        group.name === 'PropertyGroup' && group.children.includes(node))));
    if (!matches.length && !required) return '';
    if (matches.length !== 1) {
      issues.push(`Expected exactly one literal ${name} property.`);
      return '';
    }
    const node = matches[0];
    const group = project.children.find((candidate) =>
      candidate.name === 'PropertyGroup' && candidate.children.includes(node));
    if (!group || 'Condition' in group.attributes || 'Condition' in project.attributes) {
      issues.push(`Conditional/nested ${name} is unsupported.`);
      return '';
    }
    try {
      return literalText(node);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      return '';
    }
  };
  const model = property('Model', true);
  const name = property('Name', false) || path.basename(projectPath, path.extname(projectPath));
  const items: VisualStudioProject['items'] = [];
  for (const node of nodes.filter((candidate) => candidate.name === 'Content')) {
    const include = node.attributes.Include;
    if (!include || /[$@%]\(|[*?;]|%[0-9a-f]{2}/i.test(include) ||
        'Remove' in node.attributes || 'Update' in node.attributes || 'Exclude' in node.attributes) {
      issues.push('Dynamic Content items cannot be safely inspected.');
      continue;
    }
    const parts = include.replace(/\//g, '\\').split('\\');
    const group = project.children.find((candidate) =>
      candidate.name === 'ItemGroup' && candidate.children.includes(node));
    const names = node.children.filter((child) => child.name === 'Name');
    if (names.length > 1 || (names.length === 1 && literalText(names[0]) !== parts.slice(1).join('\\'))) {
      issues.push(`Content Include/Name mismatch: ${include}`);
    }
    if (parts.length === 2 && parts.every(Boolean)) {
      const conditional = !group || 'Condition' in group.attributes || 'Condition' in node.attributes;
      items.push({ type: parts[0], name: parts[1], ...(conditional ? { conditional: true } : {}) });
    }
  }
  return { name, model, path: source.path, items, inspection: issues.length ? 'unsupported' : 'literal', issues, snapshot: source };
}

function solutionMembers(source: FileSnapshot): string[] {
  if (path.extname(source.path).toLowerCase() === '.slnx') {
    const { root } = parseXml(source.bytes, source.path);
    if (root.name !== 'Solution' || root.namespace) throw new Error('Unsupported .slnx root.');
    const projects: string[] = [];
    const displayNames = new Set<string>();
    function visit(node: typeof root): void {
      for (const child of node.children) {
        if (child.name === 'Project') {
          const member = child.attributes.Path;
          if (!member || child.namespace || 'Condition' in child.attributes) {
            throw new Error('Unsupported .slnx project membership.');
          }
          if (/\.rnrproj$/i.test(member)) {
            const displayName = (child.attributes.DisplayName || path.win32.basename(member, path.extname(member))).toLowerCase();
            if (displayNames.has(displayName)) throw new Error('Duplicate project display names in solution.');
            displayNames.add(displayName);
          }
          projects.push(member);
        } else if (child.name === 'Folder' && !child.namespace) {
          visit(child);
        } else if (descendants(child).some((item) => item.name === 'Project')) {
          throw new Error('Unsupported nested .slnx Project.');
        }
      }
    }
    visit(root);
    return projects;
  }
  const text = decodeText(source.bytes).text;
  if (!/^\s*Microsoft Visual Studio Solution File, Format Version \d+\.\d+/m.test(text)) {
    throw new Error(`Malformed .sln header: ${source.path}`);
  }
  const members: string[] = [];
  const displayNames = new Set<string>();
  let inProject = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Project\s*\(/.test(line)) {
      const match = /^\s*Project\("(\{[\da-f-]+\})"\)\s*=\s*"([^"]+)",\s*"([^"]+)",\s*"(\{[\da-f-]+\})"\s*$/i.exec(line);
      if (!match || inProject) throw new Error(`Malformed .sln Project declaration: ${source.path}`);
      inProject = true;
      // Solution folders are not filesystem project members.
      if (match[1].toLowerCase() !== '{66a26720-8fb5-11d2-aa7e-00c04f688dde}' &&
          match[1].toLowerCase() !== '{2150e333-8fdc-42a3-9474-1a3956d46de8}') {
        if (/\.rnrproj$/i.test(match[3])) {
          const displayName = match[2].toLowerCase();
          if (displayNames.has(displayName)) throw new Error('Duplicate project display names in solution.');
          displayNames.add(displayName);
        }
        members.push(match[3]);
      }
    } else if (/^\s*EndProject\s*$/.test(line)) {
      if (!inProject) throw new Error(`Unexpected EndProject: ${source.path}`);
      inProject = false;
    }
  }
  if (inProject) throw new Error(`Unclosed .sln Project declaration: ${source.path}`);
  return members;
}

function pathKey(file: string): string {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

function selectPath(paths: string[], selection: string, root: string): string | undefined {
  const candidate = path.resolve(root, selection.replace(/\\/g, path.sep));
  return paths.find((file) => pathKey(file) === pathKey(candidate));
}

export function discoverVisualStudioWorkspace(root: string, targetSolution?: string): VisualStudioWorkspace {
  const resolvedRoot = canonicalRoot(root);
  const discover = (pattern: string[]) => globSync(pattern, {
    cwd: resolvedRoot, absolute: true, nodir: true, follow: false,
    windowsPathsNoEscape: true,
    ignore: ['**/bin/**', '**/obj/**', '**/.git/**', '**/.d365-mcp-write.lock/**'],
  }).map((file) => checkedPath(resolvedRoot, file)).sort();
  const solutions = discover(['**/*.[sS][lL][nN]', '**/*.[sS][lL][nN][xX]']);
  let selectedSolution: string | null = null;
  if (targetSolution) {
    selectedSolution = selectPath(solutions, targetSolution, resolvedRoot) ?? null;
    if (!selectedSolution) throw new Error(`Solution not found by path: ${targetSolution}`);
  } else if (solutions.length > 1) {
    throw new Error('Ambiguous solutions: set D365_TARGET_SOLUTION or pass solutionPath explicitly.');
  } else {
    selectedSolution = solutions[0] ?? null;
  }
  const solutionSnapshot = selectedSolution ? snapshot(resolvedRoot, selectedSolution) : null;
  const membershipSource = selectedSolution
    ? path.extname(selectedSolution).toLowerCase() === '.slnx' ? 'slnx' : 'sln'
    : 'no-solution-project-scan';
  const projectPaths = solutionSnapshot
    ? solutionMembers(solutionSnapshot).map((member) => {
      if (/[$@%]\(|[*?;]|%[0-9a-f]{2}/i.test(member) ||
          (process.platform !== 'win32' && /^[a-z]:|^\\\\/i.test(member))) {
        throw new Error(`Unsupported solution member path: ${member}`);
      }
      return checkedPath(resolvedRoot, path.resolve(path.dirname(solutionSnapshot.path), member.replace(/\\/g, path.sep)));
    }).filter((file) => path.extname(file).toLowerCase() === '.rnrproj')
    : discover(['**/*.[rR][nN][rR][pP][rR][oO][jJ]']);
  if (new Set(projectPaths.map(pathKey)).size !== projectPaths.length) {
    throw new Error('Duplicate project path identity in solution.');
  }
  const projects = projectPaths.map((file) => parseRnrProject(file, resolvedRoot))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(projects.map((project) => project.name.toLowerCase())).size !== projects.length) {
    throw new Error('Duplicate project display names are ambiguous; rename the projects.');
  }
  return { root: resolvedRoot, solutions, selectedSolution, solutionSnapshot, membershipSource, projects };
}

export function selectVisualStudioProject(
  workspace: VisualStudioWorkspace,
  requestedName: string | undefined,
  defaultName: string | undefined
): VisualStudioProject | null {
  const selected = requestedName || defaultName;
  if (!selected) return workspace.projects.length === 1 ? workspace.projects[0] : null;
  const selectedPath = selectPath(workspace.projects.map((project) => project.path), selected, workspace.root);
  const matches = workspace.projects.filter((project) =>
    project.path === selectedPath || project.name.toLowerCase() === selected.toLowerCase());
  if (matches.length > 1) throw new Error(`Ambiguous project selection: ${selected}`);
  return matches[0] ?? null;
}

/** Pure edit preparation; never reserializes or writes the project. */
export function prepareElementInRnrProject(
  project: VisualStudioProject,
  elementType: string,
  elementName: string
): Buffer {
  if (project.inspection !== 'literal') throw new Error(`Unsupported project: ${project.issues.join(' ')}`);
  if (project.items.some((item) => item.type.toLowerCase() === elementType.toLowerCase() &&
      item.name.toLowerCase() === elementName.toLowerCase())) {
    throw new Error(`Project already contains ${elementType}\\${elementName}, possibly conditionally.`);
  }
  const document = parseXml(project.snapshot.bytes, project.path);
  const prefix = document.root.qualifiedName.includes(':') ? document.root.qualifiedName.split(':')[0] + ':' : '';
  const newline = document.text.includes('\r\n') ? '\r\n' : '\n';
  const insertion = [
    '', `  <${prefix}ItemGroup>`,
    `    <${prefix}Content Include="${xmlEscape(`${elementType}\\${elementName}`)}">`,
    `      <${prefix}SubType>Content</${prefix}SubType>`,
    `      <${prefix}Name>${xmlEscape(elementName)}</${prefix}Name>`,
    `      <${prefix}Link>${xmlEscape(elementName)}</${prefix}Link>`,
    `    </${prefix}Content>`, `  </${prefix}ItemGroup>`, '',
  ].join(newline);
  const offset = rootClosingOffset(document);
  const result = document.encode(document.text.slice(0, offset) + insertion + document.text.slice(offset));
  parseXml(result, project.path);
  return result;
}
