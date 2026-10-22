import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { captureLocalTools } from '../src/gateway/localTools.js';
import { HostedCatalog } from '../src/gateway/server.js';
import { UpstreamUnavailableError, HOSTED_RETRY_MS } from '../src/gateway/upstream.js';
import type { LocalIndex, LocalTools, UpstreamPort } from '../src/gateway/types.js';
import { seedDb } from './helpers/toolHarness.js';

const workspace = {
  workspaceDir: '',
  customMetadataDir: '/dev/null/CustomModels',
  targetProject: '',
  targetPackage: '',
  targetModel: '',
  targetSolution: '',
  writableModels: [],
};

function localTools(): LocalTools {
  const db = seedDb([]);
  const localIndex = { db, customDir: workspace.customMetadataDir, status: () => ({}) } as unknown as LocalIndex;
  return captureLocalTools(db, localIndex, workspace);
}

/** The tools of a hosted server of the same version: what the gateway itself advertises. */
const sameTools = (local: LocalTools): Tool[] => local.definitions().map((definition) => ({ ...definition }));

function hostedWith(listTools: () => Promise<Tool[]>): UpstreamPort {
  return { isAvailable: () => true, listTools, callTool: vi.fn(), serverVersion: '1.0.0' };
}

const withExtraProperty = (tools: Tool[], name: string): Tool[] =>
  tools.map((tool) =>
    tool.name === name ? { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, scope: {} } } } : tool
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('HostedCatalog', () => {
  it('records the merge tools whose hosted arguments differ from the gateway ones, and clears them once they match', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const local = localTools();
    const catalog = new HostedCatalog(local);
    let tools = withExtraProperty(sameTools(local), 'search_symbols');

    await catalog.refresh(hostedWith(async () => tools));
    expect(catalog.loaded).toBe(true);
    expect(catalog.skewedTools).toEqual(new Set(['search_symbols']));

    // A hosted server that was updated: the next refresh, after the cache time, sees the arguments agree again.
    tools = sameTools(local);
    vi.setSystemTime(Date.now() + 61_000);
    await catalog.refresh(hostedWith(async () => tools));
    expect(catalog.skewedTools).toEqual(new Set());
  });

  it('tells its listeners when the tool list first arrives or changes, not when it stays the same', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const local = localTools();
    const catalog = new HostedCatalog(local);
    const listener = vi.fn();
    const stop = catalog.onChange(listener);
    const tools = sameTools(local);

    await catalog.refresh(hostedWith(async () => tools));
    expect(listener).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    await catalog.refresh(hostedWith(async () => tools));
    expect(listener).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    await catalog.refresh(hostedWith(async () => tools.slice(1)));
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
    vi.setSystemTime(Date.now() + 61_000);
    await catalog.refresh(hostedWith(async () => tools));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous list when a refresh fails and asks again no sooner than the retry pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const local = localTools();
    const catalog = new HostedCatalog(local);
    const tools = sameTools(local);
    await catalog.refresh(hostedWith(async () => tools));

    vi.setSystemTime(Date.now() + 61_000);
    const failing = vi.fn(async (): Promise<Tool[]> => {
      throw new UpstreamUnavailableError('The hosted MCP server at hosted.example is unreachable.');
    });
    await catalog.refresh(hostedWith(failing));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(catalog.tools).toEqual(tools);
    expect(catalog.failure).toContain('unreachable');
    expect(catalog.needsRefresh).toBe(true);

    await catalog.refresh(hostedWith(failing));
    expect(failing).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + HOSTED_RETRY_MS);
    await catalog.refresh(hostedWith(failing));
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
