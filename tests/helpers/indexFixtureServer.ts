import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { INDEX_SCHEMA_VERSION, META_KEYS, openDb, rebuildFts, setMeta, upsertObject } from '../../src/indexer/db.js';

export interface StaticServer {
  baseUrl: string;
  /** Request URLs in arrival order, query strings included. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * Serves a directory over HTTP the way a blob container would, so a folder
 * produced by `publishIndex` can be consumed by `syncIndexFromManifest`.
 */
export async function startStaticServer(rootDir: string): Promise<StaticServer> {
  const root = path.resolve(rootDir);
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const file = path.join(root, pathname);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export interface FixtureObject {
  type: string;
  name: string;
  filePath?: string;
}

/**
 * Writes a small index with build metadata, the minimum `publishIndex` needs.
 */
export function createIndexedDb(
  dbPath: string,
  objects: FixtureObject[],
  meta: { builtAt?: string; storeRawXml?: '0' | '1'; serverVersion?: string; schemaVersion?: string } = {}
): void {
  const db = openDb(dbPath);
  try {
    for (const object of objects) {
      upsertObject(db, {
        type: object.type,
        name: object.name,
        package: 'FixturePackage',
        model: 'FixtureModel',
        file_path: object.filePath ?? `/fake/${object.name}.xml`,
        raw_xml: `<${object.type}><Name>${object.name}</Name></${object.type}>`,
        file_mtime: 1,
      });
    }
    rebuildFts(db);
    setMeta(db, META_KEYS.builtAt, meta.builtAt ?? '2026-09-25T20:00:00.000Z');
    setMeta(db, META_KEYS.serverVersion, meta.serverVersion ?? '0.1.0');
    setMeta(db, META_KEYS.storeRawXml, meta.storeRawXml ?? '1');
    setMeta(db, META_KEYS.schemaVersion, meta.schemaVersion ?? String(INDEX_SCHEMA_VERSION));
  } finally {
    db.close();
  }
}
