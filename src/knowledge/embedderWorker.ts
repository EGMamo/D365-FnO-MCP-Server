import { parentPort, workerData } from 'node:worker_threads';
import { loadEmbedder } from './embedder.js';

/**
 * Worker thread for `loadWorkerEmbedder`: loads the model once, then answers `{ id, text }`
 * requests with `{ id, vector }` or `{ id, error }`, so inference never blocks the server's event loop.
 */
const port = parentPort!;
try {
  const embedder = await loadEmbedder((workerData as { dir: string }).dir);
  port.on('message', ({ id, text }: { id: number; text: string }) => {
    embedder.embed(text).then(
      (vector) => port.postMessage({ id, vector }, [vector.buffer as ArrayBuffer]),
      (error: unknown) => port.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    );
  });
  port.postMessage({ ready: true });
} catch (error) {
  port.postMessage({ ready: false, error: error instanceof Error ? error.message : String(error) });
}
