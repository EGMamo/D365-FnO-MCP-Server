import { z } from 'zod';
import { safeSegment } from './workspace/safety.js';
import { parseApiKeys, type ApiKeyEntry } from './server/apiKeys.js';
import { parseRequiredCapabilities } from './indexer/capabilityCoverage.js';
import { VERSION } from './version.js';

/**
 * Pure configuration loading: parses an environment object and either returns
 * the config or throws `ConfigError`. `config.ts` wraps this with dotenv and
 * process exit so the rest of the server can keep importing a ready object.
 */

const configSchema = z.object({
  MCP_PORT: z.coerce.number().default(3000),
  /** Interface to bind. Empty binds every interface (the container case). */
  MCP_HOST: z.string().default(''),
  /** Legacy single key; still accepted and reported under the name `default`. */
  MCP_API_KEY: z.string().default(''),
  /** `name=key` entries separated by commas or newlines. */
  MCP_API_KEYS: z.string().default(''),
  MCP_TRANSPORT: z.literal('http').default('http'),
  /** Required only for the offline `index` command. */
  D365_PACKAGES_DIR: z.string().default(''),
  /**
   * Four-part D365 application version for this host's PackagesLocalDirectory.
   * On the server it labels an index whose path does not name the version.
   */
  D365_APP_VERSION: z.string().default(''),
  D365_INDEX_DB_PATH: z.string().default('./d365_index.db'),
  /** Optional immutable artifact store. The active bundle is validated into D365_INDEX_DB_PATH. */
  D365_ARTIFACT_STORE_PATH: z.string().default(''),
  /**
   * Where `serve` reads the active bundle from. `local`: D365_ARTIFACT_STORE_PATH is the
   * artifact store. `azure-blob`: the store is the Blob container below and
   * D365_ARTIFACT_STORE_PATH is this replica's instance-local materialization directory.
   */
  D365_ARTIFACT_SOURCE: z.enum(['local', 'azure-blob']).default('local'),
  D365_ARTIFACT_ACCOUNT_URL: z.string().default(''),
  D365_ARTIFACT_CONTAINER: z.string().default(''),
  D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID: z.string().default(''),
  /** Comma-separated capabilities the active bundle must declare complete. Empty: the indexer's complete ones. */
  D365_ARTIFACT_REQUIRED_CAPABILITIES: z.string().default(''),
  D365_ENABLE_WRITE_TOOLS: z.coerce.number().default(0),
  /** 1 (default) passes index tool results through the knowledge base filter; 0 returns raw results. */
  D365_KNOWLEDGE_FILTER: z.coerce.number().default(1),
  D365_PROJECT_DIR: z.string().default(''),
  D365_VISUAL_STUDIO_WORKSPACE_DIR: z.string().default(''),
  D365_CUSTOM_METADATA_DIR: z.string().default(''),
  D365_TARGET_SOLUTION: z.string().default(''),
  D365_TARGET_PROJECT: z.string().default(''),
  D365_TARGET_PACKAGE: z.string().default(''),
  D365_TARGET_MODEL: z.string().default(''),
  D365_WRITABLE_MODELS: z.string().default('').transform((value) =>
    value ? value.split(',').map((entry) => entry.trim()) : []
  ),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(500),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(100),
  MAX_SESSIONS_PER_API_KEY: z.coerce.number().int().min(0).default(0),
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
});

type ParsedEnv = z.output<typeof configSchema>;

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

const configSchemaWithGuards = configSchema.superRefine((env, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  const apiKeys = parseApiKeys(env.MCP_API_KEYS, env.MCP_API_KEY);
  for (const error of apiKeys.errors) issue('MCP_API_KEYS', error);
  if (env.MCP_TRANSPORT === 'http' && apiKeys.keys.length === 0 && apiKeys.errors.length === 0) {
    issue(
      'MCP_API_KEYS',
      'The HTTP transport requires at least one API key: set MCP_API_KEYS (name=key,name=key; keys >= 32 characters) or MCP_API_KEY'
    );
  }

  if (
    env.D365_ENABLE_WRITE_TOOLS === 1 &&
    env.D365_CUSTOM_METADATA_DIR.trim().length === 0 &&
    env.D365_PROJECT_DIR.trim().length === 0
  ) {
    issue(
      'D365_CUSTOM_METADATA_DIR',
      'D365_CUSTOM_METADATA_DIR (or legacy D365_PROJECT_DIR) is required when D365_ENABLE_WRITE_TOOLS=1'
    );
  }
  if (env.D365_ARTIFACT_STORE_PATH.trim().length > 0 && env.D365_ENABLE_WRITE_TOOLS === 1) {
    issue(
      'D365_ENABLE_WRITE_TOOLS',
      'D365_ENABLE_WRITE_TOOLS must be 0 when D365_ARTIFACT_STORE_PATH enables hosted artifact mode'
    );
  }
  if (env.D365_ARTIFACT_SOURCE === 'azure-blob') {
    if (env.D365_ARTIFACT_STORE_PATH.trim().length === 0) {
      issue(
        'D365_ARTIFACT_STORE_PATH',
        'D365_ARTIFACT_STORE_PATH must name an instance-local directory when D365_ARTIFACT_SOURCE=azure-blob'
      );
    }
    if (!isHttpsOrigin(env.D365_ARTIFACT_ACCOUNT_URL.trim())) {
      issue(
        'D365_ARTIFACT_ACCOUNT_URL',
        'D365_ARTIFACT_ACCOUNT_URL must be an HTTPS storage account URL without credentials or query parameters when D365_ARTIFACT_SOURCE=azure-blob'
      );
    }
    if (env.D365_ARTIFACT_CONTAINER.trim().length === 0) {
      issue('D365_ARTIFACT_CONTAINER', 'D365_ARTIFACT_CONTAINER is required when D365_ARTIFACT_SOURCE=azure-blob');
    }
  }
  try {
    parseRequiredCapabilities(env.D365_ARTIFACT_REQUIRED_CAPABILITIES);
  } catch (err) {
    issue('D365_ARTIFACT_REQUIRED_CAPABILITIES', err instanceof Error ? err.message : String(err));
  }
  if (
    (env.D365_TARGET_PROJECT.trim().length > 0 || env.D365_TARGET_SOLUTION.trim().length > 0) &&
    env.D365_VISUAL_STUDIO_WORKSPACE_DIR.trim().length === 0
  ) {
    issue(
      'D365_VISUAL_STUDIO_WORKSPACE_DIR',
      'D365_VISUAL_STUDIO_WORKSPACE_DIR is required when D365_TARGET_PROJECT or D365_TARGET_SOLUTION is configured'
    );
  }
  for (const entry of env.D365_WRITABLE_MODELS) {
    try {
      const parts = entry.split('/');
      if (parts.length !== 2) throw new Error('Expected Package/Model.');
      parts.forEach(safeSegment);
    } catch {
      issue(
        'D365_WRITABLE_MODELS',
        `Invalid writable target '${entry}'; use comma-separated literal Package/Model pairs (spaces allowed).`
      );
    }
  }
});

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuration validation failed:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function buildConfig(env: ParsedEnv) {
  const apiKeys: ApiKeyEntry[] = parseApiKeys(env.MCP_API_KEYS, env.MCP_API_KEY).keys;
  return {
    port: env.MCP_PORT,
    host: env.MCP_HOST.trim(),
    apiKeys,
    transport: env.MCP_TRANSPORT,
    packagesDir: env.D365_PACKAGES_DIR,
    appVersion: env.D365_APP_VERSION.trim(),
    indexDbPath: env.D365_INDEX_DB_PATH,
    artifactStorePath: env.D365_ARTIFACT_STORE_PATH.trim(),
    artifactSource: env.D365_ARTIFACT_SOURCE,
    artifactAccountUrl: env.D365_ARTIFACT_ACCOUNT_URL.trim(),
    artifactContainer: env.D365_ARTIFACT_CONTAINER.trim(),
    artifactManagedIdentityClientId: env.D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID.trim(),
    artifactRequiredCapabilities: parseRequiredCapabilities(env.D365_ARTIFACT_REQUIRED_CAPABILITIES),
    enableWriteTools: env.D365_ENABLE_WRITE_TOOLS === 1,
    knowledgeFilter: env.D365_KNOWLEDGE_FILTER !== 0,
    projectDir: env.D365_PROJECT_DIR,
    visualStudioWorkspaceDir: env.D365_VISUAL_STUDIO_WORKSPACE_DIR,
    customMetadataDir: env.D365_CUSTOM_METADATA_DIR || env.D365_PROJECT_DIR,
    customMetadataSource: env.D365_CUSTOM_METADATA_DIR ? 'D365_CUSTOM_METADATA_DIR'
      : env.D365_PROJECT_DIR ? 'D365_PROJECT_DIR (legacy alias)' : 'unconfigured',
    targetSolution: env.D365_TARGET_SOLUTION,
    targetProject: env.D365_TARGET_PROJECT,
    targetPackage: env.D365_TARGET_PACKAGE,
    targetModel: env.D365_TARGET_MODEL,
    writableModels: env.D365_WRITABLE_MODELS,
    rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
    requestTimeoutMs: env.MCP_REQUEST_TIMEOUT_MS,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    maxConcurrentSessions: env.MAX_CONCURRENT_SESSIONS,
    maxSessionsPerApiKey: env.MAX_SESSIONS_PER_API_KEY,
    sessionIdleTimeoutMs: env.SESSION_IDLE_TIMEOUT_MS,
    version: VERSION,
  };
}

export type AppConfig = ReturnType<typeof buildConfig>;

/** Parses `source` (defaults to `process.env`) or throws `ConfigError`. */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchemaWithGuards.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((err) => `${err.path.join('.')}: ${err.message}`));
  }
  return buildConfig(parsed.data);
}
