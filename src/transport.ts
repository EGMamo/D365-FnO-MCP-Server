import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http, { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

type ServerFactory = () => McpServer;

// Active sessions: sessionId → transport
const sessions = new Map<string, StreamableHTTPServerTransport>();

/** Read raw HTTP request body as a parsed JSON object (or undefined). */
async function readBody(req: IncomingMessage): Promise<unknown | undefined> {
  if (req.method !== 'POST') return undefined;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
    });
    req.on('error', reject);
  });
}

function log(level: string, message: string) {
  console.log(`[D365-MCP] ${new Date().toISOString()} ${level} ${message}`);
}

/**
 * Start the HTTP server for the MCP Streamable transport (MCP 2025-03-26 spec).
 * Each new client session gets its own McpServer + transport pair.
 * Session ID is managed via the `mcp-session-id` header.
 */
export function startHttpServer(
  createMcpServer: ServerFactory,
  config: { port: number; mcpApiKey: string },
) {
  const httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // ── 1. API key auth ────────────────────────────────────────────────────────
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== config.mcpApiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing X-API-Key header' }));
      log('WARN', `Unauthorized access attempt from ${req.socket.remoteAddress}`);
      return;
    }

    log('INFO', `${req.method} ${req.url} from ${req.socket.remoteAddress}`);

    // ── 2. Route ───────────────────────────────────────────────────────────────
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found. MCP endpoint is at /mcp' }));
      return;
    }

    // ── 3. Session routing ────────────────────────────────────────────────────
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — delegate to its transport
      const body = await readBody(req);
      await sessions.get(sessionId)!.handleRequest(req, res, body);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      // Unknown session — client may have reconnected after server restart
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found. Please reconnect.' }));
      return;
    }

    // ── 4. New session ────────────────────────────────────────────────────────
    const newSessionId = randomUUID();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, transport);
        log('INFO', `Session initialized: ${sid} (total active: ${sessions.size})`);
      },
    });

    transport.onclose = () => {
      sessions.delete(newSessionId);
      log('INFO', `Session closed: ${newSessionId} (total active: ${sessions.size})`);
    };

    // Create a fresh McpServer for this session (tools share the same db via closure)
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    const body = await readBody(req);
    await transport.handleRequest(req, res, body);
  });

  httpServer.listen(config.port, () => {
    log('INFO', `MCP Server HTTP listening on port ${config.port}`);
    log('INFO', `Endpoint: http://localhost:${config.port}/mcp`);
    log('INFO', 'Clients must include X-API-Key header with every request.');
  });

  httpServer.on('error', (err) => {
    log('ERROR', `HTTP server error: ${err.message}`);
  });
}
