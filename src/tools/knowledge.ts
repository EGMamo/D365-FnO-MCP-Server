import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { stripFrontMatter } from '../knowledge/topics.js';

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
        title = firstHeading(stripFrontMatter(fs.readFileSync(filePath, 'utf8')), slug);
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
  return { entry, content: stripFrontMatter(fs.readFileSync(entry.filePath, 'utf8')) };
}

const SYSTEM_PROMPT = [
  'You are a Dynamics 365 Finance & Operations (X++/AOT) development assistant.',
  'Ground every answer in the indexed metadata exposed by this MCP server and in the',
  `curated knowledge base resources (\`${URI_SCHEME}://<slug>\`).`,
  'Never invent table names, field names, method signatures, or label IDs: look them up',
  'with the available tools first, and say so explicitly when something cannot be verified.',
  'Prefer extension patterns (Chain of Command, table/form extensions) over over-layering.',
].join(' ');

export function registerKnowledgeResources(server: McpServer, kbDir: string | null = findKnowledgeDir()): void {

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
