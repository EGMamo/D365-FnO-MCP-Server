import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { GENERATED_FILES_KEY, readGeneratedFiles } from '../tools/generatedFiles.js';
import { resolveModelTarget } from './models.js';
import { childDirectory, errorMessage, safeSegment } from './safety.js';
import { discoverVisualStudioWorkspace, selectVisualStudioProject, type VisualStudioProject } from './visualStudio.js';

export interface FileTargetOptions {
  /** The Visual Studio "Folder for your own custom metadata". No folder, no targets. */
  customMetadataDir: string;
  targetModel: string;
  targetPackage: string;
  writableModels: readonly string[];
  workspaceDir: string;
  targetSolution: string;
  targetProject: string;
}

export interface FileTarget {
  /** Absolute path of the file to create. */
  path: string;
  package: string;
  model: string;
  /** The project Content item, e.g. AxClass\MyClass. */
  projectItem: string;
  /** The selected .rnrproj, when a Visual Studio workspace is configured. */
  project: string | null;
  exists: boolean;
  inProject: boolean;
  /** True when the model accepts new files and no file of that name exists. */
  writable: boolean;
  issues: string[];
}

function selectProject(options: FileTargetOptions): VisualStudioProject | null {
  if (!options.workspaceDir) return null;
  const workspace = discoverVisualStudioWorkspace(options.workspaceDir, options.targetSolution || undefined);
  return selectVisualStudioProject(workspace, undefined, options.targetProject || undefined);
}

/** The file entry in `directory` whose name matches `fileName` ignoring case, as Windows would. */
function existingFile(directory: string, fileName: string): boolean {
  if (!fs.existsSync(directory)) return false;
  const lower = fileName.toLowerCase();
  return fs.readdirSync(directory).some((entry) => entry.toLowerCase() === lower);
}

/**
 * Adds where each generated file belongs, read from the configured custom metadata folder, model
 * descriptor and project. Reads only; nothing is created. A result without generated files, or a
 * server without a custom metadata folder (the hosted server), passes through unchanged.
 */
export function addFileTargets(result: CallToolResult, options: FileTargetOptions): CallToolResult {
  if (!options.customMetadataDir) return result;
  const found = readGeneratedFiles(result);
  if (!found) return result;
  const { index, payload } = found;

  let targets: unknown;
  try {
    const project = selectProject(options);
    const modelName = options.targetModel || project?.model || '';
    if (!modelName) {
      throw new Error('No target model: set D365_TARGET_MODEL or select a Visual Studio project with a model.');
    }
    if (project && project.model.toLowerCase() !== modelName.toLowerCase()) {
      throw new Error(`Project '${project.name}' belongs to model '${project.model}', not '${modelName}'.`);
    }
    const model = resolveModelTarget(
      options.customMetadataDir, modelName, options.targetPackage || undefined, options.writableModels,
    );
    payload[GENERATED_FILES_KEY] = payload[GENERATED_FILES_KEY].map((file) => {
      safeSegment(file.name);
      const folder = childDirectory(model.root, model.modelDir, file.aotType, true);
      const fileName = `${file.name}.xml`;
      const exists = existingFile(folder, fileName);
      const inProject = project?.items.some((item) =>
        item.type.toLowerCase() === file.aotType.toLowerCase() &&
        item.name.toLowerCase() === file.name.toLowerCase()) ?? false;
      const issues = [...model.writeIssues];
      if (exists) issues.push('A file with this name already exists; choose another name or edit the existing element.');
      const target: FileTarget = {
        path: path.join(folder, fileName),
        package: model.package,
        model: model.model,
        projectItem: `${file.aotType}\\${file.name}`,
        project: project?.path ?? null,
        exists,
        inProject,
        writable: model.writable && !exists,
        issues,
      };
      return { ...file, target };
    });
    targets = { available: true, package: model.package, model: model.model, project: project?.name ?? null };
  } catch (error) {
    targets = { available: false, reason: errorMessage(error) };
  }

  const content = [...result.content];
  content[index] = { type: 'text', text: JSON.stringify({ ...payload, targets }) };
  return { ...result, content };
}

type ToolCallback = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/**
 * Runs `register` with `server.tool` patched so that every result of the tools it registers gets
 * file targets (see `addFileTargets`). Used by local `serve`; the gateway adds them per call.
 */
export function registerWithFileTargets(server: McpServer, options: FileTargetOptions, register: () => void): void {
  if (!options.customMetadataDir) {
    register();
    return;
  }
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const patched = (...args: unknown[]) => {
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === 'function') {
      args[last] = async (...callArgs: unknown[]) =>
        addFileTargets(await (callback as ToolCallback)(...callArgs), options);
    }
    return original(...args);
  };
  (server as unknown as { tool: typeof patched }).tool = patched;
  try {
    register();
  } finally {
    (server as unknown as { tool: typeof original }).tool = original;
  }
}
