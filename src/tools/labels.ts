import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from '../indexer/db.js';
import { z } from 'zod';
import { likeContains, resolveLabel, resolveLabelByLanguage, searchLabelsFts } from '../indexer/db.js';

export function registerLabelsTools(server: McpServer, db: Database) {
  server.tool(
    'resolve_label',
    'Resolve a label ID to its value',
    { labelId: z.string() },
    async ({ labelId }) => {
      const label = resolveLabel(db, labelId);

      if (!label) {
        return { content: [{ type: 'text', text: "Label not found" }] };
      }
      
      return { content: [{ type: 'text', text: label.value }] };
    }
  );

  server.tool(
    'search_labels',
    'Search for labels by value',
    { query: z.string(), limit: z.number().int().min(1).max(500).default(20) },
    async ({ query, limit }) => {
      const labels = db.prepare(`SELECT label_id, value FROM ax_labels WHERE value LIKE ? ESCAPE '\\' LIMIT ?`)
        .all(likeContains(query), limit);
      return { content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }] };
    }
  );

  server.tool(
    'resolve_label_by_language',
    'Resolve a label ID to its value in a specific language',
    { labelId: z.string(), language: z.string().default('en-US') },
    async ({ labelId, language }) => {
      const label = resolveLabelByLanguage(db, labelId, language);
      if (!label) {
        return { content: [{ type: 'text', text: 'not found' }] };
      }
      return { content: [{ type: 'text', text: label.value }] };
    }
  );

  server.tool(
    'search_labels_fts',
    'Full-text search across label values, optionally scoped to one language',
    { query: z.string(), language: z.string().optional(), limit: z.number().int().min(1).max(500).default(20) },
    async ({ query, language, limit }) => {
      const labels = searchLabelsFts(db, query, language, limit);
      return { content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }] };
    }
  );
}
