import type { Database } from '../../src/indexer/db.js';
import type { UsageRef } from '../../src/indexer/xrefUsage.js';

/**
 * Writes usage rows directly, without a snapshot record, the way indexes built
 * before atomic xref imports stored them.
 */
export function seedLegacyUsageRefs(db: Database, refs: UsageRef[]): void {
  const insert = db.prepare(`
    INSERT INTO ax_usage_refs
    (source_type, source_name, source_method, target_type, target_name, target_method,
     reference_kind, source_line, source_column, occurrence_count, source_table, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const ref of refs) {
    insert.run(ref.sourceType, ref.sourceName, ref.sourceMethod ?? null, ref.targetType ?? null, ref.targetName,
      ref.targetMethod ?? null, ref.referenceKind, ref.sourceLine ?? null, ref.sourceColumn ?? null,
      ref.occurrenceCount ?? null, ref.sourceTable, JSON.stringify(ref.raw));
  }
}
