import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');
const fixturesDir = path.join(testDir, 'fixtures');
const entry = path.join(repoRoot, 'src', 'index.ts');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [entry, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
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

  it('doctor warns on a short API key', async () => {
    const res = await runCli(['doctor'], { ...baseEnv, MCP_API_KEY: 'short' }, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[WARN] api-key');
  }, 120_000);

  it('index --force re-creates the DB and indexes fixtures', async () => {
    fs.writeFileSync(dbPath, 'not-a-database');

    const res = await runCli(['index', '--force'], baseEnv, workDir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Indexing complete');
    expect(fs.existsSync(dbPath)).toBe(true);

    const { openDb } = await import('../src/indexer/db.js');
    const db = openDb(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM ax_objects').get() as { c: number };
    db.close();
    expect(count.c).toBeGreaterThanOrEqual(3);
  }, 120_000);

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
