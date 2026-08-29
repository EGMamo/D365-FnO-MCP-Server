import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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
}

interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string };
}

function jsonRpcError(code: number, message: string, id: string | number | null = null): JsonRpcErrorBody {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Constant-time string comparison that does not leak length via early exit. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  // timingSafeEqual throws on length mismatch, so hash to a fixed width first.
  const hashA = createHash('sha256').update(bufA).digest();
  const hashB = createHash('sha256').update(bufB).digest();
  return timingSafeEqual(hashA, hashB);
}

/** Extract a presented API key from `X-API-Key` or `Authorization: Bearer <key>`. */
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
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '1mb' }));

  // ── Rate limiting ─────────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs: options.rateLimitWindowMs,
      max: options.rateLimitMaxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === '/health',
      keyGenerator: (req) => {
        const ip = ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown');
        if (options.mcpApiKey) return ip;
        const auth = req.headers.authorization ?? '';
        return `${createHash('sha256').update(auth).digest('hex')}:${ip}`;
      },
      handler: (req, res) => {
        logger.warn('Rate limit exceeded', { ip: req.ip, path: req.path });
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
      logger.warn('Unauthorized request', { ip: req.ip, method: req.method, path: req.path });
      res.status(401).json({ error: 'Unauthorized: invalid or missing API key' });
      return;
    }
    logger.info('Request', { method: req.method, path: req.path, ip: req.ip });
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
        return rec.jsonrpc === '2.0' && typeof rec.method === 'string';
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
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.error('Request timed out', { path: req.path, timeoutMs: options.requestTimeoutMs });
        res.status(504).json(jsonRpcError(-32000, 'Request timed out'));
      }
    }, options.requestTimeoutMs);
    timer.unref?.();
    res.on('close', () => clearTimeout(timer));
    next();
  });

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
        await existing.handleRequest(req, res, req.body);
        return;
      }

      const newSessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId,
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, transport);
          logger.info('Session initialized', { sessionId: sid, active: sessions.size });
        },
      });

      transport.onclose = () => {
        sessions.delete(newSessionId);
        logger.info('Session closed', { sessionId: newSessionId, active: sessions.size });
      };

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      next(err);
    }
  };

  app.all('/mcp', handleMcp);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found. MCP endpoint is at /mcp' });
  });

  // ── Error handler (also converts body-parser failures) ────────────────────
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
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
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, 'Internal error'));
    }
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
    });
  });

  httpServer.on('error', (err: Error) => {
    logger.error('HTTP server error', { message: err.message });
  });

  return httpServer;
}
