import fs from 'node:fs';
import { findKnowledgeDir } from '../tools/knowledge.js';
import { digestKnowledge, type DigestReport } from '../knowledge/digest.js';
import type { Database } from '../indexer/db.js';

export interface DigestCommandOptions {
  file?: string;
  slug?: string;
  dryRun?: boolean;
  force?: boolean;
  kbDir?: string;
  dbPath?: string;
}

function printReport(report: DigestReport): void {
  console.log(`\nTitle: ${report.title}`);
  console.log(`Slug : ${report.slug}`);
  console.log(`Path : ${report.filePath}`);

  if (report.issues.length === 0) {
    console.log('\nNo structural or sanitization issues found.');
  } else {
    console.log('\nIssues:');
    for (const issue of report.issues) {
      console.log(`  [${issue.level.toUpperCase()}] ${issue.message}`);
    }
  }

  if (report.duplicates.length > 0) {
    console.log('\nLexical wording overlap (near-identical phrasing only):');
    for (const dup of report.duplicates) {
      console.log(`  ${(dup.score * 100).toFixed(0)}%  ${dup.slug} — ${dup.title}`);
    }
  }

  if (report.existingTopics.length > 0) {
    console.log(
      '\nExisting topics — review these yourself for CONCEPTUAL duplication (same pattern, different words; the score above will not catch this):'
    );
    for (const topic of report.existingTopics) {
      console.log(`  ${topic.slug} — ${topic.title}`);
      console.log(`      ${topic.summary}`);
    }
  }

  const unverified = report.feasibility.filter((f) => f.status === 'unverified');
  if (unverified.length > 0) {
    console.log('\nIdentifiers not found in the indexed metadata (verify, or replace with a placeholder):');
    for (const f of unverified) console.log(`  - ${f.identifier}`);
  }

  console.log(report.written ? `\n✅ Written to ${report.filePath}` : '\n⛔ Not written.');
}

/**
 * Reads `--file`, validates it as a knowledge base article (structure, sanitization,
 * duplicate detection, identifier feasibility against the index DB), and writes it into
 * the knowledge base resources folder when it passes.
 */
export async function digestCommand(
  options: DigestCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  if (!options.file) {
    console.error(
      'Usage: d365-fno-mcp-server digest --file <path-to-draft.md> [--slug <slug>] [--dry-run] [--force] [--kb-dir <dir>] [--db-path <path>]'
    );
    return 1;
  }
  if (!fs.existsSync(options.file)) {
    console.error(`File not found: ${options.file}`);
    return 1;
  }
  if (!fs.statSync(options.file).isFile()) {
    console.error(`Not a file: ${options.file}`);
    return 1;
  }

  const content = fs.readFileSync(options.file, 'utf8');
  const kbDir = options.kbDir ?? findKnowledgeDir();
  if (!kbDir) {
    console.error(
      'Could not locate the d365-fno-assistant-knowledge/resources directory. Pass --kb-dir explicitly.'
    );
    return 1;
  }

  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH;
  let db: Database | null = null;
  if (dbPath && fs.existsSync(dbPath)) {
    const { openDb } = await import('../indexer/db.js');
    db = openDb(dbPath);
  }

  try {
    const report = digestKnowledge({
      content,
      kbDir,
      db,
      slugOverride: options.slug,
      dryRun: options.dryRun,
      force: options.force,
    });
    printReport(report);

    if (report.written) return 0;
    if (options.dryRun) return report.issues.some((i) => i.level === 'error') ? 1 : 0;
    return 1;
  } finally {
    db?.close();
  }
}
