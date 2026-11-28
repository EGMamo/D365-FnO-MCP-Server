#!/usr/bin/env node
// Builds the Node gateway the Visual Studio extension ships inside its VSIX, so a developer installs nothing:
//   <out>/node.exe            Node.js for Windows x64, the same version as the Node running this script,
//                             checked against the SHA-256 that nodejs.org publishes for it
//   <out>/app/src/...         the developer package (npm run build:client), whose `gateway` command the extension runs
//   <out>/app/node_modules    its production dependencies, plus mssql and (built on Windows) msnodesqlv8 for the
//                             opt-in cross-reference import
// The extension's build packs <out> into the VSIX when <out>/node.exe exists.
// Usage: node scripts/bundle-vs-node-gateway.mjs [--out <dir>] [--skip-node]
//   --skip-node leaves node.exe out (to try the app with the Node on PATH, on any OS).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(root, 'vs-extension', 'node-gateway'));
const skipNode = args.includes('--skip-node');
const app = path.join(out, 'app');

// npm is npm.cmd on Windows, which only a shell finds.
const run = (command, commandArgs, cwd) =>
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// The developer package: setup, gateway and doctor only, with the dependencies its code imports.
run('npm', ['run', 'build:client'], root);
run('node', [path.join('scripts', 'pack-client.mjs'), '--dry-run'], root);
fs.cpSync(path.join(root, 'dist-client'), app, { recursive: true });

const pkgPath = path.join(app, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// The cross-reference import (a developer option, off by default) loads mssql lazily.
pkg.dependencies = { ...pkg.dependencies, mssql: rootPkg.optionalDependencies.mssql };
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], app);
// Windows authentication to the cross-reference database needs the native msnodesqlv8 driver, built for this
// Node version and Windows x64; its install script fetches that binary, so it only installs on Windows.
if (process.platform === 'win32') {
  run('npm', ['install', 'msnodesqlv8', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--no-save'], app);
}

// Nothing reads source maps, type declarations or package docs at run time; they only make the VSIX bigger.
const unused = /\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i;
let removed = 0;
for (const file of fs.readdirSync(app, { recursive: true })) {
  const full = path.join(app, String(file));
  if (unused.test(full) && fs.statSync(full).isFile() && path.basename(full).toLowerCase() !== 'license.md') {
    fs.rmSync(full);
    removed++;
  }
}

if (!skipNode) {
  const version = process.version;
  const base = `https://nodejs.org/dist/${version}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
  if (!expected) throw new Error(`nodejs.org lists no win-x64/node.exe for ${version}.`);
  const response = await fetch(`${base}/win-x64/node.exe`);
  if (!response.ok) throw new Error(`Downloading node.exe ${version} failed: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`node.exe ${version} has SHA-256 ${actual}, not ${expected}.`);
  fs.writeFileSync(path.join(out, 'node.exe'), bytes);
  console.log(`node.exe ${version} (SHA-256 ${actual})`);
}

const files = fs.readdirSync(out, { recursive: true }).filter((file) => fs.statSync(path.join(out, String(file))).isFile());
console.log(`Node gateway bundle in ${out}: ${files.length} files (${removed} unused files removed).`);
