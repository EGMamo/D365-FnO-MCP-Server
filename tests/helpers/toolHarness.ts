import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../../src/indexer/db.js';
import {
  openDb,
  upsertObject,
  upsertFields,
  upsertMethods,
  upsertProperties,
  upsertLabels,
  rebuildFts,
  rebuildLabelsFts,
} from '../../src/indexer/db.js';
import { registerGeneratorTools } from '../../src/tools/generators.js';
import { registerMetadataTools, type MetadataToolOptions } from '../../src/tools/metadata.js';
import { registerLabelsTools } from '../../src/tools/labels.js';

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

/** Same stand-in, but for the metadata tool registrations. */
export function collectMetadataTools(db: Database, options: MetadataToolOptions = {}): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (...args: unknown[]) => {
      const name = args[0];
      const handler = args.at(-1);
      if (typeof name !== 'string' || typeof handler !== 'function') {
        throw new Error('Invalid tool registration.');
      }
      handlers.set(name, handler as Handler);
    },
  } as unknown as McpServer;

  registerMetadataTools(fakeServer, db, options);
  return handlers;
}

/** Same stand-in, but for the labels tool registrations. */
export function collectLabelsTools(db: Database): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  registerLabelsTools(fakeServer, db);
  return handlers;
}

export interface SeedObject {
  type: string;
  name: string;
  package?: string;
  model?: string;
  file_path?: string;
  file_mtime?: number;
  raw_xml?: string;
  fields?: { name: string; type?: string; edt?: string }[];
  methods?: {
    name: string;
    accessModifier?: string;
    returnType?: string;
    params?: { name: string; type: string }[];
    isStatic?: boolean;
  }[];
  properties?: Record<string, unknown>;
}

export function seedDb(
  objects: SeedObject[],
  labels: { labelId: string; value: string; language?: string }[] = []
): Database {
  const db = openDb(':memory:');
  for (const obj of objects) {
    const id = upsertObject(db, {
      type: obj.type,
      name: obj.name,
      package: obj.package ?? 'TestPackage',
      model: obj.model ?? 'TestModel',
      file_path: obj.file_path ?? `/fake/${obj.name}.xml`,
      raw_xml: obj.raw_xml ?? `<${obj.type}><Name>${obj.name}</Name></${obj.type}>`,
      file_mtime: obj.file_mtime ?? 1,
    });
    upsertFields(db, id, obj.fields ?? []);
    upsertMethods(db, id, obj.methods ?? []);
    upsertProperties(db, id, obj.properties ?? {});
  }
  if (labels.length > 0) upsertLabels(db, labels);
  rebuildFts(db);
  rebuildLabelsFts(db);
  return db;
}
