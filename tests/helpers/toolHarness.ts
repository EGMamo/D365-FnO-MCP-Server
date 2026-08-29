import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from 'better-sqlite3';
import {
  openDb,
  upsertObject,
  upsertFields,
  upsertMethods,
  upsertProperties,
  upsertLabels,
} from '../../src/indexer/db.js';
import { registerGeneratorTools } from '../../src/tools/generators.js';

export interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Minimal McpServer stand-in that captures registered tool handlers. */
export function collectGeneratorTools(db: Database): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  registerGeneratorTools(fakeServer, db);
  return handlers;
}

export interface SeedObject {
  type: string;
  name: string;
  package?: string;
  raw_xml?: string;
  fields?: { name: string; type?: string; edt?: string }[];
  methods?: { name: string; accessModifier?: string; returnType?: string; params?: unknown[] }[];
  properties?: Record<string, unknown>;
}

export function seedDb(
  objects: SeedObject[],
  labels: { labelId: string; value: string }[] = []
): Database {
  const db = openDb(':memory:');
  for (const obj of objects) {
    const id = upsertObject(db, {
      type: obj.type,
      name: obj.name,
      package: obj.package ?? 'TestPackage',
      model: 'TestModel',
      file_path: `/fake/${obj.name}.xml`,
      raw_xml: obj.raw_xml ?? `<${obj.type}><Name>${obj.name}</Name></${obj.type}>`,
      file_mtime: 1,
    });
    upsertFields(db, id, obj.fields ?? []);
    upsertMethods(db, id, obj.methods ?? []);
    upsertProperties(db, id, obj.properties ?? {});
  }
  if (labels.length > 0) upsertLabels(db, labels);
  return db;
}
