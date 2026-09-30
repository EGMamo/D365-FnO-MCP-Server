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
import { openDb, upsertObject, rebuildFts, setMeta, META_KEYS, INDEX_SCHEMA_VERSION } from '../src/indexer/db.js';
import { publishIndex, snapshotIndex } from '../src/indexer/publishIndex.js';
import { compressFile } from '../src/indexer/compression.js';
import { IndexUploadClient } from '../src/indexer/uploadClient.js';
import { descriptorXml, projectXml, treeSnapshot } from './workspaceFixtures.js';
import { startStaticServer, type StaticServer } from './helpers/indexFixtureServer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repoRoot, 'dist', 'src', 'index.js');
const apiKey = 'integration-test-only-key-000000000000000000';
let root: string;
let environment: Record<string, string>;
const clients: Client[] = [];
const children: ChildProcess[] = [];
const staticServers: StaticServer[] = [];

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
  // Build metadata lets the hosted-mode case publish this database as-is.
  setMeta(db, META_KEYS.builtAt, '2026-09-25T20:00:00.000Z');
  setMeta(db, META_KEYS.serverVersion, '0.1.0');
  setMeta(db, META_KEYS.storeRawXml, '1');
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
  await Promise.all(staticServers.splice(0).map((server) => server.close()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

let lastHttpPort = 0;

async function connect(
  transport: 'http' | 'stdio',
  indexOnStart: boolean,
  baseEnv: Record<string, string> = environment
): Promise<Client> {
  const client = new Client({ name: 'd365-integration-test', version: '1.0.0' });
  clients.push(client);
  const env = { ...baseEnv, MCP_TRANSPORT: transport, D365_INDEX_ON_START: indexOnStart ? '1' : '0' };
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
    lastHttpPort = port;
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { 'X-API-Key': apiKey } },
    }));
  }
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!Array.isArray(result.content) || !result.content[0] || result.content[0].type !== 'text') {
    throw new Error('Tool did not return text content.');
  }
  return result.content[0].text as string;
}

async function search(client: Client, query: string): Promise<unknown[]> {
  const result = await client.callTool({ name: 'search_symbols', arguments: { query } });
  expect(result.isError).not.toBe(true);
  return JSON.parse(textOf(result)) as unknown[];
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

describe('compiled MCP server in hosted mode', () => {
  it('serves a published index over http with named keys and no packages directory', async () => {
    const publishDir = path.join(root, 'publish');
    const { manifest } = await publishIndex({
      dbPath: environment.D365_INDEX_DB_PATH, outDir: publishDir, serverVersion: '0.1.0',
    });
    const server = await startStaticServer(publishDir);
    staticServers.push(server);

    const hostedDb = path.join(root, 'hosted', 'index.db');
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(environment).filter(
        ([name]) => name !== 'D365_PACKAGES_DIR' && name !== 'MCP_API_KEY'
      )),
      D365_INDEX_URL: `${server.baseUrl}/latest/manifest.json?sv=test`,
      D365_INDEX_DB_PATH: hostedDb,
      MCP_API_KEYS: `alice=${apiKey}`,
    };
    const client = await connect('http', false, env);

    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain('search_symbols');
    expect(tools).not.toContain('write_table_extension');
    expect(await search(client, 'AlreadyIndexed')).toHaveLength(1);
    expect(fs.existsSync(hostedDb)).toBe(true);

    const stats = JSON.parse(textOf(await client.callTool({ name: 'get_index_stats', arguments: {} }))) as {
      builtAt: string; totalObjects: number;
    };
    expect(stats.builtAt).toBe(manifest.builtAt);
    expect(stats.totalObjects).toBe(1);

    const staleness = JSON.parse(textOf(await client.callTool({ name: 'get_index_staleness', arguments: {} }))) as {
      mode: string; version: string; builtAt: string; manifestUrl: string;
    };
    expect(staleness.mode).toBe('published');
    expect(staleness.version).toBe(manifest.version);
    expect(staleness.builtAt).toBe(manifest.builtAt);
    expect(staleness.manifestUrl).toBe(`${server.baseUrl}/latest/manifest.json`);

    // The published index names a file that exists on this machine, but paths from
    // an index built elsewhere are never followed.
    const indexedFile = path.join(root, 'packages', 'Package', 'Model', 'AxClass', 'AlreadyIndexed.xml');
    fs.writeFileSync(indexedFile, '<AxClass><Name>SecretOnHost</Name></AxClass>');
    const xml = textOf(await client.callTool({ name: 'get_element_xml', arguments: { name: 'AlreadyIndexed', type: 'Class' } }));
    expect(xml).not.toContain('SecretOnHost');
    expect(xml).toContain('not available on this server');
  }, 30_000);

  it('runs over stdio without any API key', async () => {
    const client = await connect('stdio', false, { ...environment, MCP_API_KEY: '' });
    expect(await search(client, 'AlreadyIndexed')).toHaveLength(1);
  }, 30_000);
});

describe('compiled MCP server index upload', () => {
  it('swaps in an uploaded index, closes old sessions, and keeps it across a restart', async () => {
    environment.D365_INDEX_UPLOAD_KEYS = 'default';
    const first = await connect('http', false);
    expect(await search(first, 'AlreadyIndexed')).toHaveLength(1);

    const source = path.join(root, 'upload-source.db');
    const db = openDb(source);
    upsertObject(db, {
      type: 'Class', name: 'UploadedClass', package: 'Package', model: 'Model',
      file_path: 'Package/Model/AxClass/UploadedClass.xml', raw_xml: '<AxClass/>', file_mtime: 1,
    });
    rebuildFts(db);
    setMeta(db, META_KEYS.builtAt, '2026-09-26T09:00:00.000Z');
    setMeta(db, META_KEYS.serverVersion, '0.1.0');
    setMeta(db, META_KEYS.storeRawXml, '1');
    setMeta(db, META_KEYS.schemaVersion, String(INDEX_SCHEMA_VERSION));
    db.close();
    const snapshot = snapshotIndex(source, path.join(root, 'upload-snapshot.db'));
    const packageFile = path.join(root, 'upload.gz');
    const packed = await compressFile(snapshot.file, packageFile, 'gzip', 'fastest');

    const baseUrl = `http://127.0.0.1:${lastHttpPort}`;
    const outcome = await new IndexUploadClient(baseUrl, apiKey).upload({
      serverUrl: baseUrl, apiKey, packageFile, packed, objects: snapshot.stats.objects, chunkSize: 2048, pollIntervalMs: 20,
    });
    expect(outcome).toMatchObject({ state: 'completed', checksumMatches: true });
    expect(await new IndexUploadClient(baseUrl, apiKey).info()).toMatchObject({
      index: { source: 'upload', objects: 1, uploadedBy: 'default', builtAt: '2026-09-26T09:00:00.000Z' },
    });

    // The session opened on the old index was closed by the swap.
    await expect(first.callTool({ name: 'search_symbols', arguments: { query: 'AlreadyIndexed' } })).rejects.toThrow();
    const second = await connect('http', false);
    expect(await search(second, 'UploadedClass')).toHaveLength(1);
    expect(await search(second, 'AlreadyIndexed')).toHaveLength(0);
    const staleness = JSON.parse(textOf(await second.callTool({ name: 'get_index_staleness', arguments: {} })));
    expect(staleness).toMatchObject({ mode: 'published', source: 'upload', uploadedBy: 'default' });

    // A restart serves the uploaded index from disk.
    for (const child of children.splice(0)) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    const third = await connect('http', false);
    expect(await search(third, 'UploadedClass')).toHaveLength(1);
  }, 60_000);
});
