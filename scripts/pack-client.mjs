#!/usr/bin/env node
// Packs the developer package (d365-fno-mcp-client, command d365-fno-mcp) from dist-client, built by
// `npm run build:client`. Its dependencies are computed from the bare imports the build contains, with the
// versions of the root package.json, so the list cannot drift from the code. Optional dependencies (loaded
// lazily, such as mssql for index-xref) are left out. Usage: node scripts/pack-client.mjs [--out <dir>] [--dry-run]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(root, 'dist-client'));
const dryRun = args.includes('--dry-run');

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const entry = path.join(out, 'src', 'clientIndex.js');
if (!fs.existsSync(entry)) {
  console.error(`No developer build at ${out}; run npm run build:client first.`);
  process.exit(1);
}

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const imports = new Set();
for (const file of fs.readdirSync(out, { recursive: true })) {
  if (!String(file).endsWith('.js') || String(file).startsWith('node_modules')) continue;
  const text = fs.readFileSync(path.join(out, String(file)), 'utf8');
  // The compiler's own scan: static imports, re-exports and import() calls, nothing inside strings or comments.
  for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (builtins.has(spec) || builtins.has(spec.split('/')[0])) continue;
    const parts = spec.split('/');
    imports.add(spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
}

const dependencies = {};
const optional = rootPkg.optionalDependencies ?? {};
for (const name of [...imports].sort()) {
  if (name in optional) continue;
  const version = rootPkg.dependencies?.[name];
  if (!version) {
    console.error(`The developer build imports ${name}, which is not a dependency of the root package.`);
    process.exit(1);
  }
  dependencies[name] = version;
}

const pkg = {
  name: 'd365-fno-mcp-client',
  version: rootPkg.version,
  description: 'Developer package of the D365 FnO MCP server: setup, the local gateway (custom models, with or without a hosted server) and doctor.',
  type: rootPkg.type,
  bin: { 'd365-fno-mcp': 'src/clientIndex.js' },
  files: ['src', 'agents/claude-code', 'agents/github-copilot', 'README.md', 'LICENSE'],
  engines: rootPkg.engines,
  license: rootPkg.license,
  repository: rootPkg.repository,
  dependencies,
};
fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
fs.copyFileSync(path.join(root, 'docs', 'client-readme.md'), path.join(out, 'README.md'));
// The built agent definitions only; agents/source is the input of npm run build:agents.
for (const folder of ['claude-code', 'github-copilot']) {
  fs.cpSync(path.join(root, 'agents', folder), path.join(out, 'agents', folder), { recursive: true });
}
fs.chmodSync(entry, 0o755);

const packArgs = ['pack', ...(dryRun ? ['--dry-run', '--json'] : [])];
// npm is npm.cmd on Windows, which only a shell finds.
const result = execFileSync('npm', packArgs, { cwd: out, encoding: 'utf8', shell: process.platform === 'win32' });
process.stdout.write(result);
