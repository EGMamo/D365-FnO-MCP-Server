import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import type { Server } from 'http';
import { logger } from '../utils/logger.js';

export type ServerFactory = () => McpServer;

export interface HttpTransportOptions {
  port: number;
  mcpApiKey: string;
  version: string;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
  requestTimeoutMs: number;
  /** Number of trusted reverse-proxy hops. 0 = do not trust X-Forwarded-For. */
  trustProxyHops?: number;
  maxConcurrentSessions?: number;
  sessionIdleTimeoutMs?: number;
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
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
  const app = express();
  const sessions = new Map<string, SessionEntry>();
  const trustProxyHops = options.trustProxyHops ?? 0;
  const maxConcurrentSessions = options.maxConcurrentSessions ?? 100;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 30 * 60 * 1000;

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

  app.use(express.json({ limit: '1mb' }));

  // ── Rate limiting ─────────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: options.rateLimitWindowMs,
      max: options.rateLimitMaxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === '/health',
      // Key on the client IP alone. The rate limiter runs before authentication,
      // so a client-controlled credential header must not be part of the bucket key.
      // When all clients share the same MCP_API_KEY, per-credential bucketing is not
      // meaningful anyway; a real per-user throttle belongs behind verified auth.
      keyGenerator: (req: Request) => clientIp(req),
      handler: (req, res) => {
        logger.warn('Rate limit exceeded', { ip: clientIp(req), path: req.path });
        res.status(429).json(jsonRpcError(-32029, 'Too many requests'));
      },
    }),
  );

  // ── Health check (unauthenticated) ────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: options.version });
  });

  // ── API key auth ──────────────────────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const presented = extractApiKey(req);
    if (!presented || !safeEqual(presented, options.mcpApiKey)) {
      logger.warn('Unauthorized request', { ip: clientIp(req), method: req.method, path: req.path });
      res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
      return;
    }
    logger.info('Request', { method: req.method, path: req.path, ip: clientIp(req) });
    next();
  });

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

  // ── Per-request timeout ───────────────────────────────────────────────────
  app.use((req: Request, res: Response, next: NextFunction) => {
    const controller = new AbortController();
    (req as Request & { abortSignal?: AbortSignal }).abortSignal = controller.signal;

    const timer = setTimeout(() => {
      controller.abort();
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

  // ── Idle session sweep ────────────────────────────────────────────────────
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity <= sessionIdleTimeoutMs) continue;
      sessions.delete(sid);
      logger.info('Closing idle session', { sessionId: sid, active: sessions.size });
      void Promise.resolve(entry.transport.close()).catch((err: unknown) => {
        logger.error('Failed to close idle session', { sessionId: sid, message: String(err) });
      });
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweep.unref?.();
  app.locals.sessionSweep = sweep;
  app.locals.sessions = sessions;

  // ── MCP endpoint ──────────────────────────────────────────────────────────
  const handleMcp = async (req: Request, res: Response, next: NextFunction) => {
    const signal = (req as Request & { abortSignal?: AbortSignal }).abortSignal;
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          res.status(404).json({ error: 'Session not found. Please reconnect.' });
          return;
        }
        existing.lastActivity = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        existing.lastActivity = Date.now();
        return;
      }

      if (sessions.size >= maxConcurrentSessions) {
        logger.warn('Session limit reached', { active: sessions.size, max: maxConcurrentSessions });
        res.status(503).json(jsonRpcError(-32000, 'Server busy: maximum concurrent sessions reached'));
        return;
      }

      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, lastActivity: Date.now() });
          logger.info('Session initialized', { sessionId: sid, active: sessions.size });
        },
      });

      transport.onclose = () => {
        sessions.delete(newSessionId);
        logger.info('Session closed', { sessionId: newSessionId, active: sessions.size });
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      if (signal?.aborted) return;
      await transport.handleRequest(req, res, req.body);
      const entry = sessions.get(newSessionId);
      if (entry) entry.lastActivity = Date.now();
    } catch (err) {
      if (signal?.aborted || res.headersSent) {
        logger.error('Request failed after response started or abort', { message: String(err) });
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
    logger.error('Unhandled request error', { message: err?.message });
    res.status(500).json(jsonRpcError(-32603, 'Internal error'));
  });

  return app;
}

/** Start the MCP Streamable HTTP transport server. */
export function startHttpServer(
  createMcpServer: ServerFactory,
  options: HttpTransportOptions,
): Server {
  const app = createHttpApp(createMcpServer, options);

  const httpServer = app.listen(options.port, () => {
    logger.info('MCP HTTP transport listening', {
      port: options.port,
      endpoint: `http://localhost:${options.port}/mcp`,
      health: `http://localhost:${options.port}/health`,
      trustProxyHops: options.trustProxyHops ?? 0,
    });
  });

  httpServer.on('close', () => {
    clearInterval(app.locals.sessionSweep as NodeJS.Timeout);
  });

  httpServer.on('error', (err: Error) => {
    logger.error('HTTP server error', { message: err.message });
  });

  return httpServer;
}
