import { z } from 'zod';
import { safeSegment } from './workspace/safety.js';
import { parseApiKeys, type ApiKeyEntry } from './server/apiKeys.js';
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
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  /** Required only for indexing (`index`, `D365_INDEX_ON_START=1`). */
  D365_PACKAGES_DIR: z.string().default(''),
  D365_INDEX_DB_PATH: z.string().default('./d365_index.db'),
  /** Manifest URL of a published index; enables hosted (read-only) mode. */
  D365_INDEX_URL: z.string().default(''),
  D365_INDEX_ON_START: z.coerce.number().default(0),
  /** Names (from MCP_API_KEYS) allowed to upload a new index over HTTP; empty disables uploads. */
  D365_INDEX_UPLOAD_KEYS: z.string().default('').transform((value) =>
    value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  ),
  D365_INDEX_UPLOAD_MAX_GB: z.coerce.number().positive().default(50),
  D365_INDEX_UPLOAD_MAX_CHUNK_MB: z.coerce.number().int().positive().max(4096).default(256),
  /** Upload scratch folder; default `<dir of D365_INDEX_DB_PATH>/.uploads` (same volume as the index). */
  D365_INDEX_UPLOAD_DIR: z.string().default(''),
  /** Container SAS URL (create + write) where uploaded indexes are published so restarts keep them. */
  D365_INDEX_PUBLISH_URL: z.string().default(''),
  D365_ENABLE_WRITE_TOOLS: z.coerce.number().default(0),
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
  SESSION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
});

type ParsedEnv = z.output<typeof configSchema>;

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

  const keyNames = new Set(apiKeys.keys.map((entry) => entry.name));
  for (const name of env.D365_INDEX_UPLOAD_KEYS) {
    if (!keyNames.has(name)) {
      issue('D365_INDEX_UPLOAD_KEYS', `'${name}' is not the name of a key in MCP_API_KEYS`);
    }
  }
  if (env.D365_INDEX_UPLOAD_KEYS.length > 0 && env.MCP_TRANSPORT !== 'http') {
    issue('D365_INDEX_UPLOAD_KEYS', 'Index uploads need the HTTP transport (MCP_TRANSPORT=http)');
  }
  const publishUrl = env.D365_INDEX_PUBLISH_URL.trim();
  if (publishUrl.length > 0 && !/^https?:\/\/[^?]+\?.+/i.test(publishUrl)) {
    issue('D365_INDEX_PUBLISH_URL', 'D365_INDEX_PUBLISH_URL must be a blob container URL with a SAS query string');
  }
  if (publishUrl.length > 0 && env.D365_INDEX_UPLOAD_KEYS.length === 0) {
    issue('D365_INDEX_PUBLISH_URL', 'D365_INDEX_PUBLISH_URL only applies to uploads; set D365_INDEX_UPLOAD_KEYS as well');
  }

  const indexUrl = env.D365_INDEX_URL.trim();
  if (indexUrl.length > 0 && !/^https?:\/\//i.test(indexUrl)) {
    issue('D365_INDEX_URL', 'D365_INDEX_URL must be an http(s) URL pointing at a published index manifest');
  }
  if (env.D365_INDEX_ON_START === 1 && env.D365_PACKAGES_DIR.trim().length === 0) {
    issue('D365_PACKAGES_DIR', 'D365_PACKAGES_DIR is required when D365_INDEX_ON_START=1');
  }
  if (indexUrl.length > 0 && env.D365_INDEX_ON_START === 1) {
    issue('D365_INDEX_ON_START', 'D365_INDEX_ON_START cannot be combined with D365_INDEX_URL; a published index is never re-indexed on the host');
  }
  if (indexUrl.length > 0 && env.D365_ENABLE_WRITE_TOOLS === 1) {
    issue('D365_ENABLE_WRITE_TOOLS', 'Write tools are not available when serving a published index (D365_INDEX_URL)');
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
  const indexUrl = env.D365_INDEX_URL.trim();
  const apiKeys: ApiKeyEntry[] = parseApiKeys(env.MCP_API_KEYS, env.MCP_API_KEY).keys;
  return {
    port: env.MCP_PORT,
    host: env.MCP_HOST.trim(),
    apiKeys,
    transport: env.MCP_TRANSPORT,
    packagesDir: env.D365_PACKAGES_DIR,
    indexDbPath: env.D365_INDEX_DB_PATH,
    indexUrl,
    /** True when the server serves a published index downloaded from `indexUrl`. */
    hostedMode: indexUrl.length > 0,
    indexOnStart: env.D365_INDEX_ON_START === 1,
    indexUploadKeys: env.D365_INDEX_UPLOAD_KEYS,
    indexUploadMaxBytes: Math.floor(env.D365_INDEX_UPLOAD_MAX_GB * 1024 ** 3),
    indexUploadMaxChunkBytes: env.D365_INDEX_UPLOAD_MAX_CHUNK_MB * 1024 ** 2,
    indexUploadDir: env.D365_INDEX_UPLOAD_DIR.trim(),
    indexPublishUrl: env.D365_INDEX_PUBLISH_URL.trim(),
    enableWriteTools: env.D365_ENABLE_WRITE_TOOLS === 1,
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
