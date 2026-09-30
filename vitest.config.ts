import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    // Keep the server's structured log lines out of the test output; tests that
    // assert on logging spy on the logger instead.
    env: { MCP_LOG_LEVEL: 'SILENT' },
  },
});
