import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { META_KEYS, type Database } from '../indexer/db.js';
import type { StandardIndexStatus } from './types.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

/**
 * Added to every id read from the custom index, so custom rows never collide with standard ones and a
 * child row still joins its own object. 2^40 leaves room for any standard index and stays an exact integer.
 */
export const CUSTOM_ID_OFFSET = 2 ** 40;

const STANDARD = 'std';
const CUSTOM = 'cus';

/** A custom object hides the standard object of the same type and name (an overlayered object), with its child rows. */
const shadowedObject = (alias: string) =>
  `EXISTS (SELECT 1 FROM ${STANDARD}.ax_objects so JOIN ${CUSTOM}.ax_objects co ON co.type = so.type AND co.name = so.name WHERE so.id = ${alias}.object_id)`;

interface LayerSpec {
  /** Columns that hold an id of the same index and get the custom offset. */
  ids: readonly string[];
  /** Condition on the standard row `s` that the custom index replaces; null keeps every standard row. */
  hidden: string | null;
}

/** Child tables of ax_objects: their own id and the object id are both offset. */
const CHILD: LayerSpec = { ids: ['id', 'object_id'], hidden: shadowedObject('s') };

/**
 * The tables the read-only tools join, and how the two layers combine in each. The full-text tables are not
 * layered: the tools that search them (search_symbols, search_labels_fts) are merge tools and read each layer apart.
 */
const LAYERS: Readonly<Record<string, LayerSpec>> = {
  ax_objects: {
    ids: ['id'],
    hidden: `EXISTS (SELECT 1 FROM ${CUSTOM}.ax_objects c WHERE c.type = s.type AND c.name = s.name)`,
  },
  ax_fields: CHILD,
  ax_methods: CHILD,
  ax_enum_values: CHILD,
  ax_datasources: CHILD,
  ax_form_controls: CHILD,
  ax_properties: CHILD,
  ax_security_grants: CHILD,
  ax_labels: {
    ids: ['id'],
    hidden: `EXISTS (SELECT 1 FROM ${CUSTOM}.ax_labels c WHERE c.label_id = s.label_id AND c.language = s.language)`,
  },
  ax_label_sources: { ids: [], hidden: null },
  ax_xref: {
    ids: ['id'],
    hidden: `EXISTS (SELECT 1 FROM ${CUSTOM}.ax_objects c WHERE c.type = s.from_type AND c.name = s.from_name)`,
  },
};

/** Names of the layered views; everything else the tools read comes from the standard index alone. */
export const LAYERED_TABLES: readonly string[] = Object.keys(LAYERS);

export interface LayeredIndex {
  /** Read-only connection whose ax_* names see the standard and custom indexes as one. */
  readonly db: Database;
  status(): StandardIndexStatus;
  close(): void;
}

/** A SQLite URI for a database file, opened read-only. */
export function readOnlyFileUri(file: string): string {
  return `${pathToFileURL(path.resolve(file)).href}?mode=ro`;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function columnsOf(db: Database, schema: string, table: string): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all() as { name: string }[]).map((c) => c.name);
}

/** The view of one table: standard rows the custom index does not replace, then the custom rows with offset ids. */
function layeredView(db: Database, table: string, spec: LayerSpec): string {
  const columns = columnsOf(db, STANDARD, table);
  if (columns.length === 0) throw new Error(`The standard index has no ${table} table; build it with this version's index command`);
  // An index built by an older version can lack a column the other one has; the missing side reads NULL.
  const custom = new Set(columnsOf(db, CUSTOM, table));
  const customColumns = columns.map((column) => {
    if (!custom.has(column)) return `NULL AS ${quote(column)}`;
    return spec.ids.includes(column) ? `c.${quote(column)} + ${CUSTOM_ID_OFFSET} AS ${quote(column)}` : `c.${quote(column)}`;
  });
  const standardRows = `SELECT ${columns.map((column) => `s.${quote(column)}`).join(', ')} FROM ${STANDARD}.${quote(table)} s`;
  const customRows = custom.size === 0 ? '' : ` UNION ALL SELECT ${customColumns.join(', ')} FROM ${CUSTOM}.${quote(table)} c`;
  return `CREATE TEMP VIEW ${quote(table)} AS ${standardRows}${spec.hidden ? ` WHERE NOT (${spec.hidden})` : ''}${customRows}`;
}

function readMeta(db: Database, key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM ${STANDARD}.ax_meta WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens the standard index read-only and lays the custom index over it. The connection has no file of its
 * own: the views live in its temp schema, which SQLite searches before the attached indexes, and the custom
 * index is read through `customUri` while the gateway's own connection keeps writing to it. Nothing is ever
 * written to either index through this connection.
 */
export function openLayeredIndex(standardDbPath: string, customUri: string): LayeredIndex {
  const file = path.resolve(standardDbPath);
  if (!fs.statSync(file).isFile()) throw new Error('The standard index path is not a file');

  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA temp_store = MEMORY');
    // An in-memory custom index is shared through SQLite's shared cache; reading without table locks keeps a
    // tool call from failing with SQLITE_LOCKED while the custom index refreshes (calls wait for that anyway).
    db.exec('PRAGMA read_uncommitted = 1');
    db.prepare(`ATTACH DATABASE ? AS ${STANDARD}`).run(readOnlyFileUri(file));
    db.prepare(`ATTACH DATABASE ? AS ${CUSTOM}`).run(customUri);
    db.exec(`PRAGMA ${STANDARD}.cache_size = -65536`);
    db.exec(`PRAGMA ${STANDARD}.mmap_size = 268435456`);
    for (const [table, spec] of Object.entries(LAYERS)) db.exec(layeredView(db, table, spec));
  } catch (err) {
    db.close();
    throw err;
  }

  const objects = (db.prepare(`SELECT COUNT(*) AS count FROM ${STANDARD}.ax_objects`).get() as { count: number }).count;
  const meta = {
    builtAt: readMeta(db, META_KEYS.builtAt),
    appVersion: readMeta(db, META_KEYS.appVersion),
    schemaVersion: readMeta(db, META_KEYS.schemaVersion),
  };

  return {
    db,
    // The file name only: the folder can name the developer's machine layout.
    status: () => ({ fileName: path.basename(file), objects, ...meta }),
    close() {
      if (db.isOpen) db.close();
    },
  };
}
