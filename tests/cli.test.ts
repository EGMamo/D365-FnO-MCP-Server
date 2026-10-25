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

  it('doctor says to build the index when nothing is indexed yet', async () => {
    // Its own database, so the answer does not depend on which other tests have run.
    const res = await runCli(['doctor'], { ...baseEnv, D365_INDEX_DB_PATH: path.join(workDir, 'unindexed.db') }, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[WARN] db-objects');
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server index`');
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

  it('index --force reparses objects without deleting compiler usage data', async () => {
    const { openDb } = await import('../src/indexer/db.js');
    const { findUsageRefs } = await import('../src/indexer/xrefUsage.js');
    const { seedLegacyUsageRefs } = await import('./helpers/usageRefs.js');
    const seeded = openDb(dbPath);
    seedLegacyUsageRefs(seeded, [{
      sourceType: 'Class', sourceName: 'Caller', targetName: 'Target',
      referenceKind: 'Call', sourceTable: 'References', raw: {},
    }]);
    seeded.close();
    const res = await runCli(['index', '--force'], baseEnv, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Indexing complete');
    // stdout is a pipe here, so no progress counter (carriage returns, escape codes) is drawn.
    expect(res.stdout).not.toMatch(/[\r\x1b]/);
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = openDb(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM ax_objects').get() as { c: number };
    expect(findUsageRefs(db, 'Target')).toHaveLength(1);
    db.close();
    expect(count.c).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('doctor on a healthy, indexed machine has no warnings and says to serve', async () => {
    const healthyEnv = { ...baseEnv, D365_INDEX_DB_PATH: path.join(workDir, 'healthy.db') };
    expect((await runCli(['index'], healthyEnv, workDir)).code).toBe(0);
    const res = await runCli(['doctor'], healthyEnv, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('0 failed, 0 warning(s)');
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server serve`');
    expect(res.stdout).not.toContain('workspace-capabilities');
  }, 120_000);

  it('does not delete a damaged DB even with --force', async () => {
    const damaged = path.join(workDir, 'damaged.db');
    fs.writeFileSync(damaged, 'not-a-database');
    const res = await runCli(['index', '--force'], { ...baseEnv, D365_INDEX_DB_PATH: damaged }, workDir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--force never deletes');
    expect(fs.readFileSync(damaged, 'utf8')).toBe('not-a-database');
  });

  it('index fails without D365_PACKAGES_DIR', async () => {
    const res = await runCli(
      ['index'],
      { D365_INDEX_DB_PATH: dbPath, DOTENV_CONFIG_PATH: baseEnv.DOTENV_CONFIG_PATH },
      workDir
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('D365_PACKAGES_DIR is not set');
  }, 120_000);

  it('setup --non-interactive writes .env', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const apiKey = 'k'.repeat(40);
    const res = await runCli(
      [
        'setup',
        '--non-interactive',
        '--packages-dir',
        packagesDir,
        '--api-key',
        apiKey,
        '--db-path',
        './data/index.db',
      ],
      { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') },
      setupDir
    );

    expect(res.code).toBe(0);
    const envFile = fs.readFileSync(path.join(setupDir, '.env'), 'utf-8');
    expect(envFile).toContain(`MCP_API_KEY=${apiKey}`);
    expect(envFile).toContain(`D365_PACKAGES_DIR=${packagesDir}`);
    expect(envFile).toContain('D365_INDEX_DB_PATH=./data/index.db');
    expect(fs.existsSync(path.join(setupDir, 'data'))).toBe(true);

    // A second run leaves the existing file alone unless --force is given.
    const args = ['setup', '--non-interactive', '--packages-dir', packagesDir, '--api-key', 'n'.repeat(40)];
    const env = { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') };
    const again = await runCli(args, env, setupDir);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('--force');
    expect(fs.readFileSync(path.join(setupDir, '.env'), 'utf-8')).toBe(envFile);
    fs.chmodSync(path.join(setupDir, '.env'), 0o644);
    expect((await runCli([...args, '--force'], env, setupDir)).code).toBe(0);
    expect(fs.readFileSync(path.join(setupDir, '.env'), 'utf-8')).toContain(`MCP_API_KEY=${'n'.repeat(40)}`);
    // The replaced file holds a new key, so it must not stay readable by others.
    if (process.platform !== 'win32') expect(fs.statSync(path.join(setupDir, '.env')).mode & 0o777).toBe(0o600);

    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('setup --non-interactive rejects a short api key', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const res = await runCli(
      ['setup', '--non-interactive', '--packages-dir', packagesDir, '--api-key', 'short'],
      { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') },
      setupDir
    );
    expect(res.code).toBe(1);
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

  it('setup --non-interactive writes MCP_HOST only when --host is given', async () => {
    const withHost = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const without = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const args = ['setup', '--non-interactive', '--packages-dir', packagesDir, '--api-key', 'h'.repeat(40)];

    expect((await runCli([...args, '--host', '127.0.0.1'], { DOTENV_CONFIG_PATH: path.join(withHost, '.env.absent') }, withHost)).code).toBe(0);
    expect((await runCli(args, { DOTENV_CONFIG_PATH: path.join(without, '.env.absent') }, without)).code).toBe(0);

    expect(parse(fs.readFileSync(path.join(withHost, '.env'), 'utf-8')).MCP_HOST).toBe('127.0.0.1');
    expect(parse(fs.readFileSync(path.join(without, '.env'), 'utf-8'))).not.toHaveProperty('MCP_HOST');
    fs.rmSync(withHost, { recursive: true, force: true });
    fs.rmSync(without, { recursive: true, force: true });
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

  it('setup runs the index and the checks it is asked for, then says to serve', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const answers = ['1', packagesDir, '', './own.db', 'y', 'y', 'y'].join('\n') + '\n';
    const res = await runCli(['setup'], { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') }, setupDir, answers);

    expect(res.code).toBe(0);
    // The real follow-ups ran, on the answers just given: the index first, then the checks that see it.
    expect(res.stdout).toContain('Indexing complete');
    expect(res.stdout).toContain('objects in db : 3');
    expect(res.stdout).toContain('[PASS] db-objects: 3 objects indexed');
    expect(res.stdout).toContain('0 failed, 0 warning(s)');
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server serve`.');
    expect(res.stdout).not.toMatch(/Next: run .*doctor/);
    expect(fs.existsSync(path.join(setupDir, 'own.db'))).toBe(true);
    fs.rmSync(setupDir, { recursive: true, force: true });
  }, 120_000);

  it('setup asks its questions on a pipe and reads every answer sent at once', async () => {
    const setupDir = fs.mkdtempSync(path.join(testDir, '.tmp-cli-setup-'));
    const answers = ['1', packagesDir, '', '', 'y', 'n', 'n'].join('\n') + '\n';
    const res = await runCli(['setup'], { DOTENV_CONFIG_PATH: path.join(setupDir, '.env.absent') }, setupDir, answers);

    expect(res.code).toBe(0);
    const written = parse(fs.readFileSync(path.join(setupDir, '.env'), 'utf-8'));
    expect(written.MCP_HOST).toBe('127.0.0.1');
    expect(written.D365_PACKAGES_DIR).toBe(packagesDir);
    expect(written.MCP_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(res.stdout).toContain('Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server index`, then `d365-fno-mcp-server serve`.');
    expect(res.stdout).not.toContain(written.MCP_API_KEY);
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
    for (const flag of ['--mode', '--host', '--hosted-url', '--hosted-api-key', '--hosted-api-key-file', '--custom-dir']) {
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
