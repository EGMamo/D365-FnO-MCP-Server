/**
 * Single source of truth for the package version. Kept in its own module so
 * CLI commands can report it without importing `config.ts`, which validates
 * the environment and exits the process on failure at import time.
 */
export const VERSION = '0.1.0';
