import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkVisualStudioIntegration, runChecks } from '../src/cli/doctor.js';
import { registerWorkspaceTools, type WorkspaceToolOptions } from '../src/tools/workspace.js';
import { projectXml, treeSnapshot, workspaceFixture } from './workspaceFixtures.js';
import type { ToolResult } from './helpers/toolHarness.js';

let fixture: ReturnType<typeof workspaceFixture>;
beforeEach(() => { fixture = workspaceFixture(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function workspaceTool(overrides: Partial<WorkspaceToolOptions> = {}) {
  let handler: ((input: Record<string, unknown>) => Promise<ToolResult>) | undefined;
  const server = {
    tool: (_name: string, _description: string, _schema: unknown, callback: typeof handler) => { handler = callback; },
  } as unknown as McpServer;
  registerWorkspaceTools(server, {
    workspaceDir: fixture.workspaceDir, customMetadataDir: fixture.metadataDir,
    targetProject: '', targetPackage: '', targetModel: '',
    writableModels: ['MyPackage/My Model'], enableWriteTools: true, ...overrides,
  });
  return async (input: Record<string, unknown> = {}) => {
    const response = await handler!(input);
    return { response, data: JSON.parse(response.content[0].text) };
  };
}

describe('read-only workspace provenance and capabilities', () => {
  it('reports real membership and descriptor identity with no live-IDE/compiler claims or writes', async () => {
    const before = treeSnapshot(fixture.root);
    const { data } = await workspaceTool()();
    expect(data.state).toBe('inspected');
    expect(data.membershipSource).toBe('sln');
    expect(data.target).toMatchObject({ model: 'My Model', package: 'MyPackage', writable: true });
    expect(data.target.modelReferences).toEqual(['ApplicationPlatform']);
    expect(data.capabilities.nativeIdeBridge).toMatchObject({ status: 'unavailable', liveVisualStudioState: false });
    expect(data.capabilities.compiler.status).toBe('notRun');
    expect(data.capabilities.dependencies.status).toBe('notEvaluated');
    expect(data.provenance.metadata.source).toBe('D365_CUSTOM_METADATA_DIR');
    expect(JSON.stringify(data)).not.toContain('"bytes"');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('reports capabilities and provenance even when unconfigured or ambiguous', async () => {
    const { data } = await workspaceTool({ workspaceDir: '' })();
    expect(data.state).toBe('unconfigured');
    expect(data.capabilities.nativeIdeBridge.status).toBe('unavailable');
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Other.slnx'), '<Solution/>');
    const ambiguous = await workspaceTool()();
    expect(ambiguous.data.state).toBe('rejected');
    expect(ambiguous.response.isError).toBe(true);
    const explicit = await workspaceTool()({ solutionPath: 'Workspace.sln', projectName: 'MyProject.rnrproj' });
    expect(explicit.data.state).toBe('inspected');
    expect(explicit.data.provenance.selection.solution).toBe('request');
  });

  it('does not advertise imported-project writes as supported for the selected project', async () => {
    fs.writeFileSync(fixture.project, projectXml('MyProject', 'My Model', '<Import Project="External.targets"/>'));
    const { data } = await workspaceTool()();
    expect(data.state).toBe('unsupported');
    expect(data.selectedProject.issues.join(' ')).toContain('Imported');
  });

  it('preserves legacy root provenance and reports explicit authorization separately', async () => {
    const { data } = await workspaceTool({
      customMetadataDir: '', projectDir: fixture.metadataDir, writableModels: [],
    })();
    expect(data.provenance.metadata.source).toBe('D365_PROJECT_DIR (legacy alias)');
    expect(data.target.writable).toBe(false);
    expect(data.target.writeIssues.join(' ')).toContain('D365_WRITABLE_MODELS');
  });
});

// runChecks opens a real SQLite index; slow Windows runners can exceed vitest's 5s default.
const DOCTOR_TIMEOUT_MS = 30_000;

describe('workspace doctor checks', () => {
  it.each([['23.0.0', 'fail'], ['24.0.0', 'pass']])('enforces the Node 24 threshold for %s', async (version, status) => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...original, value: version });
    try {
      const checks = await runChecks({
        D365_PACKAGES_DIR: fixture.metadataDir,
        D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor.db'),
      });
      expect(checks.find((check) => check.name === 'node')).toMatchObject({ status });
      if (status === 'fail') expect(checks[0].message).toContain('>= 24');
    } finally {
      Object.defineProperty(process.versions, 'node', original);
    }
  }, DOCTOR_TIMEOUT_MS);

  it('is read-only and reports configured provenance even when write tools are off', () => {
    const before = treeSnapshot(fixture.root);
    const checks = checkVisualStudioIntegration({
      D365_ENABLE_WRITE_TOOLS: '0', D365_PROJECT_DIR: fixture.metadataDir,
      D365_VISUAL_STUDIO_WORKSPACE_DIR: fixture.workspaceDir,
      D365_WRITABLE_MODELS: 'MyPackage/My Model',
    });
    expect(checks.some((check) => check.status === 'fail')).toBe(false);
    expect(checks.find((check) => check.name === 'workspace-capabilities')?.message).toContain('notRun');
    expect(checks.find((check) => check.name === 'custom-metadata-dir')?.message).toContain('legacy alias');
    expect(checks.find((check) => check.name === 'model-descriptor')?.message).toContain('MyPackage/My Model');
    expect(treeSnapshot(fixture.root)).toEqual(before);
  });

  it('fails ambiguous selection and detects retained journal locks', () => {
    fs.writeFileSync(path.join(fixture.workspaceDir, 'Other.slnx'), '<Solution/>');
    const env = {
      D365_CUSTOM_METADATA_DIR: fixture.metadataDir,
      D365_VISUAL_STUDIO_WORKSPACE_DIR: fixture.workspaceDir,
    };
    expect(checkVisualStudioIntegration(env).some((check) => check.status === 'fail')).toBe(true);
    fs.mkdirSync(path.join(fixture.modelDir, '.d365-mcp-write.lock'));
    const checks = checkVisualStudioIntegration({ ...env, D365_TARGET_SOLUTION: 'Workspace.sln' });
    expect(checks.find((check) => check.name === 'offline-write-recovery')?.status).toBe('fail');
  });

  it('does not treat descriptor presence alone as successful model validation', () => {
    fs.writeFileSync(fixture.descriptor, '<AxModelInfo><Name>My Model</Name></AxModelInfo>');
    const checks = checkVisualStudioIntegration({
      D365_CUSTOM_METADATA_DIR: fixture.metadataDir, D365_VISUAL_STUDIO_WORKSPACE_DIR: fixture.workspaceDir,
    });
    expect(checks.find((check) => check.status === 'fail')?.message).toContain('ModelModule');
  });

  it('fails HTTP doctor checks with missing API keys but only warns for stdio', async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...original, value: '24.0.0' });
    try {
      const httpChecks = await runChecks({
        D365_PACKAGES_DIR: fixture.metadataDir,
        D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-http.db'),
      });
      expect(httpChecks.find((check) => check.name === 'api-keys')).toMatchObject({ status: 'fail' });

      const stdioChecks = await runChecks({
        MCP_TRANSPORT: 'stdio',
        D365_PACKAGES_DIR: fixture.metadataDir,
        D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-stdio.db'),
      });
      expect(stdioChecks.find((check) => check.name === 'api-keys')).toMatchObject({ status: 'warn' });
    } finally {
      Object.defineProperty(process.versions, 'node', original);
    }
  }, DOCTOR_TIMEOUT_MS);

  it('fails malformed API keys even on stdio', async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...original, value: '24.0.0' });
    try {
      const checks = await runChecks({
        MCP_TRANSPORT: 'stdio',
        MCP_API_KEY: 'shortkey',
        D365_PACKAGES_DIR: fixture.metadataDir,
        D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-bad-key.db'),
      });
      expect(checks.find((check) => check.name === 'api-keys')).toMatchObject({ status: 'fail' });
    } finally {
      Object.defineProperty(process.versions, 'node', original);
    }
  });
});

describe('workspace configuration', () => {
  it('exposes solution/authorization mapping and preserves default legacy alias with spaces', async () => {
    vi.resetModules();
    vi.stubEnv('MCP_API_KEY', 'x'.repeat(32));
    vi.stubEnv('D365_PACKAGES_DIR', fixture.metadataDir);
    vi.stubEnv('D365_ENABLE_WRITE_TOOLS', '1');
    vi.stubEnv('D365_PROJECT_DIR', fixture.metadataDir);
    vi.stubEnv('D365_CUSTOM_METADATA_DIR', '');
    vi.stubEnv('D365_VISUAL_STUDIO_WORKSPACE_DIR', fixture.workspaceDir);
    vi.stubEnv('D365_TARGET_SOLUTION', 'Workspace.sln');
    vi.stubEnv('D365_TARGET_PROJECT', 'MyProject.rnrproj');
    vi.stubEnv('D365_WRITABLE_MODELS', 'MyPackage/My Model, Other Package/Other Model');
    const { config } = await import('../src/config.js');
    expect(config.customMetadataDir).toBe(fixture.metadataDir);
    expect(config.customMetadataSource).toBe('D365_PROJECT_DIR (legacy alias)');
    expect(config.targetSolution).toBe('Workspace.sln');
    expect(config.writableModels).toEqual(['MyPackage/My Model', 'Other Package/Other Model']);
  });
});
