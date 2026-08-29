import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, VERSION } from './config.js';
import { openDb } from './indexer/db.js';
import { buildIndex } from './indexer/buildIndex.js';
import { startHttpServer } from './server/httpTransport.js';
import { startStdioServer } from './server/stdioTransport.js';
import { logger } from './utils/logger.js';
import { registerMetadataTools } from './tools/metadata.js';
import { registerLabelsTools } from './tools/labels.js';
import { registerGeneratorTools } from './tools/generators.js';

async function main() {
  logger.info('Starting D365 FnO MCP Server', { version: VERSION, transport: config.transport });

  // Open shared SQLite index database
  const db = openDb(config.indexDbPath);
  logger.info('Opened SQLite DB', { path: config.indexDbPath });

  /**
   * Factory: create a new McpServer instance with all tools registered.
   * Called once per MCP client session. All sessions share the same `db`
   * connection (better-sqlite3 is synchronous and safe for shared reads).
   */
  function createMcpServer(): McpServer {
    const server = new McpServer({ name: 'd365-fno-mcp-server', version: VERSION });

    registerMetadataTools(server, db);
    registerLabelsTools(server, db);
    registerGeneratorTools(server, db);

    return server;
  }

  function startBackgroundIndexing() {
    buildIndex(db, config.packagesDir, false)
      .then((stats) => {
        logger.info('Background indexing complete', { ...stats });
      })
      .catch((err: unknown) => {
        logger.error('Background indexing failed', { message: String(err) });
      });
  }

  if (config.transport === 'stdio') {
    await startStdioServer(createMcpServer, {
      version: VERSION,
      onShutdown: () => db.close(),
    });
    // stdio clients own the process lifecycle; only index when explicitly asked.
    if (config.indexOnStart) startBackgroundIndexing();
    return;
  }

  startHttpServer(createMcpServer, {
    port: config.port,
    mcpApiKey: config.mcpApiKey,
    version: VERSION,
    rateLimitMaxRequests: config.rateLimitMaxRequests,
    rateLimitWindowMs: config.rateLimitWindowMs,
    requestTimeoutMs: config.requestTimeoutMs,
    trustProxyHops: config.trustProxyHops,
    maxConcurrentSessions: config.maxConcurrentSessions,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
  });

  startBackgroundIndexing();

  const shutdown = () => {
    logger.info('Shutting down...');
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.fatal('Initialization failed', { message: String(err) });
  process.exit(1);
});
