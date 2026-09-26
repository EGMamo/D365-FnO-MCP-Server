import { describe, it, expect } from 'vitest';
import { ConfigError, loadConfig } from '../src/configLoader.js';

const key = (char: string) => char.repeat(40);

function issuesOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
}

describe('loadConfig', () => {
  it('requires an API key for the HTTP transport', () => {
    expect(issuesOf({ MCP_TRANSPORT: 'http' })).toEqual([
      expect.stringMatching(/MCP_API_KEYS: The HTTP transport requires at least one API key/),
    ]);
  });

  it('needs no API key for stdio', () => {
    const config = loadConfig({ MCP_TRANSPORT: 'stdio' });
    expect(config.apiKeys).toEqual([]);
    expect(config.packagesDir).toBe('');
    expect(config.hostedMode).toBe(false);
  });

  it('parses MCP_API_KEYS and the legacy MCP_API_KEY into named entries', () => {
    const config = loadConfig({ MCP_API_KEYS: `alice=${key('a')},bob=${key('b')}`, MCP_API_KEY: key('z') });
    expect(config.apiKeys.map((entry) => entry.name)).toEqual(['alice', 'bob', 'default']);
  });

  it('enables index uploads only for named keys over HTTP', () => {
    const keys = `alice=${key('a')},bob=${key('b')}`;
    const config = loadConfig({ MCP_API_KEYS: keys, D365_INDEX_UPLOAD_KEYS: ' alice ,', D365_INDEX_UPLOAD_MAX_CHUNK_MB: '64' });
    expect(config.indexUploadKeys).toEqual(['alice']);
    expect(config.indexUploadMaxChunkBytes).toBe(64 * 1024 * 1024);
    expect(config.indexUploadMaxBytes).toBe(50 * 1024 ** 3);
    expect(issuesOf({ MCP_API_KEYS: keys, D365_INDEX_UPLOAD_KEYS: 'carol' })).toEqual([
      expect.stringMatching(/D365_INDEX_UPLOAD_KEYS: 'carol' is not the name of a key/),
    ]);
    expect(issuesOf({ MCP_TRANSPORT: 'stdio', MCP_API_KEYS: keys, D365_INDEX_UPLOAD_KEYS: 'alice' })).toEqual([
      expect.stringMatching(/need the HTTP transport/),
    ]);
  });

  it('requires a SAS container URL and uploads for D365_INDEX_PUBLISH_URL', () => {
    const keys = `alice=${key('a')}`;
    expect(issuesOf({ MCP_API_KEYS: keys, D365_INDEX_UPLOAD_KEYS: 'alice', D365_INDEX_PUBLISH_URL: 'https://acct.blob.core.windows.net/indexes' }))
      .toEqual([expect.stringMatching(/SAS query string/)]);
    expect(issuesOf({ MCP_API_KEYS: keys, D365_INDEX_PUBLISH_URL: 'https://acct.blob.core.windows.net/indexes?sv=1&sig=x' }))
      .toEqual([expect.stringMatching(/set D365_INDEX_UPLOAD_KEYS as well/)]);
    expect(loadConfig({
      MCP_API_KEYS: keys, D365_INDEX_UPLOAD_KEYS: 'alice', D365_INDEX_PUBLISH_URL: 'https://acct.blob.core.windows.net/indexes?sv=1&sig=x',
    }).indexPublishUrl).toContain('?sv=1');
  });

  it('reports malformed keys in either transport', () => {
    expect(issuesOf({ MCP_TRANSPORT: 'stdio', MCP_API_KEY: 'short' })).toEqual([
      expect.stringMatching(/MCP_API_KEYS: MCP_API_KEY: key for 'default' is 5 characters/),
    ]);
  });

  it('requires D365_PACKAGES_DIR only for startup indexing', () => {
    expect(loadConfig({ MCP_API_KEY: key('a') }).indexOnStart).toBe(false);
    expect(issuesOf({ MCP_API_KEY: key('a'), D365_INDEX_ON_START: '1' })).toEqual([
      expect.stringMatching(/D365_PACKAGES_DIR: D365_PACKAGES_DIR is required when D365_INDEX_ON_START=1/),
    ]);
    const config = loadConfig({ MCP_API_KEY: key('a'), D365_INDEX_ON_START: '1', D365_PACKAGES_DIR: '/packages' });
    expect(config.indexOnStart).toBe(true);
  });

  it('enables hosted mode from D365_INDEX_URL', () => {
    const config = loadConfig({
      MCP_API_KEY: key('a'),
      D365_INDEX_URL: 'https://example.blob.core.windows.net/indexes/latest/manifest.json?sv=1',
      MCP_HOST: '0.0.0.0',
    });
    expect(config.hostedMode).toBe(true);
    expect(config.indexUrl).toMatch(/^https:/);
    expect(config.host).toBe('0.0.0.0');
  });

  it('rejects hosted mode combined with startup indexing or write tools', () => {
    const base = { MCP_API_KEY: key('a'), D365_INDEX_URL: 'https://example.test/latest/manifest.json' };
    expect(issuesOf({ ...base, D365_INDEX_ON_START: '1', D365_PACKAGES_DIR: '/p' })).toEqual([
      expect.stringMatching(/D365_INDEX_ON_START cannot be combined with D365_INDEX_URL/),
    ]);
    expect(issuesOf({ ...base, D365_ENABLE_WRITE_TOOLS: '1', D365_CUSTOM_METADATA_DIR: '/m' })).toEqual([
      expect.stringMatching(/Write tools are not available when serving a published index/),
    ]);
  });

  it('rejects a non-http index URL', () => {
    expect(issuesOf({ MCP_API_KEY: key('a'), D365_INDEX_URL: 'ftp://example.test/manifest.json' })).toEqual([
      expect.stringMatching(/D365_INDEX_URL must be an http\(s\) URL/),
    ]);
  });

  it('keeps the existing write-tool and workspace guards', () => {
    expect(issuesOf({ MCP_API_KEY: key('a'), D365_ENABLE_WRITE_TOOLS: '1' })).toEqual([
      expect.stringMatching(/D365_CUSTOM_METADATA_DIR/),
    ]);
    expect(issuesOf({ MCP_API_KEY: key('a'), D365_WRITABLE_MODELS: 'NoSlash' })).toEqual([
      expect.stringMatching(/Invalid writable target 'NoSlash'/),
    ]);
  });
});
