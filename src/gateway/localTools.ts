import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import { registerCodeQualityTools } from '../tools/codeQuality.js';
import { registerEntityTools } from '../tools/entities.js';
import { registerGeneratorTools } from '../tools/generators.js';
import { registerLabelsTools } from '../tools/labels.js';
import { registerMetadataTools } from '../tools/metadata.js';
import { registerSecurityTools } from '../tools/security.js';
import { registerWorkspaceTools } from '../tools/workspace.js';
import type { GatewayWorkspaceConfig, LocalIndex, LocalToolDefinition, LocalTools } from './types.js';

const STATUS_TOOL = 'local_index_status';
const STATUS_DESCRIPTION =
  'Gateway only. State of the local custom-model index (object and label counts, last refresh, watcher and refresh errors) plus what the gateway knows about the hosted server. Reports the custom directory by name only.';

type ToolHandler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

interface CapturedTool {
  name: string;
  description: string;
  /** Null when the tool was registered without an input schema. */
  shape: z.ZodRawShape | null;
  /** The object the SDK would validate against; unknown keys are stripped and defaults applied. */
  schema: z.ZodObject;
  handler: ToolHandler;
}

/** Same test the SDK uses to tell a zod raw shape from a ToolAnnotations object (an empty object is a shape). */
function isRawShape(value: unknown): value is z.ZodRawShape {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const values = Object.values(value);
  return values.length === 0 || values.some((item) => typeof item === 'object' && item !== null && '_zod' in item);
}

/** Collects the tools a register* function adds, in place of an McpServer. */
function createToolCollector(): { server: McpServer; tools: Map<string, CapturedTool> } {
  const tools = new Map<string, CapturedTool>();
  // Mirrors McpServer.tool(name, description?, shape?, annotations?, handler).
  const tool = (name: string, ...rest: unknown[]) => {
    if (tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    const description = typeof rest[0] === 'string' ? (rest.shift() as string) : '';
    const handler = rest.pop();
    if (typeof handler !== 'function') throw new Error(`Tool ${name} has no handler.`);
    const shape = rest.find(isRawShape) ?? null;
    tools.set(name, { name, description, shape, schema: z.object(shape ?? {}), handler: handler as ToolHandler });
  };
  return { server: { tool } as unknown as McpServer, tools };
}

/** Same call, with the same options, the SDK makes to describe a tool in tools/list. */
function toInputSchema(shape: z.ZodRawShape | null): LocalToolDefinition['inputSchema'] {
  if (!shape) return { type: 'object', properties: {} };
  return z.toJSONSchema(z.object(shape), { target: 'draft-7', io: 'input' }) as LocalToolDefinition['inputSchema'];
}

/** The message text the SDK builds for invalid tool arguments, so local and hosted errors read alike. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.message} at ${issue.path.join('.')}` : issue.message))
    .join('\n');
}

const failure = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

/** Replaces an absolute directory, as written in JSON text on any platform, with a label. */
function hideDirectory(text: string, dir: string, label: string): string {
  if (dir.length < 2) return text;
  const backslashes = dir.replace(/\//g, '\\');
  const variants = [...new Set([dir, dir.replace(/\\/g, '/'), backslashes, backslashes.replace(/\\/g, '\\\\')])];
  return variants.sort((a, b) => b.length - a.length).reduce((out, variant) => out.split(variant).join(label), text);
}

/**
 * Captures the read-only tool handlers registered against the LOCAL database, so the gateway can
 * answer from them directly. Trace, telemetry, release-plan and writer tools are hosted only and the
 * knowledge filter is not applied. Captured handlers skip the SDK's input validation, so `call` and
 * `parseArgs` run the tool's zod shape first.
 */
export function captureLocalTools(db: Database, localIndex: LocalIndex, workspace: GatewayWorkspaceConfig): LocalTools {
  const { server, tools } = createToolCollector();
  registerMetadataTools(server, db, { sourceFilesAvailable: true });
  registerLabelsTools(server, db);
  registerSecurityTools(server, db);
  registerEntityTools(server, db);
  registerCodeQualityTools(server, db);
  registerGeneratorTools(server, db);
  registerWorkspaceTools(server, {
    workspaceDir: workspace.workspaceDir,
    customMetadataDir: workspace.customMetadataDir,
    targetProject: workspace.targetProject,
    targetPackage: workspace.targetPackage,
    targetModel: workspace.targetModel,
    targetSolution: workspace.targetSolution,
    writableModels: [],
    enableWriteTools: false,
  });

  let statusExtras: () => Record<string, unknown> = () => ({});
  server.tool(STATUS_TOOL, STATUS_DESCRIPTION, {}, async () => ({
    content: [
      {
        type: 'text' as const,
        // The extras are free-form, so keep the custom directory out of them as well.
        text: hideDirectory(
          JSON.stringify({ localIndex: localIndex.status(), ...statusExtras() }),
          localIndex.customDir,
          '<customDir>'
        ),
      },
    ],
  }));

  const definitions: LocalToolDefinition[] = [...tools.values()].map(({ name, description, shape }) => ({
    name,
    description,
    inputSchema: toInputSchema(shape),
  }));

  const lookup = (name: string): CapturedTool => {
    const captured = tools.get(name);
    if (!captured) throw new Error(`Tool ${name} not found`);
    return captured;
  };

  return {
    has: (name) => tools.has(name),
    async call(name, args) {
      const captured = tools.get(name);
      if (!captured) return failure(`Tool ${name} not found`);
      const parsed = captured.schema.safeParse(args);
      if (!parsed.success) {
        return failure(`Input validation error: Invalid arguments for tool ${name}: ${describeIssues(parsed.error)}`);
      }
      try {
        // Tools with an input schema receive (args, extra); tools without one receive (extra).
        return await (captured.shape ? captured.handler(parsed.data, {}) : captured.handler({}));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    },
    parseArgs: (name, args) => lookup(name).schema.parse(args),
    shapeKeys: (name) => {
      const captured = tools.get(name);
      return captured ? Object.keys(captured.shape ?? {}) : null;
    },
    definitions: () => definitions.map((definition) => ({ ...definition })),
    setStatusExtras(fn) {
      statusExtras = fn;
    },
  };
}
