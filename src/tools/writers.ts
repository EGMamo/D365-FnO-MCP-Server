import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import { resolveAnyObject, validateNaming } from '../validation/grounding.js';
import { generateTableExtensionXml } from './generators.js';
import { discoverVisualStudioWorkspace, prepareElementInRnrProject, selectVisualStudioProject } from '../workspace/visualStudio.js';
import { resolveModelTarget } from '../workspace/models.js';
import { assertAbsent, canonicalRoot, childDirectory, errorMessage, hash, safeSegment } from '../workspace/safety.js';
import { literalText, parseXml } from '../workspace/xml.js';
import {
  applyOfflineChange, captureDirectories, changeLockPaths, offlineWriteLimitations, type OfflineChange,
} from '../workspace/offlineWrite.js';

export interface WriterOptions {
  enableWriteTools: boolean;
  /** Legacy custom metadata root alias; still requires an existing authoritative descriptor/model. */
  projectDir: string;
  workspaceDir?: string;
  customMetadataDir?: string;
  defaultSolution?: string;
  defaultProject?: string;
  defaultPackage?: string;
  defaultModel?: string;
  /** Explicit operator authorization, entries are literal Package/Model pairs (spaces allowed). */
  writableModels?: readonly string[];
}

const previewSchema = {
  tableName: z.string(),
  extensionName: z.string(),
  packageName: z.string().optional(),
  modelName: z.string().optional(),
  projectName: z.string().optional().describe('Project path relative to the workspace, absolute path, or unique display name.'),
  solutionPath: z.string().optional().describe('Solution path relative to the workspace or absolute path; required if ambiguous.'),
  fields: z.array(z.object({
    name: z.string(),
    edt: z.string().min(1),
    labelId: z.string().optional(),
    mandatory: z.boolean().optional(),
    allowEdit: z.boolean().optional(),
  })),
  properties: z.object({
    labelId: z.string().optional(),
    saveDataPerCompany: z.boolean().optional(),
  }).optional(),
};
const previewInput = z.object(previewSchema).strict();
type PreviewInput = z.infer<typeof previewInput>;
const CHANGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 8;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

function result(payload: object, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** Pending changes live only in this registered server session, never in a process-global cache. */
export function registerWriterTools(server: McpServer, db: Database, options: WriterOptions): void {
  if (options.enableWriteTools !== true) return;
  const registeredOptions = JSON.stringify(options);
  const pending = new Map<string, {
    input: PreviewInput;
    binding: string;
    expiresAt: number;
    size: number;
    change: OfflineChange;
  }>();

  function prepare(input: PreviewInput, id: string) {
    if (JSON.stringify(options) !== registeredOptions) {
      throw new Error('Registered writer options changed; re-register the server and prepare again.');
    }
    const workspace = options.workspaceDir
      ? discoverVisualStudioWorkspace(options.workspaceDir, input.solutionPath || options.defaultSolution)
      : null;
    if (!workspace && (input.projectName || options.defaultProject || input.solutionPath || options.defaultSolution)) {
      throw new Error('Project/solution selection requires D365_VISUAL_STUDIO_WORKSPACE_DIR.');
    }
    const project = workspace ? selectVisualStudioProject(workspace, input.projectName, options.defaultProject) : null;
    if (workspace && !project) throw new Error('Write rejected: no unambiguous target project. Select a project explicitly.');
    if (project?.inspection === 'unsupported') throw new Error(`Unsupported project: ${project.issues.join(' ')}`);
    const requestedModel = input.modelName || options.defaultModel || project?.model || '';
    if (project && project.model.toLowerCase() !== requestedModel.toLowerCase()) {
      throw new Error(`Project '${project.name}' belongs to model '${project.model}', not '${requestedModel}'.`);
    }
    const target = resolveModelTarget(
      options.customMetadataDir || options.projectDir, requestedModel,
      input.packageName || options.defaultPackage, options.writableModels,
    );
    if (!target.writable) throw new Error(`Read-only/unauthorized target: ${target.writeIssues.join(' ')}`);
    for (const [kind, name] of [['table', input.tableName], ['extension', input.extensionName]]) {
      const validation = validateNaming(name);
      if (!validation.ok) throw new Error(`Invalid ${kind} name: ${validation.error}`);
    }
    const elementName = `${input.tableName}.${input.extensionName}`;
    safeSegment(elementName);
    for (const name of [input.extensionName, elementName]) {
      const existing = resolveAnyObject(db, name);
      if (existing) throw new Error(`Grounding failed: '${name}' already exists in the index as ${existing.type}.`);
    }
    const generated = generateTableExtensionXml(db, {
      targetTable: input.tableName, extensionName: input.extensionName,
      fields: input.fields.map((field) => ({ ...field, label: field.labelId })),
      properties: input.properties,
    });
    if (generated.isError) throw new Error(generated.content.map((content) => content.text).join('\n'));
    const metadata = Buffer.from(generated.content[0].text);
    const xml = parseXml(metadata, 'generated table extension');
    const names = xml.root.children.filter((node) => node.name === 'Name');
    if (xml.root.name !== 'AxTableExtension' || names.length !== 1 || literalText(names[0]) !== elementName) {
      throw new Error('Generated metadata Name does not match the target filename/project element.');
    }
    if (generated.content[0].text.includes('<!-- WARNING:')) {
      throw new Error('Grounding is incomplete: generated XML has unresolved EDT warnings; writing is unsupported.');
    }
    const targetPath = path.join(childDirectory(target.root, target.modelDir, 'AxTableExtension', true), `${elementName}.xml`);
    assertAbsent(target.root, targetPath);
    const change: OfflineChange = {
      id, metadataRoot: target.root, modelDir: target.modelDir, targetPath, metadata,
      workspaceRoot: workspace?.root,
      project: project ? { before: project.snapshot, after: prepareElementInRnrProject(project, 'AxTableExtension', elementName) } : undefined,
      inputs: [
        { root: target.root, file: target.descriptor },
        ...(project ? [{ root: workspace!.root, file: project.snapshot }] : []),
        ...(workspace?.solutionSnapshot ? [{ root: workspace.root, file: workspace.solutionSnapshot }] : []),
      ],
      directories: [
        ...captureDirectories(target.root, path.dirname(targetPath)),
        ...captureDirectories(target.root, path.dirname(target.descriptor.path)),
        ...(project ? captureDirectories(workspace!.root, path.dirname(project.path)) : []),
      ],
    };
    const targetInfo = {
      metadataRoot: target.root, package: target.package, model: target.model,
      descriptorPath: target.descriptor.path, path: targetPath, elementName,
      projectPath: project?.path ?? null, projectName: project?.name ?? null,
      solutionPath: workspace?.selectedSolution ?? null,
      membershipSource: workspace?.membershipSource ?? 'metadata-only',
    };
    const binding = hash(JSON.stringify({
      registeredOptions, targetInfo,
      inputs: change.inputs.map(({ file }) => ({ path: file.path, hash: file.hash, identity: file.identity })),
      directories: change.directories, metadataHash: hash(metadata),
      projectAfterHash: change.project ? hash(change.project.after) : null,
    }));
    return { change, binding, targetInfo };
  }

  server.tool(
    'write_table_extension',
    'Prepare/preview a grounded table extension. NEVER writes files. Returns a short-lived, session/target-bound change ID for apply_table_extension_change; raw project edits require explicit offline/unloaded acknowledgement.',
    previewSchema,
    async (args) => {
      try {
        for (const [id, entry] of pending) if (entry.expiresAt <= Date.now()) pending.delete(id);
        const input = previewInput.parse(args);
        const id = randomUUID();
        const prepared = prepare(input, id);
        for (const lock of changeLockPaths(prepared.change)) {
          const root = lock.startsWith(prepared.change.modelDir + path.sep)
            ? prepared.change.metadataRoot : prepared.change.workspaceRoot!;
          assertAbsent(root, lock);
        }
        const expiresAt = Date.now() + CHANGE_TTL_MS;
        const size = prepared.change.metadata.length + (prepared.change.project?.after.length ?? 0) +
          prepared.change.inputs.reduce((sum, entry) => sum + entry.file.bytes.length, 0);
        if (pending.size >= MAX_PENDING ||
            [...pending.values()].reduce((sum, entry) => sum + entry.size, size) > MAX_PENDING_BYTES) {
          throw new Error('Pending preview capacity exceeded; apply an existing change or wait for expiry.');
        }
        pending.set(id, { input, binding: prepared.binding, expiresAt, size, change: prepared.change });
        return result({
          state: 'preview', written: false, changeId: id, expiresAt: new Date(expiresAt).toISOString(),
          target: prepared.targetInfo,
          hashes: {
            descriptor: prepared.change.inputs[0].file.hash,
            projectBefore: prepared.change.project?.before.hash ?? null,
            projectAfter: prepared.change.project ? hash(prepared.change.project.after) : null,
            metadata: hash(prepared.change.metadata),
          },
          metadataXml: prepared.change.metadata.toString('utf8'),
          projectChange: prepared.change.project ? { addUnconditionalContent: `AxTableExtension\\${prepared.targetInfo.elementName}` } : null,
          apply: { tool: 'apply_table_extension_change', changeId: id, acknowledgeOfflineProject: true },
          acknowledgementRequired: 'Stop other writers/builds, save all IDE edits, and unload/close the project before applying. This server cannot verify IDE state.',
          limitations: offlineWriteLimitations,
        });
      } catch (error) {
        return result({ state: 'rejected', written: false, error: errorMessage(error) }, true);
      }
    },
  );

  server.tool(
    'apply_table_extension_change',
    'Apply an unexpired change ID from this server session, after checking exact target/project/descriptor bytes. Acknowledge the project is saved and unloaded/closed and other writers/builds are stopped. No live Visual Studio awareness.',
    { changeId: z.string().uuid(), acknowledgeOfflineProject: z.boolean() },
    async ({ changeId, acknowledgeOfflineProject }) => {
      const prepared = pending.get(changeId);
      if (!prepared) return result({ state: 'rejected', written: false, error: 'Unknown/consumed change ID for this server session.' }, true);
      if (prepared.expiresAt <= Date.now()) {
        pending.delete(changeId);
        return result({ state: 'expired', written: false, error: 'Preview expired; prepare a new change.' }, true);
      }
      if (acknowledgeOfflineProject !== true) {
        return result({ state: 'rejected', written: false, error: 'Explicit offline/unloaded-project acknowledgement is required.' }, true);
      }
      pending.delete(changeId);
      const outcome = applyOfflineChange(prepared.change, () => {
        if (canonicalRoot(options.customMetadataDir || options.projectDir) !== prepared.change.metadataRoot ||
            (options.workspaceDir && canonicalRoot(options.workspaceDir) !== prepared.change.workspaceRoot)) {
          throw new Error('Stale preview: configured root changed.');
        }
        const current = prepare(prepared.input, changeId);
        if (current.binding !== prepared.binding) throw new Error('Stale preview: target, project, descriptor, or grounded XML changed.');
      });
      return result({ ...outcome, changeId, path: prepared.change.targetPath, limitations: offlineWriteLimitations }, outcome.state !== 'applied');
    },
  );
}
