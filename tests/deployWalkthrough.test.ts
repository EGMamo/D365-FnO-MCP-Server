import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeployError, createDeployRunner, keyNameFrom, type CommandResult, type CommandRunner, type DeployDependencies } from '../src/cli/deploy.js';
import { createPrompt } from '../src/cli/prompt.js';

const SUB = '11111111-2222-3333-4444-555555555555';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const APP_ID = '99999999-8888-7777-6666-555555555555';
const ADMIN = `adm_${'a'.repeat(64)}`;
const DEV_KEY = 'd'.repeat(64);

interface Fake {
  runner: CommandRunner;
  captured: string[][];
  interactive: string[][];
  logs: string[];
  deps: Partial<DeployDependencies>;
  health: number[];
  resetCalls: number;
}

function fake(root: string, options: { missing?: string[]; signedOut?: boolean; failStep?: number; healthAlways503?: boolean; forbiddenResets?: number } = {}): Fake {
  const captured: string[][] = [];
  const interactive: string[][] = [];
  const logs: string[] = [];
  const health: number[] = [];
  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
  const state = { resetCalls: 0, clock: 0 };
  const runner: CommandRunner = {
    async capture(command, args) {
      captured.push([command, ...args]);
      if (options.missing?.includes(command)) return { code: 127, stdout: '', stderr: '' };
      if (command === 'az' && args[0] === 'account' && args[1] === 'show') {
        return options.signedOut ? { code: 1, stdout: '', stderr: 'Please run az login' } : ok(JSON.stringify({ id: SUB, tenantId: TENANT }));
      }
      if (command === 'az' && args[0] === 'account' && args[1] === 'list') {
        return ok(JSON.stringify([
          { id: SUB, name: 'Projects', tenantId: TENANT, isDefault: true },
          { id: '22222222-2222-3333-4444-555555555555', name: 'Other', tenantId: TENANT, isDefault: false },
        ]));
      }
      if (command === 'az' && args[0] === 'deployment') {
        return ok(JSON.stringify({
          webAppHostName: { value: 'app-d365mcp-dev.azurewebsites.net' },
          artifactAccountUrl: { value: 'https://std365mcpdev.blob.core.windows.net/' },
          keyRegistryContainerName: { value: 'd365-keys' },
        }));
      }
      if (command === 'az' && args[0] === 'storage') return ok('/subscriptions/x/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/std365mcpdev\n');
      if (command === 'az' && args[0] === 'ad') return ok('object-id-of-me\n');
      if (command === 'az' && args[0] === 'role') return ok();
      return ok();
    },
    async interactive(command, args) {
      interactive.push([command, ...args]);
      return options.failStep === interactive.length ? 1 : 0;
    },
  };
  const deps: Partial<DeployDependencies> = {
    runner,
    repoRoot: root,
    log: (line) => logs.push(line),
    sleep: async (ms) => {
      state.clock += ms;
    },
    now: () => state.clock,
    fetch: (async (url: string) => {
      const status = options.healthAlways503 ? 503 : health.length === 0 ? 503 : 200;
      health.push(status);
      expect(url).toBe('https://app-d365mcp-dev.azurewebsites.net/health');
      return new Response('{}', { status });
    }) as unknown as typeof fetch,
    async resetAdmin(accountUrl, container) {
      state.resetCalls += 1;
      expect([accountUrl, container]).toEqual(['https://std365mcpdev.blob.core.windows.net/', 'd365-keys']);
      if (state.resetCalls <= (options.forbiddenResets ?? 0)) throw new Error('This request is not authorized to perform this operation (403)');
      return ADMIN;
    },
    async createKey(origin, adminKey, name) {
      expect([origin, adminKey, name]).toEqual(['https://app-d365mcp-dev.azurewebsites.net', ADMIN, 'mahmoud']);
      return DEV_KEY;
    },
    userName: () => 'mahmoud',
    defaultRepository: 'EGMamo/D365-FnO-MCP-Server',
  };
  return {
    runner,
    captured,
    interactive,
    logs,
    deps,
    health,
    get resetCalls() {
      return state.resetCalls;
    },
  };
}

function clone(root: string): void {
  for (const file of ['infra/main.bicep', 'scripts/azure-deploy.ps1', 'scripts/azure-post-deploy.ps1']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), '');
  }
}

/** Answers the prompt line by line and returns what it printed. */
async function askWith(runner: ReturnType<typeof createDeployRunner>, answers: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (chunk) => (out += String(chunk)));
  input.write(answers.map((answer) => `${answer}\n`).join(''));
  const prompt = createPrompt({ input, output, terminal: false });
  try {
    const plan = await runner.ask(prompt, output);
    return { plan, out };
  } finally {
    prompt.close();
  }
}

describe('deploy walkthrough', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('names every missing tool, with its install page, and runs nothing else', async () => {
    clone(root);
    const f = fake(root, { missing: ['pwsh', 'gh'] });
    await expect(askWith(createDeployRunner(f.deps), [])).rejects.toThrow(
      'The deploy walkthrough needs PowerShell 7 (https://aka.ms/powershell), the GitHub CLI (https://cli.github.com). Install it and run setup again.'
    );
    expect(f.interactive).toEqual([]);
  });

  it('says to run from a clone when infra/ and the scripts are not there', async () => {
    const f = fake(root);
    await expect(askWith(createDeployRunner(f.deps), [])).rejects.toThrow('The deploy walkthrough runs from a clone of the repository');
  });

  it('says to sign in, and never signs in itself', async () => {
    clone(root);
    const f = fake(root, { signedOut: true });
    await expect(askWith(createDeployRunner(f.deps), [])).rejects.toThrow('Sign in first: az login (add --use-device-code if the browser sign-in is blocked).');
    expect(f.captured.some((call) => call.includes('login'))).toBe(false);
  });

  it('asks, re-asks a bad answer, shows the summary and the cost, and changes nothing when declined', async () => {
    clone(root);
    const f = fake(root);
    const { plan, out } = await askWith(createDeployRunner(f.deps), [
      '', '', 'Dev_Env', 'dev', '', '', 'not-an-email', '', 'contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com', 'nope', APP_ID, '', '', 'n',
    ]);
    expect(plan).toBeNull();
    expect(out).toContain('1) Projects (11111111-2222-3333-4444-555555555555) [current]');
    expect(out).toContain('Use 1 to 8 lowercase letters, digits or hyphens');
    expect(out).toContain('That is not an email address.');
    expect(out).toContain('Give the Dataverse URL');
    expect(out).toContain('That is not a GUID');
    expect(out).toContain('resource group    rg-d365mcp-dev');
    expect(out).toContain('cost profile      cheapest (about $290 a month, worker VM included)');
    expect(out).toContain('The standard index is built by the worker VM from Dataverse');
    expect(out).not.toMatch(/PackagesLocalDirectory/);
    expect(f.interactive).toEqual([]);
  });

  it('runs the scripts with exactly these arguments, waits for health, makes the keys and returns the URL and key', async () => {
    clone(root);
    const f = fake(root, { forbiddenResets: 2 });
    const { plan } = await askWith(createDeployRunner(f.deps), ['', '', '', '', '', 'ops@contoso.com', 'https://contoso.crm.dynamics.com', APP_ID, '', '', 'y']);
    expect(f.interactive).toEqual([]);
    const result = await plan!.run();

    expect(f.interactive).toEqual([
      ['pwsh', '-NoProfile', '-File', 'scripts/azure-deploy.ps1', '-TenantId', TENANT, '-SubscriptionId', SUB, '-ResourceGroup', 'rg-d365mcp-dev',
        '-Location', 'northeurope', '-EnvironmentName', 'dev', '-CostProfile', 'cheapest', '-GitHubRepository', 'EGMamo/D365-FnO-MCP-Server',
        '-AlertEmail', 'ops@contoso.com', '-Yes'],
      ['pwsh', '-NoProfile', '-File', 'scripts/azure-post-deploy.ps1', '-ResourceGroup', 'rg-d365mcp-dev', '-SubscriptionId', SUB,
        '-Repository', 'EGMamo/D365-FnO-MCP-Server', '-DataverseUrl', 'https://contoso.crm.dynamics.com', '-WorkerApplicationId', APP_ID, '-SmokeKeyOnly'],
    ]);
    expect(f.health).toEqual([503, 200]);
    expect(f.resetCalls).toBe(3);
    const role = f.captured.find((call) => call[1] === 'role');
    expect(role).toContain('Storage Blob Data Contributor');
    expect(role).toContain('/subscriptions/x/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/std365mcpdev/blobServices/default/containers/d365-keys');
    expect(result).toEqual({ hostedUrl: 'https://app-d365mcp-dev.azurewebsites.net/mcp', key: DEV_KEY });

    const logged = f.logs.join('\n');
    expect(logged.split(ADMIN)).toHaveLength(2);
    expect(logged).toContain('Save this admin key now. It manages developer keys and is not shown again.');
    expect(logged).not.toContain(DEV_KEY);
    expect(logged).toContain('keys new <name> --server https://app-d365mcp-dev.azurewebsites.net');
  });

  it('stops at a failed step and prints the command to resume from it', async () => {
    clone(root);
    const f = fake(root, { failStep: 2 });
    const { plan } = await askWith(createDeployRunner(f.deps), ['', '', '', '', '', '', 'https://contoso.crm.dynamics.com', APP_ID, '', '', 'y']);
    const error = await plan!.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DeployError);
    expect((error as Error).message).toMatch(/^Step 2 of 4, worker, first acquisition and the API image failed \(exit 1\)\. .*resume .*pwsh -NoProfile -File scripts\/azure-post-deploy\.ps1/);
    expect(f.interactive).toHaveLength(2);
    expect(f.health).toEqual([]);
  });

  it('gives up on health after 30 minutes', async () => {
    clone(root);
    const f = fake(root, { healthAlways503: true });
    const { plan } = await askWith(createDeployRunner(f.deps), ['', '', '', '', '', '', 'https://contoso.crm.dynamics.com', APP_ID, '', '', 'y']);
    await expect(plan!.run()).rejects.toThrow('did not report ready within 30 minutes');
  });

  it('from flags: needs --yes, names a missing flag, and otherwise plans the same deployment', async () => {
    clone(root);
    const f = fake(root);
    const runner = createDeployRunner(f.deps);
    await expect(runner.fromFlags({ 'environment-name': 'dev' })).rejects.toThrow('needs --yes');
    await expect(runner.fromFlags({ yes: true, 'environment-name': 'dev', 'worker-application-id': APP_ID })).rejects.toThrow('--dataverse-url: is required.');
    await expect(runner.fromFlags({ yes: true, 'environment-name': 'dev', 'dataverse-url': 'https://contoso.crm.dynamics.com', 'worker-application-id': 'x' })).rejects.toThrow(
      '--worker-application-id: That is not a GUID'
    );
    const plan = await runner.fromFlags({ yes: true, 'environment-name': 'prod', 'dataverse-url': 'https://contoso.crm.dynamics.com', 'worker-application-id': APP_ID, location: 'westeurope' });
    expect(f.logs.join('\n')).toContain('cost profile      standard');
    expect(f.interactive).toEqual([]);
    await plan.run();
    expect(f.interactive[0]).toEqual(expect.arrayContaining(['-ResourceGroup', 'rg-d365mcp-prod', '-Location', 'westeurope', '-CostProfile', 'standard']));
    expect(f.interactive[0]).not.toContain('-AlertEmail');
  });

  it('makes a key name from the user name', () => {
    expect(keyNameFrom('mahmoud')).toBe('mahmoud');
    expect(keyNameFrom('First Last')).toBe('FirstLast');
    expect(keyNameFrom('   ')).toBe('developer');
  });
});
