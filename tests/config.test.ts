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

  it('rejects the removed stdio transport', () => {
    expect(issuesOf({ MCP_TRANSPORT: 'stdio' })).toEqual([
      expect.stringMatching(/Invalid input/),
    ]);
  });

  it('parses MCP_API_KEYS and the legacy MCP_API_KEY into named entries', () => {
    const config = loadConfig({ MCP_API_KEYS: `alice=${key('a')},bob=${key('b')}`, MCP_API_KEY: key('z') });
    expect(config.apiKeys.map((entry) => entry.name)).toEqual(['alice', 'bob', 'default']);
  });

  it('reports malformed keys in either transport', () => {
    expect(issuesOf({ MCP_TRANSPORT: 'http', MCP_API_KEY: 'short' })).toEqual([
      expect.stringMatching(/MCP_API_KEYS: MCP_API_KEY: key for 'default' is 5 characters/),
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

  it('makes hosted artifact mode read-only', () => {
    expect(issuesOf({
      MCP_TRANSPORT: 'http',
      MCP_API_KEY: 'a'.repeat(32),
      D365_ARTIFACT_STORE_PATH: '/artifacts',
      D365_ENABLE_WRITE_TOOLS: '1',
      D365_CUSTOM_METADATA_DIR: '/metadata',
    })).toEqual([
      expect.stringMatching(/D365_ENABLE_WRITE_TOOLS must be 0 when D365_ARTIFACT_STORE_PATH/),
    ]);

    const config = loadConfig({
      MCP_TRANSPORT: 'http',
      MCP_API_KEY: 'a'.repeat(32),
      D365_ARTIFACT_STORE_PATH: ' /artifacts ',
    });
    expect(config.artifactStorePath).toBe('/artifacts');
    expect(config.enableWriteTools).toBe(false);
  });
});
