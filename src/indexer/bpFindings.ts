import { XMLParser } from 'fast-xml-parser';
import { likeContains, type Database } from './db.js';

/**
 * Imported compiler best-practice diagnostics (xppbp.exe `-xmlLog` output, as produced by
 * Visual Studio builds or d365fo.tools `Invoke-D365BestPractice`/`New-D365CAReport`).
 * Stored as a snapshot with provenance; the live server never runs xppbp itself.
 */
export interface BpDiagnostic {
  model: string;
  severity: string;
  moniker: string;
  diagnosticType: string;
  path: string;
  elementType: string;
  elementName: string;
  method: string;
  line: number | null;
  column: number | null;
  message: string;
  sourceFile: string;
}

export function createBpSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ax_bp_findings (
      id INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      severity TEXT NOT NULL,
      moniker TEXT NOT NULL,
      diagnostic_type TEXT NOT NULL,
      path TEXT NOT NULL,
      element_type TEXT NOT NULL,
      element_name TEXT NOT NULL,
      method TEXT NOT NULL,
      line INTEGER,
      col INTEGER,
      message TEXT NOT NULL,
      source_file TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ax_bp_element ON ax_bp_findings(element_name COLLATE NOCASE, element_type);
    CREATE INDEX IF NOT EXISTS idx_ax_bp_moniker ON ax_bp_findings(moniker COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS ax_bp_snapshot (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      imported_at TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      files_json TEXT NOT NULL
    );
  `);
}

const TYPE_FROM_PATH: Record<string, string> = {
  class: 'Class', classes: 'Class', table: 'Table', tables: 'Table', form: 'Form', forms: 'Form',
  query: 'Query', queries: 'Query', dataentity: 'DataEntity', dataentityview: 'DataEntity', view: 'View',
  enum: 'Enum', edt: 'Edt', map: 'Map', securityrole: 'SecurityRole', securityduty: 'SecurityDuty',
  securityprivilege: 'SecurityPrivilege', menuitemdisplay: 'MenuItemDisplay', menuitemaction: 'MenuItemAction',
  menuitemoutput: 'MenuItemOutput', tableextension: 'TableExtension', formextension: 'FormExtension',
};

/** Splits `dynamics://Table/CustTable/Method/validateWrite` into element type, name and method. */
export function parseBpPath(path: string): { elementType: string; elementName: string; method: string } {
  const parts = path.replace(/^dynamics:\/\//i, '').split(/[\\/]/).filter(Boolean);
  const rawType = parts[0] ?? '';
  const elementType = TYPE_FROM_PATH[rawType.toLowerCase()] ?? rawType;
  const methodIdx = parts.findIndex((p, i) => i >= 2 && /^methods?$/i.test(p));
  return { elementType, elementName: parts[1] ?? '', method: methodIdx >= 0 ? parts[methodIdx + 1] ?? '' : '' };
}

type XmlNode = Record<string, unknown>;

function child(node: XmlNode, names: string[]): string {
  const key = Object.keys(node).find((k) => names.includes(k.replace(/^@_/, '').toLowerCase()));
  const v = key ? node[key] : undefined;
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return String((v as XmlNode)['#text'] ?? '');
  return String(v);
}

function num(v: string): number | null {
  return v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
}

/** Model name from `Dynamics.AX.<Model>.xppbp.xml`, else the file's base name. */
export function modelFromFileName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  const m = /^Dynamics\.AX\.(.+?)\.xppbp\.xml$/i.exec(base);
  return m ? m[1] : base.replace(/\.xml$/i, '');
}

/** Parses any xppbp XML log: every `Diagnostic` element, with case-insensitive child names or attributes. */
export function parseBpLog(xml: string, sourceFile: string, model?: string): BpDiagnostic[] {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, removeNSPrefix: true });
  const root = parser.parse(xml) as XmlNode;
  const out: BpDiagnostic[] = [];
  const modelName = model ?? modelFromFileName(sourceFile);
  const visit = (node: unknown, key: string) => {
    if (Array.isArray(node)) { node.forEach((n) => visit(n, key)); return; }
    if (!node || typeof node !== 'object') return;
    const obj = node as XmlNode;
    if (/^diagnostic$/i.test(key)) {
      const path = child(obj, ['path', 'elementpath']);
      const moniker = child(obj, ['moniker', 'rule', 'id']);
      const message = child(obj, ['message', 'text']);
      if (path || moniker || message) {
        const parsed = parseBpPath(path);
        out.push({
          model: modelName,
          severity: child(obj, ['severity', 'level']) || 'Unknown',
          moniker: moniker || 'Unknown',
          diagnosticType: child(obj, ['diagnostictype', 'type', 'category']),
          path,
          ...parsed,
          line: num(child(obj, ['line', 'startline'])),
          column: num(child(obj, ['column', 'startcolumn', 'col'])),
          message,
          sourceFile,
        });
        return;
      }
    }
    for (const [k, v] of Object.entries(obj)) if (!k.startsWith('@_') && k !== '#text') visit(v, k);
  };
  visit(root, '');
  return out;
}

/** Replaces the imported findings with this set (one transaction). */
export function publishBpFindings(db: Database, rows: BpDiagnostic[], files: string[]): void {
  createBpSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM ax_bp_findings');
    const insert = db.prepare(`INSERT INTO ax_bp_findings
      (model, severity, moniker, diagnostic_type, path, element_type, element_name, method, line, col, message, source_file)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      insert.run(r.model, r.severity, r.moniker, r.diagnosticType, r.path, r.elementType, r.elementName,
        r.method, r.line, r.column, r.message, r.sourceFile);
    }
    db.prepare(`INSERT INTO ax_bp_snapshot VALUES (1, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET imported_at=excluded.imported_at, row_count=excluded.row_count, files_json=excluded.files_json`)
      .run(new Date().toISOString(), rows.length, JSON.stringify(files));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface BpSnapshotStatus {
  status: 'imported' | 'not-imported';
  importedAt?: string;
  rowCount?: number;
  files?: string[];
  message: string;
}

export function bpSnapshotStatus(db: Database): BpSnapshotStatus {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='ax_bp_snapshot'`).get();
  const row = exists
    ? db.prepare('SELECT imported_at, row_count, files_json FROM ax_bp_snapshot WHERE singleton = 1').get() as
      { imported_at: string; row_count: number; files_json: string } | undefined
    : undefined;
  if (!row) {
    return {
      status: 'not-imported',
      message: 'No compiler best-practice log has been imported. Run `d365-fno-mcp-server index-bp <Dynamics.AX.<Model>.xppbp.xml>` after a build with best-practice checks.',
    };
  }
  return {
    status: 'imported', importedAt: row.imported_at, rowCount: row.row_count, files: JSON.parse(row.files_json) as string[],
    message: 'Compiler best-practice diagnostics from the recorded import; they reflect the code as of that build.',
  };
}

export interface BpQuery {
  element?: string;
  elementType?: string;
  moniker?: string;
  severity?: string;
  model?: string;
  limit?: number;
}

export function queryBpFindings(db: Database, q: BpQuery) {
  let where = '1=1';
  const params: (string | number)[] = [];
  if (q.element) { where += ' AND element_name = ? COLLATE NOCASE'; params.push(q.element); }
  if (q.elementType) { where += ' AND element_type = ? COLLATE NOCASE'; params.push(q.elementType); }
  if (q.moniker) { where += " AND moniker LIKE ? ESCAPE '\\'"; params.push(likeContains(q.moniker)); }
  if (q.severity) { where += ' AND severity = ? COLLATE NOCASE'; params.push(q.severity); }
  if (q.model) { where += ' AND model = ? COLLATE NOCASE'; params.push(q.model); }
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ax_bp_findings WHERE ${where}`).get(...params) as { n: number }).n;
  const bySeverity = db.prepare(`SELECT severity, COUNT(*) AS count FROM ax_bp_findings WHERE ${where} GROUP BY severity ORDER BY count DESC`).all(...params);
  const byMoniker = db.prepare(`SELECT moniker, severity, COUNT(*) AS count FROM ax_bp_findings WHERE ${where}
    GROUP BY moniker, severity ORDER BY count DESC LIMIT 20`).all(...params);
  const byElement = db.prepare(`SELECT element_type AS elementType, element_name AS elementName, COUNT(*) AS count FROM ax_bp_findings
    WHERE ${where} GROUP BY element_type, element_name ORDER BY count DESC LIMIT 20`).all(...params);
  const limit = q.limit ?? (total <= 100 ? 100 : 20);
  const findings = db.prepare(`SELECT model, severity, moniker, diagnostic_type AS diagnosticType, element_type AS elementType,
      element_name AS elementName, method, line, col AS column, message, path FROM ax_bp_findings WHERE ${where}
      ORDER BY CASE lower(severity) WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, element_name, method, line LIMIT ?`)
    .all(...params, limit);
  return { total, returned: findings.length, bySeverity, byMoniker, byElement, findings };
}
