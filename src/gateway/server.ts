import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { startHttpServer, type RunningHttpServer, type SessionContext } from '../server/httpTransport.js';
import { CLIENT_ENTRY_NAME, buildClientEntry, printClientEntry as printSharedClientEntry } from '../utils/clientEntry.js';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';
import { GatewayConfigError, loadGatewayConfig } from './config.js';
import { openLayeredIndex, type LayeredIndex } from './layeredIndex.js';
import { openLocalIndex } from './localIndex.js';
import { captureLocalTools } from './localTools.js';
import { sanitizeReason } from './merge.js';
import {
  LOCAL_ONLY_TOOL_NAMES,
  MERGE_TOOL_NAMES,
  OWNER_ROUTED_TOOL_NAMES,
  computeSkewedTools,
  executeToolCall,
  layerableToolNames,
} from './router.js';
import { HOSTED_RETRY_MS, UpstreamSession, UpstreamUnavailableError, compareVersions } from './upstream.js';
import { READ_ONLY_TOOL } from '../tools/annotations.js';
import { addFileTargets } from '../workspace/fileTargets.js';
import type { GatewayConfig, LocalIndex, LocalToolDefinition, LocalTools, RouteContext, UpstreamPort } from './types.js';

/**
 * The hybrid gateway's MCP endpoint. Each downstream agent session gets a low-level
 * `Server` (hosted tools arrive as JSON Schema, which `McpServer` cannot re-register)
 * and, on first use, its own connection to the hosted server, so the hosted server
 * sees the client's SDK version and keeps per-agent state. Everything else is shared:
 * the local index, the local tool handlers and the hosted tool list.
 */

const SERVER_NAME = 'd365-fno-mcp-gateway';

/** Name the gateway's loopback API key goes by in the transport's logs. */
const TOKEN_KEY_NAME = 'gateway';

/** A hosted tool list is reused this long before the next tools/list asks the hosted server again. */
const HOSTED_TOOLS_TTL_MS = 60_000;

/** How long a graceful shutdown may take before the process exits regardless. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** How long a shutdown waits for the hosted server to end the sessions; it ends them itself when they idle out. */
const UPSTREAM_CLOSE_GRACE_MS = 2_000;

/** One agent making parallel tool calls stays far below this per minute. */
const RATE_LIMIT_MAX_REQUESTS = 1_000;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Each downstream session holds one hosted session, so the cap also protects the hosted server's own. */
const MAX_CONCURRENT_SESSIONS = 25;
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** A merge call can make several hosted calls in a row; the response timer must outlast a few of their timeouts. */
const MIN_REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_FACTOR = 4;

/** Marks a tool the gateway can answer from local data only while the hosted server is down. */
const UNAVAILABLE_PREFIX = '[hosted unavailable] ';

/** The input id the printed client entry asks the token under; the VS Code form of a secret prompt. */
const TOKEN_INPUT_ID = 'd365-gateway-token';

const HYBRID_NOTE = [
  'This server is a local gateway in front of the hosted D365 Finance and Operations MCP server.',
  'Standard Microsoft and ISV metadata comes from the hosted index; the custom models on this machine are indexed locally and their code is never sent to the hosted server.',
  'Search, label, listing, schema and reference tools merge both sides and tag rows with source "local" or "hosted"; a trailing {"gateway":{"warnings":[...]}} item says when one side could not answer.',
  'Call local_index_status to see the local index and the hosted connection.',
].join(' ');

const HOSTED_INSTRUCTIONS_MISSING = "The hosted server's own instructions were not available when this gateway started.";

/** Environment variable behind each UpstreamSession option, for problems found while building one. */
const CONNECTION_SETTINGS: Readonly<Record<string, string>> = {
  url: 'D365_HOSTED_MCP_URL',
  apiKey: 'D365_HOSTED_API_KEY',
  clientSdkVersion: 'D365_APP_VERSION',
};

/** A client SDK version the hosted server's header parser accepts: printable ASCII, 64 characters at most. */
function declarableVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= 64 && /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : null;
}

/** Builds a hosted connection, turning the options the connection rejects into config problems that name no values. */
function connectTo(config: GatewayConfig, clientSdkVersion: string | null): UpstreamSession {
  try {
    return new UpstreamSession({
      url: config.hostedUrl,
      apiKey: config.hostedApiKey,
      clientSdkVersion,
      timeoutMs: config.upstreamTimeoutMs,
      gatewayVersion: VERSION,
    });
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    throw new GatewayConfigError(
      error.issues.map((issue) => {
        const key = String(issue.path[0] ?? '');
        return `${CONNECTION_SETTINGS[key] ?? key}: ${issue.message}`;
      })
    );
  }
}

/** A hosted connection that can also tell what the hosted server said about itself at initialize. */
type HostedConnection = UpstreamPort & { readonly instructions?: string };

/**
 * What the gateway knows about the hosted server: its tool list (served stale while a
 * refresh fails), its version and instructions, and which merge tools no longer match
 * the local implementation. One instance serves every downstream session.
 */
export class HostedCatalog {
  instructions: string | undefined;
  private list: readonly Tool[] = [];
  private byName: ReadonlyMap<string, Tool> = new Map();
  private skewed: ReadonlySet<string> = new Set();
  private loadedAt = 0;
  private failedAt = 0;
  private refreshing: Promise<void> | null = null;
  private hostedVersion: string | null = null;
  private skewNote: string | null = null;
  private lastFailure: string | null = null;
  private readonly listeners = new Set<() => void>();

  /** Tools whose hosted schema is compared with the local one: the merge tools, plus the forwarded ones the gateway runs itself over a standard index. */
  private readonly skewChecked: readonly string[];

  constructor(
    private readonly local: LocalTools,
    layered = false
  ) {
    this.skewChecked = layered ? [...MERGE_TOOL_NAMES, ...layerableToolNames(local)] : MERGE_TOOL_NAMES;
  }

  /** False until a hosted tool list was received once. */
  get loaded(): boolean {
    return this.loadedAt > 0;
  }

  get tools(): readonly Tool[] {
    return this.list;
  }

  get toolMap(): ReadonlyMap<string, Tool> {
    return this.byName;
  }

  get skewedTools(): ReadonlySet<string> {
    return this.skewed;
  }

  get version(): string | null {
    return this.hostedVersion;
  }

  /** Why the gateway and the hosted server may not agree, or null. */
  get versionNote(): string | null {
    return this.skewNote;
  }

  /** Safe text for the last failed refresh; null once one succeeded. */
  get failure(): string | null {
    return this.lastFailure;
  }

  /** True when the list is missing, old, or the last attempt failed: a reason to try again soon. */
  get needsRefresh(): boolean {
    return !this.loaded || this.lastFailure !== null || Date.now() - this.loadedAt >= HOSTED_TOOLS_TTL_MS;
  }

  /** Calls `listener` whenever the hosted tool list is received for the first time or changes; returns the way to stop. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remembers the hosted version and, when it differs from the gateway's, says so once per version. */
  noteVersion(version: string | null): void {
    if (version === null) return;
    const shown = version.slice(0, 64);
    if (shown === this.hostedVersion) return;
    this.hostedVersion = shown;
    const { skew, message } = compareVersions(VERSION, shown);
    this.skewNote = skew ? (message ?? null) : null;
    if (skew) logger.warn(message ?? 'The gateway and the hosted server run different versions', { gateway: VERSION, hosted: shown });
  }

  /** Records a failed attempt to reach the hosted server. Only the first failure after a success is a warning. */
  noteFailure(error: unknown): void {
    this.failedAt = Date.now();
    const reason = error instanceof UpstreamUnavailableError ? error.message : sanitizeReason(error);
    const log = this.lastFailure === null ? logger.warn : logger.debug;
    log('Could not load the hosted tool list; hosted tools are unavailable until the hosted server answers', { reason });
    this.lastFailure = reason;
  }

  /**
   * Reloads the hosted tool list through `upstream` when it is older than the TTL. Single-flight, never
   * throws, and a failed attempt keeps the previous list.
   */
  refresh(upstream: HostedConnection): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const now = Date.now();
    if (this.loaded && now - this.loadedAt < HOSTED_TOOLS_TTL_MS) return Promise.resolve();
    if (this.failedAt > 0 && now - this.failedAt < HOSTED_RETRY_MS) return Promise.resolve();
    this.refreshing = this.load(upstream).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async load(upstream: HostedConnection): Promise<void> {
    try {
      this.apply(await upstream.listTools());
      this.noteVersion(upstream.serverVersion);
      // Sessions that start after a late first contact still get the hosted instructions.
      this.instructions ??= upstream.instructions;
    } catch (error) {
      this.noteFailure(error);
    }
  }

  private apply(tools: Tool[]): void {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const skewed = computeSkewedTools(byName, this.local, this.skewChecked);
    for (const name of skewed) {
      if (!this.skewed.has(name)) {
        logger.warn('Hosted tool arguments differ from the gateway implementation; forwarding it unchanged', { tool: name });
      }
    }
    const changed = !this.loaded || JSON.stringify(tools) !== JSON.stringify(this.list);
    this.list = tools;
    this.byName = byName;
    this.skewed = skewed;
    this.loadedAt = Date.now();
    this.failedAt = 0;
    this.lastFailure = null;
    if (changed) for (const listener of [...this.listeners]) listener();
  }
}

/** The state every downstream session shares. */
export interface GatewayRuntime {
  readonly config: GatewayConfig;
  readonly localIndex: LocalIndex;
  readonly local: LocalTools;
  /** Handlers over the standard index with the custom one laid on top; null without a standard index. */
  readonly layered: LocalTools | null;
  readonly catalog: HostedCatalog;
  /** Opens the hosted connection of one downstream session; connects on first use. */
  openUpstream(clientSdkVersion?: string | null): UpstreamSession;
  /** Starts closing a session's hosted connection; shutdown waits for it. */
  releaseUpstream(upstream: UpstreamSession): void;
  /** Hosted availability as the gateway last saw it: no failed refresh and no session that lost the hosted server. */
  hosted(): { reachable: boolean; lastError: string | null };
  /** Closes every hosted connection that is still open and waits for the closes to finish. */
  closeUpstreams(): Promise<void>;
}

/** The standard index under the custom one and the tool handlers over both. */
export interface LayeredTools {
  index: LayeredIndex;
  tools: LocalTools;
}

/** Wires the shared state around an open local index and its tool handlers; `createGatewayServer` builds one server per session on it. */
export function createGatewayRuntime(
  config: GatewayConfig,
  localIndex: LocalIndex,
  local: LocalTools,
  layered: LayeredTools | null = null
): GatewayRuntime {
  const catalog = new HostedCatalog(local, layered !== null);
  const sessions = new Set<UpstreamSession>();
  const closing = new Set<Promise<void>>();

  const hosted = (): { reachable: boolean; lastError: string | null } => {
    // Not isAvailable(): that turns true again after a pause so a call can probe, but nothing has been heard since the failure.
    const lost = [...sessions].find((upstream) => upstream.lastError !== null);
    if (lost) return { reachable: false, lastError: lost.lastError };
    return { reachable: catalog.failure === null, lastError: catalog.failure };
  };

  local.setStatusExtras(() => ({
    gateway: { version: VERSION },
    hosted: { ...hosted(), version: catalog.version, versionNote: catalog.versionNote },
    standardIndex: layered?.index.status() ?? null,
    skewedTools: [...catalog.skewedTools].sort(),
  }));

  const releaseUpstream = (upstream: UpstreamSession): void => {
    sessions.delete(upstream);
    const done = upstream.close().catch(() => undefined);
    closing.add(done);
    void done.then(() => closing.delete(done));
  };

  return {
    config,
    localIndex,
    local,
    layered: layered?.tools ?? null,
    catalog,
    openUpstream(clientSdkVersion) {
      const upstream = connectTo(config, declarableVersion(clientSdkVersion) ?? declarableVersion(config.appVersion));
      sessions.add(upstream);
      return upstream;
    },
    releaseUpstream,
    hosted,
    async closeUpstreams() {
      for (const upstream of [...sessions]) releaseUpstream(upstream);
      await Promise.allSettled([...closing]);
    },
  };
}

/** The instructions of the hosted server (when it answered at startup) followed by the hybrid note. */
function instructionsFor(catalog: HostedCatalog): string {
  return [catalog.instructions ?? HOSTED_INSTRUCTIONS_MISSING, HYBRID_NOTE].join('\n\n');
}

/** A local definition as an MCP tool; `unavailable` flags the ones listed only because the hosted server cannot be reached. */
function asTool(definition: LocalToolDefinition, unavailable: boolean): Tool {
  return {
    name: definition.name,
    description: unavailable ? `${UNAVAILABLE_PREFIX}${definition.description}` : definition.description,
    inputSchema: definition.inputSchema,
    // Every local tool is a read-only lookup or a text draft; the writers are not registered in the gateway.
    annotations: READ_ONLY_TOOL,
  };
}

/**
 * The tools an agent sees: the hosted tools as received, plus the gateway-only ones the hosted list lacks. When
 * no hosted list was ever received, the tools the local index can answer on its own.
 */
function listedTools({ catalog, local, layered }: GatewayRuntime): Tool[] {
  const definitions = new Map(local.definitions().map((definition) => [definition.name, definition]));
  if (!catalog.loaded) {
    const answerable = new Set([
      ...LOCAL_ONLY_TOOL_NAMES,
      ...MERGE_TOOL_NAMES,
      ...OWNER_ROUTED_TOOL_NAMES,
      ...(layered ? layerableToolNames(layered) : []),
    ]);
    return [...definitions.values()].filter((definition) => answerable.has(definition.name)).map((definition) => asTool(definition, true));
  }
  const gatewayOnly = LOCAL_ONLY_TOOL_NAMES.filter((name) => !catalog.toolMap.has(name)).flatMap((name) => definitions.get(name) ?? []);
  return [...catalog.tools, ...gatewayOnly.map((definition) => asTool(definition, false))];
}

/** What the router needs to answer one call, taken at call time so a refreshed hosted list applies at once. */
function routeContext(runtime: GatewayRuntime, upstream: UpstreamPort): RouteContext {
  return {
    local: runtime.local,
    localIndex: runtime.localIndex,
    upstream,
    hostedTools: runtime.catalog.toolMap,
    privatePrefixes: runtime.config.privatePrefixes,
    skewedTools: runtime.catalog.skewedTools,
    layered: runtime.layered,
  };
}

/** A failed hosted request as the MCP error the agent sees; a hosted protocol error keeps its code. */
function relayError(error: unknown): McpError {
  // The SDK prefixes every message with its code, once on each hop; one prefix is added again when this error is thrown.
  if (error instanceof McpError) return new McpError(error.code, error.message.replace(/^(?:MCP error -?\d+: )+/, ''));
  return new McpError(ErrorCode.InternalError, error instanceof UpstreamUnavailableError ? error.message : sanitizeReason(error));
}

/** A hosted list request; an unreachable hosted server yields an empty list rather than an error. */
async function relayList<T>(request: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof UpstreamUnavailableError) return empty;
    throw relayError(error);
  }
}

/** A hosted read or get request, whose failure the agent should see as an error. */
async function relay<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw relayError(error);
  }
}

/**
 * Creates the MCP server of one downstream session. The transport calls it once per
 * `initialize`; closing the session closes its hosted connection.
 */
export function createGatewayServer(runtime: GatewayRuntime, context?: SessionContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} }, instructions: instructionsFor(runtime.catalog) }
  );

  let opened: UpstreamSession | null = null;
  const upstream = (): UpstreamSession => {
    opened ??= runtime.openUpstream(context?.clientSdkVersion);
    return opened;
  };
  // The list an agent was given may be the local fallback, so it is told to ask again once the hosted tools arrive.
  const stopListening = runtime.catalog.onChange(() => {
    if (server.getClientCapabilities() === undefined) return;
    void server.sendToolListChanged().catch(() => undefined);
  });
  server.onclose = () => {
    stopListening();
    if (opened) runtime.releaseUpstream(opened);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await runtime.catalog.refresh(upstream());
    return { tools: listedTools(runtime) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const session = upstream();
    // Keeps the hosted tool list, the skew check and the reported availability current for clients that rarely list tools.
    if (runtime.catalog.needsRefresh) void runtime.catalog.refresh(session);
    const result = await executeToolCall(request.params.name, request.params.arguments, routeContext(runtime, session));
    // Local and hosted generator results alike learn where their files go on this machine.
    return addFileTargets(result, runtime.config.workspace);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    return relayList(() => upstream().listResources(cursor ? { cursor } : undefined), { resources: [] });
  });
  // The hosted knowledge-base template is also listed as concrete resources, so none is offered here.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    relay(() => upstream().readResource({ uri: request.params.uri }))
  );

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    return relayList(() => upstream().listPrompts(cursor ? { cursor } : undefined), { prompts: [] });
  });
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    relay(() => upstream().getPrompt({ name: request.params.name, arguments: request.params.arguments }))
  );

  return server;
}

/**
 * Connects to the hosted server once, before any agent does, to learn its instructions, version and
 * tools. The session is closed again afterwards; failing is only a warning, the agents' own sessions retry.
 */
async function warmCatalog(config: GatewayConfig, runtime: GatewayRuntime): Promise<void> {
  const session = connectTo(config, declarableVersion(config.appVersion));
  const { catalog } = runtime;
  try {
    await session.connect();
    catalog.noteVersion(session.serverVersion);
    await catalog.refresh(session);
  } catch (error) {
    catalog.noteFailure(error);
  } finally {
    await session.close();
  }
}

export interface RunningGateway {
  readonly config: GatewayConfig;
  readonly localIndex: LocalIndex;
  /** The standard index under the custom one, when D365_GATEWAY_STANDARD_INDEX_DB_PATH is set. */
  readonly standardIndex: LayeredIndex | null;
  /** Endpoint agents connect to. */
  readonly url: string;
  /** The address the listener is bound to, as the socket reports it. */
  readonly boundAddress: string;
  /** Ends every session, stops listening, closes the local index and asks the hosted server to end its sessions (waiting a moment for it). Safe to call twice. */
  stop(): Promise<void>;
}

/**
 * The Host header values the gateway answers to: its two host names with the port. A client leaves the port
 * out when it is 80, the HTTP default, so for that port the bare names are answered too.
 */
export function gatewayHostHeaders(port: number): string[] {
  return ['127.0.0.1', 'localhost'].flatMap((name) => (port === 80 ? [name, `${name}:${port}`] : [`${name}:${port}`]));
}

/** Resolves when `work` settles or after `ms`, whichever comes first. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the gateway for an already validated config: opens the local index (building it first),
 * listens on the loopback interface and learns what it can about the hosted server. Requests are
 * refused with 503 until that last step is done, so no session starts without the hosted
 * instructions when the hosted server is up. Installs no process-level handlers; `startGateway` does
 * that. `config.port` must be the port to bind, not 0, because the Host header allowlist needs it.
 */
export async function launchGateway(config: GatewayConfig): Promise<RunningGateway> {
  logger.info('Starting D365 FnO MCP gateway', { version: VERSION, hostedHost: new URL(config.hostedUrl).host, port: config.port });
  // Built first so that settings the connection rejects fail before anything is opened.
  connectTo(config, declarableVersion(config.appVersion));
  if (config.appVersion && declarableVersion(config.appVersion) === null) {
    logger.warn('D365_APP_VERSION cannot be sent as a client version; the hosted server will not be told your SDK version');
  }

  logger.info('Indexing the custom models', { customDir: config.customMetadataDir });
  const localIndex = await openLocalIndex({
    customDir: config.customMetadataDir,
    dbPath: config.localIndexDbPath,
    ttlMs: config.reindexTtlMs,
  });
  const status = localIndex.status();
  logger.info('Custom model index ready', { objects: status.objects, labels: status.labels });

  let runtime: GatewayRuntime;
  let http: RunningHttpServer;
  let standardIndex: LayeredIndex | null = null;
  let ready = false;
  try {
    let layered: LayeredTools | null = null;
    if (config.standardIndexDbPath) {
      standardIndex = openLayeredIndex(config.standardIndexDbPath, localIndex.attachUri);
      layered = { index: standardIndex, tools: captureLocalTools(standardIndex.db, localIndex, config.workspace) };
      logger.info('Standard index laid under the custom models; forwarded tools run locally', { objects: standardIndex.status().objects });
    }
    localIndex.startWatcher();
    runtime = createGatewayRuntime(config, localIndex, captureLocalTools(localIndex.db, localIndex, config.workspace), layered);
    http = startHttpServer((context) => createGatewayServer(runtime, context), {
      port: config.port,
      host: config.host,
      apiKeys: [{ name: TOKEN_KEY_NAME, key: config.token }],
      version: VERSION,
      rateLimitMaxRequests: RATE_LIMIT_MAX_REQUESTS,
      rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
      requestTimeoutMs: Math.max(MIN_REQUEST_TIMEOUT_MS, config.upstreamTimeoutMs * REQUEST_TIMEOUT_FACTOR),
      maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
      sessionIdleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
      readiness: { isReady: () => ready },
      // A page in the developer's browser can reach a loopback listener; only the gateway's own host names get through.
      allowedHosts: gatewayHostHeaders(config.port),
    });
  } catch (error) {
    standardIndex?.close();
    localIndex.close();
    throw error;
  }

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      http.closeAllSessions();
      const closed = new Promise<void>((resolve) => http.server.close(() => resolve()));
      http.server.closeAllConnections();
      await closed;
      // The local indexes first: closing them is quick and must not wait for a hosted server that does not answer.
      standardIndex?.close();
      localIndex.close();
      await settleWithin(runtime.closeUpstreams(), UPSTREAM_CLOSE_GRACE_MS);
    })();
    return stopping;
  };

  try {
    await http.listening;
    await warmCatalog(config, runtime);
    ready = true;
  } catch (error) {
    await stop();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(`Port ${config.port} on ${config.host} is already in use. Stop the other process or set D365_GATEWAY_PORT.`);
    }
    throw error;
  }
  const address = http.server.address();
  const boundAddress = typeof address === 'object' && address !== null ? address.address : String(address);
  return { config, localIndex, standardIndex, url: `http://${config.host}:${config.port}/mcp`, boundAddress, stop };
}

/** Prints the problems of an invalid configuration in the style of the server's own config errors. */
function printConfigProblems(error: GatewayConfigError): void {
  console.error('[D365-MCP] ERROR Gateway configuration validation failed:');
  error.problems.forEach((problem) => console.error(`  - ${problem}`));
}

/** Says where the token lives; the token itself is never printed. */
function describeToken(config: GatewayConfig, env: NodeJS.ProcessEnv): string {
  if (env.D365_GATEWAY_TOKEN?.trim()) return 'The token is the value of D365_GATEWAY_TOKEN.';
  if (config.tokenFile) return `The token is stored in ${config.tokenFile} (owner-only); paste its contents when the client asks for it.`;
  return 'The token was generated for this run only because the local index is in memory; set D365_GATEWAY_TOKEN to use a fixed one.';
}

/** Prints a client entry that points at the gateway, ready to paste. */
function printClientEntry(gateway: RunningGateway, env: NodeJS.ProcessEnv): void {
  printSharedClientEntry({
    heading: `D365 gateway listening on ${gateway.url} (hosted server: ${new URL(gateway.config.hostedUrl).host})`,
    instruction: `Register it in place of the hosted ${CLIENT_ENTRY_NAME} entry: .vscode/mcp.json for VS Code, .mcp.json for Visual Studio.`,
    entry: buildClientEntry({
      url: gateway.url,
      inputId: TOKEN_INPUT_ID,
      inputDescription: 'D365 gateway token',
    }),
    notes: [describeToken(gateway.config, env), 'Other clients send the same URL with an "Authorization: Bearer <token>" header.'],
  });
}

/**
 * Runs the `gateway` command: validates the environment, starts the gateway and keeps it running until
 * SIGINT or SIGTERM. Resolves with the process exit code: 0 once the gateway listens (the listener keeps the
 * process alive), 1 after printing every configuration problem. Other startup failures throw.
 */
export async function startGateway(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let gateway: RunningGateway;
  try {
    gateway = await launchGateway(loadGatewayConfig(env));
  } catch (error) {
    if (error instanceof GatewayConfigError) {
      printConfigProblems(error);
      return 1;
    }
    throw error;
  }
  printClientEntry(gateway, env);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...', { signal });
    const deadline = setTimeout(() => {
      logger.error('Shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();
    gateway.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('Shutdown failed', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A stray error leaves the process in an unknown state: log it and exit instead of serving from it.
  const crash = (kind: string) => (error: unknown) => {
    logger.fatal(`Unhandled ${kind}; exiting`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    try {
      gateway.localIndex.close();
    } catch {
      // Already exiting.
    }
    process.exit(1);
  };
  process.on('uncaughtException', crash('exception'));
  process.on('unhandledRejection', crash('rejection'));
  return 0;
}
