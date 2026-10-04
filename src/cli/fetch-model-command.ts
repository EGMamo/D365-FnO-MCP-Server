import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMBEDDING_MODEL_NAME, findEmbeddingModelDir } from '../knowledge/embedder.js';

// all-MiniLM-L6-v2 (Apache-2.0) as ONNX with its tokenizer, pinned by archive hash.
const ARCHIVE_URL = 'https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz';
const ARCHIVE_SHA256 = '913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3';
const FILES = ['model.onnx', 'tokenizer.json', 'tokenizer_config.json'];

export interface FetchModelOptions {
  /** Models root; the model lands in `<dir>/all-MiniLM-L6-v2`. Default: `models/` at the package root. */
  dir?: string;
}

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * Downloads the embedding model used by the knowledge filter and the digest duplicate check,
 * verifies the archive hash and extracts the files the server needs. Network access is needed
 * once; the server itself never downloads anything.
 */
export async function fetchModelCommand(options: FetchModelOptions): Promise<number> {
  const target = path.join(path.resolve(options.dir ?? path.join(packageRoot(), 'models')), EMBEDDING_MODEL_NAME);
  if (findEmbeddingModelDir(target) === target) {
    console.log(`Embedding model already present in ${target}`);
    return 0;
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-embedding-model-'));
  try {
    console.log(`Downloading ${ARCHIVE_URL}`);
    const response = await fetch(ARCHIVE_URL);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(archive).digest('hex');
    if (actual !== ARCHIVE_SHA256) throw new Error(`Archive hash mismatch: expected ${ARCHIVE_SHA256}, got ${actual}`);
    const archivePath = path.join(work, 'onnx.tar.gz');
    fs.writeFileSync(archivePath, archive);
    // tar ships with Linux, macOS and Windows 10+.
    execFileSync('tar', ['-xzf', archivePath, '-C', work], { stdio: 'inherit' });

    const staging = `${target}.partial`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const file of FILES) fs.copyFileSync(path.join(work, 'onnx', file), path.join(staging, file));
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    console.log(`Embedding model ready in ${target}. Run knowledge-check to cache the topic vectors.`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
