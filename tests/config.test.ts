import { describe, it, expect } from 'vitest';
import { ConfigError, loadConfig } from '../src/configLoader.js';
import { DEFAULT_REQUIRED_CAPABILITIES } from '../src/indexer/capabilityCoverage.js';

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

  it('defaults MAX_SESSIONS_PER_API_KEY to 0 and rejects negative values', () => {
    expect(loadConfig({ MCP_API_KEY: key('a') }).maxSessionsPerApiKey).toBe(0);
    expect(loadConfig({ MCP_API_KEY: key('a'), MAX_SESSIONS_PER_API_KEY: '5' }).maxSessionsPerApiKey).toBe(5);
    expect(issuesOf({ MCP_API_KEY: key('a'), MAX_SESSIONS_PER_API_KEY: '-1' })).toEqual([
      expect.stringMatching(/^MAX_SESSIONS_PER_API_KEY:/),
    ]);
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

  it('requires a local directory, HTTPS account and container for Azure Blob artifacts', () => {
    expect(issuesOf({
      MCP_API_KEY: key('a'),
      D365_ARTIFACT_SOURCE: 'azure-blob',
      D365_ARTIFACT_ACCOUNT_URL: 'http://account.blob.core.windows.net/?sig=secret',
    })).toEqual([
      expect.stringMatching(/D365_ARTIFACT_STORE_PATH must name an instance-local directory/),
      expect.stringMatching(/D365_ARTIFACT_ACCOUNT_URL must be an HTTPS storage account URL/),
      expect.stringMatching(/D365_ARTIFACT_CONTAINER is required/),
    ]);

    const config = loadConfig({
      MCP_API_KEY: key('a'),
      D365_ARTIFACT_SOURCE: 'azure-blob',
      D365_ARTIFACT_STORE_PATH: '/data/artifacts',
      D365_ARTIFACT_ACCOUNT_URL: ' https://account.blob.core.windows.net ',
      D365_ARTIFACT_CONTAINER: 'd365-artifacts',
    });
    expect(config.artifactSource).toBe('azure-blob');
    expect(config.artifactAccountUrl).toBe('https://account.blob.core.windows.net');
    expect(config.artifactManagedIdentityClientId).toBe('');
  });

  it('requires the indexer-complete artifact capabilities unless D365_ARTIFACT_REQUIRED_CAPABILITIES overrides them', () => {
    expect(loadConfig({ MCP_API_KEY: key('a') }).artifactRequiredCapabilities).toEqual([
      ...DEFAULT_REQUIRED_CAPABILITIES,
    ]);
    expect(loadConfig({
      MCP_API_KEY: key('a'),
      D365_ARTIFACT_REQUIRED_CAPABILITIES: 'securityGraphs, codeMetadata',
    }).artifactRequiredCapabilities).toEqual(['securityGraphs', 'codeMetadata']);
    expect(issuesOf({
      MCP_API_KEY: key('a'),
      D365_ARTIFACT_REQUIRED_CAPABILITIES: 'codeMetadata,everything',
    })).toEqual([
      expect.stringMatching(/D365_ARTIFACT_REQUIRED_CAPABILITIES: .*unknown capabilities: everything/),
    ]);
  });
});

describe('key registry settings', () => {
  const base = { MCP_TRANSPORT: 'http' } as NodeJS.ProcessEnv;
  const problems = (env: NodeJS.ProcessEnv): string[] => {
    try {
      loadConfig(env);
      return [];
    } catch (error) {
      return (error as ConfigError).issues;
    }
  };

  it('lets a server start with a registry and no fixed keys', () => {
    const config = loadConfig({ ...base, MCP_KEY_REGISTRY: 'file', MCP_KEY_REGISTRY_PATH: '/srv/keys.json' });
    expect(config.apiKeys).toEqual([]);
    expect(config.keyRegistry).toEqual({ kind: 'file', path: '/srv/keys.json' });
    expect(loadConfig({ ...base, MCP_KEY_REGISTRY: 'azure-blob', MCP_KEY_REGISTRY_ACCOUNT_URL: 'https://acct.blob.core.windows.net' }).keyRegistry).toEqual({
      kind: 'azure-blob',
      accountUrl: 'https://acct.blob.core.windows.net',
      container: 'd365-keys',
    });
    expect(loadConfig({ ...base, MCP_API_KEY: 'k'.repeat(40) }).keyRegistry).toBeNull();
  });

  it('names what is missing or wrong', () => {
    expect(problems({ ...base })).toEqual([expect.stringContaining('or a key registry (MCP_KEY_REGISTRY)')]);
    expect(problems({ ...base, MCP_KEY_REGISTRY: 'file' })).toEqual([expect.stringMatching(/^MCP_KEY_REGISTRY_PATH: is required/)]);
    expect(problems({ ...base, MCP_KEY_REGISTRY: 'azure-blob', MCP_KEY_REGISTRY_ACCOUNT_URL: 'http://acct' })).toEqual([
      expect.stringMatching(/^MCP_KEY_REGISTRY_ACCOUNT_URL: must be the https:\/\//),
    ]);
    expect(
      problems({ ...base, MCP_KEY_REGISTRY: 'azure-blob', MCP_KEY_REGISTRY_ACCOUNT_URL: 'https://acct.blob.core.windows.net', MCP_KEY_REGISTRY_CONTAINER: 'Bad_Name' })
    ).toEqual([expect.stringMatching(/^MCP_KEY_REGISTRY_CONTAINER: /)]);
    expect(problems({ ...base, MCP_KEY_REGISTRY: 'vault' })).toHaveLength(1);
  });
});
