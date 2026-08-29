import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../utils/logger.js';
import type { ServerFactory } from './httpTransport.js';

export interface StdioTransportOptions {
  version: string;
  /** Called on shutdown, e.g. to close the SQLite handle. */
  onShutdown?: () => void;
}

/**
 * Start the MCP stdio transport. A single McpServer instance is connected to a
 * single StdioServerTransport; stdout carries JSON-RPC framing only, so all
 * logging goes to stderr.
 */
export async function startStdioServer(
  createMcpServer: ServerFactory,
  options: StdioTransportOptions,
): Promise<StdioServerTransport> {
  const transport = new StdioServerTransport();
  const server: McpServer = createMcpServer();

  await server.connect(transport);
  logger.info('MCP stdio transport connected', { version: options.version });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down stdio transport', { signal });
    void transport
      .close()
      .catch((err: unknown) => logger.error('Error closing stdio transport', { message: String(err) }))
      .finally(() => {
        try {
          options.onShutdown?.();
        } catch (err) {
          logger.error('Error during shutdown hook', { message: String(err) });
        }
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return transport;
}
