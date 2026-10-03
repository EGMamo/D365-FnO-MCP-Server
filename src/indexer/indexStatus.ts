import fs from 'node:fs';
import { getIndexStats } from './buildIndex.js';
import { getMeta, INDEX_SCHEMA_VERSION, META_KEYS, openDb } from './db.js';
import { scanPackagesDir } from './scanner.js';

/** Answers whether a local index is current for a packages folder without rebuilding it. */

export interface LocalIndex {
  builtAt: string | null;
  objects: number;
  xrefImportedAt: string | null;
  /** `schema_version` the index was built with; null for indexes that predate it. */
  schemaVersion: number | null;
}

export interface ChangedFile {
  path: string;
  kind: 'added' | 'changed' | 'removed';
  model: string;
}

export interface IndexStatus {
  /** True when nothing needs to be indexed. */
  upToDate: boolean;
  /** Plain-language reasons the index is out of date; empty when it is current. */
  reasons: string[];
  local: LocalIndex;
  scannedFiles: number;
  added: number;
  changed: number;
  removed: number;
  /** Changed files per model, most first. */
  models: { model: string; files: number }[];
  /** The first `listLimit` changed files, for the log. */
  files: ChangedFile[];
  scanMs: number;
}

export interface IndexStatusOptions {
  packagesDir: string;
  dbPath: string;
  listLimit?: number;
}

/**
 * The model folder of a scanned file: <packages>/<package>/<model>/<AxType>/<file>,
 * or <model>/AxLabelFile/LabelResources/<language>/<file> for label files.
 */
function modelOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const labelDir = parts.lastIndexOf('AxLabelFile');
  if (labelDir > 0) return parts[labelDir - 1];
  return parts.length >= 3 ? parts[parts.length - 3] : '';
}

interface RecordedFiles {
  local: LocalIndex;
  /** file path -> recorded mtime, objects and label files together. */
  mtimes: Map<string, number>;
  /** `type|name` of every indexed object, to ignore files that lose a name collision. */
  keys: Set<string>;
}

function readLocalIndex(dbPath: string): RecordedFiles | null {
  if (!fs.existsSync(dbPath)) return null;
  const db = openDb(dbPath);
  try {
    const stats = getIndexStats(db);
    const mtimes = new Map<string, number>();
    const keys = new Set<string>();
    const objects = db.prepare('SELECT type, name, file_path, file_mtime FROM ax_objects').all() as {
      type: string; name: string; file_path: string; file_mtime: number;
    }[];
    for (const row of objects) {
      mtimes.set(row.file_path, Number(row.file_mtime));
      keys.add(`${row.type}|${row.name}`);
    }
    const labels = db.prepare('SELECT source_file, file_mtime FROM ax_label_sources').all() as { source_file: string; file_mtime: number }[];
    for (const row of labels) mtimes.set(row.source_file, Number(row.file_mtime));
    return {
      local: {
        builtAt: stats.builtAt,
        objects: stats.totalObjects,
        xrefImportedAt: stats.usageSnapshot.status === 'imported' ? stats.usageSnapshot.importedAt : null,
        schemaVersion: Number(getMeta(db, META_KEYS.schemaVersion)) || null,
      },
      mtimes,
      keys,
    };
  } finally {
    db.close();
  }
}

export async function checkIndexStatus(options: IndexStatusOptions): Promise<IndexStatus> {
  const listLimit = options.listLimit ?? 20;
  const recorded = readLocalIndex(options.dbPath);
  if (!recorded) throw new Error('There is no local index to compare with.');
  if (!recorded.local.builtAt) throw new Error('The local index has no build time; run `index` once, then check again.');

  const started = Date.now();
  const counts = { added: 0, changed: 0, removed: 0 };
  const perModel = new Map<string, number>();
  const files: ChangedFile[] = [];
  const note = (file: ChangedFile) => {
    counts[file.kind]++;
    perModel.set(file.model, (perModel.get(file.model) ?? 0) + 1);
    if (files.length < listLimit) files.push(file);
  };

  let scannedFiles = 0;
  const seen = new Set<string>();
  for await (const file of scanPackagesDir(options.packagesDir)) {
    scannedFiles++;
    seen.add(file.filePath);
    const mtime = recorded.mtimes.get(file.filePath);
    if (mtime === undefined) {
      // A second file with an indexed type and name loses the collision; the indexer skips it too.
      if (file.type === 'Label' || !recorded.keys.has(`${file.type}|${file.name}`)) {
        note({ path: file.filePath, kind: 'added', model: file.model });
      }
    } else if (file.mtime !== mtime) {
      note({ path: file.filePath, kind: 'changed', model: file.model });
    }
  }
  for (const filePath of recorded.mtimes.keys()) {
    if (!seen.has(filePath)) note({ path: filePath, kind: 'removed', model: modelOf(filePath) });
  }

  const fileChanges = counts.added + counts.changed + counts.removed;
  const reasons: string[] = [];
  if (fileChanges > 0) {
    reasons.push(`${fileChanges} file(s) in ${perModel.size} model(s) changed since the local index was built.`);
  }
  const localSchema = recorded.local.schemaVersion ?? 0;
  if (localSchema < INDEX_SCHEMA_VERSION) {
    reasons.push(
      `The local index was built by an older version (schema ${localSchema || 'unknown'}, current ${INDEX_SCHEMA_VERSION}); index it again to pick up the data that version adds.`
    );
  }
  if (scannedFiles === 0) reasons.push(`No metadata files were found under ${options.packagesDir}; is it the right folder?`);

  return {
    upToDate: reasons.length === 0,
    reasons,
    local: recorded.local,
    scannedFiles,
    added: counts.added,
    changed: counts.changed,
    removed: counts.removed,
    models: [...perModel].map(([model, count]) => ({ model, files: count })).sort((a, b) => b.files - a.files || a.model.localeCompare(b.model)),
    files,
    scanMs: Date.now() - started,
  };
}
