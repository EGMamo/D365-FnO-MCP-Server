import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from '../src/indexer/db.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWriterTools } from '../src/tools/writers.js';
import { seedDb, type ToolResult } from './helpers/toolHarness.js';

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectWriterTools(
  db: Database,
  options: { enableWriteTools: boolean; projectDir: string }
): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerWriterTools(fakeServer, db, options);
  return handlers;
}

let db: Database;
let projectDir: string;

beforeAll(() => {
  db = seedDb([
    {
      type: 'Table',
      name: 'CustTable',
      fields: [{ name: 'AccountNum', type: 'String', edt: 'CustAccount' }],
    },
    { type: 'Edt', name: 'CustAccount', properties: { edtType: 'String' } },
    { type: 'Class', name: 'ExistingObject' },
  ]);
});

afterEach(() => {
  if (projectDir && fs.existsSync(projectDir)) {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  db.close();
});

function freshProjectDir(): string {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-writer-'));
  return projectDir;
}

function tools() {
  return collectWriterTools(db, { enableWriteTools: true, projectDir: freshProjectDir() });
}

const goodArgs = {
  tableName: 'CustTable',
  extensionName: 'CustTableMyExt',
  packageName: 'MyPackage',
  modelName: 'MyModel',
  fields: [{ name: 'MyNewField', edt: 'CustAccount' }],
};

describe('write_table_extension', () => {
  it('is not registered when the feature flag is off', () => {
    const handlers = collectWriterTools(db, { enableWriteTools: false, projectDir: os.tmpdir() });
    expect(handlers.has('write_table_extension')).toBe(false);
  });

  it('is registered when the feature flag is on', () => {
    expect(tools().has('write_table_extension')).toBe(true);
  });

  it('writes the extension XML to the contained path', async () => {
    const handlers = tools();
    const res = await handlers.get('write_table_extension')!(goodArgs);
    expect(res.isError).toBeFalsy();

    const payload = JSON.parse(res.content[0].text) as { written: boolean; path: string };
    expect(payload.written).toBe(true);

    const expected = path.join(
      projectDir,
      'MyPackage',
      'MyModel',
      'AxTableExtension',
      'CustTableMyExt.xml'
    );
    expect(path.resolve(payload.path)).toBe(path.resolve(expected));
    const xml = fs.readFileSync(expected, 'utf-8');
    expect(xml).toContain('<AxTableExtension');
    expect(xml).toContain('CustTable.CustTableMyExt');
    expect(xml).toContain('MyNewField');
  });

  it('rejects path escapes via package/model segments', async () => {
    const handlers = tools();
    const res = await handlers.get('write_table_extension')!({
      ...goodArgs,
      packageName: '../../escape',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Write rejected');
    expect(fs.existsSync(path.resolve(projectDir, '..', '..', 'escape'))).toBe(false);
  });

  it('rejects an extension name that already exists in the index', async () => {
    const handlers = tools();
    const res = await handlers.get('write_table_extension')!({
      ...goodArgs,
      extensionName: 'ExistingObject',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('already exists in the index');
  });

  it('refuses to overwrite an existing file', async () => {
    const handlers = tools();
    const first = await handlers.get('write_table_extension')!(goodArgs);
    expect(first.isError).toBeFalsy();

    const second = await handlers.get('write_table_extension')!(goodArgs);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain('Refusing to overwrite');
  });

  it('fails grounding for an unknown EDT and writes nothing', async () => {
    const handlers = tools();
    const res = await handlers.get('write_table_extension')!({
      ...goodArgs,
      fields: [{ name: 'MyNewField', edt: 'NoSuchEdt' }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Grounding failed');
    expect(fs.existsSync(path.join(projectDir, 'MyPackage'))).toBe(false);
  });

  it('fails grounding for an unknown target table and writes nothing', async () => {
    const handlers = tools();
    const res = await handlers.get('write_table_extension')!({
      ...goodArgs,
      tableName: 'NoSuchTable',
    });
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(projectDir, 'MyPackage'))).toBe(false);
  });

  it('rejects duplicate field names', async () => {
    const handlers = tools();
    const res = await handlers.get('write_table_extension')!({
      ...goodArgs,
      fields: [
        { name: 'MyNewField', edt: 'CustAccount' },
        { name: 'mynewfield', edt: 'CustAccount' },
      ],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('duplicate field name');
  });
});
