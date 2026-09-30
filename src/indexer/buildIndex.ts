import type { Database } from './db.js';
import { parseLabelFileName, scanPackagesDir } from './scanner.js';
import * as dbUtils from './db.js';
import * as parser from './parser.js';
import { getUsageSnapshotStatus } from './xrefUsage.js';
import { extensionBaseName } from '../security/model.js';
import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { VERSION } from '../version.js';

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

export function shouldStoreRawXml(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.D365_INDEX_STORE_RAW_XML;
  if (value === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/** Labels of one `.label.txt` file, with the language and ids its file name implies. */
function readLabelFile(filePath: string, content: string): dbUtils.LabelInput[] {
  const { labelFileId, language } = parseLabelFileName(filePath);
  return parser.parseLabels(content, labelFileId).map((l) => ({ ...l, language }));
}

/**
 * Two label files may declare the same (label_id, language), and only one of
 * them owns the row. When the owner is deleted or stops declaring a label, the
 * row goes although another file still declares it. This re-reads every source
 * that contributes fewer labels than it parsed and adds the labels that no
 * source provides now, leaving rows another source owns alone. Returns the
 * number of sources that added labels.
 */
async function recoverUnderContributingLabelSources(
  writer: ReturnType<typeof dbUtils.createIndexWriter>,
  seenLabelFiles: Set<string>
): Promise<number> {
  let recovered = 0;
  for (const filePath of seenLabelFiles) {
    const source = writer.getLabelSource(filePath);
    if (!source || source.label_count === 0) continue;
    if (writer.countLabelsFromSource(filePath) >= source.label_count) continue;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const labels = readLabelFile(filePath, content);
      const added = writer.runInTransaction(() => {
        const count = writer.fillMissingLabels(labels, filePath);
        writer.updateLabelSourceMtime(filePath, source.file_mtime, labels.length);
        return count;
      });
      if (added > 0) recovered++;
    } catch (err) {
      // Clear the tracked mtime so the next run cannot skip this file. Without
      // this, a transient read/parse failure here would leave the source
      // permanently under-contributing: the mtime skip in the main loop would
      // keep passing it over.
      try {
        writer.updateLabelSourceMtime(filePath, 0, source.label_count);
      } catch {
        // Best effort only; the warning below is still the actionable signal.
      }
      logger.warn('Failed to re-apply label source after prune; will retry next run', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return recovered;
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

  const writer = dbUtils.createIndexWriter(db);
  const seenObjectFiles = new Set<string>();
  const seenLabelFiles = new Set<string>();
  // (type|name) -> file path of the object that won the key during this run.
  const seenKeys = new Map<string, string>();
  const storeRawXml = shouldStoreRawXml();
  // A run that stopped before its FTS rebuild left rows the search tables do not know about.
  const ftsPending = dbUtils.getMeta(db, dbUtils.META_KEYS.ftsPending) === '1';
  let objectFtsDirty = force || ftsPending;
  let labelFtsDirty = force || ftsPending;
  dbUtils.setMeta(db, dbUtils.META_KEYS.ftsPending, '1');
  let labelsChanged = false;

  // Captured before the scan so the prune magnitude guard compares against the
  // objects indexed by *previous* runs only. Counting after the loop would
  // include rows added by this run, inflating the denominator.
  const preScanObjectPaths = dbUtils.listObjectPaths(db);
  const preScanObjectCount = preScanObjectPaths.length;

  // Older indexes keyed labels differently; drop them so every label file is read again.
  const builtSchema = Number(dbUtils.getMeta(db, dbUtils.META_KEYS.schemaVersion) ?? 0);
  if (builtSchema < dbUtils.LABEL_IDS_SCHEMA_VERSION) {
    const hadLabels = db.prepare(`SELECT 1 FROM ax_labels LIMIT 1`).get() !== undefined;
    db.exec('DELETE FROM ax_labels; DELETE FROM ax_label_sources;');
    if (hadLabels) {
      labelFtsDirty = true;
      logger.info('Re-reading all label files: the index was built by an older version', { schemaVersion: builtSchema });
    }
  }

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
      const existing = file.type === 'Label'
        ? undefined
        : writer.getExistingObject(file.name, file.type);

      if (file.type === 'Label') {
        // Mirrors the object mtime skip. Cases where another source currently
        // owns some of this file's labels are repaired by the recovery pass
        // after the scan instead of by re-reading the file on every run.
        const existingLabelSource = writer.getLabelSource(file.filePath);
        if (!force && existingLabelSource && existingLabelSource.file_mtime === file.mtime) {
          stats.skipped++;
          continue;
        }

        const content = await fs.readFile(file.filePath, 'utf-8');
        const labels = readLabelFile(file.filePath, content);
        writer.runInTransaction(() => {
          writer.upsertLabels(labels, file.filePath);
          writer.updateLabelSourceMtime(file.filePath, file.mtime, labels.length);
        });
        stats.updated++;
        labelsChanged = true;
        labelFtsDirty = true;
        continue;
      }

      // A path change (rename/move) must always be re-indexed, even when the
      // mtime suggests the content is unchanged. Any mtime change counts, not
      // only a newer one: restoring an older copy keeps that copy's time.
      const samePath = existing?.file_path === file.filePath;
      if (!force && existing && samePath && existing.file_mtime === file.mtime) {
        stats.skipped++;
        continue;
      }

      const content = await fs.readFile(file.filePath, 'utf-8');

      // Keep the previous mtime until parsing succeeds, so a failed parse does not
      // permanently poison the incremental index by marking the object as up to date.
      const xrefs: dbUtils.XrefInput[] = [];

      writer.runInTransaction(() => {
        const objectId = writer.upsertObject({
          type: file.type,
          name: file.name,
          package: file.package,
          model: file.model,
          file_path: file.filePath,
          raw_xml: storeRawXml ? content : null,
          file_mtime: existing?.file_mtime ?? 0
        });

        switch (file.type) {
          case 'Table': {
            const parsed = parser.parseAxTable(content, file.name, file.package);
            writer.upsertFields(objectId, parsed.fields);
            writer.upsertMethods(objectId, parsed.methods);
            writer.upsertProperties(objectId, {
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
            const parsed = parser.parseAxClass(content, file.name, file.package);
            writer.upsertMethods(objectId, parsed.methods);
            writer.upsertProperties(objectId, {
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
            const parsed = parser.parseAxEnum(content, file.name, file.package);
            writer.upsertEnumValues(objectId, parsed.values);
            writer.upsertProperties(objectId, { label: parsed.label, isExtensible: parsed.isExtensible });
            break;
          }
          case 'Form': {
            const parsed = parser.parseAxForm(content, file.name, file.package);
            writer.upsertDataSources(objectId, parsed.dataSources);
            writer.upsertFormControls(objectId, parsed.controls);
            writer.upsertProperties(objectId, {
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
            const parsed = parser.parseAxQuery(content, file.name, file.package);
            writer.upsertDataSources(objectId, parsed.dataSources);
            writer.upsertProperties(objectId, { title: parsed.title });
            for (const ds of parsed.dataSources) {
              if (ds.table) {
                xrefs.push({ fromType: 'Query', fromName: file.name, toType: 'Table', toName: ds.table, xrefKind: 'datasource' });
              }
            }
            break;
          }
          case 'DataEntity': {
            const parsed = parser.parseAxDataEntity(content, file.name, file.package);
            writer.upsertFields(objectId, parsed.fields);
            writer.upsertDataSources(objectId, parsed.dataSources);
            writer.upsertProperties(objectId, {
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
            const parsed = parser.parseAxEdt(content, file.name, file.package);
            writer.upsertProperties(objectId, {
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
          case 'SecurityRole':
          case 'SecurityRoleExtension': {
            const parsed = parser.parseAxSecurityRole(content, file.name, file.package);
            writer.upsertProperties(objectId, { label: parsed.label, description: parsed.description });
            const from = { fromType: file.type, fromName: file.name };
            for (const duty of parsed.duties) {
              xrefs.push({ ...from, toType: 'SecurityDuty', toName: duty, xrefKind: 'role_duty' });
            }
            for (const priv of parsed.privileges) {
              xrefs.push({ ...from, toType: 'SecurityPrivilege', toName: priv, xrefKind: 'role_privilege' });
            }
            for (const role of parsed.subRoles) {
              xrefs.push({ ...from, toType: 'SecurityRole', toName: role, xrefKind: 'subrole' });
            }
            if (file.type === 'SecurityRoleExtension') {
              xrefs.push({ ...from, toType: 'SecurityRole', toName: extensionBaseName(file.name), xrefKind: 'extends' });
            }
            break;
          }
          case 'SecurityDuty':
          case 'SecurityDutyExtension': {
            const parsed = parser.parseAxSecurityDuty(content, file.name, file.package);
            writer.upsertProperties(objectId, { label: parsed.label, description: parsed.description });
            for (const priv of parsed.privileges) {
              xrefs.push({ fromType: file.type, fromName: file.name, toType: 'SecurityPrivilege', toName: priv, xrefKind: 'duty_privilege' });
            }
            if (file.type === 'SecurityDutyExtension') {
              xrefs.push({ fromType: file.type, fromName: file.name, toType: 'SecurityDuty', toName: extensionBaseName(file.name), xrefKind: 'extends' });
            }
            break;
          }
          case 'SecurityPrivilege': {
            const parsed = parser.parseAxSecurityPrivilege(content, file.name, file.package);
            writer.upsertProperties(objectId, { label: parsed.label, description: parsed.description });
            writer.upsertSecurityGrants(objectId, parsed.grants);
            for (const g of parsed.grants) {
              xrefs.push({
                fromType: 'SecurityPrivilege',
                fromName: file.name,
                toType: g.objectType,
                toName: g.objectName,
                xrefKind: g.kind === 'dataentity' ? 'entity_permission' : 'entrypoint',
              });
            }
            break;
          }
          case 'MenuItemDisplay':
          case 'MenuItemAction':
          case 'MenuItemOutput': {
            const parsed = parser.parseAxMenuItem(content, file.type, file.name);
            writer.upsertProperties(objectId, {
              label: parsed.label,
              object: parsed.object,
              objectType: parsed.objectType,
              configurationKey: parsed.configurationKey,
              linkedPermissionObject: parsed.linkedPermissionObject,
            });
            if (parsed.object) {
              xrefs.push({ fromType: file.type, fromName: file.name, toType: parsed.objectType, toName: parsed.object, xrefKind: 'menuitem_target' });
            }
            break;
          }
        }

        writer.deleteXrefsFrom(file.type, file.name);
        writer.upsertXrefs(xrefs);

        writer.updateObjectMtime(file.mtime, objectId);
      });

      if (!existing) stats.added++;
      else stats.updated++;
      objectFtsDirty = true;

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
    if (pruned.objects > 0) objectFtsDirty = true;
    if (pruned.labels > 0) labelFtsDirty = true;
    if (pruned.objects > 0 || pruned.labels > 0 || pruned.xrefs > 0) {
      logger.info('Pruned stale index entries', { ...pruned });
    }
    if (pruned.labels > 0) labelsChanged = true;
  }

  // Deleting or re-reading a label file can drop a row another file still declares.
  if (labelsChanged) {
    const recovered = await recoverUnderContributingLabelSources(writer, seenLabelFiles);
    if (recovered > 0) {
      stats.updated += recovered;
      labelFtsDirty = true;
      logger.info('Re-applied duplicate labels from other label files', { sources: recovered });
    }
  }

  if (objectFtsDirty || labelFtsDirty) {
    logger.info('Rebuilding FTS index', { objects: objectFtsDirty, labels: labelFtsDirty });
    if (objectFtsDirty) dbUtils.rebuildFts(db);
    if (labelFtsDirty) dbUtils.rebuildLabelsFts(db);
  } else {
    logger.info('Skipping FTS rebuild; no indexed content changed');
  }
  dbUtils.setMeta(db, dbUtils.META_KEYS.ftsPending, '0');

  stats.durationMs = Date.now() - startTime;
  recordBuildMeta(db, packagesDir, storeRawXml, stats.durationMs);
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

/**
 * Records what this run produced so a copy of the index (for example one
 * published to a hosted server) can report its own provenance. The packages
 * directory is stored as a basename plus a short hash: the full path names the
 * build user's profile folder and every reader of the index can see meta.
 */
function recordBuildMeta(db: Database, packagesDir: string, storeRawXml: boolean, durationMs: number): void {
  const resolved = path.resolve(packagesDir);
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  db.exec('BEGIN');
  try {
    dbUtils.setMeta(db, dbUtils.META_KEYS.builtAt, new Date().toISOString());
    dbUtils.setMeta(db, dbUtils.META_KEYS.serverVersion, VERSION);
    dbUtils.setMeta(db, dbUtils.META_KEYS.packagesDirBasename, path.basename(resolved));
    dbUtils.setMeta(db, dbUtils.META_KEYS.packagesDirHash, hash);
    dbUtils.setMeta(db, dbUtils.META_KEYS.storeRawXml, storeRawXml ? '1' : '0');
    dbUtils.setMeta(db, dbUtils.META_KEYS.indexDurationMs, String(durationMs));
    dbUtils.setMeta(db, dbUtils.META_KEYS.schemaVersion, String(dbUtils.INDEX_SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface IndexStatsSummary {
  totalObjects: number;
  byType: Record<string, number>;
  totalLabels: number;
  /** When `buildIndex` last completed on this database, or null if never recorded. */
  builtAt: string | null;
  /** Alias of `builtAt`, kept for callers that read the previous field name. */
  lastIndexed: string | null;
  serverVersion: string | null;
  storeRawXml: boolean | null;
  usageSnapshot: { status: string; importedAt: string | null; rowCount: number | null };
}

export function getIndexStats(db: Database): IndexStatsSummary {
  const totalObjects = (db.prepare(`SELECT COUNT(*) as count FROM ax_objects`).get() as { count: number }).count;
  const totalLabels = (db.prepare(`SELECT COUNT(*) as count FROM ax_labels`).get() as { count: number }).count;

  const typesRows = db.prepare(`SELECT type, COUNT(*) as count FROM ax_objects GROUP BY type`).all() as { type: string; count: number }[];
  const byType: Record<string, number> = {};
  for (const row of typesRows) {
    byType[row.type] = row.count;
  }

  const builtAt = dbUtils.getMeta(db, dbUtils.META_KEYS.builtAt);
  const storeRawXml = dbUtils.getMeta(db, dbUtils.META_KEYS.storeRawXml);
  const usage = getUsageSnapshotStatus(db) as { status: string; importedAt?: string; rowCount?: number };

  return {
    totalObjects,
    byType,
    totalLabels,
    builtAt,
    lastIndexed: builtAt,
    serverVersion: dbUtils.getMeta(db, dbUtils.META_KEYS.serverVersion),
    storeRawXml: storeRawXml === null ? null : storeRawXml === '1',
    usageSnapshot: {
      status: usage.status,
      importedAt: usage.importedAt ?? null,
      rowCount: usage.rowCount ?? null,
    },
  };
}
