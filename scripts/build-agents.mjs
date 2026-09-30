#!/usr/bin/env node
// Generates the GitHub Copilot and Claude Code agent files from agents/source/*.md.
// Usage: node scripts/build-agents.mjs [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'agents', 'source');
const copilotDir = path.join(root, 'agents', 'github-copilot');
const claudeDir = path.join(root, 'agents', 'claude-code');

export const D365_SERVER = 'd365-fno';
export const LEARN_SERVER = 'microsoft-learn';

const copilotFileTools = { read: ['read'], search: ['search'], edit: ['edit'] };
const claudeFileTools = { read: ['Read'], search: ['Grep', 'Glob'], edit: ['Edit', 'Write'] };

export function parseAgentSource(text, file = 'agent') {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: missing front matter`);
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) throw new Error(`${file}: bad front matter line '${line}'`);
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const list = (key) => (fields[key] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  const agent = {
    name: fields.name,
    description: fields.description,
    fileTools: list('file-tools'),
    d365Tools: list('d365-tools'),
    learnTools: list('learn-tools'),
    body: match[2].trim() + '\n',
  };
  if (!/^[a-z][a-z0-9-]*$/.test(agent.name ?? '')) throw new Error(`${file}: name must be lowercase-hyphenated`);
  if (!agent.description || agent.description.includes('"')) throw new Error(`${file}: description is required and must not contain double quotes`);
  for (const tool of agent.fileTools) {
    if (!(tool in copilotFileTools)) throw new Error(`${file}: unknown file tool '${tool}'`);
  }
  return agent;
}

function header(agent) {
  return `<!-- Generated from agents/source/${agent.name}.md by \`npm run build:agents\`. Edit the source, not this file. -->\n\n`;
}

export function renderCopilot(agent) {
  const tools = [
    ...agent.fileTools.flatMap((t) => copilotFileTools[t]),
    ...agent.d365Tools.map((t) => `${D365_SERVER}/${t}`),
    ...agent.learnTools.map((t) => `${LEARN_SERVER}/${t}`),
  ];
  return [
    '---',
    `name: ${agent.name}`,
    `description: "${agent.description}"`,
    'tools:',
    ...tools.map((t) => `  - '${t}'`),
    '---',
    '',
  ].join('\n') + header(agent) + agent.body;
}

export function renderClaude(agent) {
  const tools = [
    ...agent.fileTools.flatMap((t) => claudeFileTools[t]),
    ...agent.d365Tools.map((t) => `mcp__${D365_SERVER}__${t}`),
    ...agent.learnTools.map((t) => `mcp__${LEARN_SERVER}__${t}`),
  ];
  return [
    '---',
    `name: ${agent.name}`,
    `description: "${agent.description}"`,
    `tools: ${tools.join(', ')}`,
    '---',
    '',
  ].join('\n') + header(agent) + agent.body;
}

export function loadAgents(dir = sourceDir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseAgentSource(fs.readFileSync(path.join(dir, f), 'utf8'), f));
}

export function expectedFiles(agents = loadAgents()) {
  const files = new Map();
  for (const agent of agents) {
    files.set(path.join(copilotDir, `${agent.name}.agent.md`), renderCopilot(agent));
    files.set(path.join(claudeDir, `${agent.name}.md`), renderClaude(agent));
  }
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const files = expectedFiles();
  const stale = [];
  for (const [file, content] of files) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === content) continue;
    if (check) stale.push(path.relative(root, file));
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      console.log(`wrote ${path.relative(root, file)}`);
    }
  }
  for (const dir of [copilotDir, claudeDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (files.has(full)) continue;
      if (check) stale.push(path.relative(root, full));
      else {
        fs.rmSync(full);
        console.log(`removed ${path.relative(root, full)}`);
      }
    }
  }
  if (check && stale.length > 0) {
    console.error(`Agent files are out of date; run npm run build:agents:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
