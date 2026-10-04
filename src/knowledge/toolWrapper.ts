import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import type { KnowledgeFilter, KnowledgeSession } from './filter.js';

type ToolCallback = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/**
 * Runs `register` with `server.tool` patched so that every tool it registers passes its result
 * through the knowledge filter. Tools registered outside `register` (generators, writers) are
 * untouched. A filter failure never fails the call: the unfiltered result is returned.
 */
export function registerWithKnowledgeFilter(
  server: McpServer,
  currentFilter: () => KnowledgeFilter | null,
  register: () => void,
  session?: KnowledgeSession
): void {
  const original = server.tool.bind(server) as (...args: unknown[]) => unknown;
  const patched = (...args: unknown[]) => {
    const name = args[0] as string;
    const last = args.length - 1;
    const callback = args[last];
    if (typeof callback === 'function') {
      args[last] = async (...callArgs: unknown[]) => {
        const result = await (callback as ToolCallback)(...callArgs);
        const filter = currentFilter();
        if (!filter) return result;
        // Tools with an input schema receive (args, extra); tools without one receive (extra).
        const toolArgs = callArgs.length > 1 ? callArgs[0] : {};
        try {
          return await filter.apply(name, toolArgs, result, session);
        } catch (error) {
          logger.warn('Knowledge filter failed; returning the unfiltered result', {
            tool: name,
            error: error instanceof Error ? error.message : String(error),
          });
          return result;
        }
      };
    }
    return original(...args);
  };
  (server as unknown as { tool: typeof patched }).tool = patched;
  try {
    register();
  } finally {
    (server as unknown as { tool: typeof original }).tool = original;
  }
}
