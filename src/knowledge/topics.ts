import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Knowledge topics with their optional machine-readable header. The header is YAML front matter
 * at the top of the markdown file; it tells the knowledge filter which index tools a topic is
 * about, which result rows it marks as noise, which rows it prefers and what note to attach.
 * The prose below the header is what MCP clients read.
 */

const rowPattern = z
  .object({
    field: z.string().min(1).describe('Row property to test, e.g. name, type, package or file_path.'),
    pattern: z.string().min(1).describe('Case-insensitive glob: * matches any run of characters, ? one character.'),
  })
  .strict();

export const topicHeaderSchema = z
  .object({
    appliesTo: z
      .object({
        tools: z.array(z.string().min(1)).optional(),
        objectTypes: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    match: z
      .object({
        names: z.array(z.string().min(1)).optional(),
        tools: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    filter: z.object({ exclude: z.array(rowPattern).min(1) }).strict().optional(),
    rank: z.object({ prefer: z.array(rowPattern).min(1) }).strict().optional(),
    note: z.string().min(1).max(400).optional(),
  })
  .strict();

export type TopicHeader = z.infer<typeof topicHeaderSchema>;
export type RowPattern = z.infer<typeof rowPattern>;

export interface KnowledgeTopic {
  slug: string;
  title: string;
  uri: string;
  header: TopicHeader;
  /** Markdown without the front matter. */
  body: string;
  /** First paragraph of "When to use this", or the opening paragraph. */
  summary: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits YAML front matter from the markdown body. Throws when the header is invalid. */
export function splitFrontMatter(content: string): { header: TopicHeader; body: string; hasHeader: boolean } {
  const match = FRONT_MATTER.exec(content);
  if (!match) return { header: {}, body: content, hasHeader: false };
  const raw: unknown = parseYaml(match[1]) ?? {};
  const parsed = topicHeaderSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(header)'}: ${issue.message}`);
    throw new Error(`Invalid knowledge topic header: ${problems.join('; ')}`);
  }
  return { header: parsed.data, body: content.slice(match[0].length), hasHeader: true };
}

/** Removes the front matter without validating it, for display. */
export function stripFrontMatter(content: string): string {
  const match = FRONT_MATTER.exec(content);
  return match ? content.slice(match[0].length) : content;
}

/** Blanks fenced code so `# comment` lines in samples are not read as headings. */
function withoutCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '');
}

export function topicTitle(body: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(withoutCode(body));
  return match ? match[1].trim() : fallback;
}

export function topicSummary(body: string): string {
  const text = withoutCode(body);
  const section = /^##\s+When to use[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(text);
  const source = section ? section[1] : text.replace(/^#\s+.+$/m, '');
  const paragraph = source
    .split(/\n\s*\n/)
    .map((block) => block.replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim())
    .find((block) => block.length > 0);
  return (paragraph ?? '').slice(0, 400);
}

/**
 * Prose passages used for embeddings: paragraphs and list blocks without code, long enough to
 * carry meaning. Matching against passages, not the whole file, keeps long code-heavy topics
 * from diluting the comparison.
 */
export function topicPassages(body: string): string[] {
  const passages = withoutCode(body)
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block.length >= 40)
    .map((block) => block.slice(0, 1200));
  return passages.length > 0 ? passages : [body.replace(/\s+/g, ' ').trim().slice(0, 1200)];
}

export function readTopic(filePath: string): KnowledgeTopic {
  const slug = path.basename(filePath, '.md');
  const { header, body } = splitFrontMatter(fs.readFileSync(filePath, 'utf8'));
  return {
    slug,
    title: topicTitle(body, slug),
    uri: `d365kb://${slug}`,
    header,
    body,
    summary: topicSummary(body),
  };
}

/** Loads every topic in `kbDir`, sorted by file name. Invalid headers throw with the file name. */
export function loadTopics(kbDir: string | null): KnowledgeTopic[] {
  if (!kbDir || !fs.existsSync(kbDir)) return [];
  return fs
    .readdirSync(kbDir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      try {
        return readTopic(path.join(kbDir, file));
      } catch (err) {
        throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}

/** Case-insensitive glob with * and ?. */
export function globMatches(pattern: string, value: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    'is'
  );
  return regex.test(value);
}

export function rowMatches(row: Record<string, unknown>, pattern: RowPattern): boolean {
  const value = row[pattern.field];
  return (typeof value === 'string' || typeof value === 'number') && globMatches(pattern.pattern, String(value));
}
