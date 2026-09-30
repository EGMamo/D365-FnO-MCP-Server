import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import fs from 'fs';
import type { AxParam } from './parser.js';
import { createUsageSchema } from './xrefUsage.js';
import { createTraceSchema } from './traces.js';
import { createReleasePlanSchema } from './releasePlans.js';

export type Database = DatabaseSync;

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

function transaction<Args extends unknown[], Result>(
  db: Database,
  fn: (...args: Args) => Result
): (...args: Args) => Result {
  return (...args: Args): Result => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

export interface Xref {
  id?: number | bigint;
  from_type: string;
  from_name: string;
  to_type: string;
  to_name: string;
  xref_kind?: string;
}

export function openDb(dbPath: string): Database {
  const db = new NodeDatabaseSync(dbPath);
  try {
  db.exec('PRAGMA journal_mode = WAL');
  // Required for ON DELETE CASCADE on child tables (SQLite defaults to off).
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ax_objects (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      package TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      file_path TEXT NOT NULL,
      raw_xml TEXT,
      file_mtime INTEGER NOT NULL DEFAULT 0,
      UNIQUE(type, name)
    );

    CREATE TABLE IF NOT EXISTS ax_fields (
      id INTEGER PRIMARY KEY,
      object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT,
      edt TEXT,
      label_id TEXT,
      mandatory INTEGER DEFAULT 0,
      allow_edit INTEGER DEFAULT 1,
      data_source TEXT DEFAULT '',
      data_field TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ax_methods (
      id INTEGER PRIMARY KEY,
      object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      access_modifier TEXT DEFAULT 'public',
      return_type TEXT,
      params TEXT,
      is_static INTEGER DEFAULT 0,
      is_abstract INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ax_labels (
      id INTEGER PRIMARY KEY,
      label_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en-US',
      value TEXT NOT NULL,
      source_file TEXT NOT NULL DEFAULT '',
      UNIQUE(label_id, language)
    );

    CREATE TABLE IF NOT EXISTS ax_label_sources (
      source_file TEXT PRIMARY KEY,
      file_mtime INTEGER NOT NULL DEFAULT 0,
      label_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ax_xref (
      id INTEGER PRIMARY KEY,
      from_type TEXT NOT NULL,
      from_name TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_name TEXT NOT NULL,
      xref_kind TEXT
    );

    CREATE TABLE IF NOT EXISTS ax_enum_values (
      id INTEGER PRIMARY KEY,
      object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      value TEXT,
      label_id TEXT
    );

    CREATE TABLE IF NOT EXISTS ax_datasources (
      id INTEGER PRIMARY KEY,
      object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      table_name TEXT
    );

    CREATE TABLE IF NOT EXISTS ax_form_controls (
      id INTEGER PRIMARY KEY,
      object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT,
      parent_name TEXT
    );

    CREATE TABLE IF NOT EXISTS ax_properties (
      id INTEGER PRIMARY KEY,
      object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      UNIQUE(object_id, key)
    );

    CREATE TABLE IF NOT EXISTS ax_security_grants (
      id INTEGER PRIMARY KEY,
      object_id INTEGER REFERENCES ax_objects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_name TEXT NOT NULL,
      child_name TEXT NOT NULL DEFAULT '',
      grants TEXT NOT NULL DEFAULT ''
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ax_fts
      USING fts5(name, type, package, content=ax_objects, content_rowid=id);

    CREATE VIRTUAL TABLE IF NOT EXISTS ax_labels_fts
      USING fts5(value, content=ax_labels, content_rowid=id);
  `);

  // Lightweight migrations for databases created by earlier versions.
  const fieldCols = new Set(
    (db.prepare(`PRAGMA table_info(ax_fields)`).all() as { name: string }[]).map((c) => c.name)
  );
  if (!fieldCols.has('data_source')) db.exec(`ALTER TABLE ax_fields ADD COLUMN data_source TEXT DEFAULT ''`);
  if (!fieldCols.has('data_field')) db.exec(`ALTER TABLE ax_fields ADD COLUMN data_field TEXT DEFAULT ''`);

  const labelCols = new Set(
    (db.prepare(`PRAGMA table_info(ax_labels)`).all() as { name: string }[]).map((c) => c.name)
  );
  if (!labelCols.has('source_file')) {
    db.exec(`ALTER TABLE ax_labels ADD COLUMN source_file TEXT NOT NULL DEFAULT ''`);
  }

  const labelSourceCols = new Set(
    (db.prepare(`PRAGMA table_info(ax_label_sources)`).all() as { name: string }[]).map((c) => c.name)
  );
  if (!labelSourceCols.has('label_count')) {
    db.exec(`ALTER TABLE ax_label_sources ADD COLUMN label_count INTEGER NOT NULL DEFAULT 0`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_ax_fields_object_id ON ax_fields(object_id);
    CREATE INDEX IF NOT EXISTS idx_ax_methods_object_id ON ax_methods(object_id);
    CREATE INDEX IF NOT EXISTS idx_ax_enum_values_object_id ON ax_enum_values(object_id);
    CREATE INDEX IF NOT EXISTS idx_ax_datasources_object_id ON ax_datasources(object_id);
    CREATE INDEX IF NOT EXISTS idx_ax_form_controls_object_id ON ax_form_controls(object_id);
    CREATE INDEX IF NOT EXISTS idx_ax_xref_from ON ax_xref(from_type, from_name);
    CREATE INDEX IF NOT EXISTS idx_ax_xref_to ON ax_xref(to_type, to_name);
    CREATE INDEX IF NOT EXISTS idx_ax_labels_source_file ON ax_labels(source_file);
    CREATE INDEX IF NOT EXISTS idx_ax_security_grants_object_id ON ax_security_grants(object_id);
    CREATE INDEX IF NOT EXISTS idx_ax_security_grants_target ON ax_security_grants(target_type, target_name);

    CREATE TABLE IF NOT EXISTS ax_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  createUsageSchema(db);
  createTraceSchema(db);
  createReleasePlanSchema(db);

  return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Keys the indexer records in `ax_meta` so consumers can tell what an index holds. */
export const META_KEYS = {
  builtAt: 'built_at',
  serverVersion: 'server_version',
  /** Basename and a short hash of the packages directory; never the full path. */
  packagesDirBasename: 'packages_dir_basename',
  packagesDirHash: 'packages_dir_sha256',
  storeRawXml: 'store_raw_xml',
  indexDurationMs: 'index_duration_ms',
  schemaVersion: 'schema_version',
} as const;

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(`
    INSERT INTO ax_meta (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString());
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM ax_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export interface ObjectInput {
  type: string;
  name: string;
  package: string;
  model?: string;
  file_path: string;
  raw_xml: string | null;
  file_mtime: number;
}

export interface MethodInput {
  name: string;
  accessModifier?: string;
  returnType?: string;
  params?: AxParam[];
  isStatic?: boolean;
  isAbstract?: boolean;
}

export interface LabelInput {
  labelId: string;
  value: string;
  language?: string;
  sourceFile?: string;
}

export interface XrefInput {
  fromType: string;
  fromName: string;
  toType: string;
  toName: string;
  xrefKind: string;
}

export function upsertObject(db: Database, obj: ObjectInput): number | bigint {
  const stmt = db.prepare(`
    INSERT INTO ax_objects (type, name, package, model, file_path, raw_xml, file_mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, name) DO UPDATE SET
      package = excluded.package,
      model = excluded.model,
      file_path = excluded.file_path,
      raw_xml = excluded.raw_xml,
      file_mtime = excluded.file_mtime
    RETURNING id
  `);
  const result = stmt.get(obj.type, obj.name, obj.package, obj.model || '', obj.file_path, obj.raw_xml, obj.file_mtime) as { id: number | bigint };
  return result.id;
}

export interface ExistingObjectRow {
  id: number | bigint;
  file_mtime: number;
  file_path: string;
}

export interface ExistingLabelSourceRow {
  source_file: string;
  file_mtime: number;
  label_count: number;
}

export interface FieldInput {
  name: string;
  type?: string;
  edt?: string;
  labelId?: string;
  mandatory?: boolean;
  allowEdit?: boolean;
  dataSource?: string;
  dataField?: string;
}

export function upsertFields(db: Database, objectId: number | bigint, fields: FieldInput[]) {
  const deleteStmt = db.prepare(`DELETE FROM ax_fields WHERE object_id = ?`);
  deleteStmt.run(objectId);

  if (!fields || fields.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO ax_fields (object_id, name, type, edt, label_id, mandatory, allow_edit, data_source, data_field)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = transaction(db, (items: FieldInput[]) => {
    for (const item of items) {
      insertStmt.run(
        objectId,
        item.name,
        item.type || '',
        item.edt || '',
        item.labelId || '',
        item.mandatory ? 1 : 0,
        item.allowEdit === false ? 0 : 1,
        item.dataSource || '',
        item.dataField || ''
      );
    }
  });

  insertMany(fields);
}

export interface EnumValueInput {
  name: string;
  value?: number | string;
  labelId?: string;
}

export function upsertEnumValues(db: Database, objectId: number | bigint, values: EnumValueInput[]) {
  db.prepare(`DELETE FROM ax_enum_values WHERE object_id = ?`).run(objectId);
  if (!values || values.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO ax_enum_values (object_id, name, value, label_id) VALUES (?, ?, ?, ?)`
  );
  const insertMany = transaction(db, (items: EnumValueInput[]) => {
    for (const item of items) {
      stmt.run(objectId, item.name, item.value === undefined ? '' : String(item.value), item.labelId || '');
    }
  });
  insertMany(values);
}

export interface DataSourceInput {
  name: string;
  table?: string;
}

export function upsertDataSources(db: Database, objectId: number | bigint, dataSources: DataSourceInput[]) {
  db.prepare(`DELETE FROM ax_datasources WHERE object_id = ?`).run(objectId);
  if (!dataSources || dataSources.length === 0) return;

  const stmt = db.prepare(`INSERT INTO ax_datasources (object_id, name, table_name) VALUES (?, ?, ?)`);
  const insertMany = transaction(db, (items: DataSourceInput[]) => {
    for (const item of items) {
      stmt.run(objectId, item.name, item.table || '');
    }
  });
  insertMany(dataSources);
}

export interface ControlInput {
  name: string;
  type?: string;
  children?: ControlInput[];
}

export function upsertFormControls(db: Database, objectId: number | bigint, controls: ControlInput[]) {
  db.prepare(`DELETE FROM ax_form_controls WHERE object_id = ?`).run(objectId);
  if (!controls || controls.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO ax_form_controls (object_id, name, type, parent_name) VALUES (?, ?, ?, ?)`
  );
  const insertMany = transaction(db, (items: ControlInput[]) => {
    const walk = (list: ControlInput[], parent: string) => {
      for (const c of list) {
        stmt.run(objectId, c.name, c.type || '', parent);
        if (c.children && c.children.length > 0) walk(c.children, c.name);
      }
    };
    walk(items, '');
  });
  insertMany(controls);
}

export function upsertProperties(db: Database, objectId: number | bigint, props: Record<string, unknown>) {
  db.prepare(`DELETE FROM ax_properties WHERE object_id = ?`).run(objectId);
  const entries = Object.entries(props).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return;

  const stmt = db.prepare(
    `INSERT INTO ax_properties (object_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(object_id, key) DO UPDATE SET value = excluded.value`
  );
  const insertMany = transaction(db, (items: [string, unknown][]) => {
    for (const [key, value] of items) {
      stmt.run(objectId, key, String(value));
    }
  });
  insertMany(entries);
}

export function upsertMethods(db: Database, objectId: number | bigint, methods: MethodInput[]) {
  const deleteStmt = db.prepare(`DELETE FROM ax_methods WHERE object_id = ?`);
  deleteStmt.run(objectId);

  if (!methods || methods.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO ax_methods (object_id, name, access_modifier, return_type, params, is_static, is_abstract)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = transaction(db, (items: MethodInput[]) => {
    for (const item of items) {
      insertStmt.run(objectId, item.name, item.accessModifier || 'public', item.returnType || '', JSON.stringify(item.params || []), item.isStatic ? 1 : 0, item.isAbstract ? 1 : 0);
    }
  });

  insertMany(methods);
}

export function upsertLabels(db: Database, labels: LabelInput[], sourceFile: string = '') {
  if (sourceFile) {
    // Drop labels previously sourced from this file so removed entries don't linger.
    db.prepare(`DELETE FROM ax_labels WHERE source_file = ?`).run(sourceFile);
  }
  if (!labels || labels.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO ax_labels (label_id, language, value, source_file)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(label_id, language) DO UPDATE SET
      value = excluded.value,
      source_file = excluded.source_file
  `);

  const insertMany = transaction(db, (items: LabelInput[]) => {
    for (const item of items) {
      insertStmt.run(item.labelId, item.language || 'en-US', item.value, item.sourceFile || sourceFile);
    }
  });

  insertMany(labels);
}

export function getLabelSource(db: Database, sourceFile: string): ExistingLabelSourceRow | undefined {
  return db
    .prepare(`SELECT source_file, file_mtime, label_count FROM ax_label_sources WHERE source_file = ?`)
    .get(sourceFile) as ExistingLabelSourceRow | undefined;
}

export function updateLabelSourceMtime(
  db: Database,
  sourceFile: string,
  fileMtime: number,
  labelCount: number = 0
): void {
  db
    .prepare(
      `INSERT INTO ax_label_sources (source_file, file_mtime, label_count)
       VALUES (?, ?, ?)
       ON CONFLICT(source_file) DO UPDATE SET
         file_mtime = excluded.file_mtime,
         label_count = excluded.label_count`
    )
    .run(sourceFile, fileMtime, labelCount);
}

export function countLabelsFromSource(db: Database, sourceFile: string): number {
  return (db.prepare(`SELECT COUNT(*) as count FROM ax_labels WHERE source_file = ?`).get(sourceFile) as {
    count: number;
  }).count;
}

/**
 * How many of the given already-indexed object file paths were seen by a scan.
 * `existingPaths` must be a snapshot taken *before* the run inserts new rows,
 * otherwise objects created by this run inflate the overlap.
 */
export function countObjectsWithPaths(existingPaths: Iterable<string>, scannedPaths: Set<string>): number {
  let count = 0;
  for (const p of existingPaths) {
    if (scannedPaths.has(p)) count++;
  }
  return count;
}

/** File paths of every currently indexed object, snapshotted before a scan. */
export function listObjectPaths(db: Database): string[] {
  return (db.prepare(`SELECT file_path FROM ax_objects`).all() as { file_path: string }[]).map(
    (row) => row.file_path
  );
}

export interface PruneStats {
  objects: number;
  labels: number;
  xrefs: number;
}

/**
 * Remove objects/labels whose backing files were not seen during an index run,
 * plus any xrefs left dangling by those deletions.
 */
export function prune(db: Database, seenObjectFiles: Set<string>, seenLabelFiles: Set<string>): PruneStats {
  const stale = db
    .prepare(`SELECT id, type, name, file_path FROM ax_objects`)
    .all() as { id: number; type: string; name: string; file_path: string }[];

  const doomed = stale.filter((row) => !seenObjectFiles.has(row.file_path));

  const deleteObject = db.prepare(`DELETE FROM ax_objects WHERE id = ?`);
  const deleteXrefs = db.prepare(`DELETE FROM ax_xref WHERE from_type = ? AND from_name = ?`);
  const run = transaction(db, (rows: typeof doomed) => {
    for (const row of rows) {
      deleteObject.run(row.id);
      deleteXrefs.run(row.type, row.name);
    }
  });
  run(doomed);

  // Labels with an empty source_file predate source tracking; leave them alone.
  const labelRows = db
    .prepare(`SELECT id, source_file FROM ax_labels WHERE source_file <> ''`)
    .all() as { id: number; source_file: string }[];
  const doomedLabels = labelRows.filter((row) => !seenLabelFiles.has(row.source_file));
  const deleteLabel = db.prepare(`DELETE FROM ax_labels WHERE id = ?`);
  const labelSourceRows = db
    .prepare(`SELECT source_file FROM ax_label_sources`)
    .all() as { source_file: string }[];
  const doomedLabelSources = labelSourceRows.filter((row) => !seenLabelFiles.has(row.source_file));
  const deleteLabelSource = db.prepare(`DELETE FROM ax_label_sources WHERE source_file = ?`);
  const runLabels = transaction(db, (rows: typeof doomedLabels) => {
    for (const row of rows) {
      deleteLabel.run(row.id);
    }
    for (const row of doomedLabelSources) deleteLabelSource.run(row.source_file);
  });
  runLabels(doomedLabels);

  // Xrefs pointing at objects that no longer exist stay valid as "unresolved"
  // references, but xrefs *from* deleted objects are meaningless.
  const orphaned = db
    .prepare(
      `DELETE FROM ax_xref WHERE NOT EXISTS (
         SELECT 1 FROM ax_objects o WHERE o.type = ax_xref.from_type AND o.name = ax_xref.from_name
       )`
    )
    .run();

  return { objects: doomed.length, labels: doomedLabels.length, xrefs: Number(orphaned.changes) };
}

export function deleteXrefsFrom(db: Database, fromType: string, fromName: string) {
  db.prepare(`DELETE FROM ax_xref WHERE from_type = ? AND from_name = ?`).run(fromType, fromName);
}

/**
 * Reuses prepared statements across a full indexing pass.
 *
 * Reusing statements keeps large D365 package scans fast and avoids unnecessary
 * native resource churn.
 */
export function createIndexWriter(db: Database) {
  const selectExistingObject = db.prepare(
    `SELECT id, file_mtime, file_path FROM ax_objects WHERE name = ? AND type = ?`
  );
  const selectLabelSource = db.prepare(
    `SELECT source_file, file_mtime, label_count FROM ax_label_sources WHERE source_file = ?`
  );
  const upsertObjectStmt = db.prepare(`
    INSERT INTO ax_objects (type, name, package, model, file_path, raw_xml, file_mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(type, name) DO UPDATE SET
      package = excluded.package,
      model = excluded.model,
      file_path = excluded.file_path,
      raw_xml = excluded.raw_xml,
      file_mtime = excluded.file_mtime
    RETURNING id
  `);
  const updateObjectMtime = db.prepare(`UPDATE ax_objects SET file_mtime = ? WHERE id = ?`);

  const deleteFields = db.prepare(`DELETE FROM ax_fields WHERE object_id = ?`);
  const insertField = db.prepare(`
    INSERT INTO ax_fields (object_id, name, type, edt, label_id, mandatory, allow_edit, data_source, data_field)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFields = (objectId: number | bigint, fields: FieldInput[]) => {
    deleteFields.run(objectId);
    for (const item of fields) {
      insertField.run(
        objectId,
        item.name,
        item.type || '',
        item.edt || '',
        item.labelId || '',
        item.mandatory ? 1 : 0,
        item.allowEdit === false ? 0 : 1,
        item.dataSource || '',
        item.dataField || ''
      );
    }
  };

  const deleteEnumValues = db.prepare(`DELETE FROM ax_enum_values WHERE object_id = ?`);
  const insertEnumValue = db.prepare(
    `INSERT INTO ax_enum_values (object_id, name, value, label_id) VALUES (?, ?, ?, ?)`
  );
  const insertEnumValues = (objectId: number | bigint, values: EnumValueInput[]) => {
    deleteEnumValues.run(objectId);
    for (const item of values) {
      insertEnumValue.run(
        objectId,
        item.name,
        item.value === undefined ? '' : String(item.value),
        item.labelId || ''
      );
    }
  };

  const deleteDataSources = db.prepare(`DELETE FROM ax_datasources WHERE object_id = ?`);
  const insertDataSource = db.prepare(
    `INSERT INTO ax_datasources (object_id, name, table_name) VALUES (?, ?, ?)`
  );
  const insertDataSources = (objectId: number | bigint, dataSources: DataSourceInput[]) => {
    deleteDataSources.run(objectId);
    for (const item of dataSources) {
      insertDataSource.run(objectId, item.name, item.table || '');
    }
  };

  const deleteFormControls = db.prepare(`DELETE FROM ax_form_controls WHERE object_id = ?`);
  const insertFormControl = db.prepare(
    `INSERT INTO ax_form_controls (object_id, name, type, parent_name) VALUES (?, ?, ?, ?)`
  );
  const insertFormControls = (objectId: number | bigint, controls: ControlInput[]) => {
    deleteFormControls.run(objectId);
    const walk = (list: ControlInput[], parent: string) => {
      for (const c of list) {
        insertFormControl.run(objectId, c.name, c.type || '', parent);
        if (c.children && c.children.length > 0) walk(c.children, c.name);
      }
    };
    walk(controls, '');
  };

  const deleteProperties = db.prepare(`DELETE FROM ax_properties WHERE object_id = ?`);
  const insertProperty = db.prepare(`
    INSERT INTO ax_properties (object_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(object_id, key) DO UPDATE SET value = excluded.value
  `);
  const insertProperties = (objectId: number | bigint, props: Record<string, unknown>) => {
    deleteProperties.run(objectId);
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined && value !== null && value !== '') {
        insertProperty.run(objectId, key, String(value));
      }
    }
  };

  const deleteSecurityGrants = db.prepare(`DELETE FROM ax_security_grants WHERE object_id = ?`);
  const insertSecurityGrant = db.prepare(`
    INSERT INTO ax_security_grants (object_id, kind, target_type, target_name, child_name, grants)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertSecurityGrants = (objectId: number | bigint, grants: SecurityGrantInput[]) => {
    deleteSecurityGrants.run(objectId);
    for (const g of grants) {
      insertSecurityGrant.run(objectId, g.kind, g.objectType, g.objectName, g.childName || '', g.grants.join(','));
    }
  };

  const deleteMethods = db.prepare(`DELETE FROM ax_methods WHERE object_id = ?`);
  const insertMethod = db.prepare(`
    INSERT INTO ax_methods (object_id, name, access_modifier, return_type, params, is_static, is_abstract)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMethods = (objectId: number | bigint, methods: MethodInput[]) => {
    deleteMethods.run(objectId);
    for (const item of methods) {
      insertMethod.run(
        objectId,
        item.name,
        item.accessModifier || 'public',
        item.returnType || '',
        JSON.stringify(item.params || []),
        item.isStatic ? 1 : 0,
        item.isAbstract ? 1 : 0
      );
    }
  };

  const deleteLabelsBySource = db.prepare(`DELETE FROM ax_labels WHERE source_file = ?`);
  const insertLabel = db.prepare(`
    INSERT INTO ax_labels (label_id, language, value, source_file)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(label_id, language) DO UPDATE SET
      value = excluded.value,
      source_file = excluded.source_file
  `);
  const insertLabels = (labels: LabelInput[], sourceFile: string) => {
    if (sourceFile) deleteLabelsBySource.run(sourceFile);
    for (const item of labels) {
      insertLabel.run(item.labelId, item.language || 'en-US', item.value, item.sourceFile || sourceFile);
    }
  };
  const upsertLabelSourceMtime = db.prepare(`
    INSERT INTO ax_label_sources (source_file, file_mtime, label_count)
    VALUES (?, ?, ?)
    ON CONFLICT(source_file) DO UPDATE SET
      file_mtime = excluded.file_mtime,
      label_count = excluded.label_count
  `);
  const countLabelsBySource = db.prepare(`SELECT COUNT(*) as count FROM ax_labels WHERE source_file = ?`);

  const deleteXrefsByFrom = db.prepare(`DELETE FROM ax_xref WHERE from_type = ? AND from_name = ?`);
  const insertXref = db.prepare(`
    INSERT INTO ax_xref (from_type, from_name, to_type, to_name, xref_kind)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertXrefs = (xrefs: XrefInput[]) => {
    for (const item of xrefs) {
      insertXref.run(item.fromType, item.fromName, item.toType, item.toName, item.xrefKind);
    }
  };

  return {
    runInTransaction<Result>(fn: () => Result): Result {
      return transaction(db, fn)();
    },
    getExistingObject(name: string, type: string): ExistingObjectRow | undefined {
      return selectExistingObject.get(name, type) as ExistingObjectRow | undefined;
    },
    getLabelSource(sourceFile: string): ExistingLabelSourceRow | undefined {
      return selectLabelSource.get(sourceFile) as ExistingLabelSourceRow | undefined;
    },
    upsertObject(obj: ObjectInput): number | bigint {
      const result = upsertObjectStmt.get(
        obj.type,
        obj.name,
        obj.package,
        obj.model || '',
        obj.file_path,
        obj.raw_xml,
        obj.file_mtime
      ) as { id: number | bigint };
      return result.id;
    },
    updateObjectMtime(fileMtime: number, objectId: number | bigint): void {
      updateObjectMtime.run(fileMtime, objectId);
    },
    upsertFields(objectId: number | bigint, fields: FieldInput[]): void {
      insertFields(objectId, fields || []);
    },
    upsertEnumValues(objectId: number | bigint, values: EnumValueInput[]): void {
      insertEnumValues(objectId, values || []);
    },
    upsertDataSources(objectId: number | bigint, dataSources: DataSourceInput[]): void {
      insertDataSources(objectId, dataSources || []);
    },
    upsertFormControls(objectId: number | bigint, controls: ControlInput[]): void {
      insertFormControls(objectId, controls || []);
    },
    upsertProperties(objectId: number | bigint, props: Record<string, unknown>): void {
      insertProperties(objectId, props);
    },
    upsertMethods(objectId: number | bigint, methods: MethodInput[]): void {
      insertMethods(objectId, methods || []);
    },
    upsertSecurityGrants(objectId: number | bigint, grants: SecurityGrantInput[]): void {
      insertSecurityGrants(objectId, grants || []);
    },
    upsertLabels(labels: LabelInput[], sourceFile: string): void {
      if (!labels || labels.length === 0) {
        if (sourceFile) deleteLabelsBySource.run(sourceFile);
        return;
      }
      insertLabels(labels, sourceFile);
    },
    countLabelsFromSource(sourceFile: string): number {
      return (countLabelsBySource.get(sourceFile) as { count: number }).count;
    },
    updateLabelSourceMtime(sourceFile: string, fileMtime: number, labelCount: number = 0): void {
      upsertLabelSourceMtime.run(sourceFile, fileMtime, labelCount);
    },
    deleteXrefsFrom(fromType: string, fromName: string): void {
      deleteXrefsByFrom.run(fromType, fromName);
    },
    upsertXrefs(xrefs: XrefInput[]): void {
      if (xrefs && xrefs.length > 0) insertXrefs(xrefs);
    },
  };
}

export function rebuildFts(db: Database) {
  db.exec(`
    INSERT INTO ax_fts(ax_fts) VALUES('rebuild');
  `);
}

export function rebuildLabelsFts(db: Database) {
  db.exec(`
    INSERT INTO ax_labels_fts(ax_labels_fts) VALUES('rebuild');
  `);
}

/** Distinct package names currently present in the index. */
export function listPackages(db: Database): { package: string; objectCount: number }[] {
  return db
    .prepare(
      `SELECT package AS "package", COUNT(*) AS objectCount
       FROM ax_objects
       WHERE package <> ''
       GROUP BY package
       ORDER BY package`
    )
    .all() as { package: string; objectCount: number }[];
}

/** Distinct model names currently present in the index. */
export function listModels(db: Database): { model: string; objectCount: number }[] {
  return db
    .prepare(
      `SELECT model AS "model", COUNT(*) AS objectCount
       FROM ax_objects
       WHERE model <> ''
       GROUP BY model
       ORDER BY model`
    )
    .all() as { model: string; objectCount: number }[];
}

/** Resolves a label ID for a specific language. Returns null when absent. */
export function resolveLabelByLanguage(
  db: Database,
  labelId: string,
  language: string
): { label_id: string; language: string; value: string } | null {
  const cleanId = labelId.startsWith('@') ? labelId.substring(1) : labelId;
  const row = db
    .prepare(`SELECT label_id, language, value FROM ax_labels WHERE label_id = ? AND language = ? LIMIT 1`)
    .get(cleanId, language) as { label_id: string; language: string; value: string } | undefined;
  return row ?? null;
}

export interface LabelHit {
  label_id: string;
  language: string;
  value: string;
}

/**
 * Full-text label search backed by `ax_labels_fts`, falling back to a LIKE scan
 * when the FTS table is unavailable or the query has no usable tokens.
 */
export function searchLabelsFts(
  db: Database,
  query: string,
  language?: string,
  limit: number = 20
): LabelHit[] {
  const likeSearch = (): LabelHit[] => {
    let sql = `SELECT label_id, language, value FROM ax_labels WHERE value LIKE ? ESCAPE '\\'`;
    const params: SQLInputValue[] = [likeContains(query)];
    if (language) {
      sql += ` AND language = ?`;
      params.push(language);
    }
    sql += ` LIMIT ?`;
    params.push(limit);
    return db.prepare(sql).all(...params) as unknown as LabelHit[];
  };

  if (!/[A-Za-z0-9]/.test(query)) return likeSearch();

  try {
    const ftsQuery = `"${query.replace(/"/g, '""')}"`;
    let sql = `
      SELECT l.label_id, l.language, l.value
      FROM ax_labels_fts f
      JOIN ax_labels l ON l.id = f.rowid
      WHERE f.ax_labels_fts MATCH ?
    `;
    const params: SQLInputValue[] = [ftsQuery];
    if (language) {
      sql += ` AND l.language = ?`;
      params.push(language);
    }
    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as unknown as LabelHit[];
    return rows.length > 0 ? rows : likeSearch();
  } catch {
    return likeSearch();
  }
}

export interface StaleEntry {
  name: string;
  type: string;
  file_path: string;
  db_mtime: number;
  fs_mtime: number | 'missing';
}

/**
 * Compares indexed `file_mtime` values against the files on disk, reporting
 * objects whose source changed since indexing or whose file is gone.
 *
 * `limit` caps the number of stale entries returned. `maxScan` caps how many
 * rows are examined so a healthy large index does not block the event loop.
 */
export async function getIndexStaleness(
  db: Database,
  limit: number = 100,
  maxScan: number = 1000
): Promise<StaleEntry[]> {
  const rows = db
    .prepare(`SELECT name, type, file_path, file_mtime FROM ax_objects ORDER BY name LIMIT ?`)
    .all(maxScan) as { name: string; type: string; file_path: string; file_mtime: number }[];

  const stale: StaleEntry[] = [];
  for (const row of rows) {
    if (stale.length >= limit) break;
    let fsMtime: number | 'missing';
    try {
      const stat = await fs.promises.stat(row.file_path);
      fsMtime = Math.floor(stat.mtimeMs);
    } catch {
      fsMtime = 'missing';
    }
    if (fsMtime === 'missing' || fsMtime > row.file_mtime) {
      stale.push({
        name: row.name,
        type: row.type,
        file_path: row.file_path,
        db_mtime: row.file_mtime,
        fs_mtime: fsMtime,
      });
    }
  }
  return stale;
}

/** `%value%` for a LIKE pattern with `\\` as the escape character. */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Objects whose name, type or package starts with `query` (a prefix phrase, so
 * `Cust` finds `CustTable`), exact names first. When that finds nothing, falls
 * back to a substring match on the name (`Table` finds `CustTable`).
 */
export function searchSymbols(db: Database, query: string, type?: string, limit: number = 20) {
  // Sanitize query for FTS5: a quoted phrase with internal quotes doubled, as a prefix.
  const ftsQuery = `"${query.replace(/"/g, '""')}"*`;

  // Use a subquery joining FTS results back to ax_objects for reliable type filtering.
  // Direct WHERE on FTS virtual table columns is unreliable with content= tables.
  let sql = `
    SELECT o.name, o.type, o.package, o.id
    FROM ax_fts f
    JOIN ax_objects o ON o.id = f.rowid
    WHERE f.ax_fts MATCH ?
  `;
  const params: SQLInputValue[] = [ftsQuery];

  if (type) {
    sql += ` AND o.type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY o.name = ? COLLATE NOCASE DESC, rank LIMIT ?`;
  params.push(query, limit);

  let rows: unknown[] = [];
  if (/[\p{L}\p{N}]/u.test(query)) {
    try {
      rows = db.prepare(sql).all(...params);
    } catch {
      // FTS5 syntax the phrase quoting does not cover; the LIKE search below still runs.
    }
  }
  if (rows.length > 0) return rows;

  let likeSql = `SELECT name, type, package, id FROM ax_objects WHERE name LIKE ? ESCAPE '\\'`;
  const likeParams: SQLInputValue[] = [likeContains(query)];
  if (type) {
    likeSql += ` AND type = ?`;
    likeParams.push(type);
  }
  likeSql += ` ORDER BY length(name), name LIMIT ?`;
  likeParams.push(limit);
  return db.prepare(likeSql).all(...likeParams);
}

export interface ObjectRow {
  id: number;
  type: string;
  name: string;
  package: string;
  model: string;
  file_path: string;
  raw_xml: string | null;
  file_mtime: number;
}

export interface FieldRow {
  id: number;
  object_id: number;
  name: string;
  type: string | null;
  edt: string | null;
  label_id: string | null;
  mandatory: number;
  allow_edit: number;
  data_source: string;
  data_field: string;
}

export interface MethodRow {
  id: number;
  object_id: number;
  name: string;
  access_modifier: string;
  return_type: string | null;
  params: AxParam[];
  is_static: number;
  is_abstract: number;
}

export interface ObjectDetails extends ObjectRow {
  fields: FieldRow[];
  methods: MethodRow[];
  enumValues: { name: string; value: string | null; label_id: string | null }[];
  dataSources: { name: string; table_name: string | null }[];
  controls: { name: string; type: string | null; parent_name: string | null }[];
  properties: Record<string, string>;
}

export function getObjectByName(db: Database, name: string, type: string): ObjectDetails | null {
  // X++ names are case-insensitive: an exact match wins, otherwise any casing.
  const obj = (db.prepare(`SELECT * FROM ax_objects WHERE name = ? AND type = ?`).get(name, type) ??
    db.prepare(`SELECT * FROM ax_objects WHERE name = ? COLLATE NOCASE AND type = ? ORDER BY name LIMIT 1`).get(name, type)) as
    ObjectRow | undefined;
  if (!obj) return null;

  const fields = db.prepare(`SELECT * FROM ax_fields WHERE object_id = ?`).all(obj.id) as unknown as FieldRow[];
  const methods = db.prepare(`SELECT * FROM ax_methods WHERE object_id = ?`).all(obj.id) as unknown as (Omit<
    MethodRow,
    'params'
  > & { params: string | null })[];
  const enumValues = db
    .prepare(`SELECT name, value, label_id FROM ax_enum_values WHERE object_id = ?`)
    .all(obj.id) as unknown as ObjectDetails['enumValues'];
  const dataSources = db
    .prepare(`SELECT name, table_name FROM ax_datasources WHERE object_id = ?`)
    .all(obj.id) as unknown as ObjectDetails['dataSources'];
  const controls = db
    .prepare(`SELECT name, type, parent_name FROM ax_form_controls WHERE object_id = ?`)
    .all(obj.id) as unknown as ObjectDetails['controls'];
  const propRows = db.prepare(`SELECT key, value FROM ax_properties WHERE object_id = ?`).all(obj.id) as {
    key: string;
    value: string;
  }[];
  const properties: Record<string, string> = {};
  for (const row of propRows) properties[row.key] = row.value;

  return {
    ...obj,
    fields,
    methods: methods.map((m) => ({ ...m, params: JSON.parse(m.params || '[]') as AxParam[] })),
    enumValues,
    dataSources,
    controls,
    properties,
  };
}

export interface SecurityGrantInput {
  kind: string;
  objectType: string;
  objectName: string;
  childName?: string;
  grants: string[];
}

export interface SecurityGrantRow {
  kind: string;
  target_type: string;
  target_name: string;
  child_name: string;
  grants: string;
}

/** Entry-point and data-entity grants of a privilege, in file order. */
export function getSecurityGrants(db: Database, privilegeName: string): SecurityGrantRow[] {
  return db
    .prepare(
      `SELECT g.kind, g.target_type, g.target_name, g.child_name, g.grants
         FROM ax_security_grants g JOIN ax_objects o ON o.id = g.object_id
        WHERE o.type = 'SecurityPrivilege' AND o.name = ?
        ORDER BY g.id`
    )
    .all(privilegeName) as unknown as SecurityGrantRow[];
}

/** Outgoing cross-references of one object, optionally filtered by kind. */
export function getXrefsFrom(db: Database, name: string, type: string, xrefKind?: string): Xref[] {
  let sql = `SELECT * FROM ax_xref WHERE from_name = ? AND from_type = ?`;
  const params: SQLInputValue[] = [name, type];
  if (xrefKind !== undefined) {
    sql += ` AND xref_kind = ?`;
    params.push(xrefKind);
  }
  return db.prepare(sql).all(...params) as unknown as Xref[];
}

export function getXrefsTo(
  db: Database,
  name: string,
  type: string,
  limit?: number,
  xrefKind?: string
): Xref[] {
  let sql = `SELECT * FROM ax_xref WHERE to_name = ? AND to_type = ?`;
  const params: SQLInputValue[] = [name, type];
  if (xrefKind !== undefined) {
    sql += ` AND xref_kind = ?`;
    params.push(xrefKind);
  }
  if (limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }
  return db.prepare(sql).all(...params) as unknown as Xref[];
}

export function getAllObjects(db: Database, type?: string, pkg?: string, offset: number = 0, limit: number = 50) {
  let sql = `SELECT id, type, name, package, model, file_path, file_mtime FROM ax_objects WHERE 1=1`;
  const params: SQLInputValue[] = [];

  if (type) {
    sql += ` AND type = ?`;
    params.push(type);
  }
  if (pkg) {
    sql += ` AND package = ?`;
    params.push(pkg);
  }

  sql += ` LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}
