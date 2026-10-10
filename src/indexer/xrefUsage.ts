import type { Database } from './db.js';

export interface UsageRef {
  sourceType: string;
  sourceName: string;
  sourceMethod?: string;
  targetType?: string;
  targetName: string;
  targetMethod?: string;
  referenceKind: string;
  sourceLine?: number;
  sourceColumn?: number;
  occurrenceCount?: number;
  sourceTable: string;
  raw: Record<string, unknown>;
}

const value = (row: Record<string, unknown>, names: string[]): string => {
  const key = Object.keys(row).find((k) => names.includes(k.toLowerCase()));
  const v = key ? row[key] : '';
  return v === null || v === undefined ? '' : String(v);
};

const numberValue = (row: Record<string, unknown>, names: string[]): number | undefined => {
  const v = value(row, names);
  if (!v || Number.isNaN(Number(v))) return undefined;
  return Number(v);
};

const PATH_TYPES: Record<string, string> = {
  classes: 'Class',
  tables: 'Table',
  tableextensions: 'TableExtension',
  maps: 'Map',
  mapextensions: 'MapExtension',
  views: 'View',
  viewextensions: 'ViewExtension',
  forms: 'Form',
  formextensions: 'FormExtension',
  queries: 'Query',
  queryextensions: 'QueryExtension',
  dataentities: 'DataEntity',
  dataentity: 'DataEntity',
  dataentityviews: 'DataEntity',
  dataentityviewextensions: 'DataEntityExtension',
  enums: 'Enum',
  enumextensions: 'EnumExtension',
  edts: 'Edt',
  extendeddatatypes: 'Edt',
  extendeddatatypeextensions: 'EdtExtension',
  reports: 'Report',
  ssrsreports: 'SSRSReport',
  menus: 'Menu',
  menuitems: 'MenuItem',
  menuitemdisplay: 'MenuItemDisplay',
  menuitemdisplays: 'MenuItemDisplay',
  menuitemoutput: 'MenuItemOutput',
  menuitemoutputs: 'MenuItemOutput',
  menuitemaction: 'MenuItemAction',
  menuitemactions: 'MenuItemAction',
  jobs: 'Job',
  services: 'Service',
  servicegroups: 'ServiceGroup',
  cues: 'Cue',
  cuegroups: 'CueGroup',
  infoparts: 'InfoPart',
  formparts: 'FormPart',
  privileges: 'Privilege',
  duties: 'Duty',
  roles: 'Role',
  securityprivileges: 'SecurityPrivilege',
  securityduties: 'SecurityDuty',
  securityroles: 'SecurityRole',
  policies: 'Policy',
  securitykeys: 'SecurityKey',
  labels: 'Label',
};

// dbo.References.Kind is the compiler CrossReferenceKind enum, not the
// Dynamics.AX.Application.xRefKind metadata enum.
const REFERENCE_KIND_NAMES: Record<string, string> = {
  '0': 'Any',
  '1': 'MethodCall',
  '2': 'TypeReference',
  '3': 'InterfaceImplementation',
  '4': 'ClassExtended',
  '5': 'TestCall',
  '6': 'Property',
  '7': 'Attribute',
  '8': 'TestHelperCall',
  '9': 'Tag',
  '10': 'MethodOverride',
};

function parsePath(path: string): { type: string; name: string; method?: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const typeIndex = parts.findIndex((p) => Object.hasOwn(PATH_TYPES, p.toLowerCase()));
  if (typeIndex === -1 || !parts[typeIndex + 1]) return { type: '', name: path };
  const type = PATH_TYPES[parts[typeIndex].toLowerCase()];
  const name = parts[typeIndex + 1];
  const methodIndex = parts.findIndex((p, index) => index > typeIndex + 1 && /^methods?$/i.test(p));
  return { type, name, method: methodIndex >= 0 ? parts[methodIndex + 1] : undefined };
}

function normalizeReferenceKind(value: string, sourceTable: string): string {
  const normalized = value.trim();
  if (!normalized) return sourceTable;
  const kind = REFERENCE_KIND_NAMES[normalized];
  if (kind) return kind;
  return /^\d+$/.test(normalized) ? `Unknown(${normalized})` : normalized;
}

/** Normalizes one compiler-xref row. Unknown vendor columns are retained in raw. */
export function normalizeUsageRow(
  row: Record<string, unknown>,
  sourceTable: string,
  names: Map<string, string> = new Map()
): UsageRef | null {
  const sourcePath = value(row, ['sourcepath', 'source_name', 'sourcename', 'referencingname']);
  const targetPath = value(row, ['targetpath', 'target_name', 'targetname', 'referencedname', 'referencename']);
  const sourceId = value(row, ['sourceid', 'source_id']);
  const targetId = value(row, ['targetid', 'target_id', 'refid', 'referenceid']);
  const source = parsePath(sourcePath || names.get(sourceId) || '');
  const target = parsePath(targetPath || names.get(targetId) || '');
  const sourceName = source.name || value(row, ['sourcetable', 'sourceclass', 'sourcemethod', 'fromname']);
  const targetName = target.name || value(row, ['reftable', 'refclass', 'refmethod', 'toname']);
  if (!sourceName || !targetName) return null;

  return {
    sourceType: source.type || value(row, ['sourcetype', 'fromtype']) || 'Unknown',
    sourceName,
    sourceMethod: source.method || value(row, ['sourcemethod', 'frommethod']) || undefined,
    targetType: target.type || value(row, ['targettype', 'totype', 'reftype']) || undefined,
    targetName,
    targetMethod: target.method || value(row, ['targetmethod', 'tomethod', 'refmethod']) || undefined,
    referenceKind: normalizeReferenceKind(value(row, ['kind', 'referencekind', 'reftype', 'type']), sourceTable),
    sourceLine: numberValue(row, ['line', 'sourceline']),
    sourceColumn: numberValue(row, ['column', 'sourcecolumn']),
    occurrenceCount: numberValue(row, ['count', 'occurrencecount']),
    sourceTable,
    raw: row,
  };
}

export function createUsageSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ax_usage_refs (
      id INTEGER PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_method TEXT,
      target_type TEXT,
      target_name TEXT NOT NULL,
      target_method TEXT,
      reference_kind TEXT NOT NULL,
      source_line INTEGER,
      source_column INTEGER,
      occurrence_count INTEGER,
      source_table TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ax_usage_source ON ax_usage_refs(source_type, source_name, source_method);
    CREATE INDEX IF NOT EXISTS idx_ax_usage_target_nocase
      ON ax_usage_refs(target_name COLLATE NOCASE, target_type, target_method COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS ax_usage_snapshot (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      run_id TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      source_json TEXT NOT NULL
    );
  `);
  const columns = db.prepare('PRAGMA index_info(idx_ax_usage_target)').all() as { name: string }[];
  if (columns.map((column) => column.name).join(',') !== 'target_name,target_type,target_method') {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS idx_ax_usage_target;
      CREATE INDEX idx_ax_usage_target ON ax_usage_refs(target_name, target_type, target_method);
      COMMIT;
    `);
  }
}

const USAGE_COLUMNS = `source_type, source_name, source_method, target_type, target_name, target_method,
  reference_kind, source_line, source_column, occurrence_count, source_table, raw_json`;

function usageValues(ref: UsageRef): (string | number | null)[] {
  return [
    ref.sourceType, ref.sourceName, ref.sourceMethod ?? null, ref.targetType ?? null,
    ref.targetName, ref.targetMethod ?? null, ref.referenceKind, ref.sourceLine ?? null,
    ref.sourceColumn ?? null, ref.occurrenceCount ?? null, ref.sourceTable, JSON.stringify(ref.raw),
  ];
}

/** TEMP staging is private to this connection; readers keep seeing the last complete snapshot. */
export function stageUsageSnapshot(db: Database): void {
  db.exec(`CREATE TEMP TABLE ax_usage_staging AS SELECT ${USAGE_COLUMNS} FROM ax_usage_refs WHERE 0`);
}

export function stageUsageBatch(db: Database, refs: UsageRef[]): void {
  const insert = db.prepare(`INSERT INTO ax_usage_staging (${USAGE_COLUMNS}) VALUES (${Array(12).fill('?').join(',')})`);
  db.exec('BEGIN');
  try {
    for (const ref of refs) insert.run(...usageValues(ref));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function usageSnapshotVersion(db: Database): string | null {
  const row = db.prepare('SELECT run_id FROM ax_usage_snapshot WHERE singleton = 1').get() as
    { run_id: string } | undefined;
  return row?.run_id ?? null;
}

export function getUsageSnapshotStatus(db: Database): object {
  const snapshot = db.prepare('SELECT run_id, imported_at, row_count, source_json FROM ax_usage_snapshot WHERE singleton = 1')
    .get() as { run_id: string; imported_at: string; row_count: number; source_json: string } | undefined;
  if (!snapshot) {
    const hasLegacyRows = db.prepare('SELECT 1 FROM ax_usage_refs LIMIT 1').get() !== undefined;
    return {
      status: hasLegacyRows ? 'legacy-unverified' : 'not-imported',
      message: hasLegacyRows
        ? 'Usage rows exist, but their source consistency and import time were not recorded. Reimport to establish provenance.'
        : 'No compiler usage snapshot has been imported. Empty usage results do not prove that an object is unused.',
    };
  }
  return {
    status: 'imported', runId: snapshot.run_id, importedAt: snapshot.imported_at,
    rowCount: snapshot.row_count, source: JSON.parse(snapshot.source_json) as object,
    message: 'Static compiler references from the recorded import; freshness relative to subsequent compiler builds is unknown.',
  };
}

export function publishUsageSnapshot(
  db: Database,
  expectedVersion: string | null,
  runId: string,
  count: number,
  source: object
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (usageSnapshotVersion(db) !== expectedVersion) {
      throw new Error('Another import published a snapshot while this import was running. Retry the import.');
    }
    db.exec(`DELETE FROM ax_usage_refs;
      INSERT INTO ax_usage_refs (${USAGE_COLUMNS}) SELECT ${USAGE_COLUMNS} FROM ax_usage_staging`);
    db.prepare(`INSERT INTO ax_usage_snapshot VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET run_id=excluded.run_id, imported_at=excluded.imported_at,
      row_count=excluded.row_count, source_json=excluded.source_json`)
      .run(runId, new Date().toISOString(), count, JSON.stringify(source));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function findUsageRefs(
  db: Database,
  targetName: string,
  targetType?: string,
  targetMethod?: string,
  limit = 100
): UsageRef[] {
  let sql = `SELECT * FROM ax_usage_refs WHERE target_name = ? COLLATE NOCASE`;
  const params: (string | number)[] = [targetName];
  if (targetType) { sql += ' AND target_type = ?'; params.push(targetType); }
  if (targetMethod) { sql += ' AND target_method = ? COLLATE NOCASE'; params.push(targetMethod); }
  sql += ' ORDER BY source_name, source_method LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((row) => ({
    sourceType: String(row.source_type),
    sourceName: String(row.source_name),
    sourceMethod: row.source_method ? String(row.source_method) : undefined,
    targetType: row.target_type ? String(row.target_type) : undefined,
    targetName: String(row.target_name),
    targetMethod: row.target_method ? String(row.target_method) : undefined,
    referenceKind: String(row.reference_kind),
    sourceLine: row.source_line === null ? undefined : Number(row.source_line),
    sourceColumn: row.source_column === null ? undefined : Number(row.source_column),
    occurrenceCount: row.occurrence_count === null ? undefined : Number(row.occurrence_count),
    sourceTable: String(row.source_table),
    raw: JSON.parse(String(row.raw_json)),
  }));
}
