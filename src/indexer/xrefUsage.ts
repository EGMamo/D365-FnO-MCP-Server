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

function parsePath(path: string): { type: string; name: string; method?: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const typeIndex = parts.findIndex((p) => /^(classes|tables|forms|queries|dataentities|enums|edts)$/i.test(p));
  if (typeIndex === -1 || !parts[typeIndex + 1]) return { type: '', name: path };
  const rawType = parts[typeIndex].toLowerCase();
  const type = rawType === 'classes' ? 'Class' : rawType === 'tables' ? 'Table' :
    rawType === 'forms' ? 'Form' : rawType === 'queries' ? 'Query' :
    rawType === 'dataentities' ? 'DataEntity' : rawType === 'enums' ? 'Enum' :
    rawType === 'edts' ? 'Edt' : '';
  const name = parts[typeIndex + 1];
  const methodIndex = parts.findIndex((p) => /^methods?$/i.test(p));
  return { type, name, method: methodIndex >= 0 ? parts[methodIndex + 1] : undefined };
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
    referenceKind: value(row, ['kind', 'referencekind', 'reftype', 'type']) || sourceTable,
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
    DROP INDEX IF EXISTS idx_ax_usage_target;
    CREATE INDEX idx_ax_usage_target ON ax_usage_refs(target_name, target_type, target_method);
    CREATE INDEX IF NOT EXISTS idx_ax_usage_source ON ax_usage_refs(source_type, source_name, source_method);
  `);
}

export function replaceUsageRefs(db: Database, refs: UsageRef[]): void {
  createUsageSchema(db);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM ax_usage_refs');
    const stmt = db.prepare(`
      INSERT INTO ax_usage_refs
      (source_type, source_name, source_method, target_type, target_name, target_method,
       reference_kind, source_line, source_column, occurrence_count, source_table, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ref of refs) {
      stmt.run(ref.sourceType, ref.sourceName, ref.sourceMethod ?? null, ref.targetType ?? null, ref.targetName,
        ref.targetMethod ?? null, ref.referenceKind, ref.sourceLine ?? null, ref.sourceColumn ?? null,
        ref.occurrenceCount ?? null, ref.sourceTable, JSON.stringify(ref.raw));
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

}

export function clearUsageRefs(db: Database): void {
  db.exec('DELETE FROM ax_usage_refs');
}

export function insertUsageRefs(db: Database, refs: UsageRef[]): void {
  if (refs.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO ax_usage_refs
    (source_type, source_name, source_method, target_type, target_name, target_method,
     reference_kind, source_line, source_column, occurrence_count, source_table, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.exec('BEGIN');
  try {
    for (const ref of refs) {
      stmt.run(ref.sourceType, ref.sourceName, ref.sourceMethod ?? null, ref.targetType ?? null, ref.targetName,
        ref.targetMethod ?? null, ref.referenceKind, ref.sourceLine ?? null, ref.sourceColumn ?? null,
        ref.occurrenceCount ?? null, ref.sourceTable, JSON.stringify(ref.raw));
    }
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
  let sql = `SELECT * FROM ax_usage_refs WHERE target_name = ?`;
  const params: (string | number)[] = [targetName];
  if (targetType) { sql += ' AND target_type = ?'; params.push(targetType); }
  if (targetMethod) { sql += ' AND target_method = ?'; params.push(targetMethod); }
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
