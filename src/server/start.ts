import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fsSync from 'fs';
import path from 'path';
import { config, VERSION } from '../config.js';
import { openDb } from '../indexer/db.js';
import { buildIndex, getIndexStats } from '../indexer/buildIndex.js';
import { publishToContainer } from '../indexer/blobStore.js';
import {
  readManifestCache, redactUrl, syncIndexFromManifest, writeManifestCache, type CachedManifest,
} from '../indexer/remoteIndex.js';
import { setSourceFileReads } from '../indexer/sourceFiles.js';
import { startHttpServer, type AdminRoutes } from './httpTransport.js';
import { createIndexAdminRouter, IndexUploadManager } from './indexUpload.js';
import { startStdioServer } from './stdioTransport.js';
import { logger } from '../utils/logger.js';
import { registerMetadataTools, type PublishedIndexInfo } from '../tools/metadata.js';
import { registerLabelsTools } from '../tools/labels.js';
import { registerSecurityTools } from '../tools/security.js';
import { registerEntityTools } from '../tools/entities.js';
import { registerTraceTools } from '../tools/traces.js';
import { registerReleasePlanTools } from '../tools/releasePlans.js';
import { registerTelemetryTools } from '../tools/telemetry.js';
import { registerCodeQualityTools } from '../tools/codeQuality.js';
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
      keepNewerUpload: true,
    });
    if (result.status === 'kept-upload') {
      const cached = readManifestCache(config.indexDbPath);
      logger.info('Serving an uploaded index that is newer than the published one', {
        version: cached?.version ?? null,
        builtAt: cached?.builtAt ?? null,
        publishedVersion: result.manifest.version,
      });
      if (cached) return uploadInfo(cached);
    }
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
    return { source: 'manifest', manifestUrl, syncedAt, builtAt: result.manifest.builtAt, version: result.manifest.version };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (fsSync.existsSync(config.indexDbPath)) {
      const cached = readManifestCache(config.indexDbPath);
      logger.warn('Published index sync failed; serving the existing local copy', {
        url: manifestUrl,
        message,
        version: cached?.version ?? null,
      });
      if (cached?.source === 'upload') return uploadInfo(cached);
      return {
        source: 'manifest',
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

function uploadInfo(cache: CachedManifest): PublishedIndexInfo {
  return {
    source: 'upload',
    manifestUrl: null,
    uploadedBy: cache.uploadedBy,
    syncedAt: cache.downloadedAt,
    builtAt: cache.builtAt,
    version: cache.version,
  };
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
  let published = config.hostedMode ? await preparePublishedIndex() : undefined;
  if (!published && config.indexDbPath !== ':memory:') {
    // A local index that arrived by upload has no source files on this host either.
    const cached = readManifestCache(config.indexDbPath);
    if (cached?.source === 'upload' && fsSync.existsSync(config.indexDbPath)) published = uploadInfo(cached);
  }
  // An index that was downloaded or uploaded was built elsewhere: its file paths
  // are not this machine's, so tools must not follow them (see sourceFiles.ts).
  const transferred = published !== undefined ||
    (config.indexDbPath !== ':memory:' && readManifestCache(config.indexDbPath) !== null);
  setSourceFileReads(!transferred);

  // Open shared SQLite index database. `db` and `published` are replaced when
  // an uploaded index is activated; sessions created afterwards see the new ones.
  let db = openDb(config.indexDbPath);
  logger.info('Opened SQLite DB', { path: config.indexDbPath });
  let backgroundIndexing = false;
  let closeAllSessions: () => void = () => {};

  /**
   * Factory: create a new McpServer instance with all tools registered.
   * Called once per MCP client session. All sessions share the same `db`
   * connection (Node's built-in SQLite driver is synchronous and safe for shared reads).
   */
  function createMcpServer(): McpServer {
    const server = new McpServer({ name: 'd365-fno-mcp-server', version: VERSION });

    registerMetadataTools(server, db, { published });
    registerLabelsTools(server, db);
    registerSecurityTools(server, db);
    registerEntityTools(server, db);
    registerTraceTools(server, db);
    registerTelemetryTools(server, db);
    registerCodeQualityTools(server, db);
    registerReleasePlanTools(server, db);
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

    backgroundIndexing = true;
    buildIndex(db, config.packagesDir, false)
      .finally(() => {
        backgroundIndexing = false;
      })
      .then((stats) => {
        logger.info('Background indexing complete', { ...stats });
      })
      .catch((err: unknown) => {
        logger.error('Background indexing failed', { message: String(err) });
      });
  }

  /**
   * Swaps a verified uploaded database in. Synchronous, so no request sees a
   * closed handle. If the file cannot be moved into place, the previous index
   * is reopened and the upload fails instead of leaving the server without one.
   */
  function activateUpload(incoming: string, cache: CachedManifest): void {
    closeAllSessions();
    db.close();
    try {
      for (const suffix of ['-wal', '-shm']) fsSync.rmSync(`${config.indexDbPath}${suffix}`, { force: true });
      fsSync.renameSync(incoming, config.indexDbPath);
    } catch (err) {
      db = openDb(config.indexDbPath);
      throw err;
    }
    try {
      db = openDb(config.indexDbPath);
    } catch (err) {
      logger.fatal('The activated index could not be opened', { message: String(err) });
      process.exit(1);
    }
    writeManifestCache(config.indexDbPath, cache);
    published = uploadInfo(cache);
    setSourceFileReads(false);
  }

  function describeIndex(): Record<string, unknown> {
    const stats = getIndexStats(db);
    return {
      source: published?.source ?? 'local',
      version: published?.version ?? null,
      builtAt: stats.builtAt,
      objects: stats.totalObjects,
      labels: stats.totalLabels,
      usageSnapshot: stats.usageSnapshot,
      serverVersion: stats.serverVersion,
      uploadedBy: published?.uploadedBy ?? null,
      activatedAt: published?.syncedAt ?? null,
    };
  }

  function createAdminRoutes(): AdminRoutes {
    const publishUrl = config.indexPublishUrl;
    const uploads = config.indexUploadKeys.length > 0 && config.indexDbPath !== ':memory:'
      ? new IndexUploadManager({
          workDir: config.indexUploadDir || path.join(path.dirname(path.resolve(config.indexDbPath)), '.uploads'),
          indexDbPath: path.resolve(config.indexDbPath),
          serverVersion: VERSION,
          maxBytes: config.indexUploadMaxBytes,
          maxChunkBytes: config.indexUploadMaxChunkBytes,
          activate: activateUpload,
          persist: publishUrl ? (file, manifest) => publishToContainer(publishUrl, file, manifest) : undefined,
          blockedReason: () => (backgroundIndexing ? 'The server is indexing; try the upload again when it finishes.' : undefined),
        })
      : undefined;
    if (uploads) {
      logger.info('Index uploads enabled', {
        keys: config.indexUploadKeys.join(', '),
        persistent: publishUrl ? redactUrl(publishUrl) : 'no (lost on restart when the index disk is ephemeral)',
      });
    }
    return {
      router: createIndexAdminRouter({
        uploads,
        uploadKeyNames: new Set(config.indexUploadKeys),
        describeIndex,
        version: VERSION,
      }),
    };
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

  const admin = createAdminRoutes();
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
    admin,
  });
  closeAllSessions = http.closeAllSessions;

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
