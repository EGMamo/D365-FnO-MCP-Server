import { z } from 'zod';
import dotenv from 'dotenv';
import { safeSegment } from './workspace/safety.js';

dotenv.config();

const configSchema = z.object({
  MCP_PORT: z.coerce.number().default(3000),
  MCP_API_KEY: z.string().min(32, 'MCP_API_KEY must be at least 32 characters'),
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  D365_PACKAGES_DIR: z.string().min(1, 'D365_PACKAGES_DIR is required'),
  D365_INDEX_DB_PATH: z.string().default('./d365_index.db'),
  D365_INDEX_ON_START: z.coerce.number().default(0),
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

const configSchemaWithWriteGuard = configSchema.superRefine((env, ctx) => {
  if (
    env.D365_ENABLE_WRITE_TOOLS === 1 &&
    env.D365_CUSTOM_METADATA_DIR.trim().length === 0 &&
    env.D365_PROJECT_DIR.trim().length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['D365_CUSTOM_METADATA_DIR'],
      message:
        'D365_CUSTOM_METADATA_DIR (or legacy D365_PROJECT_DIR) is required when D365_ENABLE_WRITE_TOOLS=1',
    });
  }
  if (
    (env.D365_TARGET_PROJECT.trim().length > 0 || env.D365_TARGET_SOLUTION.trim().length > 0) &&
    env.D365_VISUAL_STUDIO_WORKSPACE_DIR.trim().length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['D365_VISUAL_STUDIO_WORKSPACE_DIR'],
      message:
        'D365_VISUAL_STUDIO_WORKSPACE_DIR is required when D365_TARGET_PROJECT or D365_TARGET_SOLUTION is configured',
    });
  }
  for (const entry of env.D365_WRITABLE_MODELS) {
    try {
      const parts = entry.split('/');
      if (parts.length !== 2) throw new Error('Expected Package/Model.');
      parts.forEach(safeSegment);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['D365_WRITABLE_MODELS'],
        message: `Invalid writable target '${entry}'; use comma-separated literal Package/Model pairs (spaces allowed).`,
      });
    }
  }
});

const parseConfig = () => {
  const parsed = configSchemaWithWriteGuard.safeParse(process.env);
  if (!parsed.success) {
    console.error('[D365-MCP] ERROR Configuration validation failed:');
    parsed.error.errors.forEach((err) => console.error(`  - ${err.path.join('.')}: ${err.message}`));
    process.exit(1);
  }
  return parsed.data;
};

const env = parseConfig();

export const VERSION = '0.1.0';

export const config = {
  port: env.MCP_PORT,
  mcpApiKey: env.MCP_API_KEY,
  transport: env.MCP_TRANSPORT,
  packagesDir: env.D365_PACKAGES_DIR,
  indexDbPath: env.D365_INDEX_DB_PATH,
  indexOnStart: env.D365_INDEX_ON_START === 1,
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
