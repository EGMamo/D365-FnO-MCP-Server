import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateStructure,
  scanSensitiveContent,
  findDuplicates,
  extractCandidateIdentifiers,
  checkFeasibility,
  nextSlugNumber,
  slugify,
  extractSummary,
  digestKnowledge,
} from '../src/knowledge/digest.js';
import { openDb, upsertObject } from '../src/indexer/db.js';

const GOOD_ARTICLE = `# Widget Batch Export Pattern

## When to use this
When you need to export widgets to an external system on a schedule.

## Pattern
Use \`<Prefix>WidgetExportController\` extending \`SysOperationServiceController\` to run
\`<Prefix>WidgetExportService\` on a recurring batch schedule. Keep the contract class thin.

## Gotchas / notes
Remember to set \`RunBaseBatch\` recurrence via the batch UI, not hard-coded values.

## Related
- 09-sysoperation-batch-pattern
`;

describe('knowledge digest: validateStructure', () => {
  it('accepts a well-formed article', () => {
    expect(validateStructure(GOOD_ARTICLE)).toEqual([]);
  });

  it('flags a missing title and missing Pattern section', () => {
    const issues = validateStructure('## Pattern\nsome content that is definitely long enough to pass the length check.....');
    expect(issues.some((i) => i.level === 'error' && i.message.includes('Title'))).toBe(true);
  });

  it('warns on missing recommended sections without blocking', () => {
    const content = `# Title\n\n## Pattern\n${'x'.repeat(250)}`;
    const issues = validateStructure(content);
    expect(issues.every((i) => i.level === 'warning')).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('ignores markdown-heading-looking lines inside fenced code blocks', () => {
    const content = `# Title\n\n## Pattern\n${'x'.repeat(200)}\n\n\`\`\`bash\n## this is a shell comment, not a heading\necho hi\n\`\`\`\n`;
    const issues = validateStructure(content);
    // Should still see the real required "Pattern" section satisfied, and only warn about the
    // genuinely-missing recommended sections (not get confused by the fenced "## comment").
    expect(issues.some((i) => i.level === 'error')).toBe(false);
  });
});

describe('knowledge digest: scanSensitiveContent', () => {
  it('flags an email address', () => {
    const issues = scanSensitiveContent('Contact bob.smith@contoso.com for details.');
    expect(issues.some((i) => i.level === 'error' && i.message.includes('email'))).toBe(true);
  });

  it('flags a literal password/connection-string secret', () => {
    const issues = scanSensitiveContent('ConnectionString: Server=x;Password=SuperSecret123;');
    expect(issues.some((i) => i.level === 'error' && i.message.includes('secret'))).toBe(true);
  });

  it('does not flag placeholder-shaped secrets', () => {
    const issues = scanSensitiveContent('Password=<YourPassword> and ApiKey=<ApiKey>');
    expect(issues.some((i) => i.level === 'error')).toBe(false);
  });

  it('warns (not errors) on a likely company-prefixed object name', () => {
    const issues = scanSensitiveContent('The class ABCSalesTable extends SalesTable.');
    const hit = issues.find((i) => i.message.includes('ABCSalesTable'));
    expect(hit?.level).toBe('warning');
  });

  it('does not flag standard framework names as company prefixes', () => {
    const issues = scanSensitiveContent('Extend RunBaseBatch and SysOperationServiceController.');
    expect(issues.some((i) => i.message.includes('RunBaseBatch'))).toBe(false);
  });

  it('treats an IPv4-shaped string as a non-blocking warning (avoids version-number false positives)', () => {
    const issues = scanSensitiveContent('This pattern applies from D365 F&O version 10.0.39.0 onward.');
    const hit = issues.find((i) => i.message.includes('10.0.39.0'));
    expect(hit).toBeDefined();
    expect(hit?.level).toBe('warning');
  });

  it('suggests a placeholder replacement that keeps the full object name intact', () => {
    const issues = scanSensitiveContent('The class ABCSalesTable extends SalesTable.');
    const hit = issues.find((i) => i.message.includes('ABCSalesTable'));
    expect(hit?.message).toContain('<Prefix>SalesTable');
    expect(hit?.message).not.toContain('<Prefix>alesTable');
  });
});

describe('knowledge digest: duplicate detection', () => {
  it('flags near-identical content as a duplicate', () => {
    const entries = [{ slug: '01-foo', title: 'Foo', content: GOOD_ARTICLE }];
    const matches = findDuplicates(GOOD_ARTICLE, entries, 0.3);
    expect(matches.length).toBe(1);
    expect(matches[0].slug).toBe('01-foo');
    expect(matches[0].score).toBeGreaterThan(0.9);
  });

  it('does not flag unrelated content', () => {
    const entries = [{ slug: '01-foo', title: 'Foo', content: 'Completely unrelated label file naming guidance.' }];
    expect(findDuplicates(GOOD_ARTICLE, entries, 0.3)).toEqual([]);
  });
});

describe('knowledge digest: feasibility', () => {
  it('extracts PascalCase identifiers while ignoring placeholders', () => {
    const ids = extractCandidateIdentifiers('Use <Prefix>WidgetController and RunBaseBatch here.');
    expect(ids).toContain('RunBaseBatch');
    expect(ids.some((id) => id.includes('Prefix'))).toBe(false);
  });

  it('does not leave the identifier glued to a placeholder tag as an unflagged candidate', () => {
    const ids = extractCandidateIdentifiers('Use <Prefix>WidgetExportController for this.');
    expect(ids).not.toContain('WidgetExportController');
    expect(ids.some((id) => id.includes('WidgetExportController'))).toBe(false);
  });

  it('verifies identifiers that exist in the index and flags ones that do not', () => {
    const db = openDb(':memory:');
    upsertObject(db, {
      type: 'class',
      name: 'RunBaseBatch',
      package: 'ApplicationSuite',
      model: '',
      file_path: 'x',
      raw_xml: '',
      file_mtime: 0,
    });

    const findings = checkFeasibility('RunBaseBatch and TotallyMadeUpClass are both mentioned here.', db);
    const verified = findings.find((f) => f.identifier === 'RunBaseBatch');
    const unverified = findings.find((f) => f.identifier === 'TotallyMadeUpClass');
    expect(verified?.status).toBe('verified');
    expect(unverified?.status).toBe('unverified');
    db.close();
  });

  it('returns an empty list when no db is provided', () => {
    expect(checkFeasibility(GOOD_ARTICLE, null)).toEqual([]);
  });
});

describe('knowledge digest: slug helpers', () => {
  it('slugifies titles', () => {
    expect(slugify('My Great Pattern!')).toBe('my-great-pattern');
  });

  it('computes the next numeric prefix from existing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
    fs.writeFileSync(path.join(dir, '01-a.md'), '# A');
    fs.writeFileSync(path.join(dir, '07-b.md'), '# B');
    expect(nextSlugNumber(dir)).toBe('08');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts at 01 for an empty/new directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-empty-'));
    expect(nextSlugNumber(dir)).toBe('01');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('knowledge digest: digestKnowledge end-to-end', () => {
  let kbDir: string;

  beforeEach(() => {
    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(kbDir, { recursive: true, force: true });
  });

  it('writes a clean article and numbers it sequentially', () => {
    fs.writeFileSync(path.join(kbDir, '03-existing.md'), '# Existing\n\n## Pattern\nSomething unrelated.');

    const report = digestKnowledge({ content: GOOD_ARTICLE, kbDir });

    expect(report.written).toBe(true);
    expect(report.slug).toBe('04-widget-batch-export-pattern');
    expect(fs.existsSync(report.filePath)).toBe(true);
    expect(report.issues.some((i) => i.level === 'error')).toBe(false);
  });

  it('allocates a different prefix while another writer holds a number reservation', () => {
    fs.writeFileSync(path.join(kbDir, '.digest-01.lock'), 'another writer\n', { flag: 'wx' });

    const report = digestKnowledge({ content: GOOD_ARTICLE, kbDir });

    expect(report.written).toBe(true);
    expect(report.slug).toBe('02-widget-batch-export-pattern');
    expect(fs.existsSync(path.join(kbDir, '.digest-02.lock'))).toBe(false);
  });

  it('refuses to write when sensitive content is present, even with force', () => {
    const dirty = `# Leaky Article\n\n## Pattern\nPassword=SuperSecret123 in the config.\n\n${'x'.repeat(120)}`;
    const report = digestKnowledge({ content: dirty, kbDir, force: true });

    expect(report.written).toBe(false);
    expect(fs.existsSync(report.filePath)).toBe(false);
    expect(report.issues.some((i) => i.level === 'error')).toBe(true);
  });

  it('does not write in dry-run mode but still reports findings', () => {
    const report = digestKnowledge({ content: GOOD_ARTICLE, kbDir, dryRun: true });
    expect(report.written).toBe(false);
    expect(fs.existsSync(report.filePath)).toBe(false);
  });

  it('blocks a near-duplicate by default but allows --force to add it anyway', () => {
    fs.writeFileSync(path.join(kbDir, '01-original.md'), GOOD_ARTICLE);

    const blocked = digestKnowledge({ content: GOOD_ARTICLE, kbDir });
    expect(blocked.written).toBe(false);
    expect(blocked.duplicates[0]?.slug).toBe('01-original');

    const forced = digestKnowledge({ content: GOOD_ARTICLE, kbDir, force: true });
    expect(forced.written).toBe(true);
  });

  it('respects an explicit slug override', () => {
    const report = digestKnowledge({ content: GOOD_ARTICLE, kbDir, slugOverride: 'custom-name' });
    expect(report.slug).toBe('01-custom-name');
  });

  it('does not crash and treats a not-yet-created kbDir as empty', () => {
    const missingDir = path.join(kbDir, 'not-created-yet');
    const report = digestKnowledge({ content: GOOD_ARTICLE, kbDir: missingDir });

    expect(report.existingTopics).toEqual([]);
    expect(report.duplicates).toEqual([]);
    expect(report.written).toBe(true);
    expect(report.slug).toBe('01-widget-batch-export-pattern');
    expect(fs.existsSync(report.filePath)).toBe(true);
  });

  it('never lets --force bypass a missing title or required Pattern section', () => {
    const malformed = `Just some prose with no title heading and no Pattern section at all, ${'x'.repeat(150)}`;
    const report = digestKnowledge({ content: malformed, kbDir, force: true });

    expect(report.written).toBe(false);
    expect(fs.existsSync(report.filePath)).toBe(false);
    expect(report.issues.some((i) => i.level === 'error' && i.message.includes('Title'))).toBe(true);
  });
});

describe('knowledge digest: conceptual duplication surfacing', () => {
  it('extracts a scenario summary from the "When to use this" section', () => {
    const summary = extractSummary(GOOD_ARTICLE);
    expect(summary).toContain('export widgets to an external system');
  });

  it('falls back to the opening paragraph when there is no "When to use this" section', () => {
    const summary = extractSummary('# Title\n\n## Pattern\nDo the thing this way.');
    expect(summary).toContain('Do the thing this way.');
  });

  it('always returns existingTopics from digestKnowledge, even when lexical duplicates is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-topics-'));
    fs.writeFileSync(
      path.join(dir, '01-reworded.md'),
      '# Scheduled Widget Sync\n\n## When to use this\nNeeded whenever widgets must reach another system periodically.\n\n## Pattern\nCompletely different wording than the batch export article, same underlying idea.'
    );

    const report = digestKnowledge({ content: GOOD_ARTICLE, kbDir: dir });
    expect(report.duplicates).toEqual([]); // wording is too different to trip the lexical check
    expect(report.existingTopics).toHaveLength(1);
    expect(report.existingTopics[0].slug).toBe('01-reworded');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
