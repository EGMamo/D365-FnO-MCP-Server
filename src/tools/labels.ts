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
    'Substring search over label values (matches inside words), optionally scoped to one language. This scans every label row, which is seconds on very large label sets; prefer search_labels_fts for whole-word queries.',
    { query: z.string(), language: z.string().optional(), limit: z.number().int().min(1).max(500).default(20) },
    async ({ query, language, limit }) => {
      let sql = `SELECT label_id, language, value FROM ax_labels WHERE value LIKE ? ESCAPE '\\'`;
      const params: (string | number)[] = [likeContains(query)];
      if (language) {
        sql += ` AND language = ? COLLATE NOCASE`;
        params.push(language);
      }
      sql += ` LIMIT ?`;
      params.push(limit);
      const labels = db.prepare(sql).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(labels) }] };
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
      return { content: [{ type: 'text', text: JSON.stringify(labels) }] };
    }
  );
}
