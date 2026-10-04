import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dot, findEmbeddingModelDir, loadEmbedder, type Embedder } from './embedder.js';
import { loadTopics, stripFrontMatter, topicPassages, type KnowledgeTopic } from './topics.js';

/**
 * Passage vectors for every topic, built once per process. Used two ways: matching an index
 * tool call to the topics it is about, and judging whether a new draft repeats an existing topic.
 */
export interface TopicVectors {
  topic: KnowledgeTopic;
  passages: Float32Array[];
}

export interface SemanticMatch {
  slug: string;
  title: string;
  score: number;
}

/** Duplicate score at or above which a draft is treated as repeating an existing topic. */
export const SEMANTIC_DUPLICATE_SCORE = 0.62;
/** Score at or above which a draft is reported as overlapping an existing topic. */
export const SEMANTIC_RELATED_SCORE = 0.5;

/**
 * Embeddings of topic passages keyed by a hash of model and text. Embedding every passage takes
 * several seconds of CPU, so vectors are kept in `passage-cache.json` beside the model; the Docker
 * build and `npm run fetch-model` fill it, and only new or edited passages are embedded at startup.
 */
export class PassageCache {
  private readonly entries = new Map<string, Float32Array>();
  private dirty = false;

  constructor(private readonly filePath: string | null = null) {
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { entries?: Record<string, string> };
      for (const [key, value] of Object.entries(raw.entries ?? {})) {
        const bytes = Buffer.from(value, 'base64');
        this.entries.set(key, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
      }
    } catch {
      // A corrupt cache only costs the time to embed again.
    }
  }

  async embed(embedder: Embedder, text: string): Promise<Float32Array> {
    const key = createHash('sha256').update(`${embedder.model}\n${text}`).digest('hex');
    const cached = this.entries.get(key);
    if (cached) return cached;
    const vector = await embedder.embed(text);
    this.entries.set(key, vector);
    this.dirty = true;
    return vector;
  }

  /** Writes new vectors back; a read-only install (the container image at runtime) is fine. */
  save(): void {
    if (!this.filePath || !this.dirty) return;
    const entries: Record<string, string> = {};
    for (const [key, vector] of this.entries) {
      entries[key] = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
    }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ entries }));
      this.dirty = false;
    } catch {
      // Not writable: vectors stay in memory for this process.
    }
  }
}

export async function embedPassages(
  embedder: Embedder,
  markdown: string,
  cache: PassageCache = new PassageCache()
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (const passage of topicPassages(markdown)) vectors.push(await cache.embed(embedder, passage));
  return vectors;
}

export async function buildTopicVectors(
  embedder: Embedder,
  topics: KnowledgeTopic[],
  cache: PassageCache = new PassageCache()
): Promise<TopicVectors[]> {
  const result: TopicVectors[] = [];
  for (const topic of topics) {
    // The title and note carry the topic's intent in few words, so they count as passages too.
    const passages = await embedPassages(embedder, topic.body, cache);
    passages.push(await cache.embed(embedder, [topic.title, topic.header.note ?? topic.summary].join('. ')));
    result.push({ topic, passages });
  }
  cache.save();
  return result;
}

/** The cache file beside a model directory. */
export function passageCachePath(modelDir: string): string {
  return path.join(modelDir, 'passage-cache.json');
}

function bestMatch(vector: Float32Array, passages: Float32Array[]): number {
  let best = -1;
  for (const passage of passages) best = Math.max(best, dot(vector, passage));
  return best;
}

function meanBest(from: Float32Array[], to: Float32Array[]): number {
  if (from.length === 0 || to.length === 0) return 0;
  return from.reduce((sum, vector) => sum + bestMatch(vector, to), 0) / from.length;
}

/** Similarity of one query vector to each topic: its best-matching passage. */
export function scoreQuery(query: Float32Array, topics: TopicVectors[]): SemanticMatch[] {
  return topics
    .map(({ topic, passages }) => ({ slug: topic.slug, title: topic.title, score: bestMatch(query, passages) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * How much a draft repeats each topic, independent of wording: for every passage on one side,
 * the closest passage on the other, averaged; the higher of the two directions wins so a short
 * draft that restates part of a long topic still scores high.
 */
export function scoreDuplicates(draft: Float32Array[], topics: TopicVectors[]): SemanticMatch[] {
  return topics
    .map(({ topic, passages }) => ({
      slug: topic.slug,
      title: topic.title,
      score: Math.max(meanBest(draft, passages), meanBest(passages, draft)),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Scores a draft against the topics in `kbDir` by meaning. Returns null when the embedding model
 * is not installed, so callers can fall back to the wording check alone.
 */
export async function scoreDraftByMeaning(draft: string, kbDir: string): Promise<SemanticMatch[] | null> {
  const modelDir = findEmbeddingModelDir();
  if (!modelDir) return null;
  const embedder = await loadEmbedder(modelDir);
  const topics = await buildTopicVectors(embedder, loadTopics(kbDir), new PassageCache(passageCachePath(modelDir)));
  return scoreDuplicates(await embedPassages(embedder, stripFrontMatter(draft)), topics);
}
