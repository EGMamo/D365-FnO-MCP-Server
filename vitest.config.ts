import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Agent worktrees hold their own copies of the test suite; run only this checkout's tests.
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '**/.claude/**'],
    // Keep the server's structured log lines out of the test output; tests that
    // assert on logging spy on the logger instead.
    env: { MCP_LOG_LEVEL: 'SILENT' },
  },
});
