import fs from 'node:fs';
import path from 'node:path';
import { canonicalRoot, checkedPath, childDirectory, safeSegment, snapshot, type FileSnapshot } from './safety.js';
import { literalText, parseXml } from './xml.js';

export interface ModelTarget {
  root: string;
  package: string;
  model: string;
  modelDir: string;
  descriptor: FileSnapshot;
  writable: boolean;
  writeIssues: string[];
  modelReferences: string[];
}

export function resolveModelTarget(
  metadataRoot: string,
  modelName: string,
  packageName?: string,
  writableModels: readonly string[] = []
): ModelTarget {
  safeSegment(modelName);
  if (packageName) safeSegment(packageName);
  const root = canonicalRoot(metadataRoot);
  const packages = packageName
    ? [childDirectory(root, root, packageName)]
    : fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => checkedPath(root, path.join(root, entry.name)));
  const candidates: ModelTarget[] = [];
  let inspected = 0;
  for (const directory of packages) {
    const descriptorDirs = fs.readdirSync(directory).filter((name) => name.toLowerCase() === 'descriptor');
    if (descriptorDirs.length > 1) throw new Error(`Ambiguous Descriptor directories: ${directory}`);
    if (!descriptorDirs.length) continue;
    const descriptorDir = childDirectory(root, directory, descriptorDirs[0]);
    for (const filename of fs.readdirSync(descriptorDir).filter((name) => /\.xml$/i.test(name))) {
      if (++inspected > 2000) throw new Error('Descriptor discovery exceeds 2000-file bound; select a package.');
      const source = snapshot(root, path.join(descriptorDir, filename));
      const document = parseXml(source.bytes, source.path);
      if (document.root.name !== 'AxModelInfo' || document.root.namespace) {
        throw new Error(`Unsupported model descriptor: ${source.path}`);
      }
      const value = (name: string, required = true): string => {
        const nodes = document.root.children.filter((node) => node.name === name && !node.namespace);
        if (nodes.length === 0 && !required) return '';
        if (nodes.length !== 1) throw new Error(`Expected exactly one descriptor ${name}: ${source.path}`);
        return literalText(nodes[0]);
      };
      const model = value('Name');
      const module = value('ModelModule');
      safeSegment(model);
      safeSegment(module);
      if (path.basename(filename, path.extname(filename)).toLowerCase() !== model.toLowerCase() ||
          path.basename(directory).toLowerCase() !== module.toLowerCase()) {
        throw new Error(`Descriptor name/package mismatch: ${source.path}`);
      }
      if (model.toLowerCase() !== modelName.toLowerCase()) continue;
      const writeIssues: string[] = [];
      if (value('Customization', false) !== 'Allow') {
        writeIssues.push('Descriptor Customization must explicitly be Allow.');
      }
      if (value('Locked', false).toLowerCase() !== 'false') {
        writeIssues.push('Descriptor Locked must explicitly be false (read-only/unknown model).');
      }
      if (!writableModels.some((entry) => entry.toLowerCase() === `${module}/${model}`.toLowerCase())) {
        writeIssues.push(`Model '${module}/${model}' is not explicitly authorized by D365_WRITABLE_MODELS.`);
      }
      const references = document.root.children.filter((node) => node.name === 'ModelReferences');
      if (references.length > 1) throw new Error(`Ambiguous ModelReferences: ${source.path}`);
      const modelReferences = references.flatMap((node) => node.children.map(literalText));
      candidates.push({
        root, package: module, model, modelDir: childDirectory(root, directory, model),
        descriptor: source, writable: writeIssues.length === 0, writeIssues, modelReferences,
      });
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Missing or ambiguous descriptor for model '${modelName}' (${candidates.length} matches).`);
  }
  return candidates[0];
}
