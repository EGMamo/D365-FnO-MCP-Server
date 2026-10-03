import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fsSync from 'fs';
import path from 'path';
import { config, VERSION } from '../config.js';
import { openDb, openDbReadOnly, getMeta, INDEX_SCHEMA_VERSION, META_KEYS } from '../indexer/db.js';
import { buildSessionInstructions } from '../indexer/appVersion.js';
import { prepareArtifactBackedIndex } from './artifactStartup.js';
import { setSourceFileReads } from '../indexer/sourceFiles.js';
import { startHttpServer, type SessionContext } from './httpTransport.js';
import { startStdioServer } from './stdioTransport.js';
import { logger } from '../utils/logger.js';
import { registerMetadataTools } from '../tools/metadata.js';
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

/** Boots the MCP server on the configured transport. */
export async function startServer(): Promise<void> {
  logger.info('Starting D365 FnO MCP Server', {
    version: VERSION,
    transport: config.transport,
  });

  if (config.indexDbPath !== ':memory:') {
    fsSync.mkdirSync(path.dirname(path.resolve(config.indexDbPath)), { recursive: true });
  }
  if (config.artifactStorePath) {
    const prepared = prepareArtifactBackedIndex({
      storePath: config.artifactStorePath,
      indexDbPath: config.indexDbPath,
      serverVersion: VERSION,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
    });
    logger.info('Activated validated artifact bundle', {
      bundleId: prepared.bundle.manifest.bundleId,
      pointerRevision: prepared.pointerRevision,
      applicationVersion: prepared.bundle.manifest.d365.applicationVersion,
    });
  }
  let sourceFilesAvailable = false;
  try {
    sourceFilesAvailable = config.packagesDir.trim().length > 0 && fsSync.statSync(config.packagesDir).isDirectory();
  } catch {
    sourceFilesAvailable = false;
  }
  setSourceFileReads(sourceFilesAvailable);

  // Open the shared SQLite index database.
  const db = config.artifactStorePath ? openDbReadOnly(config.indexDbPath) : openDb(config.indexDbPath);
  logger.info('Opened SQLite DB', {
    path: config.indexDbPath,
    readOnly: config.artifactStorePath.length > 0,
  });

  /**
   * Application version the served index describes. A locally built index on a
   * path that does not name the version (classic AOS layouts) falls back to the
   * configured version, which describes this host's own SDK.
   */
  function resolveIndexAppVersion(): string | null {
    const recorded = getMeta(db, META_KEYS.appVersion);
    if (recorded) return recorded;
    return config.appVersion || null;
  }

  /**
   * Factory: create a new McpServer instance with all tools registered.
   * Called once per MCP client session. All sessions share the same `db`
   * connection (Node's built-in SQLite driver is synchronous and safe for shared reads).
   */
  function createMcpServer(context?: SessionContext): McpServer {
    const instructions = buildSessionInstructions({
      indexVersion: resolveIndexAppVersion(),
      clientVersion: context?.clientSdkVersion ?? config.appVersion ?? null,
      builtAt: getMeta(db, META_KEYS.builtAt),
    });
    if (instructions.drift.severity === 'warning') {
      logger.warn('Client SDK version is older than the indexed application version', {
        clientVersion: instructions.drift.clientVersion,
        indexVersion: instructions.drift.indexVersion,
      });
    }
    const server = new McpServer(
      { name: 'd365-fno-mcp-server', version: VERSION },
      { instructions: instructions.text }
    );

    registerMetadataTools(server, db, { sourceFilesAvailable });
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

  if (config.transport === 'stdio') {
    await startStdioServer(createMcpServer, {
      version: VERSION,
      onShutdown: () => db.close(),
    });
    return;
  }

  if (config.enableWriteTools) {
    logger.warn('Write tools are enabled over HTTP: every API key can write metadata and knowledge base articles', {
      keys: config.apiKeys.map((entry) => entry.name).join(', '),
    });
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
