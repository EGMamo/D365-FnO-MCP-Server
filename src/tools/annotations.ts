import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Hints for a tool that only reads or drafts: lookups, searches, analyses and generator drafts.
 * It changes no file, project or metadata the caller owns. A tool may still refresh its own derived
 * index (the hybrid gateway re-indexes custom models before it answers) and, in the gateway, ask the
 * hosted server for the same read.
 *
 * Clients may treat annotations as untrusted and decide for themselves what to do with them; they
 * describe the tool, they do not grant it anything.
 */
export const READ_ONLY_TOOL = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} satisfies ToolAnnotations);
