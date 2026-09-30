import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getMeta, META_KEYS, openDb } from './db.js';
import { getIndexStats } from './buildIndex.js';
import { manifestSchema, type IndexManifest } from './remoteIndex.js';
import { compressFile, ENCODING_SUFFIX, type CompressedFile, type CompressionLevel, type IndexEncoding } from './compression.js';

/**
 * Packages a built index for the hosted server: a compact, compressed (gzip
 * by default) copy of the database plus a manifest that `syncIndexFromManifest` verifies
 * against. Output layout (relative to `outDir`):
 *
 *   <version>/d365_index.db.gz
 *   <version>/manifest.json        db.url = "d365_index.db.gz"
 *   latest/manifest.json           db.url = "../<version>/d365_index.db.gz"
 *
 * Uploading `<version>/` first and `latest/manifest.json` last makes the
 * switch atomic for readers, and old versions stay available for rollback.
 * No cloud SDK is involved; a script uploads the folder.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export const MANIFEST_FILE = 'manifest.json';
export const LATEST_DIR = 'latest';

export interface PublishOptions {
  dbPath: string;
  outDir: string;
  serverVersion: string;
  /** Absolute URL prefix for `db.url` in `latest/manifest.json` (default: relative `../<version>/`). */
  dbUrlPrefix?: string;
  /** Publish even when the index was built without raw XML. */
  allowNoRawXml?: boolean;
  /** Run `PRAGMA integrity_check` on the copy instead of the faster `quick_check`. */
  integrityCheck?: boolean;
  /** Rewrite indexed file paths relative to this packages directory in the copy. */
  relativePathsRoot?: string;
  /** Transfer encoding of the published database (default gzip). */
  encoding?: IndexEncoding;
  level?: CompressionLevel;
  now?: () => Date;
}

export interface PublishResult {
  version: string;
  versionDir: string;
  dbFile: string;
  latestManifestPath: string;
  manifest: IndexManifest;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/** `2026-09-25T20:44:20.123Z` -> `20260925T204420Z`, safe for folder and blob names. */
function compactTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid built_at timestamp in the index: ${iso}`);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Strips `root` (plus one path separator) from every indexed path that starts
 * with it, so the published copy does not carry the build machine's layout.
 */
function rewritePathsRelative(db: InstanceType<typeof DatabaseSync>, root: string): void {
  const resolved = path.resolve(root).replace(/[\\/]+$/, '');
  const prefixes = new Set([resolved, resolved.replace(/\\/g, '/'), resolved.replace(/\//g, '\\')]);
  const columns: [string, string][] = [
    ['ax_objects', 'file_path'],
    ['ax_labels', 'source_file'],
    ['ax_label_sources', 'source_file'],
  ];
  for (const prefix of prefixes) {
    const length = prefix.length;
    for (const [table, column] of columns) {
      db.prepare(
        `UPDATE ${table} SET ${column} = substr(${column}, ?)
         WHERE lower(substr(${column}, 1, ?)) = lower(?) AND substr(${column}, ?, 1) IN ('/', '\\')`
      ).run(length + 2, length, prefix, length + 1);
    }
  }
}

/** Leaves the copy as one self-contained file in rollback-journal mode. */
function normalizeCopy(dbFile: string, relativePathsRoot?: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    // Trace imports carry user names and environment SQL; they stay on the machine that imported them.
    const traces = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ax_trace_imports'`).get();
    if (traces) {
      db.exec('DELETE FROM ax_trace_sql; DELETE FROM ax_trace_methods; DELETE FROM ax_trace_sessions; DELETE FROM ax_trace_imports; VACUUM');
    }
    if (relativePathsRoot) {
      db.exec('BEGIN');
      try {
        rewritePathsRelative(db, relativePathsRoot);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      db.exec('VACUUM');
    }
  } finally {
    db.close();
  }
}

function verifyCopy(dbFile: string, expectedObjects: number, integrityCheck: boolean): void {
  const pragma = integrityCheck ? 'integrity_check' : 'quick_check';
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const verdict = Object.values(db.prepare(`PRAGMA ${pragma}`).get() as Record<string, string>)[0];
    if (verdict !== 'ok') throw new Error(`SQLite ${pragma} reported: ${verdict}`);
    const count = Number((db.prepare('SELECT COUNT(*) AS n FROM ax_objects').get() as { n: number | bigint }).n);
    if (count !== expectedObjects) {
      throw new Error(`The copied index has ${count} objects but the source reported ${expectedObjects}.`);
    }
  } finally {
    db.close();
  }
}

export async function publishIndex(options: PublishOptions): Promise<PublishResult> {
  const now = options.now ?? (() => new Date());
  const dbPath = path.resolve(options.dbPath);
  const outDir = path.resolve(options.outDir);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Index database not found at ${dbPath}. Run \`index\` first.`);
  }

  const staging = path.join(outDir, '.staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    return await publishInto(dbPath, outDir, staging, options, now);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** A compact, verified single-file copy of an index plus the facts a manifest records. */
export interface IndexSnapshot {
  file: string;
  builtAt: string;
  serverVersion: string | null;
  stats: { objects: number; labels: number; usageRows: number };
  /** When the compiler usage snapshot was imported, or null when none was. */
  xrefImportedAt: string | null;
}

export interface SnapshotOptions {
  allowNoRawXml?: boolean;
  integrityCheck?: boolean;
  relativePathsRoot?: string;
}

/**
 * Writes a compact copy of `dbPath` to `destination` (VACUUM INTO), optionally
 * rewrites indexed paths, and verifies it. The source is only read, so a
 * server may keep serving it meanwhile.
 */
export function snapshotIndex(dbPath: string, destination: string, options: SnapshotOptions = {}): IndexSnapshot {
  let builtAt: string;
  let serverVersion: string | null;
  let objects: number;
  let labels: number;
  let usageRows: number;
  let xrefImportedAt: string | null;
  fs.rmSync(destination, { force: true });
  const source = openDb(dbPath);
  try {
    const recorded = getMeta(source, META_KEYS.builtAt);
    if (!recorded) {
      throw new Error('The index has no build metadata; run `index` (this server version) before publishing.');
    }
    builtAt = recorded;
    serverVersion = getMeta(source, META_KEYS.serverVersion);
    if (getMeta(source, META_KEYS.storeRawXml) === '0' && !options.allowNoRawXml) {
      throw new Error(
        'The index was built with D365_INDEX_STORE_RAW_XML=0. A hosted server has no source files, so get_element_xml would fail; rebuild with raw XML stored or pass --allow-no-raw-xml.'
      );
    }
    const stats = getIndexStats(source);
    objects = stats.totalObjects;
    labels = stats.totalLabels;
    usageRows = Number((source.prepare('SELECT COUNT(*) AS n FROM ax_usage_refs').get() as { n: number | bigint }).n);
    xrefImportedAt = stats.usageSnapshot.status === 'imported' ? stats.usageSnapshot.importedAt : null;

    // Fold the WAL into the main file, then write a compact single-file copy.
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    source.exec(`VACUUM INTO '${escapeSqlString(destination)}'`);
  } finally {
    source.close();
  }

  normalizeCopy(destination, options.relativePathsRoot);
  verifyCopy(destination, objects, options.integrityCheck === true);
  return { file: destination, builtAt, serverVersion, stats: { objects, labels, usageRows }, xrefImportedAt };
}

/** Folder and blob name of a published version: `<built_at compacted>-<sha256 prefix>`. */
export function versionName(builtAt: string, sha256: string): string {
  return `${compactTimestamp(builtAt)}-${sha256.slice(0, 8)}`;
}

/** Published file name of the database for an encoding (`d365_index.db.gz`, `.br`, or bare). */
export function publishedDbFileName(encoding: IndexEncoding): string {
  return `d365_index.db${ENCODING_SUFFIX[encoding]}`;
}

async function publishInto(
  dbPath: string,
  outDir: string,
  staging: string,
  options: PublishOptions,
  now: () => Date
): Promise<PublishResult> {
  const stagedDb = path.join(staging, 'd365_index.db');
  const snapshot = snapshotIndex(dbPath, stagedDb, options);
  const encoding = options.encoding ?? 'gzip';
  const fileName = publishedDbFileName(encoding);

  const stagedPackage = path.join(staging, `package${ENCODING_SUFFIX[encoding] || '.db'}`);
  const packed = await compressFile(stagedDb, stagedPackage, encoding, options.level ?? 'balanced');
  const version = versionName(snapshot.builtAt, packed.sha256);
  const versionDir = path.join(outDir, version);
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.mkdirSync(versionDir, { recursive: true });
  const dbFile = path.join(versionDir, fileName);
  fs.renameSync(stagedPackage, dbFile);

  const manifestFor = (url: string): IndexManifest =>
    buildManifest({ version, serverVersion: options.serverVersion, snapshot, packed, url, publishedAt: now().toISOString() });

  const versionedManifest = manifestFor(fileName);
  fs.writeFileSync(path.join(versionDir, MANIFEST_FILE), JSON.stringify(versionedManifest, null, 2));

  const prefix = options.dbUrlPrefix?.replace(/\/+$/, '');
  const latestManifest = manifestFor(prefix ? `${prefix}/${version}/${fileName}` : `../${version}/${fileName}`);
  const latestDir = path.join(outDir, LATEST_DIR);
  fs.mkdirSync(latestDir, { recursive: true });
  const latestManifestPath = path.join(latestDir, MANIFEST_FILE);
  fs.writeFileSync(latestManifestPath, JSON.stringify(latestManifest, null, 2));

  return { version, versionDir, dbFile, latestManifestPath, manifest: latestManifest };
}

/** The manifest describing a packaged snapshot at `url`. */
export function buildManifest(input: {
  version: string;
  serverVersion: string;
  snapshot: Pick<IndexSnapshot, 'builtAt' | 'stats' | 'xrefImportedAt'>;
  packed: CompressedFile;
  url: string;
  publishedAt: string;
}): IndexManifest {
  const { packed, snapshot } = input;
  return manifestSchema.parse({
    schema: 1,
    version: input.version,
    serverVersion: input.serverVersion,
    builtAt: snapshot.builtAt,
    publishedAt: input.publishedAt,
    db: {
      url: input.url,
      sha256: packed.sha256,
      bytes: packed.bytes,
      rawBytes: packed.rawBytes,
      rawSha256: packed.rawSha256,
      gzip: packed.encoding === 'gzip',
      encoding: packed.encoding,
    },
    stats: snapshot.stats,
    xref: snapshot.xrefImportedAt ? { importedAt: snapshot.xrefImportedAt } : null,
  });
}
