import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createServer, type Server } from 'http';
import { logger } from '../utils/logger.js';
import { INDEX_VERSION_HEADER, readDeclaredClientVersion } from '../indexer/appVersion.js';
import type { ApiKeyEntry } from './apiKeys.js';
import type { StatusProvider } from './serverStatus.js';

/**
 * What a session needs from its server. `McpServer` and the SDK's low-level
 * `Server` both satisfy it, so the gateway reuses this transport unchanged.
 */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export type ServerFactory = (context?: SessionContext) => ConnectableServer;

/** Per-session facts the transport knows and the server needs at `initialize`. */
export interface SessionContext {
  /**
   * D365 application version the client declared for its own
   * PackagesLocalDirectory, used to warn about SDK drift at session start.
   */
  clientSdkVersion?: string | null;
}

export interface HttpTransportOptions {
  port: number;
  /** Interface to bind; empty or undefined binds every interface. */
  host?: string;
  /** Accepted API keys. At least one is required. */
  apiKeys: ApiKeyEntry[];
  version: string;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  requestTimeoutMs: number;
  /** Number of trusted reverse-proxy hops. 0 = do not trust X-Forwarded-For. */
  trustProxyHops?: number;
  maxConcurrentSessions?: number;
  /**
   * Most sessions one API key may hold at once, so a single client cannot take
   * every slot from the others. Omitted or 0 means only the global cap applies.
   */
  maxSessionsPerApiKey?: number;
  sessionIdleTimeoutMs?: number;
  sessionSweepIntervalMs?: number;
  /** Routes mounted at `/admin` after authentication. */
  admin?: AdminRoutes;
  /**
   * Readiness gate. While it reports not ready, `/health` answers 503 and
   * authenticated requests are refused with 503, so a platform probe routes no
   * traffic to this replica. Omitted means always ready. `/status`, when there
   * is one, is the exception: it answers while not ready, saying so.
   */
  readiness?: ReadinessProbe;
  /**
   * Host header values (`host:port`, compared case-insensitively) the server
   * answers to. Any other request gets 403 before rate limiting and auth,
   * `/health` and `/live` included, which stops DNS rebinding against a
   * loopback listener. Omitted means no Host check.
   */
  allowedHosts?: readonly string[];
  /**
   * Tells authenticated callers what this server is serving: mounts `GET /status` and sends the indexed
   * application version in the `x-d365-index-version` response header. Omitted, neither exists (the gateway
   * runs this way).
   */
  status?: StatusProvider;
}

export interface ReadinessProbe {
  isReady(): boolean;
}

export interface AdminRoutes {
  router: Router;
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: ConnectableServer;
  lastActivity: number;
  /** False while the initialize handshake is still in flight (slot reserved). */
  initialized: boolean;
  /** Name of the API key that opened the session; other keys may not use it. */
  apiKeyName: string;
}

const SESSION_SWEEP_INTERVAL_MS = 60_000;

function jsonRpcError(code: number, message: string, id: string | number | null = null): JsonRpcErrorBody {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Constant-time string comparison that does not leak length via early exit. */
function safeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(Buffer.from(a, 'utf-8')).digest();
  const hashB = createHash('sha256').update(Buffer.from(b, 'utf-8')).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Finds the key entry matching `presented`. Every entry is compared, with no
 * early exit, so the response time does not depend on which key matched.
 */
function authenticate(presented: string, keys: readonly ApiKeyEntry[]): ApiKeyEntry | undefined {
  let match: ApiKeyEntry | undefined;
  for (const entry of keys) {
    if (safeEqual(presented, entry.key)) match = entry;
  }
  return match;
}

/** Extract a presented API key from `X-API-Key` or `Authorization: Bearer ...`. */
function extractApiKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    const value = auth.replace(/^Bearer\s+/i, '').trim();
    if (value.length > 0) return value;
  }
  return undefined;
}

/**
 * Build the Express application exposing the MCP Streamable HTTP transport.
 * Exported separately from `startHttpServer` so tests can drive it directly.
 */
export function createHttpApp(createMcpServer: ServerFactory, options: HttpTransportOptions): Express {
  if (options.apiKeys.length === 0) {
    throw new Error('The HTTP transport requires at least one API key.');
  }
  const app = express();
  const sessions = new Map<string, SessionEntry>();
  const trustProxyHops = options.trustProxyHops ?? 0;
  const maxConcurrentSessions = options.maxConcurrentSessions ?? 100;
  const maxSessionsPerApiKey = options.maxSessionsPerApiKey ?? 0;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 30 * 60 * 1000;
  const sessionSweepIntervalMs = options.sessionSweepIntervalMs ?? SESSION_SWEEP_INTERVAL_MS;

  /**
   * Resolve the client IP. `req.ip` is only trustworthy when a known number of
   * reverse proxies sit in front of us; otherwise a client can forge
   * `X-Forwarded-For` and rotate its rate-limit key at will.
   */
  const clientIp = (req: Request): string =>
    trustProxyHops > 0 ? (req.ip ?? 'unknown') : (req.socket.remoteAddress ?? 'unknown');

  app.disable('x-powered-by');
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }

  // ── Host allowlist ────────────────────────────────────────────────────────
  // First in the chain, so a rebinding page is refused before its body is
  // parsed, before it spends rate-limit budget and before auth runs.
  if (options.allowedHosts) {
    const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    app.use((req: Request, res: Response, next: NextFunction) => {
      const host = req.headers.host?.toLowerCase();
      if (host !== undefined && allowedHosts.has(host)) return next();
      logger.warn('Request refused: Host header not allowed', { ip: clientIp(req), path: req.path, host });
      res.status(403).json(jsonRpcError(-32000, 'Forbidden: Host header not allowed'));
    });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Before the body parser, so a malformed or oversized body (which the parser
  // turns into an error that skips every later middleware) still spends budget.
  app.use(
    rateLimit({
      windowMs: options.rateLimitWindowMs,
      max: options.rateLimitMaxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === '/health' || req.path === '/live',
      // Key on the client IP alone. The rate limiter runs before authentication,
      // so a client-controlled credential header must not be part of the bucket key;
      // a per-key throttle would belong behind verified auth.
      keyGenerator: (req: Request) => clientIp(req),
      handler: (req, res) => {
        logger.warn('Rate limit exceeded', { ip: clientIp(req), path: req.path });
        res.status(429).json(jsonRpcError(-32029, 'Too many requests'));
      },
    }),
  );

  app.use(express.json({ limit: '1mb' }));

  const isReady = () => options.readiness?.isReady() ?? true;

  // ── Health checks (unauthenticated) ───────────────────────────────────────
  // `/health` is readiness: 200 only once the index is open. `/live` is liveness.
  app.get('/health', (_req: Request, res: Response) => {
    if (!isReady()) {
      res.status(503).set('Retry-After', '10').json({ status: 'starting', version: options.version });
      return;
    }
    res.json({ status: 'ok', version: options.version });
  });
  app.get('/live', (_req: Request, res: Response) => {
    res.json({ status: 'alive', version: options.version });
  });

  // ── API key auth ──────────────────────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const presented = extractApiKey(req);
    const entry = presented ? authenticate(presented, options.apiKeys) : undefined;
    if (!entry) {
      logger.warn('Unauthorized request', { ip: clientIp(req), method: req.method, path: req.path });
      res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
      return;
    }
    // Only the key's name is recorded anywhere; the key itself is never logged.
    res.locals.apiKeyName = entry.name;
    logger.info('Request', { method: req.method, path: req.path, ip: clientIp(req), apiKey: entry.name });
    next();
  });

  // ── What this server is serving ───────────────────────────────────────────
  // After authentication, so an unauthenticated caller learns nothing; before the readiness gate, so it answers
  // while the server is starting. Nothing here may fail a request: the version is only a header.
  if (options.status) {
    const status = options.status;
    app.use((_req: Request, res: Response, next: NextFunction) => {
      try {
        const version = isReady() ? status.indexVersion() : null;
        // The provider normalises the version, so only digits and dots can pass; anything else is left out.
        if (version !== null && /^[0-9]+(\.[0-9]+){3}$/.test(version)) res.setHeader(INDEX_VERSION_HEADER, version);
      } catch {
        // An unknown version is no reason to refuse a request.
      }
      next();
    });
    app.get('/status', (_req: Request, res: Response) => {
      try {
        res.set('Cache-Control', 'no-store').json(
          status.describe({
            ready: isReady(),
            keyName: res.locals.apiKeyName as string,
            sessions: { active: sessions.size, max: maxConcurrentSessions, maxPerKey: maxSessionsPerApiKey },
          })
        );
      } catch (err) {
        // Not `message`: the logger's own message field would overwrite it and the reason would be lost.
        logger.error('Status unavailable', { error: String(err) });
        res.status(500).json({ error: 'status unavailable' });
      }
    });
  }

  // ── Readiness gate ────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response, next: NextFunction) => {
    if (isReady()) return next();
    res.status(503).set('Retry-After', '10').json(jsonRpcError(-32000, 'Server is starting: the index is not ready'));
  });

  // ── Admin routes ──────────────────────────────────────────────────────────
  if (options.admin) app.use('/admin', options.admin.router);

  // ── JSON-RPC envelope validation ──────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const body: unknown = req.body;
    const messages = Array.isArray(body) ? body : [body];
    const valid =
      messages.length > 0 &&
      messages.every((m) => {
        if (typeof m !== 'object' || m === null) return false;
        const rec = m as Record<string, unknown>;
        if (rec.jsonrpc !== '2.0') return false;
        // Requests and notifications carry a method.
        if (typeof rec.method === 'string') return true;
        // Responses to server-initiated requests carry an id + result/error.
        return 'id' in rec && ('result' in rec || 'error' in rec);
      });

    if (!valid) {
      const id =
        !Array.isArray(body) && typeof body === 'object' && body !== null
          ? ((body as Record<string, unknown>).id as string | number | null | undefined) ?? null
          : null;
      res.status(400).json(jsonRpcError(-32600, 'Invalid Request: missing "jsonrpc" or "method"', id));
      return;
    }
    return next();
  });

  // ── Per-request response timeout ──────────────────────────────────────────
  // This guard is response-only: it fails the HTTP request with 504 when nothing
  // has been sent in time. It cannot cancel work already in flight — the MCP SDK's
  // `transport.handleRequest` takes no AbortSignal, and synchronous SQLite
  // queries are not cancellable from Node once started.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.error('Request timed out', {
          path: req.path,
          ip: clientIp(req),
          timeoutMs: options.requestTimeoutMs,
        });
        res.status(504).json(jsonRpcError(-32000, 'Request timed out'));
      }
    }, options.requestTimeoutMs);
    timer.unref?.();
    res.on('close', () => clearTimeout(timer));
    next();
  });

  const closeSession = (sid: string, entry: SessionEntry, reason: string): void => {
    sessions.delete(sid);
    logger.info('Closing session', { sessionId: sid, reason, active: sessions.size });
    void Promise.resolve(entry.transport.close()).catch((err: unknown) => {
      logger.error('Failed to close session transport', { sessionId: sid, message: String(err) });
    });
    void Promise.resolve(entry.server.close()).catch((err: unknown) => {
      logger.error('Failed to close session server', { sessionId: sid, message: String(err) });
    });
  };

  // ── Idle session sweep ────────────────────────────────────────────────────
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity <= sessionIdleTimeoutMs) continue;
      closeSession(sid, entry, 'idle');
    }
  }, sessionSweepIntervalMs);
  sweep.unref?.();
  app.locals.sessionSweep = sweep;
  app.locals.sessions = sessions;
  /** Closes every session; graceful shutdown uses it to end SSE streams. */
  app.locals.closeAllSessions = (): void => {
    for (const [sid, entry] of [...sessions]) closeSession(sid, entry, 'shutdown');
  };

  /** First JSON-RPC message method in the body, if any. */
  const firstMethod = (body: unknown): string | undefined => {
    const msg = Array.isArray(body) ? body[0] : body;
    if (typeof msg !== 'object' || msg === null) return undefined;
    const method = (msg as Record<string, unknown>).method;
    return typeof method === 'string' ? method : undefined;
  };

  const firstId = (body: unknown): string | number | null => {
    const msg = Array.isArray(body) ? body[0] : body;
    if (typeof msg !== 'object' || msg === null) return null;
    const id = (msg as Record<string, unknown>).id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  };

  // ── MCP endpoint ──────────────────────────────────────────────────────────
  const handleMcp = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.status(404).json({ error: 'Session not found. Please reconnect.' });
          return;
        }
        if (existing.apiKeyName !== res.locals.apiKeyName) {
          logger.warn('Session used with a different API key', {
            sessionId,
            sessionKey: existing.apiKeyName,
            presentedKey: res.locals.apiKeyName,
          });
          res.status(403).json({ error: 'Session belongs to a different API key' });
          return;
        }
        existing.lastActivity = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        existing.lastActivity = Date.now();
        return;
      }

      // Without a session ID the only legal request is `initialize`. Anything else
      // must be rejected *before* we allocate a transport + McpServer, otherwise an
      // unauthenticated-shaped request stream would leak one server per request.
      if (req.method !== 'POST' || firstMethod(req.body) !== 'initialize') {
        res
          .status(400)
          .json(jsonRpcError(-32600, 'Bad Request: mcp-session-id header required for non-initialize requests', firstId(req.body)));
        return;
      }

      // Pre-check the cap before allocating any transport or McpServer. The
      // post-reservation check below still guards the tiny race window.
      if (sessions.size >= maxConcurrentSessions) {
        logger.warn('Session limit reached', { active: sessions.size, max: maxConcurrentSessions });
        res.status(503).json(jsonRpcError(-32000, 'Server busy: maximum concurrent sessions reached'));
        return;
      }

      const apiKeyName = res.locals.apiKeyName as string;
      // Counts reserved slots too, and runs synchronously up to the reservation
      // below, so concurrent initializations cannot overshoot the per-key cap.
      if (maxSessionsPerApiKey > 0) {
        let held = 0;
        for (const s of sessions.values()) if (s.apiKeyName === apiKeyName) held++;
        if (held >= maxSessionsPerApiKey) {
          logger.warn('Per-key session limit reached', { apiKey: apiKeyName, active: held, max: maxSessionsPerApiKey });
          res.status(429).json(jsonRpcError(-32000, 'Too many sessions: this API key holds its maximum concurrent sessions', firstId(req.body)));
          return;
        }
      }

      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid: string) => {
          const entry = sessions.get(sid);
          if (entry) entry.initialized = true;
          logger.info('Session initialized', { sessionId: sid, apiKey: apiKeyName, active: sessions.size });
        },
      });

      const mcpServer = createMcpServer({ clientSdkVersion: readDeclaredClientVersion(req.headers) });
      const entry: SessionEntry = {
        transport,
        server: mcpServer,
        lastActivity: Date.now(),
        initialized: false,
        apiKeyName,
      };

      // Reserve the slot synchronously so concurrent initializations cannot all
      // observe a stale `sessions.size` and blow past the cap.
      sessions.set(newSessionId, entry);
      if (sessions.size > maxConcurrentSessions) {
        sessions.delete(newSessionId);
        logger.warn('Session limit reached', { active: sessions.size, max: maxConcurrentSessions });
        res.status(503).json(jsonRpcError(-32000, 'Server busy: maximum concurrent sessions reached'));
        return;
      }

      transport.onclose = () => {
        if (sessions.delete(newSessionId)) {
          logger.info('Session closed', { sessionId: newSessionId, apiKey: apiKeyName, active: sessions.size });
        }
      };

      let handshakeOk = false;
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        handshakeOk = sessions.get(newSessionId)?.initialized ?? false;
        entry.lastActivity = Date.now();
      } finally {
        // If `onsessioninitialized` never fired (client disconnect, transport error,
        // rejected handshake) the reservation must be released along with the server.
        if (!handshakeOk && sessions.get(newSessionId) === entry) {
          closeSession(newSessionId, entry, 'initialize did not complete');
        }
      }
    } catch (err) {
      if (res.headersSent) {
        logger.error('Request failed after response started', { message: String(err) });
        return;
      }
      next(err);
    }
  };

  app.all('/mcp', handleMcp);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found. MCP endpoint is at /mcp' });
  });

  // ── Error handler (also converts body-parser failures) ────────────────────
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err?.type === 'entity.too.large') {
      logger.warn('Request body too large');
      res.status(413).json(jsonRpcError(-32600, 'Request body too large'));
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json(jsonRpcError(-32700, 'Parse error'));
      return;
    }
    // Any other client error from the body parser (unsupported charset or
    // content encoding, aborted upload) keeps its own 4xx status: it is the
    // caller's fault, so it must not surface as a 500 or page on-call.
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
      logger.warn('Request body rejected', { type: err.type, status: err.status });
      res.status(err.status).json(jsonRpcError(-32600, `Invalid Request: ${err.message}`));
      return;
    }
    logger.error('Unhandled request error', { message: err?.message });
    res.status(500).json(jsonRpcError(-32603, 'Internal error'));
  });

  return app;
}

export interface RunningHttpServer {
  server: Server;
  /** Resolves only after binding succeeds; rejects when the listener cannot start. */
  listening: Promise<void>;
  /** Closes every MCP session so their SSE streams end before the listener closes. */
  closeAllSessions: () => void;
}

/** Start the MCP Streamable HTTP transport server. */
export function startHttpServer(
  createMcpServer: ServerFactory,
  options: HttpTransportOptions,
): RunningHttpServer {
  const app = createHttpApp(createMcpServer, options);
  const httpServer = createServer(app);

  const logListening = () => {
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      logger.error('HTTP listener did not report a TCP address');
      return;
    }
    const port = address.port;
    logger.info('MCP HTTP transport listening', {
      port,
      host: options.host || 'all interfaces',
      endpoint: `http://localhost:${port}/mcp`,
      health: `http://localhost:${port}/health`,
      ready: options.readiness?.isReady() ?? true,
      trustProxyHops: options.trustProxyHops ?? 0,
      apiKeys: options.apiKeys.length,
    });
  };
  httpServer.on('close', () => {
    clearInterval(app.locals.sessionSweep as NodeJS.Timeout);
  });

  httpServer.on('error', (err: Error) => {
    logger.error('HTTP server error', { message: err.message });
  });

  const listening = new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('listening', onListening);
      httpServer.off('error', onError);
      clearInterval(app.locals.sessionSweep as NodeJS.Timeout);
      reject(error);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      logListening();
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    try {
      httpServer.listen(options.port, options.host);
    } catch (error) {
      onError(error as Error);
    }
  });

  return { server: httpServer, listening, closeAllSessions: app.locals.closeAllSessions as () => void };
}
