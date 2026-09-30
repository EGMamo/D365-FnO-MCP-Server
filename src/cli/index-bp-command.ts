import fs from 'node:fs/promises';
import path from 'node:path';
import { openDb } from '../indexer/db.js';
import { parseBpLog, publishBpFindings, type BpDiagnostic } from '../indexer/bpFindings.js';

export interface IndexBpOptions {
  files: string[];
  model?: string;
  dbPath?: string;
  allowEmpty?: boolean;
}

/** Imports xppbp best-practice XML logs, replacing any previous import. */
export async function indexBpCommand(options: IndexBpOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (options.files.length === 0) {
    console.error('Pass one or more best-practice logs, e.g. index-bp Dynamics.AX.MyModel.xppbp.xml');
    return 1;
  }
  const rows: BpDiagnostic[] = [];
  const files: string[] = [];
  try {
    for (const file of options.files) {
      const xml = await fs.readFile(file, 'utf-8');
      const diagnostics = parseBpLog(xml, path.basename(file), options.model);
      console.log(`${path.basename(file)}: ${diagnostics.length} diagnostics`);
      rows.push(...diagnostics);
      files.push(path.basename(file));
    }
  } catch (err) {
    console.error(`Failed to read best-practice log: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (rows.length === 0 && !options.allowEmpty) {
    console.error('No Diagnostic elements found; the previous import was kept. Use --allow-empty to clear it.');
    return 1;
  }
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const db = openDb(path.resolve(dbPath));
  try {
    publishBpFindings(db, rows, files);
  } finally {
    db.close();
  }
  const bySeverity = new Map<string, number>();
  for (const r of rows) bySeverity.set(r.severity, (bySeverity.get(r.severity) ?? 0) + 1);
  console.log(`Imported ${rows.length} best-practice findings (${[...bySeverity].map(([s, n]) => `${s}: ${n}`).join(', ') || 'none'}) into ${dbPath}.`);
  return 0;
}
