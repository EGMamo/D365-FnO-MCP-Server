import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeFilter } from '../src/knowledge/filter.js';
import { findEmbeddingModelDir, loadEmbedder } from '../src/knowledge/embedder.js';
import { scoreDraftByMeaning } from '../src/knowledge/semantic.js';
import { loadTopics, splitFrontMatter } from '../src/knowledge/topics.js';
import { digestKnowledge } from '../src/knowledge/digest.js';
import { findKnowledgeDir } from '../src/tools/knowledge.js';

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

function texts(result: CallToolResult): string[] {
  return result.content.map((item) => (item.type === 'text' ? item.text : ''));
}

function knowledgeOf(result: CallToolResult) {
  const last = texts(result).at(-1)!;
  return (JSON.parse(last) as { knowledge: { notes: Array<{ topic: string; matchedBy: string }>; filtered?: unknown; reordered?: unknown } }).knowledge;
}

describe('knowledge topic headers', () => {
  it('parses a valid header and rejects unknown keys', () => {
    const { header, body } = splitFrontMatter('---\nappliesTo:\n  tools: [search_symbols]\nnote: Hi\n---\n# Title\n');
    expect(header).toEqual({ appliesTo: { tools: ['search_symbols'] }, note: 'Hi' });
    expect(body).toBe('# Title\n');
    expect(() => splitFrontMatter('---\nbogus: 1\n---\n# T\n')).toThrow(/Invalid knowledge topic header/);
  });

  it('loads every shipped topic with a valid header', () => {
    const topics = loadTopics(findKnowledgeDir());
    expect(topics.length).toBeGreaterThanOrEqual(24);
    expect(topics.every((topic) => topic.header.note && topic.title && !topic.title.startsWith('appliesTo'))).toBe(true);
  });
});

describe('knowledge filter (rules)', () => {
  let kbDir: string;

  beforeEach(() => {
    kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-kb-filter-'));
    fs.writeFileSync(
      path.join(kbDir, '01-mirrors.md'),
      [
        '---',
        'appliesTo:',
        '  tools: [search_symbols, list_objects]',
        'filter:',
        "  exclude: [{ field: file_path, pattern: '*XppMetadata*' }]",
        'note: Mirrors are build output.',
        '---',
        '# Mirrors',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(kbDir, '02-coc.md'),
      [
        '---',
        'appliesTo:',
        '  tools: [search_symbols, get_class_hierarchy]',
        'match:',
        "  names: ['*_Extension']",
        'rank:',
        "  prefer: [{ field: name, pattern: '*_Extension' }]",
        'note: Use the right selector.',
        '---',
        '# CoC',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(kbDir, '03-tables.md'),
      '---\nappliesTo:\n  tools: [get_table_schema]\n  objectTypes: [Table]\nnote: Table advice.\n---\n# Tables\n'
    );
    fs.writeFileSync(
      path.join(kbDir, '04-labels.md'),
      '---\nmatch:\n  tools: [resolve_label]\n---\n# Labels\n\n## When to use this\nResolving label ids.\n'
    );
  });

  afterEach(() => fs.rmSync(kbDir, { recursive: true, force: true }));

  it('drops noise rows, prefers rows and attaches the topics that acted', async () => {
    const filter = await KnowledgeFilter.create(kbDir);
    const result = await filter.apply('search_symbols', { query: 'Sales' }, json([
      { name: 'SalesTable', type: 'Table', file_path: '/pkg/Model/AxTable/SalesTable.xml' },
      { name: 'SalesTable', type: 'Table', file_path: '/pkg/XppMetadata/SalesTable.xml' },
      { name: 'SalesTable_Extension', type: 'Class', file_path: '/pkg/Model/AxClass/SalesTable_Extension.xml' },
    ]));

    const rows = JSON.parse(texts(result)[0]) as Array<{ name: string; file_path: string }>;
    expect(rows.map((row) => row.name)).toEqual(['SalesTable_Extension', 'SalesTable']);
    expect(rows.some((row) => row.file_path.includes('XppMetadata'))).toBe(false);
    const knowledge = knowledgeOf(result);
    expect(knowledge.filtered).toEqual([{ topic: 'd365kb://01-mirrors', removed: 1 }]);
    expect(knowledge.reordered).toEqual(['d365kb://02-coc']);
    expect(knowledge.notes.map((note) => note.topic)).toEqual(['d365kb://01-mirrors', 'd365kb://02-coc']);
  });

  it('matches by argument object type and by trigger tool, and respects the tool gate', async () => {
    const filter = await KnowledgeFilter.create(kbDir);
    const table = await filter.apply('get_table_schema', { tableName: 'CustTable' }, json({ name: 'CustTable', fields: [] }));
    expect(knowledgeOf(table).notes).toEqual([
      expect.objectContaining({ topic: 'd365kb://03-tables', matchedBy: 'rule', note: 'Table advice.' }),
    ]);
    // Without a header note, the "When to use this" summary is the note.
    const label = await filter.apply('resolve_label', { labelId: '@SYS1' }, json({ text: 'Customer' }));
    expect(knowledgeOf(label).notes[0]).toMatchObject({ topic: 'd365kb://04-labels', note: 'Resolving label ids.' });
    // 03-tables is gated to get_table_schema, so another tool about a table gets nothing.
    const other = await filter.apply('find_references', { name: 'CustTable', type: 'Table' }, json([]));
    expect(other.content).toHaveLength(1);
  });

  it('passes errors through and annotates plain-text results without rewriting them', async () => {
    const filter = await KnowledgeFilter.create(kbDir);
    const error: CallToolResult = { content: [{ type: 'text', text: 'boom' }], isError: true };
    expect(await filter.apply('resolve_label', {}, error)).toBe(error);
    const plain = await filter.apply('resolve_label', {}, { content: [{ type: 'text', text: 'Customer' }] });
    expect(texts(plain)[0]).toBe('Customer');
    expect(knowledgeOf(plain).notes).toHaveLength(1);
  });
});

const modelDir = findEmbeddingModelDir();

describe.skipIf(!modelDir)('knowledge embeddings (needs npm run fetch-model)', () => {
  it('adds a note by meaning when no rule matches', async () => {
    const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-kb-semantic-'));
    try {
      fs.writeFileSync(
        path.join(kbDir, '01-tts.md'),
        '# Transactions\n\n## When to use this\nWrapping database writes in ttsbegin and ttscommit inside try/catch blocks.\n'
      );
      fs.writeFileSync(
        path.join(kbDir, '02-colors.md'),
        '# Color groups\n\n## When to use this\nProduct color groups and the color dimension tables.\n'
      );
      const filter = await KnowledgeFilter.create(kbDir, { embedder: await loadEmbedder(modelDir!) });
      const result = await filter.apply('find_usages', { name: 'ttsbegin' }, json([]));
      expect(knowledgeOf(result).notes).toEqual([
        expect.objectContaining({ topic: 'd365kb://01-tts', matchedBy: 'meaning' }),
      ]);
    } finally {
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('blocks a draft that restates an existing topic in different words', async () => {
    const kbDir = findKnowledgeDir()!;
    const paraphrase = [
      '# Database transaction scopes in X++',
      '',
      '## When to use this',
      'Any time you write several records that must succeed or fail together inside a try/catch.',
      '',
      '## Pattern',
      'Put ttsbegin first and ttscommit last inside the try block. Never call ttsabort in the catch,',
      'because the kernel already aborts the transaction when the exception leaves the try; a manual',
      'abort then hits tts level 0 and raises the unbalanced begin/commit best-practice error.',
      "Don't move ttsbegin outside the try either.",
      '',
    ].join('\n');
    const semanticScores = (await scoreDraftByMeaning(paraphrase, kbDir))!;
    const report = digestKnowledge({ content: paraphrase, kbDir, dryRun: true, semanticScores });
    expect(report.semanticCheck).toBe('ran');
    // The wording check alone would only warn, never block.
    expect(report.duplicates.every((match) => match.score < 0.8)).toBe(true);
    expect(report.semanticDuplicates[0].slug).toBe('10-transactions');
    expect(report.issues).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringContaining('10-transactions') }));

    const unrelated = '# Number sequences\n\n## When to use this\nA new master table needs an automatic ID.\n\n## Pattern\nExtend NumberSeqModule, register the reference in loadModule and fetch numbers with NumberSeq::newGetNum.\n';
    const clean = digestKnowledge({ content: unrelated, kbDir, dryRun: true, semanticScores: (await scoreDraftByMeaning(unrelated, kbDir))! });
    expect(clean.semanticDuplicates).toEqual([]);
  }, 120_000);
});
