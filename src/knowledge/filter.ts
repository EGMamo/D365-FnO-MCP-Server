import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { findEmbeddingModelDir, loadEmbedder, type Embedder } from './embedder.js';
import { buildTopicVectors, PassageCache, passageCachePath, scoreQuery, type TopicVectors } from './semantic.js';
import { globMatches, loadTopics, rowMatches, type KnowledgeTopic } from './topics.js';

/**
 * Post-processes index tool results with the knowledge base before they reach the client:
 *   filter   drop rows a topic marks as noise (reported with a count),
 *   rank     move rows a topic prefers to the front (stable),
 *   annotate attach up to MAX_NOTES matching topics, found by header rules and, when the
 *            embedding model is present, by meaning.
 * It only removes, reorders or adds notes; it never invents or renames objects, so every name in
 * the output still comes from the index.
 */

const MAX_NOTES = 3;
const MAX_SEMANTIC_NOTES = 2;
/** Calibrated on the shipped topics: specific queries score 0.35-0.6 on their topic, noise < 0.3. */
const SEMANTIC_NOTE_SCORE = 0.38;
const MAX_QUERY_NAMES = 10;
/** Whole requests score lower than short queries; clauses of a request reach 0.45+ on their topic. */
const TASK_TOPIC_SCORE = 0.33;
const TASK_STRONG_SCORE = 0.45;
const MAX_TASK_TOPICS = 5;
const MAX_TASK_CHARS = 4000;
const QUERY_CACHE_SIZE = 256;

/** Argument names that say which object type a tool is about. */
const ARG_OBJECT_TYPES: Record<string, string> = {
  tableName: 'Table',
  className: 'Class',
  formName: 'Form',
  enumName: 'Enum',
  edtName: 'Edt',
  queryName: 'Query',
  entityName: 'DataEntity',
  roleName: 'SecurityRole',
  dutyName: 'SecurityDuty',
  privilegeName: 'SecurityPrivilege',
};

export interface KnowledgeNote {
  topic: string;
  title: string;
  note: string;
  matchedBy: 'rule' | 'meaning' | 'task';
  score?: number;
}

export interface KnowledgeSection {
  notes: KnowledgeNote[];
  filtered?: Array<{ topic: string; removed: number }>;
  reordered?: string[];
}

type Row = Record<string, unknown>;

/**
 * Per MCP session: the request the client registered with `get_task_guidance`, so later index
 * calls are matched against the task as well as their own object names.
 */
export class KnowledgeSession {
  task: { text: string; scores: Map<string, number> } | null = null;
  /** Task notes already sent in this session; each is attached once, not on every call. */
  readonly delivered = new Set<string>();
}

export interface TaskGuidance {
  task: string;
  /** strong: a topic clearly covers the request; partial: related topics only; none: no topic applies. */
  coverage: 'strong' | 'partial' | 'none';
  topics: Array<{ topic: string; title: string; note: string; score: number }>;
  /** Parts of the request no topic covers; ground these in the index tools alone. */
  uncovered: string[];
  matchedBy: 'meaning' | 'keywords';
}

/** The request plus its clauses, so each part of a multi-step request is matched on its own. */
export function splitTask(task: string): string[] {
  // Trailing punctuation alone shifts MiniLM scores by up to 0.1, so every clause is embedded bare.
  const tidy = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/[.!?:]+$/, '').trim();
  const clauses = task
    .split(/[,;.\n]|\b(?:and then|and|then|using|with|so that|where|which)\b/i)
    .map(tidy)
    .filter((clause) => clause.split(' ').length >= 3);
  return [...new Set([tidy(task), ...clauses])];
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Arrays of objects at the top level of a result, or one level down in an object result. */
function rowLists(value: unknown): Row[][] {
  if (Array.isArray(value)) return value.length > 0 && value.every(isRow) ? [value as Row[]] : [];
  if (!isRow(value)) return [];
  return Object.values(value).filter(
    (entry): entry is Row[] => Array.isArray(entry) && entry.length > 0 && entry.every(isRow)
  );
}

function applies(topic: KnowledgeTopic, tool: string): boolean {
  const tools = topic.header.appliesTo?.tools;
  return !tools || tools.length === 0 || tools.includes(tool);
}

function typeAllowed(topic: KnowledgeTopic, type: unknown): boolean {
  const types = topic.header.appliesTo?.objectTypes;
  return !types || types.length === 0 || (typeof type === 'string' && types.includes(type));
}

export interface KnowledgeFilterOptions {
  /** Embedding model; null runs on header rules only. */
  embedder?: Embedder | null;
  /** Stored topic passage vectors, so startup embeds only new or edited passages. */
  cache?: PassageCache;
}

export class KnowledgeFilter {
  private vectors: TopicVectors[] | null = null;
  private readonly queryCache = new Map<string, Float32Array>();

  private constructor(
    private readonly topics: KnowledgeTopic[],
    private readonly embedder: Embedder | null
  ) {}

  /** Builds a filter over the topics in `kbDir`; topic vectors are computed up front. */
  static async create(kbDir: string | null, options: KnowledgeFilterOptions = {}): Promise<KnowledgeFilter> {
    const filter = new KnowledgeFilter(loadTopics(kbDir), options.embedder ?? null);
    if (filter.embedder) filter.vectors = await buildTopicVectors(filter.embedder, filter.topics, options.cache);
    return filter;
  }

  get topicCount(): number {
    return this.topics.length;
  }

  get usesEmbeddings(): boolean {
    return this.vectors !== null;
  }

  /**
   * Matches a whole request against the topics, clause by clause, records it on `session` and
   * reports which parts of it no topic covers.
   */
  async guidance(task: string, session?: KnowledgeSession): Promise<TaskGuidance> {
    const text = task.slice(0, MAX_TASK_CHARS);
    const clauses = splitTask(text);
    const scores = new Map<string, number>();
    const uncovered: string[] = [];
    if (this.vectors) {
      for (const [i, clause] of clauses.entries()) {
        const matches = scoreQuery(await this.embedQuery(clause), this.vectors);
        for (const match of matches) scores.set(match.slug, Math.max(scores.get(match.slug) ?? 0, match.score));
        // The whole request counts as a part only when it doesn't split into clauses.
        if ((i > 0 || clauses.length === 1) && (matches[0]?.score ?? 0) < TASK_TOPIC_SCORE) uncovered.push(clause);
      }
    } else {
      // Without the model: shared words between the request and each topic's title and note.
      const words = new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? []);
      for (const topic of this.topics) {
        const topicWords = new Set(`${topic.title} ${topic.header.note ?? topic.summary}`.toLowerCase().match(/[a-z]{4,}/g) ?? []);
        const shared = [...words].filter((word) => topicWords.has(word)).length;
        scores.set(topic.slug, words.size === 0 ? 0 : Math.min(1, shared / 4));
      }
    }
    // When one topic clearly covers the request, keep only topics at least half as close.
    const best = Math.max(0, ...scores.values());
    const cutoff = Math.max(TASK_TOPIC_SCORE, best * 0.5);
    const ranked = this.topics
      .map((topic) => ({ topic, score: scores.get(topic.slug) ?? 0 }))
      .filter((entry) => entry.score >= cutoff)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TASK_TOPICS);
    // Nothing covers the request: every part of it is uncovered, with or without the model.
    if (best < TASK_TOPIC_SCORE && uncovered.length === 0) uncovered.push(...(clauses.length > 1 ? clauses.slice(1) : clauses));
    if (session) session.task = { text, scores: new Map(ranked.map(({ topic, score }) => [topic.slug, score])) };
    return {
      task: text,
      coverage: best >= TASK_STRONG_SCORE ? 'strong' : best >= TASK_TOPIC_SCORE ? 'partial' : 'none',
      topics: ranked.map(({ topic, score }) => ({
        topic: topic.uri,
        title: topic.title,
        note: topic.header.note ?? topic.summary,
        score: Number(score.toFixed(3)),
      })),
      uncovered,
      matchedBy: this.vectors ? 'meaning' : 'keywords',
    };
  }

  async apply(tool: string, args: unknown, result: CallToolResult, session?: KnowledgeSession): Promise<CallToolResult> {
    if (result.isError || !Array.isArray(result.content) || this.topics.length === 0) return result;
    const index = result.content.findIndex((item) => item.type === 'text');
    if (index < 0) return result;
    const first = result.content[index] as { type: 'text'; text: string };

    let payload: unknown;
    let isJson = true;
    try {
      payload = JSON.parse(first.text);
    } catch {
      isJson = false;
    }

    const section: KnowledgeSection = { notes: [] };
    const candidates = this.topics.filter((topic) => applies(topic, tool));
    const lists = isJson ? rowLists(payload) : [];
    let changed = false;

    // Filter.
    const filtered = new Map<string, number>();
    for (const list of lists) {
      for (const topic of candidates) {
        const exclude = topic.header.filter?.exclude;
        if (!exclude) continue;
        for (let i = list.length - 1; i >= 0; i--) {
          const row = list[i];
          if (typeAllowed(topic, row.type) && exclude.some((pattern) => rowMatches(row, pattern))) {
            list.splice(i, 1);
            filtered.set(topic.uri, (filtered.get(topic.uri) ?? 0) + 1);
            changed = true;
          }
        }
      }
    }
    if (filtered.size > 0) section.filtered = [...filtered].map(([topic, removed]) => ({ topic, removed }));

    // Rank.
    const reordered = new Set<string>();
    for (const list of lists) {
      for (const topic of candidates) {
        const prefer = topic.header.rank?.prefer;
        if (!prefer) continue;
        const preferred = list.filter((row) => typeAllowed(topic, row.type) && prefer.some((p) => rowMatches(row, p)));
        if (preferred.length === 0 || preferred.length === list.length) continue;
        const rest = list.filter((row) => !preferred.includes(row));
        const next = [...preferred, ...rest];
        if (next.some((row, i) => row !== list[i])) {
          list.splice(0, list.length, ...next);
          reordered.add(topic.uri);
          changed = true;
        }
      }
    }
    if (reordered.size > 0) section.reordered = [...reordered];

    // Annotate: header rules first, then meaning.
    const { names, types } = this.describe(args, lists);
    const noted = new Set<string>();
    for (const topic of candidates) {
      if (section.notes.length >= MAX_NOTES) break;
      const byName = topic.header.match?.names?.some((pattern) => names.some((name) => globMatches(pattern, name)));
      const byType = topic.header.appliesTo?.objectTypes?.some((type) => types.includes(type));
      const byTool = topic.header.match?.tools?.includes(tool) === true;
      const acted = filtered.has(topic.uri) || reordered.has(topic.uri);
      if (byName || byType || byTool || acted) {
        section.notes.push(this.note(topic, 'rule'));
        noted.add(topic.slug);
      }
    }
    if (this.vectors && section.notes.length < MAX_NOTES) {
      const query = [tool.replace(/_/g, ' '), ...names, ...types].join(' ').trim();
      const vector = await this.embedQuery(query);
      let added = 0;
      for (const match of scoreQuery(vector, this.vectors)) {
        if (match.score < SEMANTIC_NOTE_SCORE || added >= MAX_SEMANTIC_NOTES || section.notes.length >= MAX_NOTES) break;
        const topic = candidates.find((candidate) => candidate.slug === match.slug);
        if (!topic || noted.has(topic.slug)) continue;
        section.notes.push({ ...this.note(topic, 'meaning'), score: Number(match.score.toFixed(3)) });
        noted.add(topic.slug);
        added++;
      }
    }
    // Topics the session's task needs, on the calls their header names, once per session.
    if (session?.task) {
      for (const topic of candidates) {
        if (section.notes.length >= MAX_NOTES) break;
        const score = session.task.scores.get(topic.slug) ?? 0;
        if (score < TASK_TOPIC_SCORE || noted.has(topic.slug) || session.delivered.has(topic.slug)) continue;
        if (!topic.header.appliesTo?.tools?.includes(tool)) continue;
        section.notes.push({ ...this.note(topic, 'task'), score: Number(score.toFixed(3)) });
        noted.add(topic.slug);
      }
      for (const note of section.notes) session.delivered.add(note.topic.slice('d365kb://'.length));
    }

    if (section.notes.length === 0 && !section.filtered && !section.reordered) return result;
    const content = [...result.content];
    if (changed) content[index] = { ...first, text: JSON.stringify(payload, null, 2) };
    content.push({ type: 'text', text: JSON.stringify({ knowledge: section }, null, 2) });
    return { ...result, content };
  }

  private note(topic: KnowledgeTopic, matchedBy: KnowledgeNote['matchedBy']): KnowledgeNote {
    return { topic: topic.uri, title: topic.title, note: topic.header.note ?? topic.summary, matchedBy };
  }

  /** Object names and types the call is about: string arguments plus the first result rows. */
  private describe(args: unknown, lists: Row[][]): { names: string[]; types: string[] } {
    const names = new Set<string>();
    const types = new Set<string>();
    if (isRow(args)) {
      for (const [key, value] of Object.entries(args)) {
        if (typeof value !== 'string' || value.trim().length === 0) continue;
        if (key === 'type' || key === 'objectType') types.add(value);
        else names.add(value.trim());
        if (ARG_OBJECT_TYPES[key]) types.add(ARG_OBJECT_TYPES[key]);
      }
    }
    for (const list of lists) {
      for (const row of list.slice(0, MAX_QUERY_NAMES)) {
        if (typeof row.name === 'string' && names.size < MAX_QUERY_NAMES * 2) names.add(row.name);
        if (typeof row.type === 'string') types.add(row.type);
      }
    }
    return { names: [...names].slice(0, MAX_QUERY_NAMES * 2), types: [...types] };
  }

  private async embedQuery(text: string): Promise<Float32Array> {
    const cached = this.queryCache.get(text);
    if (cached) return cached;
    const vector = await this.embedder!.embed(text);
    if (this.queryCache.size >= QUERY_CACHE_SIZE) {
      this.queryCache.delete(this.queryCache.keys().next().value as string);
    }
    this.queryCache.set(text, vector);
    return vector;
  }
}

/**
 * Starts building the shared filter: rules immediately, embeddings once the model has loaded.
 * `current()` always returns the best filter available so far; failures fall back to rules only.
 */
export function startKnowledgeFilter(kbDir: string | null): { current(): KnowledgeFilter | null } {
  let filter: KnowledgeFilter | null = null;
  void KnowledgeFilter.create(kbDir)
    .then(async (rulesOnly) => {
      filter = rulesOnly;
      const modelDir = findEmbeddingModelDir();
      if (!modelDir) {
        logger.info('Knowledge filter running on topic rules only; embedding model not found (npm run fetch-model)', {
          topics: rulesOnly.topicCount,
        });
        return;
      }
      const started = Date.now();
      const embedder = await loadEmbedder(modelDir);
      filter = await KnowledgeFilter.create(kbDir, { embedder, cache: new PassageCache(passageCachePath(modelDir)) });
      logger.info('Knowledge filter ready with embeddings', {
        topics: filter.topicCount,
        model: embedder.model,
        loadMs: Date.now() - started,
      });
    })
    .catch((error: unknown) => {
      logger.warn('Knowledge filter could not use embeddings; continuing with what loaded', {
        error: error instanceof Error ? error.message : String(error),
        rulesOnly: filter !== null,
      });
    });
  return { current: () => filter };
}
