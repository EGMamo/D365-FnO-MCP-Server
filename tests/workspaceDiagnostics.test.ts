import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkGateway, checkVisualStudioIntegration, runChecks, type CheckResult } from '../src/cli/doctor.js';
import { createHttpApp } from '../src/server/httpTransport.js';
import { registerWorkspaceTools, type WorkspaceToolOptions } from '../src/tools/workspace.js';
import { projectXml, treeSnapshot, workspaceFixture } from './workspaceFixtures.js';
import type { ToolResult } from './helpers/toolHarness.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

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

  it('fails HTTP doctor checks with missing API keys', async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...original, value: '24.0.0' });
    try {
      const httpChecks = await runChecks({
        D365_PACKAGES_DIR: fixture.metadataDir,
        D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-http.db'),
      });
      expect(httpChecks.find((check) => check.name === 'api-keys')).toMatchObject({ status: 'fail' });

    } finally {
      Object.defineProperty(process.versions, 'node', original);
    }
  }, DOCTOR_TIMEOUT_MS);

  it('fails malformed API keys', async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...original, value: '24.0.0' });
    try {
      const checks = await runChecks({
        MCP_TRANSPORT: 'http',
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

const HOSTED_KEY = 'hosted-secret-key-0123456789-abcdefghijklmnop';

interface HostedStandIn {
  url: string;
  stop(): Promise<void>;
}

/** The hosted server in miniature: the real transport (health, API key auth, sessions) around one tool. */
async function startHostedStandIn(version = '0.1.0'): Promise<HostedStandIn> {
  const app = createHttpApp(
    () => {
      const server = new McpServer({ name: 'hosted-standin', version });
      server.tool('echo', 'Echoes.', async () => ({ content: [{ type: 'text' as const, text: 'echo' }] }));
      return server;
    },
    {
      port: 0,
      apiKeys: [{ name: 'doctor-test', key: HOSTED_KEY }],
      version,
      rateLimitMaxRequests: 10_000,
      rateLimitWindowMs: 60_000,
      requestTimeoutMs: 5_000,
    }
  );
  const server = await new Promise<Server>((resolve) => {
    const created = createServer(app);
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const byName = (checks: CheckResult[], name: string): CheckResult | undefined => checks.find((check) => check.name === name);

describe('gateway doctor checks', () => {
  let hosted: HostedStandIn;
  beforeEach(async () => {
    hosted = await startHostedStandIn();
    // Custom models in the layout the local index reads.
    const tableDir = path.join(fixture.modelDir, 'AxTable');
    fs.mkdirSync(tableDir);
    fs.copyFileSync(path.join(testDir, 'fixtures', 'AxTableSample.xml'), path.join(tableDir, 'SampleTable.xml'));
  });
  afterEach(async () => {
    await hosted.stop();
  });

  /** A complete gateway environment confined to the fixture; no packages folder, so only the gateway runs. */
  function gatewayEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      D365_HOSTED_MCP_URL: hosted.url,
      D365_HOSTED_API_KEY: HOSTED_KEY,
      D365_CUSTOM_METADATA_DIR: fixture.metadataDir,
      D365_LOCAL_INDEX_DB_PATH: path.join(fixture.root, 'state', 'custom_index.db'),
      D365_INDEX_DB_PATH: path.join(fixture.root, 'main.db'),
      ...overrides,
    };
  }

  it('adds no gateway checks without D365_HOSTED_MCP_URL', async () => {
    const checks = await runChecks({
      D365_PACKAGES_DIR: fixture.metadataDir,
      D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-no-gateway.db'),
    });
    expect(checks.filter((check) => check.name.startsWith('gateway-'))).toEqual([]);
    expect(byName(checks, 'packages-dir')).toBeDefined();
  }, DOCTOR_TIMEOUT_MS);

  it('passes against a healthy hosted server and replaces the serve checks on a gateway-only machine', async () => {
    const before = treeSnapshot(fixture.root);
    const checks = await runChecks(gatewayEnv());

    expect(checks.filter((check) => check.name.startsWith('gateway-')).map((check) => [check.name, check.status])).toEqual([
      ['gateway-config', 'pass'],
      ['gateway-custom-dir', 'pass'],
      ['gateway-local-index', 'pass'],
      ['gateway-hosted-health', 'pass'],
      ['gateway-hosted-key', 'pass'],
      ['gateway-version', 'pass'],
    ]);
    expect(byName(checks, 'gateway-custom-dir')?.message).toContain('SampleTable');
    expect(byName(checks, 'gateway-hosted-key')?.message).toContain('1 tool(s)');
    expect(byName(checks, 'serve-checks')).toMatchObject({ status: 'pass' });
    for (const skipped of ['packages-dir', 'db-dir', 'db-open', 'api-keys']) expect(byName(checks, skipped)).toBeUndefined();
    // Read-only: no local index folder, no token file and no main index were created.
    expect(treeSnapshot(fixture.root)).toEqual(before);
    expect(fs.existsSync(path.join(fixture.root, 'state'))).toBe(false);
  }, DOCTOR_TIMEOUT_MS);

  it('runs the serve checks as well when D365_PACKAGES_DIR is set', async () => {
    const checks = await runChecks(gatewayEnv({ D365_PACKAGES_DIR: fixture.metadataDir }));
    expect(byName(checks, 'packages-dir')).toBeDefined();
    expect(byName(checks, 'api-keys')).toBeDefined();
    expect(byName(checks, 'gateway-config')).toMatchObject({ status: 'pass' });
    expect(byName(checks, 'serve-checks')).toBeUndefined();
  }, DOCTOR_TIMEOUT_MS);

  it('fails a rejected hosted API key without echoing either key', async () => {
    const wrongKey = 'wrong-key-0123456789-abcdefghijklmnopqrstuvwx';
    const checks = await checkGateway(gatewayEnv({ D365_HOSTED_API_KEY: wrongKey }));
    expect(byName(checks, 'gateway-hosted-health')).toMatchObject({ status: 'pass' });
    expect(byName(checks, 'gateway-hosted-key')).toMatchObject({ status: 'fail' });
    expect(byName(checks, 'gateway-hosted-key')?.message).toContain('rejected the API key');
    const text = JSON.stringify(checks);
    expect(text).not.toContain(wrongKey);
    expect(text).not.toContain(HOSTED_KEY);
  }, DOCTOR_TIMEOUT_MS);

  it('reports an unreachable hosted server and skips the key check', async () => {
    await hosted.stop();
    const checks = await checkGateway(gatewayEnv());
    expect(byName(checks, 'gateway-hosted-health')).toMatchObject({ status: 'fail' });
    expect(byName(checks, 'gateway-hosted-health')?.message).toContain('unreachable');
    expect(byName(checks, 'gateway-hosted-key')).toMatchObject({ status: 'warn' });
    expect(byName(checks, 'gateway-hosted-key')?.message).toContain('Not checked');
  }, DOCTOR_TIMEOUT_MS);

  it('warns when the hosted server runs another major.minor version', async () => {
    await hosted.stop();
    hosted = await startHostedStandIn('9.9.0');
    const checks = await checkGateway(gatewayEnv());
    expect(byName(checks, 'gateway-hosted-key')).toMatchObject({ status: 'pass' });
    expect(byName(checks, 'gateway-version')).toMatchObject({ status: 'warn' });
    expect(byName(checks, 'gateway-version')?.message).toContain('9.9');
  }, DOCTOR_TIMEOUT_MS);

  it('reports every configuration problem at once with the secrets redacted', async () => {
    const checks = await checkGateway(
      gatewayEnv({
        D365_HOSTED_MCP_URL: 'http://hosted.example.com/mcp',
        D365_CUSTOM_METADATA_DIR: path.join(fixture.root, 'missing'),
        D365_LOCAL_INDEX_DB_PATH: path.join(fixture.root, 'main.db'),
        D365_GATEWAY_TOKEN: 'token-secret-short',
      })
    );
    expect(checks).toHaveLength(1);
    const [config] = checks;
    expect(config).toMatchObject({ name: 'gateway-config', status: 'fail' });
    for (const problem of ['D365_HOSTED_MCP_URL', 'D365_CUSTOM_METADATA_DIR', 'D365_LOCAL_INDEX_DB_PATH', 'D365_GATEWAY_TOKEN']) {
      expect(config.message).toContain(problem);
    }
    expect(JSON.stringify(checks)).not.toContain('token-secret-short');
    expect(JSON.stringify(checks)).not.toContain(HOSTED_KEY);
  }, DOCTOR_TIMEOUT_MS);

  it('flags a custom folder without metadata and an unusable local index location', async () => {
    const empty = path.join(fixture.root, 'empty-models');
    fs.mkdirSync(empty);
    const blocker = path.join(fixture.root, 'blocker');
    fs.writeFileSync(blocker, 'a file where a folder is needed');

    const checks = await checkGateway(
      gatewayEnv({ D365_CUSTOM_METADATA_DIR: empty, D365_LOCAL_INDEX_DB_PATH: path.join(blocker, 'custom_index.db') })
    );
    expect(byName(checks, 'gateway-custom-dir')).toMatchObject({ status: 'warn' });
    expect(byName(checks, 'gateway-local-index')).toMatchObject({ status: 'fail' });
    expect(byName(checks, 'gateway-local-index')?.message).toContain('not a directory');

    const memory = await checkGateway(gatewayEnv({ D365_LOCAL_INDEX_DB_PATH: ':memory:' }));
    expect(byName(memory, 'gateway-local-index')).toMatchObject({ status: 'warn' });
  }, DOCTOR_TIMEOUT_MS);

  it('notes a local index folder that will be created', async () => {
    const checks = await checkGateway(
      gatewayEnv({ D365_LOCAL_INDEX_DB_PATH: path.join(fixture.root, 'a', 'b', 'custom_index.db') })
    );
    expect(byName(checks, 'gateway-local-index')).toMatchObject({ status: 'pass' });
    expect(byName(checks, 'gateway-local-index')?.message).toContain('will be created');
    expect(fs.existsSync(path.join(fixture.root, 'a'))).toBe(false);
  }, DOCTOR_TIMEOUT_MS);
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
