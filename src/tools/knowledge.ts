import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { stripFrontMatter } from '../knowledge/topics.js';
import type { KnowledgeFilter, KnowledgeSession } from '../knowledge/filter.js';

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

interface LoadedKnowledgeBase {
  entries: KnowledgeEntry[];
  contents: Map<string, string>;
}

const loadedKnowledgeBases = new Map<string, LoadedKnowledgeBase>();

/**
 * Every topic with its content, read from disk once per process: resource lists, completions,
 * reads and prompts are served from memory instead of re-reading the folder per request.
 */
function loadedKnowledgeBase(kbDir: string | null): LoadedKnowledgeBase {
  const key = kbDir ?? '';
  let loaded = loadedKnowledgeBases.get(key);
  if (!loaded) {
    const entries = listKnowledgeEntries(kbDir);
    const contents = new Map<string, string>();
    for (const entry of entries) {
      try {
        contents.set(entry.slug, stripFrontMatter(fs.readFileSync(entry.filePath, 'utf8')));
      } catch {
        // Unreadable file: listed by title, but reads report it as unknown.
      }
    }
    loaded = { entries, contents };
    loadedKnowledgeBases.set(key, loaded);
  }
  return loaded;
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
  const { entries, contents } = loadedKnowledgeBase(kbDir);
  const read = (slug: string) => {
    const entry = entries.find((e) => e.slug === slug);
    const content = contents.get(slug);
    return entry && content !== undefined ? { entry, content } : null;
  };

  server.resource(
    'd365-knowledge-base',
    new ResourceTemplate(`${URI_SCHEME}://{slug}`, {
      list: () => ({
        resources: entries.map((entry) => ({
          uri: `${URI_SCHEME}://${entry.slug}`,
          name: entry.slug,
          title: entry.title,
          description: entry.title,
          mimeType: 'text/markdown',
        })),
      }),
      complete: {
        slug: (value: string) =>
          entries
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
      const found = slug ? read(String(slug)) : null;
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
      let body: string;

      if (topic) {
        const found = read(topic);
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

export const TASK_GUIDANCE_HINT =
  'For a multi-step request (a feature, batch job, integration or fix), call get_task_guidance with the ' +
  "user's request, in English, first: it returns the knowledge base topics that apply and the parts no topic covers, and " +
  'later tool results in this session carry the matching topic notes.';

/**
 * Registers `get_task_guidance`: the client hands over the user's whole request, gets the topics
 * that apply (matched clause by clause) plus the parts no topic covers, and the request is kept
 * for the session so later index results are annotated with the topics the task needs.
 */
export function registerTaskGuidanceTool(
  server: McpServer,
  currentFilter: () => KnowledgeFilter | null,
  session: KnowledgeSession
): void {
  server.tool(
    'get_task_guidance',
    `Match a whole D365 F&O development request against the knowledge base before planning it. ${TASK_GUIDANCE_HINT} ` +
      'Read the returned topics with their d365kb:// URIs. For parts listed under "uncovered", rely on the index tools only and say the knowledge base has no guidance for them.',
    {
      task: z
        .string()
        .trim()
        .min(10, 'Describe the request in at least a few words.')
        .max(4000)
        .describe(
          "The user's request in English, e.g. 'batch job that posts arrival journals and creates product receipts'. " +
            'The knowledge base matches English text only, so translate a request written in another language first.'
        ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ task }) => {
      const filter = currentFilter();
      if (!filter) {
        return {
          content: [{ type: 'text' as const, text: 'The knowledge filter is not loaded yet or is turned off (D365_KNOWLEDGE_FILTER=0).' }],
          isError: true,
        };
      }
      const guidance = await filter.guidance(task, session);
      return { content: [{ type: 'text' as const, text: JSON.stringify(guidance) }] };
    }
  );
}
