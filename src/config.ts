import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  MCP_PORT: z.coerce.number().default(3000),
  MCP_API_KEY: z.string().min(1, 'MCP_API_KEY is required'),
  MCP_TRANSPORT: z.enum(['http', 'stdio']).default('http'),
  D365_PACKAGES_DIR: z.string().min(1, 'D365_PACKAGES_DIR is required'),
  D365_INDEX_DB_PATH: z.string().default('./d365_index.db'),
  D365_INDEX_ON_START: z.coerce.number().default(0),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(500),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  MCP_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

const parseConfig = () => {
  const parsed = configSchema.safeParse(process.env);
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
  rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS,
  rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
  requestTimeoutMs: env.MCP_REQUEST_TIMEOUT_MS,
  version: VERSION,
};
