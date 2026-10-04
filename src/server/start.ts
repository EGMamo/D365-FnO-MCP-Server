import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fsSync from 'fs';
import path from 'path';
import { config, VERSION } from '../config.js';
import { openDb, openDbReadOnly, getMeta, INDEX_SCHEMA_VERSION, META_KEYS, type Database } from '../indexer/db.js';
import { buildSessionInstructions } from '../indexer/appVersion.js';
import { materializeAzureArtifactIndex, prepareArtifactBackedIndex } from './artifactStartup.js';
import { setSourceFileReads } from '../indexer/sourceFiles.js';
import { startHttpServer, type SessionContext } from './httpTransport.js';
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
import {
  findKnowledgeDir,
  registerKnowledgeResources,
  registerTaskGuidanceTool,
  TASK_GUIDANCE_HINT,
} from '../tools/knowledge.js';
import { KnowledgeSession, startKnowledgeFilter } from '../knowledge/filter.js';
import { registerWithKnowledgeFilter } from '../knowledge/toolWrapper.js';
import { registerWorkspaceTools } from '../tools/workspace.js';

/** How long a graceful shutdown may take before the process exits regardless. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Boots the MCP server over authenticated HTTP. */
export async function startServer(): Promise<void> {
  logger.info('Starting D365 FnO MCP Server', {
    version: VERSION,
    transport: 'http',
  });

  if (config.indexDbPath !== ':memory:') {
    fsSync.mkdirSync(path.dirname(path.resolve(config.indexDbPath)), { recursive: true });
  }
  const hosted = config.artifactStorePath.length > 0;
  let sourceFilesAvailable = false;
  try {
    sourceFilesAvailable =
      !hosted &&
      config.packagesDir.trim().length > 0 &&
      fsSync.statSync(config.packagesDir).isDirectory();
  } catch {
    sourceFilesAvailable = false;
  }
  setSourceFileReads(sourceFilesAvailable, config.packagesDir);

  /** The served index. Hosted mode opens it only after the artifact bundle is activated. */
  let db: Database | null = null;
  const openIndex = () => {
    const opened = hosted ? openDbReadOnly(config.indexDbPath) : openDb(config.indexDbPath);
    // A representative read proves the activated snapshot is queryable before readiness.
    if (hosted) opened.prepare('SELECT name FROM ax_objects LIMIT 1').get();
    db = opened;
    logger.info('Opened SQLite DB', { path: config.indexDbPath, readOnly: hosted });
  };
  const requireDb = (): Database => {
    if (!db) throw new Error('The index is not open yet.');
    return db;
  };
  if (!hosted) openIndex();

  /**
   * Application version the served index describes. A locally built index on a
   * path that does not name the version (classic AOS layouts) falls back to the
   * configured version, which describes this host's own SDK.
   */
  function resolveIndexAppVersion(): string | null {
    const recorded = getMeta(requireDb(), META_KEYS.appVersion);
    if (recorded) return recorded;
    return config.appVersion || null;
  }

  // Index tool results pass through the knowledge base (filter, rank, annotate). Embeddings load
  // in the background; until then, and without the model, topic header rules still apply.
  const knowledgeDir = findKnowledgeDir();
  const knowledgeFilter = config.knowledgeFilter ? startKnowledgeFilter(knowledgeDir) : { current: () => null };

  /**
   * Factory: create a new McpServer instance with all tools registered.
   * Called once per MCP client session. All sessions share the same `db`
   * connection (Node's built-in SQLite driver is synchronous and safe for shared reads).
   */
  function createMcpServer(context?: SessionContext): McpServer {
    const db = requireDb();
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
      { instructions: config.knowledgeFilter ? `${instructions.text}\n\n${TASK_GUIDANCE_HINT}` : instructions.text }
    );
    const knowledgeSession = new KnowledgeSession();

    registerWithKnowledgeFilter(server, knowledgeFilter.current, () => {
      registerMetadataTools(server, db, { sourceFilesAvailable });
      registerLabelsTools(server, db);
      registerSecurityTools(server, db);
      registerEntityTools(server, db);
      registerTraceTools(server, db);
      registerTelemetryTools(server, db);
      registerCodeQualityTools(server, db);
      registerReleasePlanTools(server, db);
      registerGeneratorTools(server, db);
    }, knowledgeSession);
    if (config.knowledgeFilter) registerTaskGuidanceTool(server, knowledgeFilter.current, knowledgeSession);
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
    registerKnowledgeResources(server, knowledgeDir);

    return server;
  }

  async function activateArtifactIndex(): Promise<void> {
    const options = {
      storePath: config.artifactStorePath,
      indexDbPath: config.indexDbPath,
      serverVersion: VERSION,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
      requiredCapabilities: config.artifactRequiredCapabilities,
    };
    if (config.artifactSource === 'azure-blob') {
      logger.info('Materializing the active artifact bundle from Azure Blob Storage', {
        accountUrl: config.artifactAccountUrl,
        container: config.artifactContainer,
        localStorePath: config.artifactStorePath,
      });
      const { createAzureBlobArtifactStore } = await import('../indexer/azureBlobArtifactStoreSdk.js');
      const store = createAzureBlobArtifactStore({
        accountUrl: config.artifactAccountUrl,
        containerName: config.artifactContainer,
        managedIdentityClientId: config.artifactManagedIdentityClientId || undefined,
      });
      const materialized = await materializeAzureArtifactIndex({ ...options, store });
      logger.info('Activated validated artifact bundle', {
        source: 'azure-blob',
        bundleId: materialized.bundle.manifest.bundleId,
        pointerRevision: materialized.pointerRevision,
        pointerEtag: materialized.pointerEtag,
        reusedLocalBundle: materialized.reusedLocalBundle,
        applicationVersion: materialized.bundle.manifest.d365.applicationVersion,
      });
      return;
    }
    const prepared = prepareArtifactBackedIndex(options);
    logger.info('Activated validated artifact bundle', {
      source: 'local',
      bundleId: prepared.bundle.manifest.bundleId,
      pointerRevision: prepared.pointerRevision,
      applicationVersion: prepared.bundle.manifest.d365.applicationVersion,
    });
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
    readiness: { isReady: () => db !== null },
  });

  if (hosted) {
    // Listen first so the platform sees a live but unready replica while the
    // bundle is materialized and validated; fail closed if that does not succeed.
    http.server.once('listening', () => {
      void activateArtifactIndex()
        .then(() => {
          openIndex();
          logger.info('MCP server ready', { indexDbPath: config.indexDbPath });
        })
        .catch((error: unknown) => {
          logger.fatal('Artifact startup failed; refusing to serve', {
            error: error instanceof Error ? error.message : String(error),
          });
          process.exit(1);
        });
    });
  }

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
      db?.close();
      process.exit(0);
    });
    http.server.closeAllConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
