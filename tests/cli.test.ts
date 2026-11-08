import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { parse } from 'dotenv';
import { HELP_TEXT } from '../src/cli/args.js';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const fixturesDir = path.join(testDir, 'fixtures');
const entry = path.join(repoRoot, 'src', 'index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string>, cwd: string, input = ''): Promise<RunResult> {
  try {
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(D365_|MCP_|DOTENV_)/.test(name))
    );
    const run = execFileAsync(process.execPath, ['--import', tsx, entry, ...args], {
      cwd,
      env: { ...inheritedEnv, ...env },
      timeout: 120_000,
    });
    // execFile leaves the child's stdin open, so a command that reads it would wait for the timeout.
    run.child.stdin?.end(input);
    const { stdout, stderr } = await run;
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

function stagePackages(root: string) {
  const layout: [string, string, string][] = [
    ['AxTable', 'AxTableSample.xml', 'SampleTable'],
    ['AxClass', 'AxClassSample.xml', 'SampleClass'],
    ['AxEnum', 'AxEnumSample.xml', 'SampleEnum'],
  ];
  for (const [typeDir, fixture, name] of layout) {
    const dir = path.join(root, 'TestPackage', 'TestModel', typeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(fixturesDir, fixture), path.join(dir, `${name}.xml`));
  }
}

describe('CLI', () => {
  let workDir: string;
  let packagesDir: string;
  let dbPath: string;
  let baseEnv: Record<string, string>;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-'));
    packagesDir = path.join(workDir, 'PackagesLocalDirectory');
    stagePackages(packagesDir);
    dbPath = path.join(workDir, 'index.db');
    baseEnv = {
      D365_PACKAGES_DIR: packagesDir,
      D365_INDEX_DB_PATH: dbPath,
      MCP_API_KEY: 'a'.repeat(40),
      DOTENV_CONFIG_PATH: path.join(workDir, '.env.absent'),
    };
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('doctor passes with a valid environment', async () => {
    const res = await runCli(['doctor'], baseEnv, workDir);
    expect(res.stdout).toContain('metadata-files');
    expect(res.stdout).toContain('0 failed');
    expect(res.code).toBe(0);
  }, 120_000);

  it('doctor says where an index for serve comes from when nothing is indexed yet', async () => {
    // Its own database, so the answer does not depend on which other tests have run.
    const res = await runCli(['doctor'], { ...baseEnv, D365_INDEX_DB_PATH: path.join(workDir, 'unindexed.db') }, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[WARN] db-objects');
    expect(res.stdout).toContain('Next: point D365_INDEX_DB_PATH at an index built by the hosted worker');
  }, 120_000);

  it('doctor points a machine with nothing configured at setup', async () => {
    const res = await runCli(
      ['doctor'],
      { D365_INDEX_DB_PATH: path.join(workDir, 'fresh.db'), DOTENV_CONFIG_PATH: baseEnv.DOTENV_CONFIG_PATH },
      workDir
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[FAIL] packages-dir');
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server setup`.');
  }, 120_000);

  it('doctor fails when packages dir is missing', async () => {
    const res = await runCli(
      ['doctor'],
      { ...baseEnv, D365_PACKAGES_DIR: path.join(workDir, 'nope') },
      workDir
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[FAIL] packages-dir');
  }, 120_000);

  it('doctor fails on a malformed API key without echoing it', async () => {
    const res = await runCli(['doctor'], { ...baseEnv, MCP_API_KEY: 'shortkey' }, workDir);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[FAIL] api-keys');
    expect(res.stdout).not.toContain('shortkey');
  }, 120_000);

  it('doctor fails an HTTP deployment without API keys', async () => {
    const env = { ...baseEnv };
    delete env.MCP_API_KEY;
    const res = await runCli(['doctor'], env, workDir);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[FAIL] api-keys');
  }, 120_000);

  it('doctor accepts named keys from MCP_API_KEYS', async () => {
    const env = { ...baseEnv, MCP_API_KEYS: `alice=${'a'.repeat(40)},bob=${'b'.repeat(40)}` };
    delete (env as Record<string, string>).MCP_API_KEY;
    const res = await runCli(['doctor'], env, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[PASS] api-keys: 2 API key(s) configured: alice, bob');
  }, 120_000);

  it('index refuses: full local indexes are no longer supported', async () => {
    const untouched = path.join(workDir, 'never-built.db');
    const res = await runCli(['index', '--force'], { ...baseEnv, D365_INDEX_DB_PATH: untouched }, workDir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Full local indexes are no longer supported. Local mode indexes only your custom models (setup --mode local)');
    expect(fs.existsSync(untouched)).toBe(false);
  }, 120_000);

  it('doctor on a healthy, indexed machine has no warnings and says to serve', async () => {
    const healthy = path.join(workDir, 'healthy.db');
    const { runIndexPass } = await import('../src/cli/index-command.js');
    await runIndexPass(packagesDir, healthy, false);
    const res = await runCli(['doctor'], { ...baseEnv, D365_INDEX_DB_PATH: healthy }, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('0 failed, 0 warning(s)');
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server serve`');
    expect(res.stdout).not.toContain('workspace-capabilities');
  }, 120_000);

  it('setup --non-interactive --mode local writes the custom models folder, and keeps an existing .env without --force', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const env = { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') };
    const args = ['setup', '--non-interactive', '--mode', 'local', '--custom-dir', packagesDir];
    const res = await runCli(args, env, setupDir);

    expect(res.code).toBe(0);
    const envFile = fs.readFileSync(path.join(setupDir, '.env'), 'utf-8');
    expect(parse(envFile)).toEqual({ D365_CUSTOM_METADATA_DIR: packagesDir });
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server gateway`.');

    const again = await runCli(args, env, setupDir);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('--force');
    expect(fs.readFileSync(path.join(setupDir, '.env'), 'utf-8')).toBe(envFile);
    fs.chmodSync(path.join(setupDir, '.env'), 0o644);
    expect((await runCli([...args, '--force'], env, setupDir)).code).toBe(0);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(setupDir, '.env')).mode & 0o777).toBe(0o600);
    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('setup refuses the flags of the removed full-local-index mode by name', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const res = await runCli(
      ['setup', '--non-interactive', '--packages-dir', packagesDir, '--api-key', 'k'.repeat(40)],
      { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') },
      setupDir
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--packages-dir is no longer supported: setup no longer builds a full local index.');
    expect(fs.existsSync(path.join(setupDir, '.env'))).toBe(false);
    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('setup --non-interactive --mode hosted writes the gateway settings', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const keyFile = path.join(setupDir, 'hosted-api-key');
    fs.writeFileSync(keyFile, 'hosted-key-0123456789-abcdef\n');
    const res = await runCli(
      [
        'setup',
        '--non-interactive',
        '--mode',
        'hosted',
        '--hosted-url',
        'https://hosted.example.com',
        '--hosted-api-key-file',
        keyFile,
        '--custom-dir',
        packagesDir,
      ],
      { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') },
      setupDir
    );

    expect(res.code).toBe(0);
    expect(parse(fs.readFileSync(path.join(setupDir, '.env'), 'utf-8'))).toEqual({
      D365_HOSTED_MCP_URL: 'https://hosted.example.com/mcp',
      D365_HOSTED_API_KEY_FILE: keyFile,
      D365_CUSTOM_METADATA_DIR: packagesDir,
    });
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server gateway`.');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(setupDir, '.env')).mode & 0o777).toBe(0o600);
    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('setup rejects a bare --mode and a value swallowed by --non-interactive, writing nothing', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const env = { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') };

    const bare = await runCli(['setup', '--non-interactive', '--mode'], env, setupDir);
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain('--mode needs a value.');

    const swallowed = await runCli(['setup', '--non-interactive', 'hosted'], env, setupDir);
    expect(swallowed.code).toBe(1);
    expect(swallowed.stderr).toContain('--non-interactive does not take a value');

    const unknown = await runCli(['setup', '--non-interactive', '--mode', 'cloud'], env, setupDir);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('--mode must be "local" or "hosted".');

    expect(fs.existsSync(path.join(setupDir, '.env'))).toBe(false);
    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('setup asks its questions on a pipe, reads every answer sent at once, and runs the real checks', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const answers = ['1', packagesDir, '', 'y'].join('\n') + '\n';
    const res = await runCli(['setup'], { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') }, setupDir, answers);

    expect(res.code).toBe(0);
    expect(parse(fs.readFileSync(path.join(setupDir, '.env'), 'utf-8'))).toEqual({ D365_CUSTOM_METADATA_DIR: packagesDir });
    expect(res.stdout).toContain('[PASS] gateway-hosted: local mode, no hosted server configured');
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server gateway`.');
    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('setup with nothing on stdin exits 1 and writes nothing, instead of exiting 0 silently', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const res = await runCli(['setup'], { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') }, setupDir);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Input ended before setup finished; nothing was written.');
    expect(fs.existsSync(path.join(setupDir, '.env'))).toBe(false);
    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('prepare-bundle writes bundle options and prints only its JSON summary on stdout', async () => {
    const versioned = path.join(workDir, 'cache', '10.0.2645.124', 'PackagesLocalDirectory');
    stagePackages(versioned);
    const securityDir = path.join(versioned, 'TestPackage', 'TestModel', 'AxSecurityRole');
    fs.mkdirSync(securityDir, { recursive: true });
    fs.copyFileSync(path.join(fixturesDir, 'AxSecurityRoleSample.xml'), path.join(securityDir, 'SampleClerkRole.xml'));
    const labelDir = path.join(versioned, 'TestPackage', 'TestModel', 'AxLabelFile', 'LabelResources', 'en-US');
    fs.mkdirSync(labelDir, { recursive: true });
    fs.writeFileSync(path.join(labelDir, 'SampleLabels.en-US.label.txt'), 'Account=Account\n');
    const acquired = { fileName: 'asset', sha256: 'f'.repeat(64), bytes: 1, acquiredAt: '2025-10-04T05:30:00Z' };
    const sources = path.join(workDir, 'sources.json');
    fs.writeFileSync(sources, JSON.stringify({
      schemaVersion: 1,
      applicationVersion: '10.0.2645.124',
      dataverseEnvironmentUri: 'https://contoso.crm.dynamics.com/',
      packagesLocalDirectory: versioned,
      sources: { systemmetadata: acquired, finopsvsix22: acquired, crossreference: acquired },
    }));
    const bundleOptions = path.join(workDir, 'bundle-options.json');
    const args = [
      'prepare-bundle', '--sources', sources, '--db-path', path.join(workDir, 'candidate.db'),
      '--bundle-options', bundleOptions, '--release-id', 'service-update-45',
    ];

    const res = await runCli(args, baseEnv, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('\r');
    expect(JSON.parse(res.stdout)).toEqual({
      applicationVersion: '10.0.2645.124',
      objects: 4,
      releaseId: 'service-update-45',
      bundleOptionsFile: bundleOptions,
    });
    expect(JSON.parse(fs.readFileSync(bundleOptions, 'utf8'))).toMatchObject({ releaseId: 'service-update-45' });

    const again = await runCli(args, baseEnv, workDir);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('Refusing to overwrite');
  }, 120_000);

  it('gateway prints every configuration problem and exits 1 without echoing the key', async () => {
    const key = 'hosted-secret-key-0123456789-abcdefghijklmnop';
    const res = await runCli(
      ['gateway'],
      { DOTENV_CONFIG_PATH: baseEnv.DOTENV_CONFIG_PATH, D365_HOSTED_MCP_URL: 'http://hosted.example.com/mcp', D365_HOSTED_API_KEY: key },
      workDir
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Gateway configuration validation failed');
    expect(res.stderr).toContain('D365_HOSTED_MCP_URL: must use https://');
    expect(res.stderr).toContain('D365_CUSTOM_METADATA_DIR: is required');
    expect(res.stdout + res.stderr).not.toContain(key);
    // Nothing was started or written beside the failing configuration.
    expect(fs.existsSync(path.join(workDir, '.d365'))).toBe(false);
  }, 120_000);

  it('doctor checks the gateway settings and the hosted server when D365_HOSTED_MCP_URL is set', async () => {
    const key = 'hosted-secret-key-0123456789-abcdefghijklmnop';
    const res = await runCli(
      ['doctor'],
      {
        ...baseEnv,
        // Port 9 (discard) refuses connections, so the hosted server counts as unreachable.
        D365_HOSTED_MCP_URL: 'http://127.0.0.1:9/mcp',
        D365_HOSTED_API_KEY: key,
        D365_CUSTOM_METADATA_DIR: packagesDir,
        D365_LOCAL_INDEX_DB_PATH: path.join(workDir, 'gateway-state', 'custom_index.db'),
        D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '2000',
      },
      workDir
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[PASS] gateway-config');
    expect(res.stdout).toContain('[PASS] gateway-custom-dir');
    expect(res.stdout).toContain('[PASS] gateway-local-index');
    expect(res.stdout).toContain('[FAIL] gateway-hosted-health');
    expect(res.stdout).toContain('Next: fix the failed checks above (gateway-hosted-health)');
    expect(res.stdout + res.stderr).not.toContain(key);
  }, 120_000);

  it('exits non-zero for an unknown command', async () => {
    const res = await runCli(['bogus'], baseEnv, workDir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Unknown command: bogus');
  }, 120_000);

  it('prints help', async () => {
    const res = await runCli(['--help'], baseEnv, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Commands:');
    expect(res.stdout).toContain('prepare-bundle');
  }, 120_000);

  it('documents the gateway command and its environment in help', () => {
    expect(HELP_TEXT).toContain('gateway ');
    for (const name of ['D365_HOSTED_MCP_URL', 'D365_HOSTED_API_KEY', 'D365_CUSTOM_METADATA_DIR', 'D365_LOCAL_INDEX_DB_PATH', 'D365_GATEWAY_PORT', 'D365_GATEWAY_TOKEN']) {
      expect(HELP_TEXT).toContain(name);
    }
  });

  it('documents the setup modes and their flags in help', () => {
    for (const flag of ['--mode', '--index-path', '--deploy', '--hosted-url', '--hosted-api-key', '--hosted-api-key-file', '--custom-dir']) {
      expect(HELP_TEXT).toContain(flag);
    }
  });

  it('shows the same help text in the README CLI reference', () => {
    // Windows checkouts may convert the README to CRLF.
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf-8').replace(/\r\n/g, '\n');
    expect(readme).toContain(HELP_TEXT.trimEnd());
  });

  it('omits retired index transfer commands from help', () => {
    expect(HELP_TEXT).toContain('index-status');
    expect(HELP_TEXT).not.toMatch(/publish-index|pull-index|upload-index|D365_INDEX_URL|--server/);
  });
});
