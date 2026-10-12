import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Database } from '../indexer/db.js';

/** Where a merged row came from. */
export type ResultSource = 'local' | 'hosted';

/** Settings for the local get_visual_studio_workspace tool (same env names as the server). */
export interface GatewayWorkspaceConfig {
  workspaceDir: string;
  customMetadataDir: string;
  targetProject: string;
  targetPackage: string;
  targetModel: string;
  targetSolution: string;
}

/** Validated gateway settings (src/gateway/config.ts). */
export interface GatewayConfig {
  /** Hosted MCP endpoint, always ending in a path (normally /mcp). */
  hostedUrl: string;
  hostedApiKey: string;
  customMetadataDir: string;
  /** Absolute path of the custom-models SQLite index (never the main index). */
  localIndexDbPath: string;
  port: number;
  host: '127.0.0.1';
  /** Bearer token agents must present to the loopback gateway. */
  token: string;
  /** File the token was read from or persisted to; null when it came from the environment. */
  tokenFile: string | null;
  appVersion: string;
  /** Object-name prefixes that must never be sent upstream. */
  privatePrefixes: string[];
  upstreamTimeoutMs: number;
  reindexTtlMs: number;
  workspace: GatewayWorkspaceConfig;
}

export interface LocalIndexStatus {
  /** Basename of the custom metadata dir only; never a full path. */
  customDirName: string;
  objects: number;
  labels: number;
  lastRefreshAt: string | null;
  dirty: boolean;
  watcher: 'active' | 'inactive' | 'error';
  watcherError: string | null;
  lastError: string | null;
}

/** Incrementally maintained SQLite index of the developer's custom models. */
export interface LocalIndex {
  readonly db: Database;
  readonly customDir: string;
  /** Re-indexes when dirty or older than the TTL. Single-flight; never throws. */
  ensureFresh(): Promise<void>;
  markDirty(): void;
  status(): LocalIndexStatus;
  startWatcher(): void;
  close(): void;
}

export interface LocalToolDefinition {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
}

/** The tool handlers registered against the LOCAL database. */
export interface LocalTools {
  has(name: string): boolean;
  /** Parses args with the tool's zod shape (defaults applied), runs the handler; failures become isError results. */
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Parses args with the tool's zod shape; throws ZodError when invalid. */
  parseArgs(name: string, args: Record<string, unknown>): Record<string, unknown>;
  /** Top-level keys of the tool's zod shape, or null when the tool is unknown. */
  shapeKeys(name: string): string[] | null;
  definitions(): LocalToolDefinition[];
  /** Lets the server add hosted/skew facts to the local_index_status result. */
  setStatusExtras(fn: () => Record<string, unknown>): void;
}

/** The hosted server as the router sees it. */
export interface UpstreamPort {
  /** False for a short pause after a failed call, so a dead hosted server is not asked on every call; true otherwise. */
  isAvailable(): boolean;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readonly serverVersion: string | null;
}

export interface RouteContext {
  local: LocalTools;
  localIndex: LocalIndex;
  upstream: UpstreamPort;
  /** Hosted tool definitions by name (cached tools/list); empty when the hosted server was never reachable. */
  hostedTools: ReadonlyMap<string, Tool>;
  /** Object-name prefixes that must never be sent upstream. */
  privatePrefixes: readonly string[];
  /** Merge tools whose hosted schema differs from the local one; they are forwarded instead of merged. */
  skewedTools: ReadonlySet<string>;
}

/**
 * Strategy for one merge tool. args are parsed with the local zod shape
 * (defaults applied); raw are the caller's original args, which are the ones
 * forwarded upstream.
 */
export type MergeFn = (
  args: Record<string, unknown>,
  ctx: RouteContext,
  raw: Record<string, unknown>
) => Promise<CallToolResult>;
