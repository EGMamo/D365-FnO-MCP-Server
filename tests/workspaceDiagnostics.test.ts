import fs from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  checkGateway, checkVisualStudioIntegration, doctorCommand, nextStep, runChecks, type CheckResult,
} from '../src/cli/doctor.js';
import { META_KEYS, setMeta, type Database } from '../src/indexer/db.js';
import { createHttpApp } from '../src/server/httpTransport.js';
import { createStatusProvider, describeArtifact } from '../src/server/serverStatus.js';
import { registerWorkspaceTools, type WorkspaceToolOptions } from '../src/tools/workspace.js';
import { projectXml, treeSnapshot, workspaceFixture } from './workspaceFixtures.js';
import { fakeToolServer, seedDb, type ToolResult } from './helpers/toolHarness.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));

let fixture: ReturnType<typeof workspaceFixture>;
beforeEach(() => { fixture = workspaceFixture(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

function workspaceTool(overrides: Partial<WorkspaceToolOptions> = {}) {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<ToolResult>>();
  registerWorkspaceTools(fakeToolServer(handlers), {
    workspaceDir: fixture.workspaceDir, customMetadataDir: fixture.metadataDir,
    targetProject: '', targetPackage: '', targetModel: '',
    writableModels: ['MyPackage/My Model'], enableWriteTools: true, ...overrides,
  });
  return async (input: Record<string, unknown> = {}) => {
    const response = await handlers.get('get_visual_studio_workspace')!(input);
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

  describe('reports workspace capabilities only where they matter', () => {
    const names = (checks: CheckResult[]) => checks.map((check) => check.name);

    it('reports nothing for a machine with neither write tools nor a workspace', () => {
      expect(checkVisualStudioIntegration({})).toEqual([]);
      expect(checkVisualStudioIntegration({ D365_ENABLE_WRITE_TOOLS: '0' })).toEqual([]);
    });

    it('reports capabilities and the unconfigured workspace when write tools are on', () => {
      const checks = checkVisualStudioIntegration({
        D365_ENABLE_WRITE_TOOLS: '1', D365_CUSTOM_METADATA_DIR: fixture.metadataDir,
      });
      expect(names(checks)).toContain('workspace-capabilities');
      expect(checks.find((check) => check.name === 'visual-studio-workspace')).toMatchObject({ status: 'warn' });
      expect(checks.find((check) => check.name === 'visual-studio-workspace')?.message).toContain('is not configured');
    });

    it('reports capabilities when a Visual Studio workspace is configured', () => {
      const checks = checkVisualStudioIntegration({ D365_VISUAL_STUDIO_WORKSPACE_DIR: fixture.workspaceDir });
      expect(names(checks)).toContain('workspace-capabilities');
      expect(checks.find((check) => check.name === 'visual-studio-workspace')).toMatchObject({ status: 'pass' });
    });

    it('keeps capabilities next to a workspace folder that cannot be used', () => {
      const checks = checkVisualStudioIntegration({ D365_VISUAL_STUDIO_WORKSPACE_DIR: path.join(fixture.root, 'missing') });
      expect(names(checks)).toContain('workspace-capabilities');
      expect(checks.some((check) => check.status === 'fail')).toBe(true);
    });

    it('does not count a custom metadata folder alone as a reason to report them', () => {
      const checks = checkVisualStudioIntegration({ D365_CUSTOM_METADATA_DIR: fixture.metadataDir });
      expect(checks.map((check) => [check.name, check.status])).toEqual([['custom-metadata-dir', 'pass']]);
    });

    it('does not count the legacy project folder or the writable models alone either', () => {
      const checks = checkVisualStudioIntegration({
        D365_PROJECT_DIR: fixture.metadataDir, D365_WRITABLE_MODELS: 'MyPackage/My Model',
      });
      expect(names(checks)).not.toContain('workspace-capabilities');
      expect(names(checks)).not.toContain('visual-studio-workspace');
    });

    it('blames a custom metadata folder that cannot be used on that folder, not on the Visual Studio workspace', () => {
      const missing = path.join(fixture.root, 'not-there');
      const checks = checkVisualStudioIntegration({ D365_CUSTOM_METADATA_DIR: missing });

      expect(checks.map((check) => [check.name, check.status])).toEqual([['custom-metadata-dir', 'fail']]);
      expect(checks[0].message).toContain('D365_CUSTOM_METADATA_DIR');
      expect(checks[0].message).toContain(missing);
      expect(nextStep(checks, { D365_HOSTED_MCP_URL: 'https://hosted.example.com/mcp' })).toBe(
        'Next: fix the failed checks above (custom-metadata-dir), then run `d365-fno-mcp-server doctor` again.'
      );
    });

    it('names the legacy variable when that is the one that holds the unusable folder', () => {
      const checks = checkVisualStudioIntegration({ D365_PROJECT_DIR: path.join(fixture.root, 'not-there') });

      expect(checks.map((check) => check.name)).toEqual(['custom-metadata-dir']);
      expect(checks[0].message).toContain('D365_PROJECT_DIR');
    });

    it('still fails write tools that have no custom metadata folder', () => {
      const checks = checkVisualStudioIntegration({ D365_ENABLE_WRITE_TOOLS: '1' });
      expect(names(checks)).toContain('workspace-capabilities');
      expect(checks.find((check) => check.status === 'fail')?.message).toContain('D365_CUSTOM_METADATA_DIR');
    });
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

describe('doctor next step', () => {
  const check = (name: string, status: CheckResult['status'] = 'pass'): CheckResult => ({ name, status, message: `${name} ${status}` });
  const local = { D365_PACKAGES_DIR: '/packages' };
  const hosted = { D365_HOSTED_MCP_URL: 'https://hosted.example.com/mcp' };

  it.each<[string, CheckResult[], NodeJS.ProcessEnv, string | null]>([
    // (0) nothing configured yet: setup comes before anything the checks say.
    ['setup on a fresh clone', [check('node'), check('packages-dir', 'fail'), check('api-keys', 'fail')], {},
      'Next: run `d365-fno-mcp-server setup`.'],
    ['setup when the packages folder is only whitespace', [check('packages-dir', 'fail')], { D365_PACKAGES_DIR: '   ' },
      'Next: run `d365-fno-mcp-server setup`.'],
    ['setup when the hosted URL is blank', [check('packages-dir', 'fail')], { D365_HOSTED_MCP_URL: '' },
      'Next: run `d365-fno-mcp-server setup`.'],
    // (1) failures, named once, ahead of every warning.
    ['the failed checks, in order', [check('node'), check('packages-dir', 'fail'), check('metadata-files', 'fail'), check('db-objects', 'warn')], local,
      'Next: fix the failed checks above (packages-dir, metadata-files), then run `d365-fno-mcp-server doctor` again.'],
    ['a repeated failed check once', [check('visual-studio-workspace', 'warn'), check('visual-studio-workspace', 'fail'), check('api-keys', 'fail'), check('visual-studio-workspace', 'fail')], local,
      'Next: fix the failed checks above (visual-studio-workspace, api-keys), then run `d365-fno-mcp-server doctor` again.'],
    ['failures before a hosted server that is still starting', [check('gateway-config'), check('gateway-hosted-health', 'warn'), check('api-keys', 'fail')], { ...local, ...hosted },
      'Next: fix the failed checks above (api-keys), then run `d365-fno-mcp-server doctor` again.'],
    // (2) hosted answered 503.
    ['another doctor run while the hosted server starts', [check('gateway-config'), check('gateway-hosted-health', 'warn'), check('gateway-hosted-key', 'warn'), check('db-objects', 'warn'), check('packages-dir')], { ...local, ...hosted },
      'Next: the hosted server is still starting; run `d365-fno-mcp-server doctor` again in a moment.'],
    // (3) no index yet.
    ['index then serve when nothing is indexed', [check('packages-dir'), check('db-open'), check('db-objects', 'warn')], local,
      'Next: run `d365-fno-mcp-server index`, then `d365-fno-mcp-server serve`.'],
    ['index then serve, noting the gateway needs no index', [check('packages-dir'), check('db-objects', 'warn'), check('gateway-config')], { ...local, ...hosted },
      'Next: run `d365-fno-mcp-server index`, then `d365-fno-mcp-server serve`. The gateway needs no index and can start now.'],
    // (4)-(6) everything clear.
    ['serve or gateway when both are set up', [check('packages-dir'), check('db-objects'), check('gateway-config')], { ...local, ...hosted },
      'Next: run `d365-fno-mcp-server serve` (local index) or `d365-fno-mcp-server gateway` (hosted + custom models).'],
    ['serve when only the local index is set up', [check('node'), check('packages-dir'), check('metadata-files'), check('db-objects'), check('api-keys')], local,
      'Next: run `d365-fno-mcp-server serve`.'],
    ['gateway on a gateway-only machine', [check('node'), check('serve-checks'), check('gateway-config'), check('gateway-hosted-health'), check('gateway-hosted-key')], hosted,
      'Next: run `d365-fno-mcp-server gateway`.'],
    // Warnings that are not about a missing index or a starting server never block.
    ['serve despite unrelated warnings', [check('packages-dir'), check('sample-parse', 'warn'), check('workspace-capabilities', 'warn'), check('visual-studio-workspace', 'warn'), check('db-objects')], local,
      'Next: run `d365-fno-mcp-server serve`.'],
    ['gateway despite unrelated warnings', [check('serve-checks'), check('gateway-config'), check('gateway-custom-dir', 'warn'), check('gateway-version', 'warn')], hosted,
      'Next: run `d365-fno-mcp-server gateway`.'],
    ['gateway despite a warning about the hosted index', [check('serve-checks'), check('gateway-config'), check('gateway-hosted-key'), check('gateway-hosted-index', 'warn')], hosted,
      'Next: run `d365-fno-mcp-server gateway`.'],
    // (7) nothing to say.
    ['nothing when no check names a command', [check('node')], local, null],
  ])('suggests %s', (_label, results, env, expected) => {
    expect(nextStep(results, env)).toBe(expected);
  });

  it.each([
    ['without a .env file in the folder', false, 'Next: run `d365-fno-mcp-server setup`.'],
    [
      'with a .env file that setup would refuse to replace',
      true,
      'Next: set D365_PACKAGES_DIR in your .env file, or run `d365-fno-mcp-server setup --force` to write a new .env (it replaces the current one).',
    ],
  ])('points an unconfigured machine at setup %s', (_label, envFileExists, expected) => {
    expect(nextStep([check('node')], {}, { envFileExists })).toBe(expected);
  });

  describe('doctorCommand', () => {
    const doctorEnv = () => ({
      D365_PACKAGES_DIR: fixture.metadataDir,
      D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-next.db'),
      MCP_API_KEY: 'a'.repeat(40),
    });
    const printed = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((call) => String(call[0]));

    it('ends with the next step by default', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      // The fixture folder holds no D365 metadata XML, so metadata-files fails.
      expect(await doctorCommand(doctorEnv())).toBe(1);
      const lines = printed(log);
      expect(lines.at(-2)).toMatch(/^\n\d+ checks, 1 failed, \d+ warning\(s\)\.$/);
      expect(lines.at(-1)).toBe('\nNext: fix the failed checks above (metadata-files), then run `d365-fno-mcp-server doctor` again.');
    }, DOCTOR_TIMEOUT_MS);

    it('leaves the next step out when asked, for a caller that prints its own', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await doctorCommand(doctorEnv(), { showNext: false })).toBe(1);
      const lines = printed(log);
      expect(lines.at(-1)).toMatch(/checks, 1 failed/);
      expect(lines.some((line) => line.includes('Next:'))).toBe(false);
    }, DOCTOR_TIMEOUT_MS);

    it('points a machine with nothing configured at setup', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      // Told explicitly: a developer who ran setup in their clone has a .env in the folder the tests run from.
      const env = { D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-fresh.db') };
      expect(await doctorCommand(env, { envFileExists: false })).toBe(1);
      expect(printed(log).at(-1)).toBe('\nNext: run `d365-fno-mcp-server setup`.');
    }, DOCTOR_TIMEOUT_MS);

    it('tells a machine whose .env lacks the settings how to go on, since setup would refuse', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const env = { D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-env-file.db') };
      expect(await doctorCommand(env, { envFileExists: true })).toBe(1);
      expect(printed(log).at(-1)).toBe(
        '\nNext: set D365_PACKAGES_DIR in your .env file, or run `d365-fno-mcp-server setup --force` to write a new .env (it replaces the current one).'
      );
    }, DOCTOR_TIMEOUT_MS);

    it('looks for the .env in the working folder when it is not told', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cwd-'));
      const cwd = vi.spyOn(process, 'cwd').mockReturnValue(folder);
      try {
        const env = { D365_INDEX_DB_PATH: path.join(fixture.root, 'doctor-cwd.db') };
        await doctorCommand(env);
        expect(printed(log).at(-1)).toBe('\nNext: run `d365-fno-mcp-server setup`.');
        fs.writeFileSync(path.join(folder, '.env'), 'OTHER=1\n');
        log.mockClear();
        await doctorCommand(env);
        expect(printed(log).at(-1)).toContain('set D365_PACKAGES_DIR in your .env file');
      } finally {
        cwd.mockRestore();
        fs.rmSync(folder, { recursive: true, force: true });
      }
    }, DOCTOR_TIMEOUT_MS);
  });
});

const HOSTED_KEY = 'hosted-secret-key-0123456789-abcdefghijklmnop';
const BUNDLE_ID = `sha256:${'ab'.repeat(32)}`;

type StatusHandler = (req: IncomingMessage, res: ServerResponse) => void;

interface HostedStandIn {
  url: string;
  /** The headers of every GET /status the stand-in received, where the server's own /status is. */
  statusRequests: IncomingHttpHeaders[];
  /** The request path (with query) of each of those. */
  statusPaths: string[];
  /** The headers of every GET /status at the host root while the server is mounted below it: another application's route. */
  strayRequests: IncomingHttpHeaders[];
  stop(): Promise<void>;
}

/** What a current hosted server answers to /status; each part can be replaced to describe another server. */
function statusDocument(version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ok',
    you: { keyName: 'doctor-test' },
    server: { version, startedAt: '2026-10-25T08:00:00.000Z', uptimeSeconds: 5 },
    index: {
      applicationVersion: '10.0.2428.63',
      applicationVersionSource: 'packages-dir',
      builtAt: '2026-10-24T22:10:00.000Z',
      schemaVersion: 3,
      objects: 7,
      labels: 2,
    },
    artifact: {
      source: 'azure-blob',
      bundleId: BUNDLE_ID,
      pointerRevision: 12,
      createdAt: '2026-10-24T21:40:00.000Z',
      applicationVersion: '10.0.2428.63',
    },
    sessions: { active: 0, max: 100, maxPerKey: 0 },
    ...overrides,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** The /status of a current server: a key is required, then the document. */
const answerStatus =
  (version: string, overrides: Record<string, unknown> = {}): StatusHandler =>
  (req, res) => {
    if (req.headers['x-api-key'] !== HOSTED_KEY) sendJson(res, 401, { error: 'Unauthorized: invalid or missing API key' });
    else sendJson(res, 200, statusDocument(version, overrides));
  };

/**
 * The hosted server in miniature: the real transport (health, API key auth, sessions) around one tool.
 * `options.status` answers GET /status: by default like a current server; `null` leaves it to the transport,
 * which has no such route, like an older server (404). `options.mcpPath` is where a reverse proxy mounts the MCP
 * endpoint (`/d365/mcp`): the server's own /status is then beside it, and a /status at the host root belongs to
 * some other application, which answers 200 whatever it is sent.
 */
async function startHostedStandIn(
  version = '0.1.0',
  options: { status?: StatusHandler | null; mcpPath?: string } = {}
): Promise<HostedStandIn> {
  const mcpPath = options.mcpPath ?? '/mcp';
  const mountedAt = mcpPath.replace(/\/$/, '');
  const base = mountedAt.slice(0, mountedAt.lastIndexOf('/'));
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
  const handler = options.status === undefined ? answerStatus(version) : options.status;
  const statusRequests: IncomingHttpHeaders[] = [];
  const statusPaths: string[] = [];
  const strayRequests: IncomingHttpHeaders[] = [];
  const server = await new Promise<Server>((resolve) => {
    const created = createServer((req, res) => {
      const target = req.url ?? '';
      const pathname = target.split('?')[0];
      if (handler && req.method === 'GET' && pathname === `${base}/status`) {
        statusRequests.push(req.headers);
        statusPaths.push(target);
        handler(req, res);
        return;
      }
      if (base !== '' && req.method === 'GET' && pathname === '/status') {
        strayRequests.push(req.headers);
        sendJson(res, 200, { other: 'application' });
        return;
      }
      // The proxy's mount: the transport itself only knows /mcp.
      if (pathname === mcpPath) req.url = `/mcp${target.slice(pathname.length)}`;
      app(req, res);
    });
    created.listen(0, '127.0.0.1', () => resolve(created));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${mcpPath}`,
    statusRequests,
    statusPaths,
    strayRequests,
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
      ['gateway-hosted-index', 'pass'],
    ]);
    expect(byName(checks, 'gateway-custom-dir')?.message).toContain('SampleTable');
    expect(byName(checks, 'gateway-hosted-key')?.message).toContain('1 tool(s)');
    expect(byName(checks, 'gateway-hosted-index')?.message).toContain('10.0.2428.63');
    expect(hosted.statusRequests).toHaveLength(1);
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

  describe('hosted index', () => {
    const ESC = String.fromCharCode(27);

    /** Replaces the stand-in with one whose /status is answered by `status` (null: no such route, like an older server). */
    async function hostedWith(status: StatusHandler | null, version = '0.1.0'): Promise<void> {
      await hosted.stop();
      hosted = await startHostedStandIn(version, { status });
    }
    const indexRow = (checks: CheckResult[]) => byName(checks, 'gateway-hosted-index');
    const hasControlCharacter = (text: string) => [...text].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

    it('says what the hosted server is serving, from one authenticated request', async () => {
      const checks = await checkGateway(gatewayEnv());

      expect(indexRow(checks)).toEqual({
        name: 'gateway-hosted-index',
        status: 'pass',
        message: `Hosted index: application version 10.0.2428.63, built 2026-10-24T22:10:00.000Z; bundle ${BUNDLE_ID}; server 0.1.0`,
      });
      expect(hosted.statusRequests).toHaveLength(1);
      expect(hosted.statusRequests[0]['x-api-key']).toBe(HOSTED_KEY);
      expect(hosted.statusRequests[0].accept).toBe('application/json');
      expect(hosted.statusRequests[0].authorization).toBeUndefined();
    }, DOCTOR_TIMEOUT_MS);

    it('names a server without a bundle plainly', async () => {
      await hostedWith(answerStatus('0.1.0', { artifact: null }));

      expect(indexRow(await checkGateway(gatewayEnv()))?.message).toContain('; no artifact bundle; ');
    }, DOCTOR_TIMEOUT_MS);

    it.each([
      ['matches the hosted index', '10.0.2428.63', 'pass', 'D365_APP_VERSION matches'],
      ['is an older release', '10.0.2400.10', 'warn', 'D365_APP_VERSION 10.0.2400.10 is an older release than the hosted index (10.0.2428.63)'],
      ['is an older hotfix', '10.0.2428.60', 'warn', 'D365_APP_VERSION 10.0.2428.60 is an older hotfix than the hosted index (10.0.2428.63)'],
      ['is newer than the hosted index', '10.0.2500.1', 'warn', 'D365_APP_VERSION 10.0.2500.1 is newer than the hosted index (10.0.2428.63)'],
      ['is not a four-part version', '10.0.39', 'pass', 'D365_APP_VERSION is not a four-part version, so it was not compared'],
    ])('compares D365_APP_VERSION when it %s', async (_label, configured, status, sentence) => {
      const row = indexRow(await checkGateway(gatewayEnv({ D365_APP_VERSION: configured })));

      expect(row?.status).toBe(status);
      expect(row?.message).toContain('Hosted index: application version 10.0.2428.63');
      expect(row?.message).toContain(sentence);
    }, DOCTOR_TIMEOUT_MS);

    it('prints only the facts when D365_APP_VERSION is not set', async () => {
      const row = indexRow(await checkGateway(gatewayEnv()));

      expect(row?.status).toBe('pass');
      expect(row?.message).not.toContain('D365_APP_VERSION');
    }, DOCTOR_TIMEOUT_MS);

    it('does not compare when the hosted index records no four-part version', async () => {
      await hostedWith(answerStatus('0.1.0', { index: { applicationVersion: null, builtAt: '2026-10-24T22:10:00.000Z' } }));

      const row = indexRow(await checkGateway(gatewayEnv({ D365_APP_VERSION: '10.0.2428.63' })));

      expect(row?.status).toBe('pass');
      expect(row?.message).toContain('application version unknown');
      expect(row?.message).toContain('records no four-part application version, so D365_APP_VERSION was not compared');
    }, DOCTOR_TIMEOUT_MS);

    it('adds nothing for an older hosted server that has no /status, and reports no failure', async () => {
      await hostedWith(null);

      const checks = await checkGateway(gatewayEnv());

      expect(indexRow(checks)).toBeUndefined();
      expect(checks.filter((check) => check.name.startsWith('gateway-')).map((check) => [check.name, check.status])).toEqual([
        ['gateway-config', 'pass'],
        ['gateway-custom-dir', 'pass'],
        ['gateway-local-index', 'pass'],
        ['gateway-hosted-health', 'pass'],
        ['gateway-hosted-key', 'pass'],
        ['gateway-version', 'pass'],
      ]);
      expect(checks.some((check) => check.status === 'fail')).toBe(false);
    }, DOCTOR_TIMEOUT_MS);

    /** Replaces the stand-in with one whose MCP endpoint is mounted at `mcpPath`, as a reverse proxy would. */
    async function hostedAt(mcpPath: string): Promise<void> {
      await hosted.stop();
      hosted = await startHostedStandIn('0.1.0', { mcpPath });
    }

    it('asks beside the configured MCP path, never at the host root where another application may answer', async () => {
      await hostedAt('/d365/mcp');

      const checks = await checkGateway(gatewayEnv());

      expect(byName(checks, 'gateway-hosted-key')?.status).toBe('pass');
      expect(indexRow(checks)?.status).toBe('pass');
      expect(hosted.statusPaths).toEqual(['/d365/status']);
      expect(hosted.statusRequests[0]['x-api-key']).toBe(HOSTED_KEY);
      expect(hosted.strayRequests).toEqual([]);
    }, DOCTOR_TIMEOUT_MS);

    it('ignores a trailing slash, and sends neither the query nor the fragment of the MCP URL', async () => {
      await hostedAt('/d365/mcp/');

      const checks = await checkGateway(gatewayEnv({ D365_HOSTED_MCP_URL: `${hosted.url}?tenant=contoso#section` }));

      expect(indexRow(checks)?.status).toBe('pass');
      expect(hosted.statusPaths).toEqual(['/d365/status']);
      expect(hosted.strayRequests).toEqual([]);
    }, DOCTOR_TIMEOUT_MS);

    it('asks nothing when the MCP path does not end in /mcp, because the key must not go to a guessed place', async () => {
      await hostedAt('/api/d365');

      const checks = await checkGateway(gatewayEnv());

      expect(byName(checks, 'gateway-hosted-key')?.status).toBe('pass');
      expect(indexRow(checks)).toBeUndefined();
      expect(hosted.statusRequests).toEqual([]);
      expect(hosted.strayRequests).toEqual([]);
      expect(checks.some((check) => check.status === 'fail')).toBe(false);
    }, DOCTOR_TIMEOUT_MS);

    describe('against the document a real server builds', () => {
      let served: Database;
      beforeEach(() => {
        served = seedDb([{ type: 'Table', name: 'CustTable' }]);
        setMeta(served, META_KEYS.appVersion, '10.0.2428.63');
        setMeta(served, META_KEYS.appVersionSource, 'packages-dir');
        setMeta(served, META_KEYS.builtAt, '2026-10-24T22:10:00.000Z');
      });
      afterEach(() => served.close());

      /** The /status of a current server, built by the provider the server itself uses. */
      const realStatus = (ready: boolean): StatusHandler => {
        const provider = createStatusProvider({
          version: '0.1.0',
          database: () => served,
          artifact: () => describeArtifact('azure-blob', 12, { bundleId: BUNDLE_ID, createdAt: '2026-10-24T21:40:00.000Z', d365: { applicationVersion: '10.0.2428.63' } }),
        });
        return (req, res) => {
          if (req.headers['x-api-key'] !== HOSTED_KEY) sendJson(res, 401, { error: 'Unauthorized' });
          else sendJson(res, 200, provider.describe({ ready, keyName: 'doctor-test', sessions: { active: 0, max: 100, maxPerKey: 0 } }));
        };
      };

      it('reads the facts a ready server reports', async () => {
        await hostedWith(realStatus(true));

        expect(indexRow(await checkGateway(gatewayEnv()))).toEqual({
          name: 'gateway-hosted-index',
          status: 'pass',
          message: `Hosted index: application version 10.0.2428.63, built 2026-10-24T22:10:00.000Z; bundle ${BUNDLE_ID}; server 0.1.0`,
        });
      }, DOCTOR_TIMEOUT_MS);

      it('recognises a server that is still starting', async () => {
        await hostedWith(realStatus(false));

        const row = indexRow(await checkGateway(gatewayEnv()));

        expect(row?.status).toBe('warn');
        expect(row?.message).toContain('still starting');
      }, DOCTOR_TIMEOUT_MS);
    });

    it('does not ask /status with a key the server rejected, or of a server that cannot be reached', async () => {
      const rejected = await checkGateway(gatewayEnv({ D365_HOSTED_API_KEY: 'wrong-key-0123456789-abcdefghijklmnopqrstuvwx' }));
      expect(indexRow(rejected)).toBeUndefined();
      expect(hosted.statusRequests).toHaveLength(0);

      await hosted.stop();
      expect(indexRow(await checkGateway(gatewayEnv()))).toBeUndefined();
    }, DOCTOR_TIMEOUT_MS);

    it.each([
      ['a server error', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 500, 'boom at /srv/internal/path', 'text/plain'), 'HTTP 500', 'boom'],
      ['rate limiting', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 429, { error: { message: 'Too many requests' } }), 'HTTP 429', 'Too many'],
      ['a rejected key', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 401, { error: 'nope' }), 'HTTP 401 although the API key was accepted', 'nope'],
      ['an HTML page', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, '<html>login</html>', 'text/html'), 'unreadable', 'login'],
      ['a JSON array', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, '[1,2,3]'), 'unreadable', '[1,2,3]'],
      ['text that is not JSON', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, 'not json at all'), 'unreadable', 'not json at all'],
      // A valid document is still refused when it does not say it is JSON: it may be something else that happens to parse.
      ['a document that says it is plain text', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, statusDocument('0.1.0'), 'text/plain'), 'unreadable', '10.0.2428.63'],
      ['an index that is not an object', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, statusDocument('0.1.0', { index: 'oops' })), 'without a readable index description', 'oops'],
      ['a server that is still starting', (_req: IncomingMessage, res: ServerResponse) => sendJson(res, 200, { status: 'starting', index: null, artifact: null }), 'still starting', 'null'],
    ])('warns, never fails, for %s', async (_label, status, expected, forbidden) => {
      await hostedWith(status);

      const checks = await checkGateway(gatewayEnv());
      const row = indexRow(checks);

      expect(row?.status).toBe('warn');
      expect(row?.message).toContain(expected);
      expect(row?.message).not.toContain(forbidden);
      expect(checks.some((check) => check.status === 'fail')).toBe(false);
    }, DOCTOR_TIMEOUT_MS);

    it('does not follow a redirect, which would carry the key to another host', async () => {
      const seen: IncomingHttpHeaders[] = [];
      const other = await new Promise<Server>((resolve) => {
        const created = createServer((req, res) => {
          seen.push(req.headers);
          res.end('captured');
        });
        created.listen(0, '127.0.0.1', () => resolve(created));
      });
      try {
        const target = `http://127.0.0.1:${(other.address() as AddressInfo).port}/capture`;
        await hostedWith((_req, res) => {
          res.writeHead(302, { Location: target });
          res.end();
        });

        const row = indexRow(await checkGateway(gatewayEnv()));

        expect(row?.status).toBe('warn');
        expect(row?.message).toContain('redirect');
        expect(seen).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => other.close(() => resolve()));
      }
    }, DOCTOR_TIMEOUT_MS);

    it('stops reading an endless body at 64 KiB', async () => {
      let sent = 0;
      await hostedWith((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chunk = 'x'.repeat(16_384);
        const timer = setInterval(() => {
          sent += chunk.length;
          res.write(chunk);
        }, 1);
        res.on('close', () => clearInterval(timer));
      });

      const row = indexRow(await checkGateway(gatewayEnv()));

      expect(row?.status).toBe('warn');
      expect(row?.message).toContain('larger than 65536 bytes');
      expect(sent).toBeLessThan(10 * 1024 * 1024);
    }, DOCTOR_TIMEOUT_MS);

    it('gives up on a /status that never answers, within the time budget', async () => {
      await hostedWith(() => {
        // Never answers; the stand-in closes the connection when it stops.
      });

      const row = indexRow(await checkGateway(gatewayEnv({ D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000' })));

      expect(row?.status).toBe('warn');
      expect(row?.message).toContain('did not answer within 1000 ms');
    }, DOCTOR_TIMEOUT_MS);

    it('waits at most five seconds for /status, however long the gateway is willing to wait for the rest', async () => {
      await hostedWith(() => {
        // Never answers.
      });

      const row = indexRow(await checkGateway(gatewayEnv({ D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '30000' })));

      expect(row?.status).toBe('warn');
      expect(row?.message).toContain('did not answer within 5000 ms');
    }, DOCTOR_TIMEOUT_MS);

    it('shows a hostile server version as nothing, in every result, never as a forged line', async () => {
      await hostedWith(answerStatus('0.1.0'), `0.1.0${ESC}[2J\n  [PASS] gateway-hosted-key: forged`);

      const checks = await checkGateway(gatewayEnv());

      for (const check of checks) {
        expect(hasControlCharacter(check.message)).toBe(false);
        expect(check.message).not.toContain('forged');
      }
      expect(byName(checks, 'gateway-hosted-health')?.message).toMatch(/is healthy$/);
      expect(byName(checks, 'gateway-version')?.message).toMatch(/^Gateway \S+ matches the hosted server \(major\.minor\)$/);
    }, DOCTOR_TIMEOUT_MS);

    it('never prints the hosted key, even when the server sends it back inside a field', async () => {
      await hostedWith(
        answerStatus('0.1.0', {
          artifact: { source: 'local', bundleId: HOSTED_KEY, pointerRevision: 1, createdAt: '2026-10-24T21:40:00.000Z', applicationVersion: '10.0.2428.63' },
        })
      );

      const checks = await checkGateway(gatewayEnv());
      const text = JSON.stringify(checks);

      expect(text).not.toContain(HOSTED_KEY);
      expect(text).not.toContain(HOSTED_KEY.slice(0, 20));
      expect(indexRow(checks)?.message).toContain('[redacted]');
    }, DOCTOR_TIMEOUT_MS);

    it('shows a field that is off-charset, control-laden or too long as unknown, never as a forged line', async () => {
      await hostedWith(
        answerStatus('0.1.0', {
          server: { version: '1'.repeat(200) },
          index: { applicationVersion: `10.0${ESC}[2J`, builtAt: '2026-10-24T22:10:00.000Z\n  [PASS] gateway-hosted-key: forged' },
          artifact: { bundleId: 'x\n  [PASS] gateway-hosted-key: forged' },
        })
      );

      const row = indexRow(await checkGateway(gatewayEnv()));

      expect(row?.message).toBe('Hosted index: application version unknown, built unknown; no artifact bundle; server unknown');
      expect(hasControlCharacter(row?.message ?? '')).toBe(false);
    }, DOCTOR_TIMEOUT_MS);

    it('refuses a short value with a control character in each field on its own, not only for being too long', async () => {
      const forged = '1\n[PASS] gateway-hosted-key: forged';
      await hostedWith(
        answerStatus('0.1.0', {
          server: { version: forged },
          index: { applicationVersion: forged, builtAt: forged },
          artifact: { bundleId: forged },
        })
      );

      const row = indexRow(await checkGateway(gatewayEnv()));

      expect(row?.message).toBe('Hosted index: application version unknown, built unknown; no artifact bundle; server unknown');
    }, DOCTOR_TIMEOUT_MS);

    it('leaves the machine as it found it', async () => {
      const before = treeSnapshot(fixture.root);

      await checkGateway(gatewayEnv());

      expect(treeSnapshot(fixture.root)).toEqual(before);
    }, DOCTOR_TIMEOUT_MS);
  });

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
