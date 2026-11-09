import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Builds the developer package into a temporary folder, packs it with --dry-run, and runs the built entry point.
describe('developer package (d365-fno-mcp-client)', () => {
  let out: string;
  let packed: { files: { path: string }[] }[];

  beforeAll(async () => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pack-'));
    await run(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.client.json', '--outDir', out], { cwd: root });
    // Its own npm cache, so the dry run writes nothing outside the temporary folder.
    const { stdout } = await run(process.execPath, [path.join(root, 'scripts', 'pack-client.mjs'), '--out', out, '--dry-run'], {
      cwd: root,
      env: { ...process.env, npm_config_cache: path.join(out, '.npm-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false' },
    });
    packed = JSON.parse(stdout) as { files: { path: string }[] }[];
    // What an install provides; linked after packing so it cannot end up in the package.
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(out, 'node_modules'), 'junction');
  }, 180_000);

  afterAll(() => {
    fs.rmSync(out, { recursive: true, force: true });
  });

  const cli = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await run(process.execPath, [path.join(out, 'src', 'clientIndex.js'), ...args], {
        cwd: out,
        env: { PATH: process.env.PATH ?? '', DOTENV_CONFIG_PATH: path.join(out, '.env.absent') },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };

  it('has the d365-fno-mcp bin only, the root version, and the dependencies its code imports', () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('d365-fno-mcp-client');
    expect(pkg.version).toBe(rootPkg.version);
    expect(pkg.bin).toEqual({ 'd365-fno-mcp': 'src/clientIndex.js' });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(
      ['@modelcontextprotocol/sdk', 'dotenv', 'express', 'express-rate-limit', 'fast-xml-parser', 'glob', 'yaml', 'zod'].sort()
    );
    for (const [name, version] of Object.entries(pkg.dependencies)) expect(version).toBe(rootPkg.dependencies[name]);
  });

  it('packs no operator file', () => {
    const files = packed[0].files.map((file) => file.path);
    expect(files.some((file) => file.startsWith('.npm-cache'))).toBe(false);
    expect(files).toContain('src/clientIndex.js');
    expect(files.filter((file) => /src\/(index|config|configLoader)\.js$|server\/start\.js|knowledge\/|artifact|azureBlob|-command\.js$/.test(file))).toEqual([]);
  });

  it('answers version and help with the developer commands only, and refuses the server commands', async () => {
    const version = await cli(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = await cli(['help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('d365-fno-mcp <command>');
    for (const word of ['serve', 'prepare-bundle', 'artifact', 'keys']) expect(help.stdout).not.toMatch(new RegExp(`^  ${word}\\b`, 'm'));
    for (const command of ['serve', 'keys', 'index', 'artifact']) {
      const refused = await cli([command]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('the server commands are in the operator package');
    }
  }, 60_000);
});
