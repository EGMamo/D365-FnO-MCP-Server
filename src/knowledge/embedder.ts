import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Local sentence embeddings for the knowledge filter and the digest duplicate check.
 * The model (all-MiniLM-L6-v2, fetched by `npm run fetch-model`) runs in-process through the
 * WebAssembly build of ONNX Runtime, so there is no native install, GPU or network call.
 * Everything that uses it keeps working on rules alone when the model files are absent.
 */

export const EMBEDDING_MODEL_NAME = 'all-MiniLM-L6-v2';
const MODEL_FILES = ['model.onnx', 'tokenizer.json', 'tokenizer_config.json'] as const;
/** The model was trained on sequences up to 256 word pieces; longer input is cut. */
const MAX_TOKENS = 256;

export interface Embedder {
  readonly model: string;
  /** Unit-length vectors, so a dot product is the cosine similarity. */
  embed(text: string): Promise<Float32Array>;
}

function hasModelFiles(dir: string): boolean {
  return MODEL_FILES.every((file) => fs.existsSync(path.join(dir, file)));
}

/**
 * Model directory: `D365_EMBEDDING_MODEL_DIR` when set, otherwise `models/all-MiniLM-L6-v2`
 * next to the package root (found by walking up from this module, as for the knowledge base).
 */
export function findEmbeddingModelDir(override = process.env.D365_EMBEDDING_MODEL_DIR): string | null {
  if (override && override.trim().length > 0) {
    const dir = path.resolve(override.trim());
    return hasModelFiles(dir) ? dir : null;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'models', EMBEDDING_MODEL_NAME);
    if (hasModelFiles(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Loads the tokenizer and ONNX session from `dir`. Takes about a second and ~100 MB of memory. */
export async function loadEmbedder(dir: string): Promise<Embedder> {
  const [ort, { Tokenizer }] = await Promise.all([import('onnxruntime-web'), import('@huggingface/tokenizers')]);
  ort.env.logLevel = 'error';
  ort.env.wasm.numThreads = 1;
  const tokenizer = new Tokenizer(
    JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8'))
  );
  const session = await ort.InferenceSession.create(fs.readFileSync(path.join(dir, 'model.onnx')));
  const outputName = session.outputNames[0];

  return {
    model: EMBEDDING_MODEL_NAME,
    async embed(text: string): Promise<Float32Array> {
      let ids = tokenizer.encode(text).ids;
      if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]];
      const length = ids.length;
      const tensor = (values: number[]) =>
        new ort.Tensor('int64', BigInt64Array.from(values, (value) => BigInt(value)), [1, length]);
      const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
        input_ids: tensor(ids),
        attention_mask: tensor(ids.map(() => 1)),
      };
      if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = tensor(ids.map(() => 0));
      const output = (await session.run(feeds))[outputName];
      const hidden = output.data as Float32Array;
      const width = output.dims[2];

      // Mean pooling over tokens, then L2 normalization (the sentence-transformers recipe).
      const vector = new Float32Array(width);
      for (let token = 0; token < length; token++) {
        for (let i = 0; i < width; i++) vector[i] += hidden[token * width + i];
      }
      let norm = 0;
      for (let i = 0; i < width; i++) {
        vector[i] /= length;
        norm += vector[i] * vector[i];
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < width; i++) vector[i] /= norm;
      return vector;
    },
  };
}
