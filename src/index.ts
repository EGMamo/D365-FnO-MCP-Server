import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from './config.js';
import { openDb } from './indexer/db.js';
import { buildIndex } from './indexer/buildIndex.js';
import { startHttpServer } from './transport.js';
import { registerMetadataTools } from './tools/metadata.js';
import { registerLabelsTools } from './tools/labels.js';
import { registerGeneratorTools } from './tools/generators.js';

async function main() {
  console.log(`[D365-MCP] ${new Date().toISOString()} INFO Starting D365 FnO MCP Server v0.1.0`);

  // Open shared SQLite index database
  const db = openDb(config.indexDbPath);
  console.log(`[D365-MCP] ${new Date().toISOString()} INFO Opened SQLite DB at ${config.indexDbPath}`);

  /**
   * Factory: create a new McpServer instance with all tools registered.
   * Called once per MCP client session. All sessions share the same `db`
   * connection (better-sqlite3 is thread-safe for reads).
   */
  function createMcpServer(): McpServer {
    const server = new McpServer({
      name: 'd365-fno-mcp-server',
      version: '0.1.0',
    });

    registerMetadataTools(server, db);
    registerLabelsTools(server, db);
    registerGeneratorTools(server, db);

    return server;
  }

  // Start HTTP/SSE transport with API key middleware
  startHttpServer(createMcpServer, config);

  // Trigger background indexing (non-blocking — logs progress every 500 files)
  buildIndex(db, config.packagesDir, false)
    .then((stats) => {
      console.log(
        `[D365-MCP] ${new Date().toISOString()} INFO Background indexing complete: ` +
        `${stats.added} added, ${stats.updated} updated, ${stats.skipped} skipped, ` +
        `${stats.errors} errors in ${stats.durationMs}ms`,
      );
    })
    .catch((err) => {
      console.error(`[D365-MCP] ${new Date().toISOString()} ERROR Background indexing failed:`, err);
    });

  // Graceful shutdown
  const shutdown = () => {
    console.log(`[D365-MCP] ${new Date().toISOString()} INFO Shutting down...`);
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`[D365-MCP] ${new Date().toISOString()} FATAL Initialization failed:`, err);
  process.exit(1);
});
