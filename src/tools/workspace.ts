import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { discoverVisualStudioWorkspace, selectVisualStudioProject } from '../workspace/visualStudio.js';
import { resolveModelTarget } from '../workspace/models.js';
import { metadataProvenance, workspaceCapabilities } from '../workspace/capabilities.js';
import { errorMessage } from '../workspace/safety.js';
import { READ_ONLY_TOOL } from './annotations.js';

export interface WorkspaceToolOptions {
  workspaceDir: string;
  customMetadataDir: string;
  projectDir?: string;
  /** Set to the original env setting if customMetadataDir already contains the legacy fallback. */
  customMetadataSource?: string;
  targetSolution?: string;
  targetProject: string;
  targetPackage: string;
  targetModel: string;
  writableModels?: readonly string[];
  enableWriteTools?: boolean;
}

export function registerWorkspaceTools(server: McpServer, options: WorkspaceToolOptions): void {
  server.tool(
    'get_visual_studio_workspace',
    'Read-only server-configured .sln/.slnx project membership, literal model identity and capabilities. No live IDE/unsaved state, MSBuild evaluation or compiler execution.',
    { projectName: z.string().optional(), solutionPath: z.string().optional() },
    READ_ONLY_TOOL,
    async ({ projectName, solutionPath }) => {
      const provenance = {
        workspace: { configuredPath: options.workspaceDir || null, source: 'D365_VISUAL_STUDIO_WORKSPACE_DIR' },
        metadata: {
          ...metadataProvenance(options.customMetadataDir, options.projectDir),
          ...(options.customMetadataSource ? { source: options.customMetadataSource } : {}),
        },
        selection: {
          solution: solutionPath ? 'request' : options.targetSolution ? 'D365_TARGET_SOLUTION' : 'unique-solution-or-no-solution-fallback',
          project: projectName ? 'request' : options.targetProject ? 'D365_TARGET_PROJECT' : 'unique-project',
          model: options.targetModel ? 'D365_TARGET_MODEL' : 'literal project Model',
          package: options.targetPackage ? 'D365_TARGET_PACKAGE' : 'descriptor ModelModule',
        },
      };
      const capabilities = workspaceCapabilities();
      const respond = (payload: object, isError = false) => ({
        content: [{ type: 'text' as const, text: JSON.stringify({
          ...payload, provenance, capabilities, writeToolsEnabled: options.enableWriteTools === true,
        }) }],
        ...(isError ? { isError: true } : {}),
      });
      if (!options.workspaceDir) {
        return respond({ state: 'unconfigured', error: 'D365_VISUAL_STUDIO_WORKSPACE_DIR is not configured.' }, true);
      }
      try {
        const workspace = discoverVisualStudioWorkspace(options.workspaceDir, solutionPath || options.targetSolution);
        const selected = selectVisualStudioProject(workspace, projectName, options.targetProject);
        if ((projectName || options.targetProject) && !selected) throw new Error('Selected project is not a member of the selected workspace.');
        if (selected && options.targetModel && selected.model &&
            options.targetModel.toLowerCase() !== selected.model.toLowerCase()) {
          throw new Error(`Configured model '${options.targetModel}' differs from project model '${selected.model}'.`);
        }
        const model = options.targetModel || selected?.model;
        const metadataRoot = options.customMetadataDir || options.projectDir;
        const target = model && metadataRoot
          ? resolveModelTarget(metadataRoot, model, options.targetPackage || undefined, options.writableModels)
          : null;
        const publicProject = (project: NonNullable<typeof selected>) => ({
          name: project.name, path: project.path, model: project.model, items: project.items,
          inspection: project.inspection, issues: project.issues, hash: project.snapshot.hash,
        });
        return respond({
          state: !selected ? 'selectionRequired' : selected.inspection === 'unsupported' ? 'unsupported' : 'inspected',
          root: workspace.root, solutions: workspace.solutions,
          selectedSolution: workspace.selectedSolution, membershipSource: workspace.membershipSource,
          projects: workspace.projects.map(publicProject),
          selectedProject: selected ? publicProject(selected) : null,
          target: target ? {
            root: target.root, package: target.package, model: target.model, modelDir: target.modelDir,
            descriptorPath: target.descriptor.path, descriptorHash: target.descriptor.hash,
            writable: target.writable, writeIssues: target.writeIssues,
            modelReferences: target.modelReferences,
          } : null,
          guidance: 'Only saved files on the server are inspected. Preview is read-only; apply requires explicit custom-model authorization and offline/unloaded-project acknowledgement.',
        });
      } catch (error) {
        return respond({ state: 'rejected', error: errorMessage(error) }, true);
      }
    },
  );
}
