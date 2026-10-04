import { findKnowledgeDir } from '../tools/knowledge.js';
import { findEmbeddingModelDir, loadEmbedder } from '../knowledge/embedder.js';
import { buildTopicVectors, PassageCache, passageCachePath } from '../knowledge/semantic.js';
import { loadTopics } from '../knowledge/topics.js';

export interface KnowledgeCheckOptions {
  kbDir?: string;
}

/**
 * Validates every topic header and, when the embedding model is installed, fills the topic
 * vector cache so the server starts without embedding the knowledge base. The Docker build runs
 * it after `fetch-model`; run it locally after editing topics.
 */
export async function knowledgeCheckCommand(options: KnowledgeCheckOptions): Promise<number> {
  const kbDir = options.kbDir ?? findKnowledgeDir();
  if (!kbDir) {
    console.error('Could not locate the d365-fno-assistant-knowledge/resources directory. Pass --kb-dir explicitly.');
    return 1;
  }
  let topics;
  try {
    topics = loadTopics(kbDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const withoutHeader = topics.filter((topic) => Object.keys(topic.header).length === 0).map((topic) => topic.slug);
  console.log(`${topics.length} topics, headers valid.`);
  if (withoutHeader.length > 0) {
    console.log(`Topics without a header (matched by meaning only): ${withoutHeader.join(', ')}`);
  }

  const modelDir = findEmbeddingModelDir();
  if (!modelDir) {
    console.log('Embedding model not installed (npm run fetch-model); the filter will use header rules only.');
    return 0;
  }
  const started = Date.now();
  const embedder = await loadEmbedder(modelDir);
  await buildTopicVectors(embedder, topics, new PassageCache(passageCachePath(modelDir)));
  console.log(`Topic vectors ready in ${passageCachePath(modelDir)} (${Date.now() - started} ms).`);
  return 0;
}
