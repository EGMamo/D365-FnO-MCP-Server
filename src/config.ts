import dotenv from 'dotenv';
import { ConfigError, loadConfig, type AppConfig } from './configLoader.js';

dotenv.config();

export { VERSION } from './version.js';
export { ConfigError, loadConfig } from './configLoader.js';
export type { AppConfig } from './configLoader.js';

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('[D365-MCP] ERROR Configuration validation failed:');
      err.issues.forEach((issue) => console.error(`  - ${issue}`));
      process.exit(1);
    }
    throw err;
  }
}

export const config = loadConfigOrExit();
