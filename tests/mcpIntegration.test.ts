import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb, upsertObject, rebuildFts } from '../src/indexer/db.js';
import { descriptorXml, projectXml, treeSnapshot } from './workspaceFixtures.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repoRoot, 'dist', 'src', 'index.js');
const apiKey = 'integration-test-only-key-000000000000000000';
let root: string;
let environment: Record<string, string>;
const clients: Client[] = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  if (!fs.existsSync(entry)) throw new Error('Run npm run build before the compiled MCP integration tests.');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-mcp-smoke-'));
  const packages = path.join(root, 'packages');
  const classDir = path.join(packages, 'Package', 'Model', 'AxClass');
  fs.mkdirSync(classDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'tests', 'fixtures', 'AxClassSample.xml'), path.join(classDir, 'SampleClass.xml'));
  const dbPath = path.join(root, 'index.db');
  const db = openDb(dbPath);
  upsertObject(db, {
    type: 'Class', name: 'AlreadyIndexed', package: 'Package', model: 'Model',
    file_path: path.join(classDir, 'AlreadyIndexed.xml'), raw_xml: '', file_mtime: 1,
  });
  rebuildFts(db);
  db.close();
  environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !/^(D365_|MCP_|DOTENV_)/.test(entry[0])
    )),
    D365_PACKAGES_DIR: packages,
    D365_INDEX_DB_PATH: dbPath,
    D365_INDEX_ON_START: '0',
    D365_ENABLE_WRITE_TOOLS: '0',
    MCP_API_KEY: apiKey,
    MCP_PORT: '0',
  };
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function connect(transport: 'http' | 'stdio', indexOnStart: boolean): Promise<Client> {
  const client = new Client({ name: 'd365-integration-test', version: '1.0.0' });
  clients.push(client);
  const env = { ...environment, MCP_TRANSPORT: transport, D365_INDEX_ON_START: indexOnStart ? '1' : '0' };
  if (transport === 'stdio') {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [entry, 'serve'], env, cwd: root, stderr: 'pipe',
    }));
  } else {
    const child = spawn(process.execPath, [entry, 'serve'], { env, cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stderr! });
      let stderr = '';
      const timeout = setTimeout(() => reject(new Error(`MCP startup timed out: ${stderr}`)), 15_000);
      const cleanup = () => { clearTimeout(timeout); lines.close(); };
      child.once('error', (err) => { cleanup(); reject(err); });
      child.once('exit', (code) => { cleanup(); reject(new Error(`MCP exited (${code}): ${stderr}`)); });
      lines.on('line', (line) => {
        stderr += `${line}\n`;
        if (!line.startsWith('{')) return;
        const message = JSON.parse(line) as { message: string; port?: number };
        if (message.message === 'MCP HTTP transport listening' && message.port) {
          cleanup();
          resolve(message.port);
        }
      });
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { 'X-API-Key': apiKey } },
    }));
  }
  return client;
}

async function search(client: Client, query: string): Promise<unknown[]> {
  const result = await client.callTool({ name: 'search_symbols', arguments: { query } });
  expect(result.isError).not.toBe(true);
  if (!Array.isArray(result.content) || !result.content[0] || result.content[0].type !== 'text') {
    throw new Error('Search tool did not return text content.');
  }
  return JSON.parse(result.content[0].text) as unknown[];
}

describe.each(['stdio', 'http'] as const)('compiled MCP server over %s', (transport) => {
  it('initializes, exposes resources/prompts, calls actual tools, and disables writes/indexing', async () => {
    const client = await connect(transport, false);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain('get_visual_studio_workspace');
    expect(tools).not.toContain('write_table_extension');
    expect(tools).not.toContain('digest_knowledge');
    expect((await client.listResources()).resources.length).toBeGreaterThan(0);
    expect((await client.listPrompts()).prompts.length).toBeGreaterThan(0);
    expect(await search(client, 'AlreadyIndexed')).toHaveLength(1);
    expect(await search(client, 'SampleClass')).toHaveLength(0);
    await expect(client.callTool({
      name: 'write_table_extension', arguments: {},
    })).resolves.toMatchObject({ isError: true });
    expect(await client.callTool({
      name: 'get_visual_studio_workspace', arguments: {},
    })).toMatchObject({ isError: true });
  }, 30_000);

  it('performs startup indexing only with the flag enabled', async () => {
    const client = await connect(transport, true);
    await expect.poll(async () => (await search(client, 'SampleClass')).length, { timeout: 10_000 }).toBe(1);
  }, 30_000);

  it('previews and applies a synthetic supported offline project through the real protocol', async () => {
    const workspace = path.join(root, 'workspace');
    const metadata = path.join(root, 'metadata');
    const modelDir = path.join(metadata, 'MyPackage', 'My Model');
    const descriptorDir = path.join(metadata, 'MyPackage', 'Descriptor');
    fs.mkdirSync(workspace);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(descriptorDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'MyProject.rnrproj'), projectXml());
    fs.writeFileSync(path.join(workspace, 'Workspace.slnx'), '<Solution><Project Path="MyProject.rnrproj" /></Solution>');
    fs.writeFileSync(path.join(descriptorDir, 'My Model.xml'), descriptorXml());
    Object.assign(environment, {
      D365_ENABLE_WRITE_TOOLS: '1',
      D365_CUSTOM_METADATA_DIR: metadata,
      D365_VISUAL_STUDIO_WORKSPACE_DIR: workspace,
      D365_TARGET_SOLUTION: 'Workspace.slnx',
      D365_WRITABLE_MODELS: 'MyPackage/My Model',
    });
    const db = openDb(environment.D365_INDEX_DB_PATH);
    upsertObject(db, {
      type: 'Table', name: 'ExampleTable', package: 'Package', model: 'Model',
      file_path: path.join(root, 'ExampleTable.xml'), raw_xml: '', file_mtime: 1,
    });
    db.close();
    const client = await connect(transport, false);
    const beforeMetadata = treeSnapshot(metadata);
    const beforeProject = fs.readFileSync(path.join(workspace, 'MyProject.rnrproj'));
    const preview = await client.callTool({
      name: 'write_table_extension',
      arguments: { tableName: 'ExampleTable', extensionName: 'SmokeExtension', fields: [] },
    });
    expect(preview.isError).not.toBe(true);
    if (!Array.isArray(preview.content) || preview.content[0]?.type !== 'text') throw new Error('Expected a preview.');
    const { changeId, state } = JSON.parse(preview.content[0].text) as { changeId: string; state: string };
    expect(state).toBe('preview');
    expect(treeSnapshot(metadata)).toEqual(beforeMetadata);
    expect(fs.readFileSync(path.join(workspace, 'MyProject.rnrproj'))).toEqual(beforeProject);

    const refused = await client.callTool({
      name: 'apply_table_extension_change', arguments: { changeId, acknowledgeOfflineProject: false },
    });
    expect(refused.isError).toBe(true);
    const applied = await client.callTool({
      name: 'apply_table_extension_change', arguments: { changeId, acknowledgeOfflineProject: true },
    });
    expect(applied.isError).not.toBe(true);
    expect(fs.readFileSync(path.join(modelDir, 'AxTableExtension', 'ExampleTable.SmokeExtension.xml'), 'utf8'))
      .toContain('<Name>ExampleTable.SmokeExtension</Name>');
    expect(fs.readFileSync(path.join(workspace, 'MyProject.rnrproj'), 'utf8'))
      .toContain('AxTableExtension\\ExampleTable.SmokeExtension');
    expect((await client.callTool({
      name: 'apply_table_extension_change', arguments: { changeId, acknowledgeOfflineProject: true },
    })).isError).toBe(true);
  }, 30_000);
});
