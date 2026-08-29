import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  MCP_PORT: z.coerce.number().default(3000),
  MCP_API_KEY: z.string().min(1, "MCP_API_KEY is required"),
  D365_PACKAGES_DIR: z.string().min(1, "D365_PACKAGES_DIR is required"),
  D365_INDEX_DB_PATH: z.string().default('./d365_index.db'),
});

const parseConfig = () => {
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[D365-MCP] ERROR Configuration validation failed:');
    parsed.error.errors.forEach(err => console.error(`  - ${err.path.join('.')}: ${err.message}`));
    process.exit(1);
  }
  return parsed.data;
};

const env = parseConfig();

export const config = {
  port: env.MCP_PORT,
  mcpApiKey: env.MCP_API_KEY,
  packagesDir: env.D365_PACKAGES_DIR,
  indexDbPath: env.D365_INDEX_DB_PATH,
};
