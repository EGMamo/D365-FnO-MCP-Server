import { describe, it, expect } from 'vitest';
import {
  findKnowledgeDir,
  listKnowledgeEntries,
  readKnowledgeEntry,
  registerKnowledgeResources,
} from '../src/tools/knowledge.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('knowledge base', () => {
  it('locates the resources folder', () => {
    expect(findKnowledgeDir()).not.toBeNull();
  });

  it('enumerates markdown topics with slugs', () => {
    const entries = listKnowledgeEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.slug)).toContain('02-chain-of-command');
    expect(entries.every((e) => !e.slug.endsWith('.md'))).toBe(true);
  });

  it('reads a topic by slug and returns null for unknown slugs', () => {
    const found = readKnowledgeEntry('02-chain-of-command');
    expect(found?.content).toContain('ExtensionOf');
    expect(readKnowledgeEntry('does-not-exist')).toBeNull();
  });

  it('registers a resource template and the pattern assistant prompt', async () => {
    let resourceName = '';
    let listResult: unknown;
    let promptCb: ((args: { topic?: string }) => { messages: { content: { text: string } }[] }) | null =
      null;

    const fakeServer = {
      resource: (name: string, template: { listCallback?: () => unknown }) => {
        resourceName = name;
        listResult = template.listCallback?.();
      },
      prompt: (_name: string, _desc: string, _schema: unknown, cb: typeof promptCb) => {
        promptCb = cb;
      },
    } as unknown as McpServer;

    registerKnowledgeResources(fakeServer);

    expect(resourceName).toBe('d365-knowledge-base');
    const resources = (listResult as { resources: { uri: string }[] }).resources;
    expect(resources.some((r) => r.uri === 'd365kb://02-chain-of-command')).toBe(true);

    expect(promptCb).not.toBeNull();
    const withTopic = promptCb!({ topic: '02-chain-of-command' });
    expect(withTopic.messages[0].content.text).toContain('ExtensionOf');

    const withoutTopic = promptCb!({});
    expect(withoutTopic.messages[0].content.text).toContain('d365kb://01-aot-source-layout');
  });
});
