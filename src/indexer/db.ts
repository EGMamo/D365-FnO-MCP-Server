import DatabaseConstructor, { Database } from 'better-sqlite3';

export interface Xref {
  id?: number | bigint;
  from_type: string;
  from_name: string;
  to_type: string;
  to_name: string;
  xref_kind?: string;
}

export function openDb(dbPath: string): Database {
  const db = new DatabaseConstructor(dbPath);
  db.pragma('journal_mode = WAL');

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
      allow_edit INTEGER DEFAULT 1
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
      UNIQUE(label_id, language)
    );

    CREATE TABLE IF NOT EXISTS ax_xref (
      id INTEGER PRIMARY KEY,
      from_type TEXT NOT NULL,
      from_name TEXT NOT NULL,
      to_type TEXT NOT NULL,
      to_name TEXT NOT NULL,
      xref_kind TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS ax_fts
      USING fts5(name, type, package, content=ax_objects, content_rowid=id);
  `);

  return db;
}

export function upsertObject(db: Database, obj: any): number | bigint {
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

export function upsertFields(db: Database, objectId: number | bigint, fields: any[]) {
  const deleteStmt = db.prepare(`DELETE FROM ax_fields WHERE object_id = ?`);
  deleteStmt.run(objectId);

  if (!fields || fields.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO ax_fields (object_id, name, type, edt, label_id, mandatory, allow_edit)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertStmt.run(objectId, item.name, item.type || '', item.edt || '', item.labelId || '', item.mandatory ? 1 : 0, item.allowEdit === false ? 0 : 1);
    }
  });

  insertMany(fields);
}

export function upsertMethods(db: Database, objectId: number | bigint, methods: any[]) {
  const deleteStmt = db.prepare(`DELETE FROM ax_methods WHERE object_id = ?`);
  deleteStmt.run(objectId);

  if (!methods || methods.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO ax_methods (object_id, name, access_modifier, return_type, params, is_static, is_abstract)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertStmt.run(objectId, item.name, item.accessModifier || 'public', item.returnType || '', JSON.stringify(item.params || []), item.isStatic ? 1 : 0, item.isAbstract ? 1 : 0);
    }
  });

  insertMany(methods);
}

export function upsertLabels(db: Database, labels: any[]) {
  if (!labels || labels.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO ax_labels (label_id, language, value)
    VALUES (?, ?, ?)
    ON CONFLICT(label_id, language) DO UPDATE SET
      value = excluded.value
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertStmt.run(item.labelId, item.language || 'en-US', item.value);
    }
  });

  insertMany(labels);
}

export function upsertXref(db: Database, xrefs: any[]) {
  if (!xrefs || xrefs.length === 0) return;

  const insertStmt = db.prepare(`
    INSERT INTO ax_xref (from_type, from_name, to_type, to_name, xref_kind)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insertStmt.run(item.fromType, item.fromName, item.toType, item.toName, item.xrefKind);
    }
  });

  insertMany(xrefs);
}

export function rebuildFts(db: Database) {
  db.exec(`
    INSERT INTO ax_fts(ax_fts) VALUES('rebuild');
  `);
}

export function searchSymbols(db: Database, query: string, type?: string, limit: number = 20) {
  // Sanitize query for FTS5: wrap in quotes to treat as phrase, escape internal quotes
  const ftsQuery = `"${query.replace(/"/g, '""')}"`;

  // Use a subquery joining FTS results back to ax_objects for reliable type filtering.
  // Direct WHERE on FTS virtual table columns is unreliable with content= tables.
  let sql = `
    SELECT o.name, o.type, o.package, o.id
    FROM ax_fts f
    JOIN ax_objects o ON o.id = f.rowid
    WHERE f.ax_fts MATCH ?
  `;
  const params: unknown[] = [ftsQuery];

  if (type) {
    sql += ` AND o.type = ?`;
    params.push(type);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

export function getObjectByName(db: Database, name: string, type: string) {
  const obj = db.prepare(`SELECT * FROM ax_objects WHERE name = ? AND type = ?`).get(name, type) as any;
  if (!obj) return null;

  const fields = db.prepare(`SELECT * FROM ax_fields WHERE object_id = ?`).all(obj.id);
  const methods = db.prepare(`SELECT * FROM ax_methods WHERE object_id = ?`).all(obj.id);

  return { ...obj, fields, methods: methods.map((m: any) => ({ ...m, params: JSON.parse(m.params) })) };
}

export function getXrefsTo(db: Database, name: string, type: string): Xref[] {
  return db.prepare(`SELECT * FROM ax_xref WHERE to_name = ? AND to_type = ?`).all(name, type) as Xref[];
}

export function getXrefsFrom(db: Database, name: string, type: string): Xref[] {
  return db.prepare(`SELECT * FROM ax_xref WHERE from_name = ? AND from_type = ?`).all(name, type) as Xref[];
}

export function getAllObjects(db: Database, type?: string, pkg?: string, offset: number = 0, limit: number = 50) {
  let sql = `SELECT id, type, name, package, model, file_path, file_mtime FROM ax_objects WHERE 1=1`;
  const params: any[] = [];

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
