import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../indexer/db.js';
import { listKnowledgeEntries } from '../tools/knowledge.js';

export type IssueLevel = 'error' | 'warning';

export interface DigestIssue {
  level: IssueLevel;
  message: string;
}

export interface DuplicateMatch {
  slug: string;
  title: string;
  /**
   * Jaccard similarity of the token sets, 0..1. This is a *lexical* wording-overlap signal only —
   * it catches near-identical rewrites but NOT the same underlying pattern described in different
   * words. Use `existingTopics` to judge that kind of conceptual duplication.
   */
  score: number;
}

export interface ExistingTopicSummary {
  slug: string;
  title: string;
  /** First paragraph of "When to use this" (or the article opener when that section is absent). */
  summary: string;
}

export interface FeasibilityFinding {
  identifier: string;
  status: 'verified' | 'unverified';
  type?: string;
  package?: string;
}

export interface DigestReport {
  slug: string;
  title: string;
  filePath: string;
  written: boolean;
  issues: DigestIssue[];
  duplicates: DuplicateMatch[];
  feasibility: FeasibilityFinding[];
  /**
   * Title + one-line scenario summary of every existing topic. Wording can differ completely
   * while covering the same underlying knowledge, so conceptual duplication must be judged by
   * reading these summaries (a human, or the assistant that already has the draft in context) —
   * `duplicates` alone will miss it.
   */
  existingTopics: ExistingTopicSummary[];
}

export interface DigestOptions {
  /** Full markdown content of the draft article. */
  content: string;
  /** Knowledge base `resources/` directory to validate against and write into. */
  kbDir: string;
  /** Optional open index DB, used to cross-check identifiers mentioned in the article. */
  db?: Database | null;
  /** Optional filename slug override (kebab-case, no number prefix). Defaults to a slugified title. */
  slugOverride?: string;
  /** Validate only; never write the file. */
  dryRun?: boolean;
  /**
   * Write even when a near-duplicate match is found (score at/above the near-duplicate
   * threshold). Missing required sections/title and sensitive-content findings always block
   * the write, regardless of this flag.
   */
  force?: boolean;
  /** Jaccard similarity at/above which an existing topic is reported as a possible duplicate. */
  duplicateThreshold?: number;
}

const REQUIRED_SECTIONS = ['Pattern'];
const RECOMMENDED_SECTIONS = ['When to use this', 'Gotchas', 'Related'];
const NEAR_DUPLICATE_SCORE = 0.8;
const DEFAULT_DUPLICATE_THRESHOLD = 0.35;

/**
 * Blanks out lines inside fenced code blocks (``` ... ```) so heading-detection regexes don't
 * mistake a `## comment` inside a shell/code sample for a real markdown section heading. Line
 * count and non-fence content are preserved.
 */
function stripCodeFences(content: string): string {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

export function extractTitle(content: string): string | null {
  for (const line of stripCodeFences(content).split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return null;
}

/** Returns the body of the first `## <heading>` section whose title includes `headingIncludes`. */
function extractSection(content: string, headingIncludes: string): string | null {
  const lines = stripCodeFences(content).split(/\r?\n/);
  let capturing = false;
  const buf: string[] = [];
  for (const line of lines) {
    const match = /^##\s+(.+)$/.exec(line.trim());
    if (match) {
      if (capturing) break;
      if (match[1].toLowerCase().includes(headingIncludes)) capturing = true;
      continue;
    }
    if (capturing) buf.push(line);
  }
  return capturing ? buf.join('\n').trim() : null;
}

/** One-line scenario summary: the "When to use this" section, or the opening paragraph. */
export function extractSummary(content: string): string {
  const section = extractSection(content, 'when to use this');
  const source = section ?? content.replace(/^#\s+.+$/m, '').trim();
  const firstParagraph = source.split(/\r?\n\s*\r?\n/)[0] ?? source;
  return firstParagraph.trim().replace(/\s+/g, ' ').slice(0, 220);
}

function extractSectionTitles(content: string): string[] {
  const titles: string[] = [];
  for (const line of stripCodeFences(content).split(/\r?\n/)) {
    const match = /^##\s+(.+)$/.exec(line.trim());
    if (match) titles.push(match[1].trim());
  }
  return titles;
}

/** Checks the article has the expected shape: a title plus required/recommended sections. */
export function validateStructure(content: string): DigestIssue[] {
  const issues: DigestIssue[] = [];

  if (!extractTitle(content)) {
    issues.push({ level: 'error', message: 'Missing a top-level "# Title" heading.' });
  }

  const sections = extractSectionTitles(content).map((s) => s.toLowerCase());
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.some((s) => s.includes(required.toLowerCase()))) {
      issues.push({ level: 'error', message: `Missing required "## ${required}" section.` });
    }
  }
  for (const recommended of RECOMMENDED_SECTIONS) {
    if (!sections.some((s) => s.includes(recommended.toLowerCase()))) {
      issues.push({ level: 'warning', message: `Missing recommended "## ${recommended}" section.` });
    }
  }

  if (content.trim().length < 200) {
    issues.push({ level: 'warning', message: 'Article body is very short (<200 chars) — consider adding more detail.' });
  }

  return issues;
}

interface SensitivePattern {
  label: string;
  regex: RegExp;
  level: IssueLevel;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { label: 'email address', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, level: 'error' },
  {
    // IPv4-shaped strings are common false positives (D365 version numbers like "10.0.39.0" match
    // this pattern just as well as a real internal IP), so this is advisory only, not blocking.
    label: 'IPv4 address (or version number)',
    regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    level: 'warning',
  },
  {
    label: 'connection string secret',
    regex: /(password|pwd|accountkey|client[_-]?secret)\s*[:=]\s*[^;\s<][^;\n]{2,}/i,
    level: 'error',
  },
  {
    label: 'API key / bearer token',
    regex: /(api[_-]?key|apikey|authorization|bearer)\s*[:=]\s*(?!<)['"]?[A-Za-z0-9\-_.]{16,}/i,
    level: 'error',
  },
  {
    label: 'GUID-shaped tenant/subscription/client id',
    regex: /(tenant|subscription|client)[ _-]?id\s*[:=]\s*[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}/i,
    level: 'error',
  },
  { label: 'AWS-style access key', regex: /\bAKIA[0-9A-Z]{16}\b/, level: 'error' },
];

/** Flags obvious un-sanitized secrets/PII, plus a heuristic for un-placeholder-ed company prefixes. */
export function scanSensitiveContent(content: string): DigestIssue[] {
  const issues: DigestIssue[] = [];

  for (const { label, regex, level } of SENSITIVE_PATTERNS) {
    const match = regex.exec(content);
    if (match) {
      issues.push({
        level,
        message: `Possible unsanitized ${label} found near: "${match[0].slice(0, 60)}"`,
      });
    }
  }

  // Heuristic: an all-caps 2-5 letter run immediately followed by capitalized word(s)
  // (e.g. "ABCSalesTable") looks like a company prefix + standard object name.
  const withoutPlaceholders = content.replace(/<[^>\n]{1,40}>/g, ' ');
  const prefixPattern = /\b[A-Z]{2,5}(?:[A-Z][a-z0-9]+){1,}\b/g;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = prefixPattern.exec(withoutPlaceholders))) {
    seen.add(match[0]);
  }
  for (const word of seen) {
    // Lookahead ensures we only strip the prefix run itself, not the first letter of the
    // retained object name too (e.g. "ABCSalesTable" -> "SalesTable", not "alesTable").
    const suggestion = word.replace(/^[A-Z]{2,5}(?=[A-Z][a-z0-9])/, '');
    issues.push({
      level: 'warning',
      message: `"${word}" looks like a company-prefixed object name — consider a placeholder like "<Prefix>${suggestion}" instead.`,
    });
  }

  return issues;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'with', 'this',
  'that', 'it', 'be', 'as', 'by', 'from', 'at', 'when', 'you', 'your', 'not', 'can', 'will',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Compares the draft against every existing entry using bag-of-words Jaccard similarity. */
export function findDuplicates(
  content: string,
  entries: { slug: string; title: string; content: string }[],
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD
): DuplicateMatch[] {
  const newTokens = tokenize(content);
  const matches: DuplicateMatch[] = [];
  for (const entry of entries) {
    const score = jaccardSimilarity(newTokens, tokenize(entry.content));
    if (score >= threshold) {
      matches.push({ slug: entry.slug, title: entry.title, score: Math.round(score * 100) / 100 });
    }
  }
  return matches.sort((a, b) => b.score - a.score);
}

/** Pulls out likely D365 object/class-style identifiers (PascalCase, ignoring placeholders). */
export function extractCandidateIdentifiers(content: string): string[] {
  // Consume the placeholder tag *and* the identifier immediately glued to it (e.g.
  // "<Prefix>WidgetExportController") so a correctly placeholder-ed custom name isn't left
  // behind and misreported as an unverified real identifier.
  const withoutPlaceholders = content.replace(/<[^>\n]{1,40}>[A-Za-z0-9_]*/g, ' ');
  const withoutCodeFenceLangs = withoutPlaceholders.replace(/```[a-zA-Z]*\n/g, '\n');
  const matches = withoutCodeFenceLangs.match(/\b[A-Z][a-zA-Z0-9]*[a-z][A-Z][a-zA-Z0-9]*\b/g) ?? [];
  return Array.from(new Set(matches)).filter((w) => w.length >= 6);
}

/** Cross-checks candidate identifiers against the indexed AOT metadata, when a DB is available. */
export function checkFeasibility(content: string, db: Database | null | undefined): FeasibilityFinding[] {
  if (!db) return [];
  const identifiers = extractCandidateIdentifiers(content);
  const findings: FeasibilityFinding[] = [];
  for (const identifier of identifiers) {
    let row: { type: string; package: string } | undefined;
    try {
      row = db.prepare('SELECT type, package FROM ax_objects WHERE name = ? LIMIT 1').get(identifier) as
        | { type: string; package: string }
        | undefined;
    } catch {
      row = undefined;
    }
    findings.push(
      row
        ? { identifier, status: 'verified', type: row.type, package: row.package }
        : { identifier, status: 'unverified' }
    );
  }
  return findings;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'topic'
  );
}

const NUMBER_RESERVATION_RE = /^\.digest-(\d+)\.lock$/;

/** Finds the next 2+ digit numeric prefix after existing articles and in-flight reservations. */
export function nextSlugNumber(kbDir: string): string {
  let max = 0;
  if (fs.existsSync(kbDir)) {
    for (const file of fs.readdirSync(kbDir)) {
      const match = /^(\d+)-/.exec(file) ?? NUMBER_RESERVATION_RE.exec(file);
      if (match) max = Math.max(max, parseInt(match[1], 10));
    }
  }
  return String(max + 1).padStart(2, '0');
}

function reserveNextSlugNumber(kbDir: string): { number: string; reservationPath: string } {
  fs.mkdirSync(kbDir, { recursive: true });

  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const number = nextSlugNumber(kbDir);
    const reservationPath = path.join(kbDir, `.digest-${number}.lock`);
    try {
      fs.writeFileSync(reservationPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' });
      return { number, reservationPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(`Could not reserve a knowledge-base number after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Validates a draft knowledge base article (structure, sanitization, duplicates, identifier
 * feasibility against the indexed metadata) and, when it passes, writes it as a new numbered
 * markdown file in `kbDir`. Missing required structure and sensitive-content findings always
 * block the write, even with `force`; only a near-duplicate match is force-overridable.
 */
export function digestKnowledge(options: DigestOptions): DigestReport {
  const {
    content,
    kbDir,
    db = null,
    slugOverride,
    dryRun = false,
    force = false,
    duplicateThreshold = DEFAULT_DUPLICATE_THRESHOLD,
  } = options;

  const title = extractTitle(content) ?? 'Untitled';
  const structureIssues = validateStructure(content);
  const sensitiveIssues = scanSensitiveContent(content);

  const existing = listKnowledgeEntries(kbDir).map((e) => ({
    slug: e.slug,
    title: e.title,
    content: fs.readFileSync(e.filePath, 'utf8'),
  }));
  const duplicates = findDuplicates(content, existing, duplicateThreshold);

  const issues: DigestIssue[] = [...structureIssues, ...sensitiveIssues];
  for (const dup of duplicates) {
    if (dup.score >= NEAR_DUPLICATE_SCORE) {
      issues.push({
        level: 'error',
        message: `Near-duplicate of existing topic "${dup.slug}" (similarity ${(dup.score * 100).toFixed(0)}%). Refusing to add; use --force to override.`,
      });
    } else {
      issues.push({
        level: 'warning',
        message: `Possible overlap with existing topic "${dup.slug}" (similarity ${(dup.score * 100).toFixed(0)}%). Consider merging instead of adding a new file.`,
      });
    }
  }

  const feasibility = checkFeasibility(content, db);
  const existingTopics: ExistingTopicSummary[] = existing.map((e) => ({
    slug: e.slug,
    title: e.title,
    summary: extractSummary(e.content),
  }));

  const hasSensitiveError = sensitiveIssues.some((i) => i.level === 'error');
  // Missing title / required sections are always hard-blocking — `force` only overrides a
  // near-duplicate match, matching the documented CLI/tool behavior.
  const hasRequiredStructureError = structureIssues.some((i) => i.level === 'error');
  const hasNearDuplicateError = duplicates.some((d) => d.score >= NEAR_DUPLICATE_SCORE);
  const written = !dryRun && !hasSensitiveError && !hasRequiredStructureError && (!hasNearDuplicateError || force);

  const slugBase = slugOverride ? slugify(slugOverride) : slugify(title);

  let actuallyWritten = false;
  let slug = '';
  let filePath = '';
  if (written) {
    let reservationPath = '';
    try {
      const reservation = reserveNextSlugNumber(kbDir);
      reservationPath = reservation.reservationPath;
      slug = `${reservation.number}-${slugBase}`;
      filePath = path.join(kbDir, `${slug}.md`);
      fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      actuallyWritten = true;
    } catch (err) {
      if (!slug) {
        const number = nextSlugNumber(kbDir);
        slug = `${number}-${slugBase}`;
        filePath = path.join(kbDir, `${slug}.md`);
      }
      issues.push({
        level: 'error',
        message: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      if (reservationPath) {
        try {
          fs.rmSync(reservationPath, { force: true });
        } catch (err) {
          issues.push({
            level: 'warning',
            message: `Reservation cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  } else {
    const number = nextSlugNumber(kbDir);
    slug = `${number}-${slugBase}`;
    filePath = path.join(kbDir, `${slug}.md`);
  }

  return { slug, title, filePath, written: actuallyWritten, issues, duplicates, feasibility, existingTopics };
}
