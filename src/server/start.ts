import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fsSync from 'fs';
import path from 'path';
import { config, VERSION } from '../config.js';
import { openDb } from '../indexer/db.js';
import { buildIndex } from '../indexer/buildIndex.js';
import { readManifestCache, redactUrl, syncIndexFromManifest } from '../indexer/remoteIndex.js';
import { startHttpServer } from './httpTransport.js';
import { startStdioServer } from './stdioTransport.js';
import { logger } from '../utils/logger.js';
import { registerMetadataTools, type PublishedIndexInfo } from '../tools/metadata.js';
import { registerLabelsTools } from '../tools/labels.js';
import { registerGeneratorTools } from '../tools/generators.js';
import { registerWriterTools } from '../tools/writers.js';
import { registerKnowledgeResources, registerKnowledgeDigestTool } from '../tools/knowledge.js';
import { registerWorkspaceTools } from '../tools/workspace.js';

/** How long a graceful shutdown may take before the process exits regardless. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Hosted mode: bring the local database in line with the published index
 * before anything opens it. A stale local copy is still served when the
 * download fails; with no copy at all there is nothing to serve, so exit and
 * let the platform restart the container.
 */
async function preparePublishedIndex(): Promise<PublishedIndexInfo> {
  const manifestUrl = redactUrl(config.indexUrl);
  try {
    const result = await syncIndexFromManifest({
      manifestUrl: config.indexUrl,
      dbPath: config.indexDbPath,
      expectedServerVersion: VERSION,
    });
    logger.info('Published index ready', {
      status: result.status,
      version: result.manifest.version,
      builtAt: result.manifest.builtAt,
      objects: result.manifest.stats.objects,
      bytes: result.bytes,
      url: manifestUrl,
    });
    const syncedAt =
      result.status === 'downloaded'
        ? new Date().toISOString()
        : (readManifestCache(config.indexDbPath)?.downloadedAt ?? new Date().toISOString());
    return { manifestUrl, syncedAt, builtAt: result.manifest.builtAt, version: result.manifest.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (fsSync.existsSync(config.indexDbPath)) {
      const cached = readManifestCache(config.indexDbPath);
      logger.warn('Published index sync failed; serving the existing local copy', {
        url: manifestUrl,
        message,
        version: cached?.version ?? null,
      });
      return {
        manifestUrl,
        syncedAt: cached?.downloadedAt ?? null,
        builtAt: cached?.builtAt ?? null,
        version: cached?.version ?? null,
      };
    }
    logger.fatal('Published index sync failed and no local index exists', { url: manifestUrl, message });
    process.exit(1);
  }
}

/** Boots the MCP server on the configured transport. */
export async function startServer(): Promise<void> {
  logger.info('Starting D365 FnO MCP Server', {
    version: VERSION,
    transport: config.transport,
    hostedMode: config.hostedMode,
  });

  if (config.indexDbPath !== ':memory:') {
    fsSync.mkdirSync(path.dirname(path.resolve(config.indexDbPath)), { recursive: true });
  }
  const published = config.hostedMode ? await preparePublishedIndex() : undefined;

  // Open shared SQLite index database
  const db = openDb(config.indexDbPath);
  logger.info('Opened SQLite DB', { path: config.indexDbPath });

  /**
   * Factory: create a new McpServer instance with all tools registered.
   * Called once per MCP client session. All sessions share the same `db`
   * connection (Node's built-in SQLite driver is synchronous and safe for shared reads).
   */
  function createMcpServer(): McpServer {
    const server = new McpServer({ name: 'd365-fno-mcp-server', version: VERSION });

    registerMetadataTools(server, db, { published });
    registerLabelsTools(server, db);
    registerGeneratorTools(server, db);
    registerWriterTools(server, db, {
      enableWriteTools: config.enableWriteTools,
      projectDir: config.projectDir,
      workspaceDir: config.visualStudioWorkspaceDir,
      customMetadataDir: config.customMetadataDir,
      defaultProject: config.targetProject,
      defaultPackage: config.targetPackage,
      defaultModel: config.targetModel,
      defaultSolution: config.targetSolution,
      writableModels: config.writableModels,
    });
    registerWorkspaceTools(server, {
      workspaceDir: config.visualStudioWorkspaceDir,
      customMetadataDir: config.customMetadataDir,
      targetProject: config.targetProject,
      targetPackage: config.targetPackage,
      targetModel: config.targetModel,
      targetSolution: config.targetSolution,
      writableModels: config.writableModels,
      projectDir: config.projectDir,
      customMetadataSource: config.customMetadataSource,
      enableWriteTools: config.enableWriteTools,
    });
    registerKnowledgeResources(server);
    registerKnowledgeDigestTool(server, db, { enableWriteTools: config.enableWriteTools });

    return server;
  }

  function startBackgroundIndexing() {
    if (!config.packagesDir) {
      logger.error('Skipping background indexing: D365_PACKAGES_DIR is not set');
      return;
    }
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

  const http = startHttpServer(createMcpServer, {
    port: config.port,
    host: config.host || undefined,
    apiKeys: config.apiKeys,
    version: VERSION,
    rateLimitMaxRequests: config.rateLimitMaxRequests,
    rateLimitWindowMs: config.rateLimitWindowMs,
    requestTimeoutMs: config.requestTimeoutMs,
    trustProxyHops: config.trustProxyHops,
    maxConcurrentSessions: config.maxConcurrentSessions,
    sessionIdleTimeoutMs: config.sessionIdleTimeoutMs,
  });

  if (config.indexOnStart) startBackgroundIndexing();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...', { signal });
    const deadline = setTimeout(() => {
      logger.warn('Shutdown timed out; exiting');
      process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    deadline.unref();

    http.closeAllSessions();
    http.server.close(() => {
      db.close();
      process.exit(0);
    });
    http.server.closeAllConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
