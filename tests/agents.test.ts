import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { expectedFiles, loadAgents, parseAgentSource, renderClaude, renderCopilot } from '../scripts/build-agents.mjs';

interface Agent {
  name: string;
  description: string;
  fileTools: string[];
  d365Tools: string[];
  learnTools: string[];
  body: string;
}

const toolsDir = path.resolve('src/tools');
const registeredTools = new Set(
  fs.readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => [...fs.readFileSync(path.join(toolsDir, f), 'utf8').matchAll(/server\.tool\(\s*'([a-z_]+)'/g)].map((m) => m[1]))
);
const learnTools = new Set(['microsoft_docs_search', 'microsoft_docs_fetch', 'microsoft_code_sample_search']);

describe('local agent definitions', () => {
  const agents = loadAgents() as Agent[];

  it('finds the registered tools', () => {
    expect(registeredTools.has('search_symbols')).toBe(true);
    expect(registeredTools.size).toBeGreaterThan(40);
  });

  it('defines the four agents', () => {
    expect(agents.map((a) => a.name)).toEqual(['performance-reviewer', 'release-planner', 'security-reviewer', 'xpp-developer']);
  });

  it.each(agents.map((a) => [a.name, a] as const))('%s references only existing tools', (_name, agent) => {
    expect(agent.d365Tools.length).toBeGreaterThan(0);
    expect(agent.d365Tools.filter((t) => !registeredTools.has(t))).toEqual([]);
    expect(agent.learnTools.filter((t) => !learnTools.has(t))).toEqual([]);
    expect(new Set(agent.d365Tools).size).toBe(agent.d365Tools.length);
  });

  it('never grants the write tools', () => {
    for (const agent of agents) {
      expect(agent.d365Tools).not.toContain('apply_table_extension_change');
      expect(agent.d365Tools).not.toContain('write_table_extension');
    }
  });

  it('keeps the generated files up to date (run npm run build:agents)', () => {
    for (const [file, content] of expectedFiles() as Map<string, string>) {
      expect(fs.existsSync(file), file).toBe(true);
      expect(fs.readFileSync(file, 'utf8'), file).toBe(content);
    }
  });

  it('renders both formats with prefixed MCP tool names', () => {
    const agent = parseAgentSource(
      '---\nname: demo\ndescription: Demo agent.\nfile-tools: read, edit\nd365-tools: search_symbols\nlearn-tools: microsoft_docs_search\n---\nBody\n'
    ) as Agent;
    const copilot = renderCopilot(agent) as string;
    const claude = renderClaude(agent) as string;
    expect(copilot).toContain("  - 'read'\n  - 'edit'\n  - 'd365-fno/search_symbols'\n  - 'microsoft-learn/microsoft_docs_search'\n");
    expect(copilot.endsWith('Body\n')).toBe(true);
    expect(claude).toContain('tools: Read, Edit, Write, mcp__d365-fno__search_symbols, mcp__microsoft-learn__microsoft_docs_search\n');
    expect(claude).toContain('description: "Demo agent."');
  });

  it('rejects invalid sources', () => {
    expect(() => parseAgentSource('no front matter')).toThrow(/front matter/);
    expect(() => parseAgentSource('---\nname: Bad Name\ndescription: x\n---\nb')).toThrow(/lowercase/);
    expect(() => parseAgentSource('---\nname: ok\ndescription: say "hi"\n---\nb')).toThrow(/double quotes/);
    expect(() => parseAgentSource('---\nname: ok\ndescription: x\nfile-tools: execute\n---\nb')).toThrow(/unknown file tool/);
  });
});
