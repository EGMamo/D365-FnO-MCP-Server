import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'node:module';
import { startStaticServer, type StaticServer } from './helpers/indexFixtureServer.js';

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

async function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  try {
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !/^(D365_|MCP_|DOTENV_)/.test(name))
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', tsx, entry, ...args], {
      cwd,
      env: { ...inheritedEnv, ...env },
      timeout: 120_000,
    });
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

  it('doctor fails when packages dir is missing', async () => {
    const res = await runCli(
      ['doctor'],
      { ...baseEnv, D365_PACKAGES_DIR: path.join(workDir, 'nope') },
      workDir
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('[FAIL] packages-dir');
  }, 120_000);

  it('doctor warns on a short API key without echoing it', async () => {
    const res = await runCli(['doctor'], { ...baseEnv, MCP_API_KEY: 'shortkey' }, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[WARN] api-keys');
    expect(res.stdout).not.toContain('shortkey');
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
    const { replaceUsageRefs, findUsageRefs } = await import('../src/indexer/xrefUsage.js');
    const seeded = openDb(dbPath);
    replaceUsageRefs(seeded, [{
      sourceType: 'Class', sourceName: 'Caller', targetName: 'Target',
      referenceKind: 'Call', sourceTable: 'References', raw: {},
    }]);
    seeded.close();
    const res = await runCli(['index', '--force'], baseEnv, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Indexing complete');
    expect(fs.existsSync(dbPath)).toBe(true);

    const db = openDb(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM ax_objects').get() as { c: number };
    expect(findUsageRefs(db, 'Target')).toHaveLength(1);
    db.close();
    expect(count.c).toBeGreaterThanOrEqual(3);
  }, 120_000);

  describe('published index', () => {
    let publishDir: string;
    let server: StaticServer;
    let manifestUrl: string;

    beforeAll(async () => {
      publishDir = path.join(workDir, 'publish');
    });

    afterAll(async () => {
      if (server) await server.close();
    });

    it('publish-index packages an indexed database', async () => {
      const res = await runCli(['publish-index', '--db-path', dbPath, '--out', publishDir], baseEnv, workDir);
      expect(res.stderr).toBe('');
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Published:');
      expect(fs.existsSync(path.join(publishDir, 'latest', 'manifest.json'))).toBe(true);
      server = await startStaticServer(publishDir);
      manifestUrl = `${server.baseUrl}/latest/manifest.json?sv=test`;
    }, 120_000);

    it('publish-index refuses a database that was never indexed', async () => {
      const { openDb } = await import('../src/indexer/db.js');
      const empty = path.join(workDir, 'empty.db');
      openDb(empty).close();
      const res = await runCli(['publish-index', '--db-path', empty, '--out', path.join(workDir, 'empty-out')], baseEnv, workDir);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('run `index`');
    }, 120_000);

    it('doctor --hosted validates a deployment without a packages directory', async () => {
      const env = {
        D365_INDEX_URL: manifestUrl,
        D365_INDEX_DB_PATH: path.join(workDir, 'hosted', 'index.db'),
        MCP_API_KEYS: `alice=${'a'.repeat(40)}`,
        TRUST_PROXY_HOPS: '1',
        DOTENV_CONFIG_PATH: baseEnv.DOTENV_CONFIG_PATH,
      };
      fs.mkdirSync(path.join(workDir, 'hosted'), { recursive: true });
      const res = await runCli(['doctor', '--hosted'], env, workDir);
      expect(res.stdout).toContain('[PASS] index-url');
      expect(res.stdout).toContain('[PASS] api-keys');
      expect(res.stdout).toContain('[PASS] trust-proxy');
      expect(res.stdout).toContain('[WARN] db-objects');
      expect(res.stdout).not.toContain('metadata-files');
      expect(res.stdout).not.toContain('sv=test');
      expect(res.code).toBe(0);
    }, 120_000);

    it('doctor fails a hosted deployment without API keys', async () => {
      const env = {
        D365_INDEX_URL: manifestUrl,
        D365_INDEX_DB_PATH: path.join(workDir, 'hosted', 'index.db'),
        DOTENV_CONFIG_PATH: baseEnv.DOTENV_CONFIG_PATH,
      };
      const res = await runCli(['doctor'], env, workDir);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('[FAIL] api-keys');
    }, 120_000);

    it('pull-index downloads the published index', async () => {
      const pulled = path.join(workDir, 'pulled', 'index.db');
      const res = await runCli(['pull-index', '--url', manifestUrl, '--db-path', pulled], baseEnv, workDir);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Downloaded the published index.');
      // Neither the summary nor the progress log may leak the SAS query string.
      expect(res.stdout).not.toContain('sv=test');
      expect(res.stderr).not.toContain('sv=test');
      const { openDb } = await import('../src/indexer/db.js');
      const db = openDb(pulled);
      const count = db.prepare('SELECT COUNT(*) as c FROM ax_objects').get() as { c: number };
      db.close();
      expect(count.c).toBeGreaterThanOrEqual(3);

      const again = await runCli(['pull-index', '--url', manifestUrl, '--db-path', pulled], baseEnv, workDir);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('already matches');
    }, 120_000);
  });

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

  it('exits non-zero for an unknown command', async () => {
    const res = await runCli(['bogus'], baseEnv, workDir);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Unknown command: bogus');
  }, 120_000);

  it('prints help', async () => {
    const res = await runCli(['--help'], baseEnv, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Commands:');
  }, 120_000);
});
