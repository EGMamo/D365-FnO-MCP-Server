import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import type { Database } from '../indexer/db.js';
import { digestKnowledge } from '../knowledge/digest.js';

const KB_DIR_NAME = 'd365-fno-assistant-knowledge';
const RESOURCE_SUBDIR = 'resources';
const URI_SCHEME = 'd365kb';

export interface KnowledgeEntry {
  slug: string;
  title: string;
  filePath: string;
}

/**
 * The knowledge base ships next to the package root, but the module can be loaded
 * from `src/` (tsx) or `dist/src/` (build), so walk upwards until it is found.
 */
export function findKnowledgeDir(startDir?: string): string | null {
  let dir = startDir ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, KB_DIR_NAME, RESOURCE_SUBDIR);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function firstHeading(content: string, fallback: string): string {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return fallback;
}

/** Lists every markdown file in the knowledge base resources folder. */
export function listKnowledgeEntries(kbDir: string | null = findKnowledgeDir()): KnowledgeEntry[] {
  if (!kbDir || !fs.existsSync(kbDir)) return [];
  return fs
    .readdirSync(kbDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const filePath = path.join(kbDir, file);
      const slug = file.slice(0, -3);
      let title = slug;
      try {
        title = firstHeading(fs.readFileSync(filePath, 'utf8'), slug);
      } catch {
        // Unreadable file: fall back to the slug as the display title.
      }
      return { slug, title, filePath };
    });
}

/** Reads one knowledge base entry by slug, or null when the slug is unknown. */
export function readKnowledgeEntry(
  slug: string,
  kbDir: string | null = findKnowledgeDir()
): { entry: KnowledgeEntry; content: string } | null {
  const entry = listKnowledgeEntries(kbDir).find((e) => e.slug === slug);
  if (!entry) return null;
  return { entry, content: fs.readFileSync(entry.filePath, 'utf8') };
}

const SYSTEM_PROMPT = [
  'You are a Dynamics 365 Finance & Operations (X++/AOT) development assistant.',
  'Ground every answer in the indexed metadata exposed by this MCP server and in the',
  `curated knowledge base resources (\`${URI_SCHEME}://<slug>\`).`,
  'Never invent table names, field names, method signatures, or label IDs: look them up',
  'with the available tools first, and say so explicitly when something cannot be verified.',
  'Prefer extension patterns (Chain of Command, table/form extensions) over over-layering.',
].join(' ');

export function registerKnowledgeResources(server: McpServer): void {
  const kbDir = findKnowledgeDir();

  server.resource(
    'd365-knowledge-base',
    new ResourceTemplate(`${URI_SCHEME}://{slug}`, {
      list: () => ({
        resources: listKnowledgeEntries(kbDir).map((entry) => ({
          uri: `${URI_SCHEME}://${entry.slug}`,
          name: entry.slug,
          title: entry.title,
          description: entry.title,
          mimeType: 'text/markdown',
        })),
      }),
      complete: {
        slug: (value: string) =>
          listKnowledgeEntries(kbDir)
            .map((e) => e.slug)
            .filter((s) => s.toLowerCase().includes(value.toLowerCase())),
      },
    }),
    {
      description: 'D365 F&O development patterns and gotchas, one markdown topic per resource',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const raw = variables.slug;
      const slug = Array.isArray(raw) ? raw[0] : raw;
      const found = slug ? readKnowledgeEntry(String(slug), kbDir) : null;
      if (!found) {
        throw new Error(`Unknown knowledge base resource: ${String(slug)}`);
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: found.content }],
      };
    }
  );

  server.prompt(
    'd365_pattern_assistant',
    'System prompt for D365 F&O work, optionally seeded with one knowledge base topic',
    { topic: z.string().optional().describe('Knowledge base slug, e.g. 02-chain-of-command') },
    ({ topic }) => {
      const entries = listKnowledgeEntries(kbDir);
      let body: string;

      if (topic) {
        const found = readKnowledgeEntry(topic, kbDir);
        body = found
          ? `## Knowledge base topic: ${found.entry.title} (${URI_SCHEME}://${found.entry.slug})\n\n${found.content}`
          : `Topic "${topic}" was not found. Available topics:\n` +
            entries.map((e) => `- ${e.slug}: ${e.title}`).join('\n');
      } else {
        body =
          'Available knowledge base topics (read with the matching resource URI):\n' +
          (entries.length > 0
            ? entries.map((e) => `- ${URI_SCHEME}://${e.slug} — ${e.title}`).join('\n')
            : '- (knowledge base not found in this installation)');
      }

      return {
        messages: [
          { role: 'user' as const, content: { type: 'text' as const, text: `${SYSTEM_PROMPT}\n\n${body}` } },
        ],
      };
    }
  );
}

export interface KnowledgeDigestOptions {
  /** Master feature flag: reuses the write-tools flag since this writes files under the repo. */
  enableWriteTools: boolean;
}

/**
 * Registers `digest_knowledge`: lets an assistant hand over a sanitized draft article and have
 * it validated (structure, sanitization, lexical duplicate detection, identifier feasibility
 * against the indexed AOT metadata) and, if it passes, added to the knowledge base as a new
 * numbered file. Every existing topic's title + scenario summary is always returned in the report
 * so the caller can judge *conceptual* duplication itself — the same pattern written up in
 * different words — which no wording-overlap heuristic can reliably catch.
 */
export function registerKnowledgeDigestTool(
  server: McpServer,
  db: Database | null,
  options: KnowledgeDigestOptions
): void {
  if (options.enableWriteTools !== true) return;

  const kbDir = findKnowledgeDir();

  server.tool(
    'digest_knowledge',
    'Validate a draft D365 F&O knowledge base article (structure, sanitization, lexical wording-overlap ' +
      'check, and identifier feasibility against the indexed metadata) and, if it passes, add it to the ' +
      'knowledge base as a new numbered markdown file. Sensitive-content findings always block the write. ' +
      'IMPORTANT: the returned report includes every existing topic\'s title and one-line scenario summary ' +
      '(`existingTopics`) — before calling this tool, or before trusting a clean report, compare the draft ' +
      'against that list yourself for CONCEPTUAL duplication (the same underlying pattern described in ' +
      'different words). The `duplicates` field only catches near-identical phrasing and will miss that.',
    {
      content: z.string().min(1).describe('Full markdown content of the draft article, already sanitized.'),
      slug: z.string().optional().describe('Optional filename slug override (kebab-case, no number prefix).'),
      dryRun: z.boolean().optional().describe('When true, only validate; never write the file.'),
      force: z
        .boolean()
        .optional()
        .describe(
          'Write even when a near-duplicate match is found. Missing required sections and sensitive-content errors always block, regardless of force.'
        ),
    },
    async ({ content, slug, dryRun, force }) => {
      if (!kbDir) {
        return {
          content: [
            { type: 'text' as const, text: 'Knowledge base resources directory not found in this installation.' },
          ],
          isError: true,
        };
      }

      try {
        const report = digestKnowledge({ content, kbDir, db, slugOverride: slug, dryRun, force });
        const hasErrors = report.issues.some((issue) => issue.level === 'error');
        const blocked = hasErrors && !report.written;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
          isError: blocked,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to digest knowledge entry: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
