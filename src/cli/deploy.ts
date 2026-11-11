import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEY_NAME_PATTERN } from '../server/apiKeys.js';
import type { Prompt } from './prompt.js';
import type { DeployPlan, DeployResult, DeployRunner } from './setup.js';

/**
 * The deploy walkthrough behind `setup --mode hosted --deploy` (operator package only): checks the tools, asks
 * what to deploy, and after one confirmation runs the repository's own scripts (`scripts/azure-deploy.ps1`, then
 * `scripts/azure-post-deploy.ps1 -SmokeKeyOnly`), waits for the server, makes the admin key and the deployer's
 * developer key, and hands the URL and that key back to setup. The standard index is built only by the worker VM
 * from Dataverse, never from a local PackagesLocalDirectory. It never signs in for the user and never sees a password:
 * the scripts prompt for the VM password and the worker's client secret themselves.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How commands run: captured for `az` queries, on the terminal for the PowerShell scripts. */
export interface CommandRunner {
  capture(command: string, args: string[]): Promise<CommandResult>;
  interactive(command: string, args: string[], options: { cwd: string }): Promise<number>;
}

export interface DeployDependencies {
  runner: CommandRunner;
  /** The clone of the repository: it holds infra/ and scripts/. */
  repoRoot: string;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Fetch for the health poll. */
  fetch: typeof fetch;
  /** Makes the admin key in the blob registry with the caller's Azure sign-in. */
  resetAdmin(accountUrl: string, container: string): Promise<string>;
  /** Creates a developer key through the server's admin API. */
  createKey(origin: string, adminKey: string, name: string): Promise<string>;
  userName(): string;
  /** The `owner/name` the package comes from, the default for the repository question. */
  defaultRepository: string | null;
}

export interface DeployAnswers {
  subscriptionId: string;
  tenantId: string;
  location: string;
  environmentName: string;
  resourceGroup: string;
  costProfile: 'cheapest' | 'standard';
  alertEmail: string;
  dataverseUrl: string;
  workerApplicationId: string;
  repository: string;
  developerName: string;
}

const REGIONS = ['northeurope', 'westeurope', 'uksouth', 'swedencentral', 'eastus', 'eastus2', 'westus3', 'australiaeast'] as const;
const MONTHLY_COST = { cheapest: 'about $290 a month', standard: 'about $470 a month' } as const;
const ENVIRONMENT_NAME = /^[a-z0-9-]{1,8}$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATAVERSE_URL = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\/?$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESOURCE_GROUP = /^[-\w._()]{1,90}$/;
const KEY_REGISTRY_CONTAINER = 'd365-keys';
const HEALTH_TIMEOUT_MS = 30 * 60_000;
const HEALTH_INTERVAL_MS = 15_000;
const ROLE_PROPAGATION_MS = 5 * 60_000;
const ROLE_RETRY_MS = 15_000;

/** A failed check or step, worded to print as is. */
export class DeployError extends Error {}

// ── Checks ──────────────────────────────────────────────────────────────────

/** The tools the scripts need, and an Azure CLI sign-in. Returns the signed-in account's subscription and tenant. */
async function preflight(deps: Pick<DeployDependencies, 'runner' | 'repoRoot'>): Promise<{ subscriptionId: string; tenantId: string }> {
  const missing: string[] = [];
  const tool = async (command: string, args: string[], name: string, page: string): Promise<void> => {
    const result = await deps.runner.capture(command, args).catch(() => ({ code: 127, stdout: '', stderr: '' }));
    if (result.code !== 0) missing.push(`${name} (${page})`);
  };
  await tool('az', ['version', '-o', 'none'], 'the Azure CLI', 'https://aka.ms/installazurecli');
  await tool('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], 'PowerShell 7', 'https://aka.ms/powershell');
  await tool('gh', ['--version'], 'the GitHub CLI', 'https://cli.github.com');
  if (missing.length > 0) throw new DeployError(`The deploy walkthrough needs ${missing.join(', ')}. Install it and run setup again.`);

  for (const file of ['infra/main.bicep', 'scripts/azure-deploy.ps1', 'scripts/azure-post-deploy.ps1']) {
    if (!fs.existsSync(path.join(deps.repoRoot, file))) {
      throw new DeployError(
        'The deploy walkthrough runs from a clone of the repository: git clone https://github.com/EGMamo/D365-FnO-MCP-Server.git, ' +
          'then npm ci, npm run build, and node dist/src/index.js setup --mode hosted --deploy.'
      );
    }
  }

  const account = await deps.runner.capture('az', ['account', 'show', '-o', 'json']);
  if (account.code !== 0) throw new DeployError('Sign in first: az login (add --use-device-code if the browser sign-in is blocked).');
  const gh = await deps.runner.capture('gh', ['auth', 'status']);
  if (gh.code !== 0) throw new DeployError('Sign in to GitHub first: gh auth login (the Deploy workflow runs in your repository).');
  try {
    const parsed = JSON.parse(account.stdout) as { id?: string; tenantId?: string };
    return { subscriptionId: parsed.id ?? '', tenantId: parsed.tenantId ?? '' };
  } catch {
    throw new DeployError('The Azure CLI did not report the signed-in account. Run az account show to see why.');
  }
}

// ── Questions ───────────────────────────────────────────────────────────────

/** A developer-key name from a user name: what the key-name rule allows, or `developer`. */
export function keyNameFrom(user: string): string {
  const cleaned = user.replace(/[^A-Za-z0-9._@-]/g, '').slice(0, 64);
  return KEY_NAME_PATTERN.test(cleaned) ? cleaned : 'developer';
}

/** Checks one answer; the problem in plain words, or undefined. Shared by the prompts and the flags. */
function answerProblem(field: keyof DeployAnswers, value: string): string | undefined {
  switch (field) {
    case 'subscriptionId':
    case 'tenantId':
    case 'workerApplicationId':
      return GUID.test(value) ? undefined : 'That is not a GUID like 00000000-0000-0000-0000-000000000000.';
    case 'location':
      return /^[a-z0-9]+$/.test(value) ? undefined : 'Give an Azure region name such as northeurope.';
    case 'environmentName':
      return ENVIRONMENT_NAME.test(value) ? undefined : 'Use 1 to 8 lowercase letters, digits or hyphens, for example dev.';
    case 'resourceGroup':
      return RESOURCE_GROUP.test(value) ? undefined : 'A resource group name is 1 to 90 letters, digits, hyphens, underscores, dots or parentheses.';
    case 'costProfile':
      return value === 'cheapest' || value === 'standard' ? undefined : 'Answer cheapest or standard.';
    case 'alertEmail':
      return value === '' || EMAIL.test(value) ? undefined : 'That is not an email address.';
    case 'dataverseUrl':
      return DATAVERSE_URL.test(value) ? undefined : 'Give the Dataverse URL, like https://contoso.crm.dynamics.com.';
    case 'repository':
      return REPOSITORY.test(value) ? undefined : 'Give the GitHub repository as owner/name.';
    case 'developerName':
      return KEY_NAME_PATTERN.test(value) ? undefined : "Use 1-64 letters, digits, '.', '_', '@' or '-'.";
  }
}

async function askField(prompt: Prompt, question: string, field: keyof DeployAnswers, fallback?: string): Promise<string> {
  const answer = await prompt.ask(question, {
    ...(fallback !== undefined ? { default: fallback } : {}),
    validate: (value) => answerProblem(field, value.trim()),
  });
  return answer.trim();
}

interface Subscription {
  id: string;
  name: string;
  tenantId: string;
  isDefault: boolean;
}

async function askSubscription(prompt: Prompt, output: NodeJS.WritableStream, deps: DeployDependencies): Promise<Subscription> {
  const listed = await deps.runner.capture('az', ['account', 'list', '--query', '[].{id:id,name:name,tenantId:tenantId,isDefault:isDefault}', '-o', 'json']);
  let subscriptions: Subscription[] = [];
  try {
    subscriptions = (JSON.parse(listed.stdout) as Subscription[]).filter((entry) => GUID.test(entry.id));
  } catch {
    subscriptions = [];
  }
  if (subscriptions.length === 0) throw new DeployError('The Azure CLI lists no subscription for this sign-in. Run az account list to see why.');
  output.write('Azure subscription:\n');
  subscriptions.forEach((entry, index) => output.write(`  ${index + 1}) ${entry.name} (${entry.id})${entry.isDefault ? ' [current]' : ''}\n`));
  const current = Math.max(0, subscriptions.findIndex((entry) => entry.isDefault));
  const answer = await prompt.ask(`Choose 1-${subscriptions.length}`, {
    default: String(current + 1),
    validate: (value) => {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= subscriptions.length ? undefined : `Answer a number from 1 to ${subscriptions.length}.`;
    },
  });
  return subscriptions[Number(answer) - 1]!;
}

function summary(answers: DeployAnswers): string {
  return [
    'About to deploy:',
    `  subscription      ${answers.subscriptionId}`,
    `  region            ${answers.location}`,
    `  resource group    ${answers.resourceGroup}`,
    `  environment       ${answers.environmentName}`,
    `  cost profile      ${answers.costProfile} (${MONTHLY_COST[answers.costProfile]}, worker VM included)`,
    `  alert email       ${answers.alertEmail || '(none)'}`,
    `  Dataverse         ${answers.dataverseUrl}`,
    `  worker app ID     ${answers.workerApplicationId}`,
    `  repository        ${answers.repository}`,
    `  your key's name   ${answers.developerName}`,
    'The standard index is built by the worker VM from Dataverse; the first acquisition runs during the deployment.',
    'PowerShell will ask for the worker VM password and the worker app secret itself; neither passes through this tool.',
  ].join('\n');
}

// ── Running ─────────────────────────────────────────────────────────────────

function deployArgs(answers: DeployAnswers): string[] {
  return [
    '-NoProfile',
    '-File',
    'scripts/azure-deploy.ps1',
    '-TenantId',
    answers.tenantId,
    '-SubscriptionId',
    answers.subscriptionId,
    '-ResourceGroup',
    answers.resourceGroup,
    '-Location',
    answers.location,
    '-EnvironmentName',
    answers.environmentName,
    '-CostProfile',
    answers.costProfile,
    '-GitHubRepository',
    answers.repository,
    ...(answers.alertEmail ? ['-AlertEmail', answers.alertEmail] : []),
    '-Yes',
  ];
}

function postDeployArgs(answers: DeployAnswers): string[] {
  return [
    '-NoProfile',
    '-File',
    'scripts/azure-post-deploy.ps1',
    '-ResourceGroup',
    answers.resourceGroup,
    '-SubscriptionId',
    answers.subscriptionId,
    '-Repository',
    answers.repository,
    '-DataverseUrl',
    answers.dataverseUrl,
    '-WorkerApplicationId',
    answers.workerApplicationId,
    '-SmokeKeyOnly',
  ];
}

/** Shell-ready text of a command, for the resume hint. */
const commandLine = (command: string, args: string[]): string =>
  [command, ...args.map((arg) => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "''")}'`))].join(' ');

interface DeploymentOutputs {
  webAppHostName: string;
  artifactAccountUrl: string;
  keyRegistryContainerName: string;
}

async function readOutputs(deps: DeployDependencies, answers: DeployAnswers): Promise<DeploymentOutputs> {
  const result = await deps.runner.capture('az', [
    'deployment', 'group', 'list', '-g', answers.resourceGroup, '--subscription', answers.subscriptionId,
    '--query', "[?properties.provisioningState=='Succeeded' && properties.outputs.webAppName != null] | sort_by(@, &properties.timestamp) | [-1].properties.outputs",
    '-o', 'json',
  ]);
  try {
    const outputs = JSON.parse(result.stdout) as Record<string, { value?: unknown }>;
    const value = (name: string): string => (typeof outputs[name]?.value === 'string' ? (outputs[name]!.value as string) : '');
    const read = {
      webAppHostName: value('webAppHostName'),
      artifactAccountUrl: value('artifactAccountUrl'),
      keyRegistryContainerName: value('keyRegistryContainerName') || KEY_REGISTRY_CONTAINER,
    };
    if (read.webAppHostName && read.artifactAccountUrl) return read;
  } catch {
    // Reported below.
  }
  throw new DeployError(`The deployment outputs of ${answers.resourceGroup} could not be read; check az deployment group list -g ${answers.resourceGroup}.`);
}

async function waitForHealth(deps: DeployDependencies, origin: string): Promise<void> {
  const started = deps.now();
  for (;;) {
    try {
      const res = await deps.fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) return;
    } catch {
      // Not reachable yet.
    }
    const elapsed = deps.now() - started;
    if (elapsed >= HEALTH_TIMEOUT_MS) {
      throw new DeployError(`${origin}/health did not report ready within 30 minutes. Check the App Service log stream, then run setup --mode hosted with --hosted-url.`);
    }
    deps.log(`  waiting for ${origin}/health to report ready (${Math.floor(elapsed / 60_000)} min so far)`);
    await deps.sleep(HEALTH_INTERVAL_MS);
  }
}

/** Lets the signed-in user write the key registry container, so reset-admin can make the admin key. */
async function grantRegistryAccess(deps: DeployDependencies, answers: DeployAnswers, outputs: DeploymentOutputs): Promise<void> {
  const accountName = new URL(outputs.artifactAccountUrl).hostname.split('.')[0] ?? '';
  const account = await deps.runner.capture('az', ['storage', 'account', 'show', '-n', accountName, '-g', answers.resourceGroup, '--subscription', answers.subscriptionId, '--query', 'id', '-o', 'tsv']);
  const me = await deps.runner.capture('az', ['ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv']);
  if (account.code !== 0 || me.code !== 0 || !account.stdout.trim() || !me.stdout.trim()) {
    throw new DeployError('The storage account or your Azure identity could not be read to grant you access to the key registry.');
  }
  const scope = `${account.stdout.trim()}/blobServices/default/containers/${outputs.keyRegistryContainerName}`;
  deps.log(`Giving you Storage Blob Data Contributor on the ${outputs.keyRegistryContainerName} container, to make the admin key.`);
  const granted = await deps.runner.capture('az', [
    'role', 'assignment', 'create', '--assignee-object-id', me.stdout.trim(), '--assignee-principal-type', 'User',
    '--role', 'Storage Blob Data Contributor', '--scope', scope, '-o', 'none',
  ]);
  if (granted.code !== 0 && !/RoleAssignmentExists/.test(granted.stderr)) {
    throw new DeployError(`Access to the key registry could not be granted: ${granted.stderr.trim().split('\n')[0] ?? 'az failed'}`);
  }
}

/** reset-admin, retried while a fresh role assignment propagates (Azure answers 403 for a few minutes). */
async function resetAdminWithRetry(deps: DeployDependencies, outputs: DeploymentOutputs): Promise<string> {
  const started = deps.now();
  for (;;) {
    try {
      return await deps.resetAdmin(outputs.artifactAccountUrl, outputs.keyRegistryContainerName);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const forbidden = /403|AuthorizationPermissionMismatch|not authorized/i.test(text);
      if (!forbidden || deps.now() - started >= ROLE_PROPAGATION_MS) throw new DeployError(`The admin key could not be made: ${text}`);
      deps.log('  waiting for the new role assignment to take effect');
      await deps.sleep(ROLE_RETRY_MS);
    }
  }
}

/** The steps after the confirmation; each failure names the step and how to resume. */
async function runDeployment(deps: DeployDependencies, answers: DeployAnswers): Promise<DeployResult> {
  const step = async (label: string, command: string, args: string[]): Promise<void> => {
    deps.log(`\n${label}: ${commandLine(command, args)}`);
    const code = await deps.runner.interactive(command, args, { cwd: deps.repoRoot });
    if (code !== 0) {
      throw new DeployError(`${label} failed (exit ${code}). Fix what it reported, then resume from the repository folder with: ${commandLine(command, args)}`);
    }
  };
  await step('Step 1 of 4, infrastructure', 'pwsh', deployArgs(answers));
  await step('Step 2 of 4, worker, first acquisition and the API image', 'pwsh', postDeployArgs(answers));

  deps.log('\nStep 3 of 4, waiting for the server');
  const outputs = await readOutputs(deps, answers);
  const origin = `https://${outputs.webAppHostName}`;
  await waitForHealth(deps, origin);

  deps.log('\nStep 4 of 4, keys');
  await grantRegistryAccess(deps, answers, outputs);
  const adminKey = await resetAdminWithRetry(deps, outputs);
  const key = await deps.createKey(origin, adminKey, answers.developerName);
  deps.log('\nAdmin key (shown once; the server keeps only its fingerprint):');
  deps.log(`  ${adminKey}`);
  deps.log('Save this admin key now. It manages developer keys and is not shown again.');
  deps.log(`\nYour developer key "${answers.developerName}" goes into the .env below. For other developers:`);
  deps.log(`  Create their keys with: d365-fno-mcp-server keys new <name> --server ${origin}`);
  deps.log(`  or on the page ${origin}/admin. They run: d365-fno-mcp setup --mode hosted --hosted-url ${origin}/mcp`);
  return { hostedUrl: `${origin}/mcp`, key };
}

// ── The runner setup uses ───────────────────────────────────────────────────

const FLAG_FOR: Readonly<Record<keyof DeployAnswers, string>> = {
  subscriptionId: 'subscription-id',
  tenantId: 'tenant-id',
  location: 'location',
  environmentName: 'environment-name',
  resourceGroup: 'resource-group',
  costProfile: 'cost-profile',
  alertEmail: 'alert-email',
  dataverseUrl: 'dataverse-url',
  workerApplicationId: 'worker-application-id',
  repository: 'repository',
  developerName: 'developer-name',
};

export function createDeployRunner(overrides: Partial<DeployDependencies> = {}): DeployRunner {
  const deps: DeployDependencies = { ...defaultDependencies(), ...overrides };
  const plan = (answers: DeployAnswers): DeployPlan => ({ run: () => runDeployment(deps, answers) });

  return {
    async ask(prompt: Prompt, output: NodeJS.WritableStream): Promise<DeployPlan | null> {
      const signedIn = await preflight(deps);
      output.write('Deploying a hosted server on Azure. Nothing changes in Azure until you confirm at the end.\n');
      const subscription = await askSubscription(prompt, output, deps);
      output.write(`Region (${REGIONS.join(', ')})\n`);
      const location = await askField(prompt, 'Region', 'location', 'northeurope');
      const environmentName = await askField(prompt, 'Environment name', 'environmentName', 'dev');
      const resourceGroup = await askField(prompt, 'Resource group', 'resourceGroup', `rg-d365mcp-${environmentName}`);
      const costProfile = (await askField(prompt, `Cost profile: cheapest (${MONTHLY_COST.cheapest}) or standard (${MONTHLY_COST.standard})`, 'costProfile', environmentName.startsWith('dev') ? 'cheapest' : 'standard')) as DeployAnswers['costProfile'];
      const alertEmail = await askField(prompt, 'Alert email (blank for none)', 'alertEmail', '');
      const dataverseUrl = await askField(prompt, 'Dataverse URL of the environment linked to Finance and Operations', 'dataverseUrl');
      const workerApplicationId = await askField(prompt, "Worker app registration's application (client) ID", 'workerApplicationId');
      const repository = await askField(prompt, 'GitHub repository the worker and the Deploy workflow build from (owner/name)', 'repository', deps.defaultRepository ?? undefined);
      const developerName = await askField(prompt, 'Name of your own developer key', 'developerName', keyNameFrom(deps.userName()));
      const answers: DeployAnswers = {
        subscriptionId: subscription.id,
        tenantId: subscription.tenantId || signedIn.tenantId,
        location,
        environmentName,
        resourceGroup,
        costProfile,
        alertEmail,
        dataverseUrl,
        workerApplicationId,
        repository,
        developerName,
      };
      output.write(`${summary(answers)}\n`);
      const confirmed = await prompt.ask('Deploy now? [y/N]', {
        default: 'n',
        validate: (value) => (/^(y|yes|n|no)$/i.test(value) ? undefined : 'Answer y or n.'),
      });
      return /^y/i.test(confirmed) ? plan(answers) : null;
    },

    async fromFlags(flags): Promise<DeployPlan> {
      if (flags.yes !== true && flags.yes !== 'true') {
        throw new DeployError('--deploy with --non-interactive needs --yes, because it creates billable Azure resources.');
      }
      const signedIn = await preflight(deps);
      const text = (field: keyof DeployAnswers): string => {
        const value = flags[FLAG_FOR[field]];
        return typeof value === 'string' ? value.trim() : '';
      };
      const fallbacks: Partial<Record<keyof DeployAnswers, string>> = {
        subscriptionId: signedIn.subscriptionId,
        tenantId: signedIn.tenantId,
        location: 'northeurope',
        alertEmail: '',
        repository: deps.defaultRepository ?? '',
        developerName: keyNameFrom(deps.userName()),
      };
      const answers = {} as Record<keyof DeployAnswers, string>;
      for (const field of Object.keys(FLAG_FOR) as Array<keyof DeployAnswers>) {
        answers[field] = text(field) || fallbacks[field] || '';
      }
      answers.resourceGroup ||= answers.environmentName ? `rg-d365mcp-${answers.environmentName}` : '';
      answers.costProfile ||= answers.environmentName.startsWith('dev') ? 'cheapest' : 'standard';
      for (const field of Object.keys(FLAG_FOR) as Array<keyof DeployAnswers>) {
        const problem = answerProblem(field, answers[field]);
        if (problem) throw new DeployError(`--${FLAG_FOR[field]}: ${answers[field] ? problem : 'is required.'}`);
      }
      deps.log(summary(answers as unknown as DeployAnswers));
      return plan(answers as unknown as DeployAnswers);
    },
  };
}

// ── Defaults ────────────────────────────────────────────────────────────────

function packageRoot(): string {
  // dist/src/cli/deploy.js or src/cli/deploy.ts: the package root holds package.json.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

function repositoryOf(root: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { repository?: { url?: string } | string };
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
    const match = /github\.com[/:]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

const childRunner: CommandRunner = {
  capture(command, args) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.on('error', () => resolve({ code: 127, stdout, stderr }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
  interactive(command, args, options) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: 'inherit', cwd: options.cwd, shell: process.platform === 'win32' });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 1));
    });
  },
};

function defaultDependencies(): DeployDependencies {
  const root = packageRoot();
  return {
    runner: childRunner,
    repoRoot: root,
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    async resetAdmin(accountUrl, container) {
      const { openKeyRegistry } = await import('../server/keyRegistryOpen.js');
      const registry = await openKeyRegistry({ kind: 'azure-blob', accountUrl, container });
      try {
        return await registry.resetAdmin();
      } finally {
        registry.stop();
      }
    },
    async createKey(origin, adminKey, name) {
      const res = await fetch(`${origin}/admin/api/keys`, {
        method: 'POST',
        headers: { 'X-Admin-Key': adminKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => null)) as { key?: string; error?: string } | null;
      if (res.status !== 201 || typeof data?.key !== 'string') {
        throw new DeployError(`Your developer key could not be created (HTTP ${res.status}): ${data?.error ?? 'no reason given'}`);
      }
      return data.key;
    },
    userName: () => {
      try {
        return os.userInfo().username;
      } catch {
        return 'developer';
      }
    },
    defaultRepository: repositoryOf(root),
  };
}
