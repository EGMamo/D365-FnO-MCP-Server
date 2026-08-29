import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fsSync from 'fs';
import { config, VERSION } from '../config.js';
import { openDb } from '../indexer/db.js';
import { buildIndex } from '../indexer/buildIndex.js';
import { startHttpServer } from './httpTransport.js';
import { startStdioServer } from './stdioTransport.js';
import { logger } from '../utils/logger.js';
import { registerMetadataTools } from '../tools/metadata.js';
import { registerLabelsTools } from '../tools/labels.js';
import { registerGeneratorTools } from '../tools/generators.js';
import { registerWriterTools } from '../tools/writers.js';
import { registerKnowledgeResources } from '../tools/knowledge.js';

/** Boots the MCP server on the configured transport. */
export async function startServer(): Promise<void> {
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
    registerWriterTools(server, db, {
      enableWriteTools: config.enableWriteTools,
      projectDir: config.projectDir,
    });
    registerKnowledgeResources(server);

    return server;
  }

  function startBackgroundIndexing() {
    let isDir = false;
    try {
      isDir = fsSync.statSync(config.packagesDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      logger.error('Skipping background indexing: packages directory is missing or not a directory', {
        packagesDir: config.packagesDir,
      });
      return;
    }

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
