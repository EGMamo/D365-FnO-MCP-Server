import { Database } from 'better-sqlite3';
import { scanPackagesDir } from './scanner.js';
import * as dbUtils from './db.js';
import * as parser from './parser.js';
import fs from 'fs/promises';

export interface IndexStats {
  total: number;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export async function buildIndex(db: Database, packagesDir: string, force: boolean = false): Promise<IndexStats> {
  const startTime = Date.now();
  const stats: IndexStats = { total: 0, added: 0, updated: 0, skipped: 0, errors: 0, durationMs: 0 };

  console.log(`[D365-MCP] ${new Date().toISOString()} INFO Starting indexing in ${packagesDir}`);

  for await (const file of scanPackagesDir(packagesDir)) {
    stats.total++;
    
    if (stats.total % 500 === 0) {
      console.log(`[D365-MCP] ${new Date().toISOString()} INFO Indexed ${stats.total} files...`);
    }

    try {
      const existing = db.prepare(`SELECT id, file_mtime FROM ax_objects WHERE name = ? AND type = ?`).get(file.name, file.type) as any;

      if (!force && existing && existing.file_mtime >= file.mtime) {
        stats.skipped++;
        continue;
      }

      const content = await fs.readFile(file.filePath, 'utf-8');

      if (file.type === 'Label') {
        const labels = parser.parseLabels(content);
        dbUtils.upsertLabels(db, labels.map(l => ({ ...l, language: file.name.split('_')[1] || 'en-US' })));
        stats.updated++;
        continue;
      }

      const objectId = dbUtils.upsertObject(db, {
        type: file.type,
        name: file.name,
        package: file.package,
        model: file.model,
        file_path: file.filePath,
        raw_xml: content,
        file_mtime: file.mtime
      });

      if (!existing) stats.added++;
      else stats.updated++;

      let parsed: any;
      const xrefs: any[] = [];

      switch (file.type) {
        case 'Table':
          parsed = parser.parseAxTable(content, file.name, file.package);
          dbUtils.upsertFields(db, objectId, parsed.fields);
          dbUtils.upsertMethods(db, objectId, parsed.methods);
          if (parsed.extends) {
            xrefs.push({ fromType: 'Table', fromName: file.name, toType: 'Table', toName: parsed.extends, xrefKind: 'extends' });
          }
          break;
        case 'Class':
          parsed = parser.parseAxClass(content, file.name, file.package);
          dbUtils.upsertMethods(db, objectId, parsed.methods);
          if (parsed.extends) {
            xrefs.push({ fromType: 'Class', fromName: file.name, toType: 'Class', toName: parsed.extends, xrefKind: 'extends' });
          }
          break;
      }
      
      if (xrefs.length > 0) {
        dbUtils.upsertXref(db, xrefs);
      }

    } catch (err) {
      stats.errors++;
      console.error(`[D365-MCP] ${new Date().toISOString()} ERROR Failed to index ${file.filePath}:`, err);
    }
  }

  console.log(`[D365-MCP] ${new Date().toISOString()} INFO Rebuilding FTS index...`);
  dbUtils.rebuildFts(db);

  stats.durationMs = Date.now() - startTime;
  console.log(`[D365-MCP] ${new Date().toISOString()} INFO Indexing complete. Added: ${stats.added}, Updated: ${stats.updated}, Skipped: ${stats.skipped}, Errors: ${stats.errors} in ${stats.durationMs}ms`);
  
  return stats;
}

export function getIndexStats(db: Database) {
  const totalObjects = (db.prepare(`SELECT COUNT(*) as count FROM ax_objects`).get() as any).count;
  const totalLabels = (db.prepare(`SELECT COUNT(*) as count FROM ax_labels`).get() as any).count;
  
  const typesRows = db.prepare(`SELECT type, COUNT(*) as count FROM ax_objects GROUP BY type`).all() as any[];
  const byType: Record<string, number> = {};
  for (const row of typesRows) {
    byType[row.type] = row.count;
  }

  return { totalObjects, byType, totalLabels, lastIndexed: new Date().toISOString() };
}
