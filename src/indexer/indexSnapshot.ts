import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getIndexStats } from './buildIndex.js';
import { getMeta, META_KEYS, openDb } from './db.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export interface IndexSnapshot {
  file: string;
  builtAt: string;
  serverVersion: string | null;
  applicationVersion: string | null;
  schemaVersion: number | null;
  stats: { objects: number; labels: number; usageRows: number };
  xrefImportedAt: string | null;
}

export interface SnapshotOptions {
  allowNoRawXml?: boolean;
  integrityCheck?: boolean;
  relativePathsRoot?: string;
  /** Callers that run and record their own integrity check can skip the built-in one. */
  verify?: boolean;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

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

function normalizeSnapshot(dbFile: string, relativePathsRoot?: string): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
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

function verifySnapshot(dbFile: string, expectedObjects: number, integrityCheck: boolean): void {
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

/**
 * Writes and verifies a compact single-file index candidate. The source remains
 * openable throughout, so a worker can build the candidate before activation.
 */
export function snapshotIndex(dbPath: string, destination: string, options: SnapshotOptions = {}): IndexSnapshot {
  let builtAt: string;
  let serverVersion: string | null;
  let applicationVersion: string | null;
  let schemaVersion: number | null;
  let objects: number;
  let labels: number;
  let usageRows: number;
  let xrefImportedAt: string | null;
  fs.rmSync(destination, { force: true });
  const source = openDb(dbPath);
  try {
    const recorded = getMeta(source, META_KEYS.builtAt);
    if (!recorded) throw new Error('The index has no build metadata; run `index` before creating a snapshot.');
    builtAt = recorded;
    serverVersion = getMeta(source, META_KEYS.serverVersion);
    applicationVersion = getMeta(source, META_KEYS.appVersion);
    const recordedSchema = Number(getMeta(source, META_KEYS.schemaVersion));
    schemaVersion = Number.isSafeInteger(recordedSchema) && recordedSchema > 0 ? recordedSchema : null;
    if (getMeta(source, META_KEYS.storeRawXml) === '0' && !options.allowNoRawXml) {
      throw new Error(
        'The index was built with D365_INDEX_STORE_RAW_XML=0. A server without source files cannot serve get_element_xml; rebuild with raw XML stored or explicitly allow a snapshot without it.'
      );
    }
    const stats = getIndexStats(source);
    objects = stats.totalObjects;
    labels = stats.totalLabels;
    usageRows = Number((source.prepare('SELECT COUNT(*) AS n FROM ax_usage_refs').get() as { n: number | bigint }).n);
    xrefImportedAt = stats.usageSnapshot.status === 'imported' ? stats.usageSnapshot.importedAt : null;
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    source.exec(`VACUUM INTO '${escapeSqlString(destination)}'`);
  } finally {
    source.close();
  }

  normalizeSnapshot(destination, options.relativePathsRoot);
  if (options.verify !== false) verifySnapshot(destination, objects, options.integrityCheck === true);
  return {
    file: destination,
    builtAt,
    serverVersion,
    applicationVersion,
    schemaVersion,
    stats: { objects, labels, usageRows },
    xrefImportedAt,
  };
}
