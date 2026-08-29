import { Database } from 'better-sqlite3';
import { scanPackagesDir } from './scanner.js';
import * as dbUtils from './db.js';
import * as parser from './parser.js';
import fs from 'fs/promises';
import { logger } from '../utils/logger.js';

/** Above this share of failed parses the scan is treated as untrustworthy and pruning is skipped. */
const MAX_PRUNE_ERROR_RATIO = 0.5;

/** Minimum share of the already-indexed objects a scan must overlap before pruning is allowed. */
const MIN_SCANNED_OBJECT_RATIO = 0.5;

export interface IndexStats {
  total: number;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  deleted: number;
  collisions: number;
  durationMs: number;
}

export async function buildIndex(db: Database, packagesDir: string, force: boolean = false): Promise<IndexStats> {
  const startTime = Date.now();
  const stats: IndexStats = {
    total: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    deleted: 0,
    collisions: 0,
    durationMs: 0,
  };

  logger.info('Starting indexing', { packagesDir });

  const seenObjectFiles = new Set<string>();
  const seenLabelFiles = new Set<string>();
  // (type|name) -> file path of the object that won the key during this run.
  const seenKeys = new Map<string, string>();

  // Captured before the scan so the prune magnitude guard compares against the
  // objects indexed by *previous* runs only. Counting after the loop would
  // include rows added by this run, inflating the denominator.
  const preScanObjectPaths = dbUtils.listObjectPaths(db);
  const preScanObjectCount = preScanObjectPaths.length;

  for await (const file of scanPackagesDir(packagesDir)) {
    stats.total++;
    
    if (stats.total % 500 === 0) {
      logger.info('Indexing progress', { files: stats.total });
    }

    if (file.type === 'Label') {
      seenLabelFiles.add(file.filePath);
    } else {
      seenObjectFiles.add(file.filePath);

      const key = `${file.type}|${file.name}`;
      const winner = seenKeys.get(key);
      if (winner !== undefined) {
        stats.collisions++;
        logger.warn(`Collision: ${file.type} ${file.name} defined in both ${winner} and ${file.filePath}`, {
          type: file.type,
          name: file.name,
          keptPath: winner,
          ignoredPath: file.filePath,
        });
        continue;
      }
      seenKeys.set(key, file.filePath);
    }

    try {
      const existing = db.prepare(`SELECT id, file_mtime, file_path FROM ax_objects WHERE name = ? AND type = ?`).get(file.name, file.type) as any;

      // A path change (rename/move) must always be re-indexed, even when the
      // mtime suggests the content is unchanged.
      const samePath = existing?.file_path === file.filePath;
      if (!force && existing && samePath && existing.file_mtime >= file.mtime) {
        stats.skipped++;
        continue;
      }

      const content = await fs.readFile(file.filePath, 'utf-8');

      if (file.type === 'Label') {
        const labels = parser.parseLabels(content);
        dbUtils.upsertLabels(
          db,
          labels.map(l => ({ ...l, language: file.name.split('_')[1] || 'en-US' })),
          file.filePath
        );
        stats.updated++;
        continue;
      }

      // Keep the previous mtime until parsing succeeds, so a failed parse does not
      // permanently poison the incremental index by marking the object as up to date.
      const objectId = dbUtils.upsertObject(db, {
        type: file.type,
        name: file.name,
        package: file.package,
        model: file.model,
        file_path: file.filePath,
        raw_xml: content,
        file_mtime: existing?.file_mtime ?? 0
      });

      let parsed: any;
      const xrefs: any[] = [];

      switch (file.type) {
        case 'Table': {
          parsed = parser.parseAxTable(content, file.name, file.package);
          dbUtils.upsertFields(db, objectId, parsed.fields);
          dbUtils.upsertMethods(db, objectId, parsed.methods);
          dbUtils.upsertProperties(db, objectId, {
            label: parsed.label,
            extends: parsed.extends,
            saveDataPerCompany: parsed.saveDataPerCompany,
            indexes: parsed.indexes.join(','),
          });
          if (parsed.extends) {
            xrefs.push({ fromType: 'Table', fromName: file.name, toType: 'Table', toName: parsed.extends, xrefKind: 'extends' });
          }
          for (const f of parsed.fields) {
            if (f.edt) {
              xrefs.push({ fromType: 'Table', fromName: file.name, toType: 'Edt', toName: f.edt, xrefKind: 'uses' });
            }
          }
          break;
        }
        case 'Class': {
          parsed = parser.parseAxClass(content, file.name, file.package);
          dbUtils.upsertMethods(db, objectId, parsed.methods);
          dbUtils.upsertProperties(db, objectId, {
            extends: parsed.extends,
            implements: parsed.implements.join(','),
            isAbstract: parsed.isAbstract,
            isFinal: parsed.isFinal,
          });
          if (parsed.extends) {
            xrefs.push({ fromType: 'Class', fromName: file.name, toType: 'Class', toName: parsed.extends, xrefKind: 'extends' });
          }
          for (const iface of parsed.implements) {
            xrefs.push({ fromType: 'Class', fromName: file.name, toType: 'Class', toName: iface, xrefKind: 'implements' });
          }
          break;
        }
        case 'Enum': {
          parsed = parser.parseAxEnum(content, file.name, file.package);
          dbUtils.upsertEnumValues(db, objectId, parsed.values);
          dbUtils.upsertProperties(db, objectId, { label: parsed.label, isExtensible: parsed.isExtensible });
          break;
        }
        case 'Form': {
          parsed = parser.parseAxForm(content, file.name, file.package);
          dbUtils.upsertDataSources(db, objectId, parsed.dataSources);
          dbUtils.upsertFormControls(db, objectId, parsed.controls);
          dbUtils.upsertProperties(db, objectId, {
            pattern: parsed.pattern,
            patternVersion: parsed.patternVersion,
            caption: parsed.caption,
          });
          for (const ds of parsed.dataSources) {
            if (ds.table) {
              xrefs.push({ fromType: 'Form', fromName: file.name, toType: 'Table', toName: ds.table, xrefKind: 'datasource' });
            }
          }
          break;
        }
        case 'Query': {
          parsed = parser.parseAxQuery(content, file.name, file.package);
          dbUtils.upsertDataSources(db, objectId, parsed.dataSources);
          dbUtils.upsertProperties(db, objectId, { title: parsed.title });
          for (const ds of parsed.dataSources) {
            if (ds.table) {
              xrefs.push({ fromType: 'Query', fromName: file.name, toType: 'Table', toName: ds.table, xrefKind: 'datasource' });
            }
          }
          break;
        }
        case 'DataEntity': {
          parsed = parser.parseAxDataEntity(content, file.name, file.package);
          dbUtils.upsertFields(db, objectId, parsed.fields);
          dbUtils.upsertDataSources(db, objectId, parsed.dataSources);
          dbUtils.upsertProperties(db, objectId, {
            publicEntityName: parsed.publicEntityName,
            publicCollectionName: parsed.publicCollectionName,
            stagingTable: parsed.stagingTable,
            primaryKey: parsed.primaryKey,
            isPublic: parsed.isPublic,
          });
          for (const ds of parsed.dataSources) {
            if (ds.table) {
              xrefs.push({ fromType: 'DataEntity', fromName: file.name, toType: 'Table', toName: ds.table, xrefKind: 'datasource' });
            }
          }
          break;
        }
        case 'Edt': {
          parsed = parser.parseAxEdt(content, file.name, file.package);
          dbUtils.upsertProperties(db, objectId, {
            extends: parsed.extends,
            label: parsed.labelId,
            helpText: parsed.helpText,
            stringSize: parsed.stringSize,
            edtType: parsed.edtType,
          });
          if (parsed.extends) {
            xrefs.push({ fromType: 'Edt', fromName: file.name, toType: 'Edt', toName: parsed.extends, xrefKind: 'extends' });
          }
          break;
        }
      }
      
      dbUtils.deleteXrefsFrom(db, file.type, file.name);
      if (xrefs.length > 0) {
        dbUtils.upsertXref(db, xrefs);
      }

      db.prepare(`UPDATE ax_objects SET file_mtime = ? WHERE id = ?`).run(file.mtime, objectId);

      if (!existing) stats.added++;
      else stats.updated++;

    } catch (err) {
      stats.errors++;
      logger.error('Failed to index file', { filePath: file.filePath, message: String(err) });
    }
  }

  // Pruning deletes every indexed row whose file was not seen during this scan.
  // That is only safe when the scan itself was trustworthy: an empty, mostly
  // failing, or partially available packages directory usually means a bad or
  // half-mounted source tree, not real deletions.
  const errorRatio = stats.total > 0 ? stats.errors / stats.total : 0;
  // Overlap, not raw scan size: a disjoint tree of similar size must not be
  // treated as covering the existing index.
  const overlapCount = dbUtils.countObjectsWithPaths(preScanObjectPaths, seenObjectFiles);
  const bypassMagnitudeGuard = process.env.D365_BYPASS_PRUNE_GUARD === '1';
  if (stats.total === 0) {
    logger.warn('Skipping prune: no files were scanned', { packagesDir });
  } else if (errorRatio > MAX_PRUNE_ERROR_RATIO) {
    logger.warn('Skipping prune: too many files failed to parse', {
      packagesDir,
      total: stats.total,
      errors: stats.errors,
      errorRatio,
    });
  } else if (
    !bypassMagnitudeGuard &&
    preScanObjectCount > 0 &&
    overlapCount < preScanObjectCount * MIN_SCANNED_OBJECT_RATIO
  ) {
    logger.warn(
      `Pruning skipped: only ${overlapCount} of ${preScanObjectCount} existing objects overlap with scanned paths (below ${MIN_SCANNED_OBJECT_RATIO * 100}% threshold)`,
      { packagesDir, overlapCount, preScanObjectCount, minRatio: MIN_SCANNED_OBJECT_RATIO }
    );
  } else {
    const pruned = dbUtils.prune(db, seenObjectFiles, seenLabelFiles);
    stats.deleted = pruned.objects;
    if (pruned.objects > 0 || pruned.labels > 0 || pruned.xrefs > 0) {
      logger.info('Pruned stale index entries', { ...pruned });
    }
  }

  logger.info('Rebuilding FTS index');
  dbUtils.rebuildFts(db);
  dbUtils.rebuildLabelsFts(db);

  stats.durationMs = Date.now() - startTime;
  logger.info('Indexing complete', { ...stats });

  const summary = getIndexStats(db);
  const byType = Object.entries(summary.byType)
    .map(([t, c]) => `${t}=${c}`)
    .join(', ');
  logger.info('Index summary', {
    totalObjects: summary.totalObjects,
    byType: byType || 'none',
    totalLabels: summary.totalLabels,
  });

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
