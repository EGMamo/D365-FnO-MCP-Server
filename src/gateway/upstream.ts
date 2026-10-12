import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ReadResourceResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CLIENT_SDK_VERSION_HEADER } from '../indexer/appVersion.js';
import { logger } from '../utils/logger.js';
import { errorMessage } from '../workspace/safety.js';
import type { UpstreamPort } from './types.js';

/**
 * The gateway's connection to the hosted MCP server. One instance serves one
 * downstream session: it connects lazily, reconnects after a failure or an
 * expired hosted session, and reports whether the hosted server answered the
 * last time it was asked.
 *
 * The hosted API key is only ever placed in the `X-API-Key` request header. It
 * is never logged or thrown: `UpstreamUnavailableError` messages are built from
 * the host and a fixed reason (no headers, path or server text), and the one
 * server-supplied message that is rethrown, a JSON-RPC error, is scrubbed of the
 * key first.
 */

/** Hosted tool lists are small; the cap only stops a server that keeps handing out cursors. */
const MAX_LIST_PAGES = 20;

const CLIENT_NAME = 'd365-fno-mcp-gateway';

/** After a failure the hosted server is left alone this long; the next call after that goes through to find out whether it is back. */
export const HOSTED_RETRY_MS = 5_000;

/** Printable ASCII without whitespace: safe in a header value and for a key that is pasted from a portal. */
const HEADER_TOKEN = /^[\x21-\x7e]+$/;
const HEADER_TEXT = /^[\x20-\x7e]+$/;

const optionsSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  apiKey: z.string().regex(HEADER_TOKEN, 'must be non-empty printable ASCII without whitespace'),
  // Same 64-character limit the hosted side applies when it reads the header.
  clientSdkVersion: z.string().trim().min(1).max(64).regex(HEADER_TEXT, 'must be printable ASCII').nullish(),
  timeoutMs: z.number().int().positive(),
  gatewayVersion: z.string().min(1),
});

export interface UpstreamSessionOptions {
  /** Hosted MCP endpoint (normally https://host/mcp). */
  url: string;
  apiKey: string;
  /** D365 application version of the developer's PackagesLocalDirectory; sent so the hosted server can warn about drift. */
  clientSdkVersion?: string | null;
  /** Budget for connecting and for each request. */
  timeoutMs: number;
  /** Version of this gateway, announced as the MCP client version. */
  gatewayVersion: string;
}

/** The hosted server could not be used: unreachable, too slow, or it rejected the request. The message is safe to show to an agent. */
export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamUnavailableError';
  }
}

/** One MCP connection to the hosted server. */
interface Live {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** Set once the connection is discarded, so requests it still carries are not blamed on the server. */
  dropped: boolean;
}

/** An Error.cause chain can hold the system error whose `code` (ECONNREFUSED, ENOTFOUND, ...) names the failure. */
function networkCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
    current = current.cause;
  }
  return null;
}

/** The server answered with a JSON-RPC error (unknown tool, bad params), so it is reachable. */
function isProtocolError(error: unknown): error is McpError {
  return error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed;
}

function isConnectionClosed(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.ConnectionClosed;
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // Already closed or never opened; nothing left to release.
  }
}

export class UpstreamSession implements UpstreamPort {
  private readonly url: URL;
  /** host[:port] only, the one part of the endpoint that appears in messages. */
  private readonly host: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly gatewayVersion: string;
  private current: Live | null = null;
  /** Single-flight: concurrent first calls share one initialize handshake. */
  private connecting: Promise<Live> | null = null;
  /** Optimistic until an operation fails. */
  private available = true;
  private failure: string | null = null;
  private failedAt = 0;
  private closed = false;
  private version: string | null = null;
  private serverInstructions: string | undefined;

  constructor(options: UpstreamSessionOptions) {
    const parsed = optionsSchema.parse(options);
    this.url = new URL(parsed.url);
    this.host = this.url.host;
    this.apiKey = parsed.apiKey;
    this.timeoutMs = parsed.timeoutMs;
    this.gatewayVersion = parsed.gatewayVersion;
    this.headers = { 'X-API-Key': parsed.apiKey };
    if (parsed.clientSdkVersion) this.headers[CLIENT_SDK_VERSION_HEADER] = parsed.clientSdkVersion;
  }

  /**
   * Whether a call should be sent: true until an operation fails, false for HOSTED_RETRY_MS after that, then true
   * again so the next call can find out whether the hosted server is back. Only an operation that succeeds
   * clears `lastError`; callers that refuse to call while this is false would otherwise never get that far.
   */
  isAvailable(): boolean {
    return this.available || Date.now() - this.failedAt >= HOSTED_RETRY_MS;
  }

  /** Why the last operation failed (safe text), or null once one succeeded. */
  get lastError(): string | null {
    return this.available ? null : this.failure;
  }

  /** Version the hosted server announced when the session was last established; null until the first connect. */
  get serverVersion(): string | null {
    return this.version;
  }

  /** Instructions the hosted server announced at initialize; undefined until the first connect. */
  get instructions(): string | undefined {
    return this.serverInstructions;
  }

  /** Connects now instead of on first use. A no-op while connected; throws UpstreamUnavailableError on failure. */
  async connect(): Promise<void> {
    await this.run(async () => undefined);
  }

  /** Lists every hosted tool. Throws UpstreamUnavailableError when the hosted server cannot be used. */
  async listTools(): Promise<Tool[]> {
    return this.run(async (client) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await client.listTools(cursor ? { cursor } : undefined, this.requestOptions());
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    });
  }

  /**
   * Calls a hosted tool. A tool that fails on the server comes back as an
   * isError result like any other; only an unusable server throws
   * UpstreamUnavailableError. A protocol error the server answered with (unknown
   * tool, invalid params) is rethrown as McpError.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // The SDK types every callTool result as CallToolResult | legacy { toolResult }; the schema passed here rules the legacy shape out.
    const call = (client: Client) => client.callTool({ name, arguments: args }, CallToolResultSchema, this.requestOptions());
    return this.run(call) as Promise<CallToolResult>;
  }

  async listResources(params?: { cursor?: string }): Promise<ListResourcesResult> {
    return this.run((client) => client.listResources(params, this.requestOptions()));
  }

  async readResource(params: { uri: string }): Promise<ReadResourceResult> {
    return this.run((client) => client.readResource(params, this.requestOptions()));
  }

  async listPrompts(params?: { cursor?: string }): Promise<ListPromptsResult> {
    return this.run((client) => client.listPrompts(params, this.requestOptions()));
  }

  async getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<GetPromptResult> {
    return this.run((client) => client.getPrompt(params, this.requestOptions()));
  }

  /** Ends the hosted session (best effort) and closes the connection. A closed session never reconnects. */
  async close(): Promise<void> {
    this.closed = true;
    const live = this.current;
    this.current = null;
    if (!live) return;
    live.dropped = true;
    await this.release(live);
  }

  private requestOptions(): { timeout: number } {
    return { timeout: this.timeoutMs };
  }

  /**
   * Runs one request on the live connection, connecting first when needed.
   * An expired hosted session (404 for a request that carried a session id) is
   * replaced and the request repeated once; any other failure drops the
   * connection, and ends its hosted session, so the next call starts from a
   * fresh handshake.
   */
  private async run<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    let retried = false;
    for (;;) {
      let live: Live | undefined;
      try {
        live = await this.live();
        const result = await operation(live.client);
        this.markAvailable();
        return result;
      } catch (error) {
        if (live && !retried && this.sessionLost(error, live)) {
          retried = true;
          logger.info('Hosted MCP session lost; reconnecting', { host: this.host });
          this.drop(live, true);
          continue;
        }
        if (isProtocolError(error)) {
          // The server answered, so it is reachable; the request itself was refused.
          this.markAvailable();
          throw this.scrub(error);
        }
        const unavailable = error instanceof UpstreamUnavailableError ? error : this.unavailable(error);
        if (live) this.drop(live, false);
        this.markUnavailable(unavailable.message);
        throw unavailable;
      }
    }
  }

  /** The hosted session no longer exists: HTTP 404 on a request that carried its id, or a connection another request already replaced. */
  private sessionLost(error: unknown, live: Live): boolean {
    if (live.dropped && isConnectionClosed(error)) return true;
    return error instanceof StreamableHTTPError && error.code === 404 && live.transport.sessionId !== undefined;
  }

  private live(): Promise<Live> {
    if (this.current) return Promise.resolve(this.current);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<Live> {
    if (this.closed) throw this.closedError();
    const client = new Client({ name: CLIENT_NAME, version: this.gatewayVersion });
    // Transport errors also reject the request that hit them; this is only for diagnosis.
    client.onerror = (error) => {
      logger.debug('Hosted MCP transport error', { host: this.host, error: this.redact(errorMessage(error)) });
    };
    const transport = new StreamableHTTPClientTransport(this.url, { requestInit: { headers: this.headers } });
    try {
      await client.connect(transport, this.requestOptions());
    } catch (error) {
      await closeQuietly(client);
      throw this.unavailable(error);
    }
    if (this.closed) {
      await closeQuietly(client);
      throw this.closedError();
    }
    const live: Live = { client, transport, dropped: false };
    this.current = live;
    this.version = client.getServerVersion()?.version ?? null;
    this.serverInstructions = client.getInstructions();
    return live;
  }

  /**
   * Forgets a connection (only if it is still the current one) and releases it in the background. Unless the
   * hosted session is known to be gone, the hosted server is asked to end it: a session left behind after every
   * transient failure would keep counting against the hosted server's session cap until its idle sweep.
   */
  private drop(live: Live, hostedSessionGone: boolean): void {
    if (live.dropped) return;
    live.dropped = true;
    if (this.current === live) this.current = null;
    void (hostedSessionGone ? closeQuietly(live.client) : this.release(live));
  }

  /** Ends the hosted session, then closes the connection; the end request needs the connection to still be open. */
  private async release(live: Live): Promise<void> {
    await this.endHostedSession(live);
    await closeQuietly(live.client);
  }

  /** Asks the hosted server to end the session so it does not linger until its idle sweep; never throws and never waits longer than the request budget. */
  private async endHostedSession(live: Live): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        live.transport.terminateSession(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.timeoutMs);
        }),
      ]);
    } catch {
      // The session ends with the idle sweep instead.
    } finally {
      clearTimeout(timer);
    }
  }

  private markAvailable(): void {
    this.failure = null;
    if (this.available) return;
    this.available = true;
    logger.info('Hosted MCP server is reachable again', { host: this.host });
  }

  private markUnavailable(reason: string): void {
    this.failure = reason;
    this.failedAt = Date.now();
    if (!this.available) return;
    this.available = false;
    logger.warn('Hosted MCP server unavailable', { host: this.host, reason });
  }

  private closedError(): UpstreamUnavailableError {
    return new UpstreamUnavailableError(`The session to the hosted MCP server at ${this.host} is closed.`);
  }

  /** Maps whatever the SDK or fetch threw to a message built only from the host and a fixed reason. */
  private unavailable(error: unknown): UpstreamUnavailableError {
    const where = `The hosted MCP server at ${this.host}`;
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      return new UpstreamUnavailableError(`${where} did not respond within ${this.timeoutMs} ms.`);
    }
    if (isConnectionClosed(error)) {
      return new UpstreamUnavailableError(`${where} closed the connection.`);
    }
    if (error instanceof StreamableHTTPError && typeof error.code === 'number' && error.code > 0) {
      if (error.code === 401 || error.code === 403) {
        return new UpstreamUnavailableError(`${where} rejected the API key (HTTP ${error.code}).`);
      }
      return new UpstreamUnavailableError(`${where} answered with HTTP ${error.code}.`);
    }
    const code = networkCode(error);
    if (code) return new UpstreamUnavailableError(`${where} is unreachable (${code}).`);
    if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
      return new UpstreamUnavailableError(`${where} is unreachable.`);
    }
    return new UpstreamUnavailableError(`${where} returned an unexpected response.`);
  }

  /** A protocol error is server-supplied text; make sure it cannot hand the key back. */
  private scrub(error: McpError): McpError {
    if (!error.message.includes(this.apiKey)) return error;
    return new McpError(error.code, this.redact(error.message.replace(/^MCP error -?\d+: /, '')));
  }

  private redact(text: string): string {
    return text.split(this.apiKey).join('[redacted]');
  }
}

const MAJOR_MINOR = /^v?(\d+)\.(\d+)/;

/**
 * Compares the gateway's version with the hosted server's by major.minor. A
 * version that is missing or not numeric cannot show skew, so it never warns.
 */
export function compareVersions(gateway: string, hosted: string | null): { skew: boolean; message?: string } {
  if (hosted === null) return { skew: false };
  const local = MAJOR_MINOR.exec(gateway.trim());
  const remote = MAJOR_MINOR.exec(hosted.trim());
  if (!local || !remote) return { skew: false };
  const localMajor = Number(local[1]);
  const localMinor = Number(local[2]);
  const remoteMajor = Number(remote[1]);
  const remoteMinor = Number(remote[2]);
  if (localMajor === remoteMajor && localMinor === remoteMinor) return { skew: false };

  const gatewayLabel = `${localMajor}.${localMinor}`;
  const hostedLabel = `${remoteMajor}.${remoteMinor}`;
  const hostedIsNewer = remoteMajor > localMajor || (remoteMajor === localMajor && remoteMinor > localMinor);
  return {
    skew: true,
    message: hostedIsNewer
      ? `The hosted server (${hostedLabel}) is newer than this gateway (${gatewayLabel}); update the gateway so merged results match the hosted tools.`
      : `This gateway (${gatewayLabel}) is newer than the hosted server (${hostedLabel}); tools the gateway expects may be missing upstream until the hosted server is updated.`,
  };
}
