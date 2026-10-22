import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayConfigError, gatewayConfigSchema, loadGatewayConfig } from '../src/gateway/config.js';
import { containsPrivateName } from '../src/gateway/merge.js';

const HOSTED_KEY = 'hosted-secret-key-0123456789-abcdefghijklmnop';
const TOKEN = 'gateway-token-0123456789-abcdefghijklmnopqrstu';

let root: string;
let customDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-'));
  customDir = path.join(root, 'custom');
  fs.mkdirSync(customDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A complete environment confined to the temp dir; `undefined` overrides unset a variable. */
function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    D365_HOSTED_MCP_URL: 'https://d365.example.com/mcp',
    D365_HOSTED_API_KEY: HOSTED_KEY,
    D365_CUSTOM_METADATA_DIR: customDir,
    D365_LOCAL_INDEX_DB_PATH: path.join(root, 'state', 'custom_index.db'),
    D365_INDEX_DB_PATH: path.join(root, 'd365_index.db'),
    ...overrides,
  };
}

function loadError(env: NodeJS.ProcessEnv): GatewayConfigError {
  try {
    loadGatewayConfig(env);
  } catch (err) {
    if (err instanceof GatewayConfigError) return err;
    throw err;
  }
  throw new Error('Expected loadGatewayConfig to throw a GatewayConfigError.');
}

const problemsOf = (env: NodeJS.ProcessEnv): string[] => loadError(env).problems;

describe('loadGatewayConfig hosted URL', () => {
  it('requires https for a remote host', () => {
    expect(problemsOf(validEnv({ D365_HOSTED_MCP_URL: 'http://d365.example.com/mcp' }))).toEqual([
      expect.stringMatching(/^D365_HOSTED_MCP_URL: must use https:\/\//),
    ]);
    expect(problemsOf(validEnv({ D365_HOSTED_MCP_URL: 'ftp://d365.example.com/mcp' }))).toHaveLength(1);
  });

  it('accepts plain http for loopback hosts only', () => {
    for (const url of ['http://127.0.0.1:3000/mcp', 'http://localhost:3000/mcp', 'http://[::1]:3000/mcp']) {
      expect(loadGatewayConfig(validEnv({ D365_HOSTED_MCP_URL: url })).hostedUrl).toBe(url);
    }
    // Looks like loopback, resolves elsewhere.
    expect(problemsOf(validEnv({ D365_HOSTED_MCP_URL: 'http://127.0.0.1.evil.example/mcp' }))).toHaveLength(1);
    expect(problemsOf(validEnv({ D365_HOSTED_MCP_URL: 'http://localhost.evil.example/mcp' }))).toHaveLength(1);
  });

  it('appends /mcp when the URL has no path', () => {
    const urlFor = (hosted: string) => loadGatewayConfig(validEnv({ D365_HOSTED_MCP_URL: hosted })).hostedUrl;
    expect(urlFor('https://d365.example.com')).toBe('https://d365.example.com/mcp');
    expect(urlFor('https://d365.example.com/')).toBe('https://d365.example.com/mcp');
    expect(urlFor('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/mcp');
    expect(urlFor('https://d365.example.com/gateway/mcp')).toBe('https://d365.example.com/gateway/mcp');
  });

  it('requires the URL and rejects values that are not URLs', () => {
    expect(problemsOf(validEnv({ D365_HOSTED_MCP_URL: undefined }))).toEqual([
      expect.stringMatching(/^D365_HOSTED_MCP_URL: is required/),
    ]);
    expect(problemsOf(validEnv({ D365_HOSTED_MCP_URL: 'd365.example.com' }))).toEqual([
      expect.stringMatching(/^D365_HOSTED_MCP_URL: /),
    ]);
  });

  it('rejects credentials embedded in the URL without echoing them', () => {
    const error = loadError(validEnv({ D365_HOSTED_MCP_URL: 'https://user:hunter2-password@d365.example.com/mcp' }));
    expect(error.problems).toEqual([expect.stringMatching(/credentials/)]);
    expect(error.message).not.toContain('hunter2-password');
  });
});

describe('loadGatewayConfig hosted API key', () => {
  it('rejects setting both sources and setting neither', () => {
    const keyFile = path.join(root, 'hosted.key');
    fs.writeFileSync(keyFile, HOSTED_KEY);
    expect(problemsOf(validEnv({ D365_HOSTED_API_KEY_FILE: keyFile }))).toEqual([
      expect.stringMatching(/^D365_HOSTED_API_KEY: set either D365_HOSTED_API_KEY or D365_HOSTED_API_KEY_FILE, not both/),
    ]);
    expect(problemsOf(validEnv({ D365_HOSTED_API_KEY: undefined }))).toEqual([
      expect.stringMatching(/^D365_HOSTED_API_KEY: is required/),
    ]);
  });

  it('reads and trims the key file', () => {
    const keyFile = path.join(root, 'hosted.key');
    fs.writeFileSync(keyFile, `  ${HOSTED_KEY}\r\n`);
    const config = loadGatewayConfig(validEnv({ D365_HOSTED_API_KEY: undefined, D365_HOSTED_API_KEY_FILE: keyFile }));
    expect(config.hostedApiKey).toBe(HOSTED_KEY);
  });

  it('rejects an empty or unreadable key file', () => {
    const empty = path.join(root, 'empty.key');
    fs.writeFileSync(empty, ' \n');
    expect(problemsOf(validEnv({ D365_HOSTED_API_KEY: undefined, D365_HOSTED_API_KEY_FILE: empty }))).toEqual([
      expect.stringMatching(/^D365_HOSTED_API_KEY_FILE: the key file is empty/),
    ]);
    const missing = path.join(root, 'missing.key');
    expect(problemsOf(validEnv({ D365_HOSTED_API_KEY: undefined, D365_HOSTED_API_KEY_FILE: missing }))).toEqual([
      expect.stringMatching(/^D365_HOSTED_API_KEY_FILE: cannot read the key file \(ENOENT\)/),
    ]);
  });

  it('rejects a key that spans several lines', () => {
    const keyFile = path.join(root, 'two-lines.key');
    fs.writeFileSync(keyFile, `${HOSTED_KEY}\nsecond-line`);
    const error = loadError(validEnv({ D365_HOSTED_API_KEY: undefined, D365_HOSTED_API_KEY_FILE: keyFile }));
    expect(error.problems).toHaveLength(1);
    expect(error.message).not.toContain(HOSTED_KEY);
    expect(error.message).not.toContain('second-line');
  });

  it('does not echo the key when it was pasted into the file variable', () => {
    const error = loadError(validEnv({ D365_HOSTED_API_KEY: undefined, D365_HOSTED_API_KEY_FILE: HOSTED_KEY }));
    expect(error.problems).toHaveLength(1);
    expect(error.message).not.toContain(HOSTED_KEY);
  });
});

describe('loadGatewayConfig custom metadata dir', () => {
  it('requires an existing directory', () => {
    expect(problemsOf(validEnv({ D365_CUSTOM_METADATA_DIR: undefined }))).toEqual([
      expect.stringMatching(/^D365_CUSTOM_METADATA_DIR: is required/),
    ]);
    const missing = path.join(root, 'nope');
    expect(problemsOf(validEnv({ D365_CUSTOM_METADATA_DIR: missing }))).toEqual([
      `D365_CUSTOM_METADATA_DIR: directory does not exist: ${missing}`,
    ]);
    const file = path.join(root, 'a-file');
    fs.writeFileSync(file, '');
    expect(problemsOf(validEnv({ D365_CUSTOM_METADATA_DIR: file }))).toEqual([
      expect.stringMatching(/^D365_CUSTOM_METADATA_DIR: Not a directory/),
    ]);
  });

  it('falls back to the legacy D365_PROJECT_DIR and prefers D365_CUSTOM_METADATA_DIR', () => {
    const legacyDir = path.join(root, 'legacy');
    fs.mkdirSync(legacyDir);
    const legacy = loadGatewayConfig(validEnv({ D365_CUSTOM_METADATA_DIR: undefined, D365_PROJECT_DIR: legacyDir }));
    expect(legacy.customMetadataDir).toBe(fs.realpathSync(legacyDir));
    expect(legacy.workspace.customMetadataDir).toBe(legacy.customMetadataDir);

    const both = loadGatewayConfig(validEnv({ D365_PROJECT_DIR: legacyDir }));
    expect(both.customMetadataDir).toBe(fs.realpathSync(customDir));

    expect(problemsOf(validEnv({ D365_CUSTOM_METADATA_DIR: undefined, D365_PROJECT_DIR: path.join(root, 'nope') }))).toEqual([
      expect.stringMatching(/^D365_PROJECT_DIR: directory does not exist/),
    ]);
  });
});

describe('loadGatewayConfig local index path', () => {
  it('rejects the main index path, however it is spelled', () => {
    const main = path.join(root, 'd365_index.db');
    expect(problemsOf(validEnv({ D365_LOCAL_INDEX_DB_PATH: main }))).toEqual([
      expect.stringMatching(/^D365_LOCAL_INDEX_DB_PATH: must differ from D365_INDEX_DB_PATH/),
    ]);
    expect(problemsOf(validEnv({ D365_LOCAL_INDEX_DB_PATH: path.join(root, 'sub', '..', 'd365_index.db') }))).toHaveLength(1);
  });

  it('rejects a symlink to the main index', () => {
    const main = path.join(root, 'd365_index.db');
    fs.writeFileSync(main, '');
    const link = path.join(root, 'linked.db');
    try {
      fs.symlinkSync(main, link);
    } catch {
      return; // symlinks need elevated rights on some Windows setups
    }
    expect(problemsOf(validEnv({ D365_LOCAL_INDEX_DB_PATH: link }))).toHaveLength(1);
  });

  it('compares against the default main index path when D365_INDEX_DB_PATH is unset', () => {
    const defaultMain = path.resolve('./d365_index.db');
    expect(problemsOf(validEnv({ D365_INDEX_DB_PATH: undefined, D365_LOCAL_INDEX_DB_PATH: defaultMain }))).toHaveLength(1);
  });

  it('resolves the path and allows :memory:', () => {
    const relative = loadGatewayConfig(validEnv({ D365_LOCAL_INDEX_DB_PATH: 'rel/custom.db', D365_GATEWAY_TOKEN: TOKEN }));
    expect(relative.localIndexDbPath).toBe(path.resolve('rel/custom.db'));
    expect(fs.existsSync(path.resolve('rel'))).toBe(false);

    const memory = loadGatewayConfig(validEnv({ D365_LOCAL_INDEX_DB_PATH: ':memory:' }));
    expect(memory.localIndexDbPath).toBe(':memory:');
  });
});

describe('loadGatewayConfig token', () => {
  const tokenFile = () => path.join(root, 'state', 'gateway-token');

  it('generates a token, stores it beside the local index and reuses it', () => {
    const first = loadGatewayConfig(validEnv());
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tokenFile).toBe(tokenFile());
    expect(fs.readFileSync(tokenFile(), 'utf8').trim()).toBe(first.token);

    const second = loadGatewayConfig(validEnv());
    expect(second.token).toBe(first.token);
    expect(second.tokenFile).toBe(tokenFile());
  });

  it.skipIf(process.platform === 'win32')('stores the token with mode 0600', () => {
    loadGatewayConfig(validEnv());
    expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('tightens an existing token file that others can read', () => {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    fs.writeFileSync(tokenFile(), `${TOKEN}\n`, { mode: 0o644 });
    fs.chmodSync(tokenFile(), 0o644);
    expect(loadGatewayConfig(validEnv()).token).toBe(TOKEN);
    expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);
  });

  it('replaces a stored token that fails the rules', () => {
    fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
    for (const stale of ['', 'short', 'change-me-to-a-strong-random-secret-min-32-chars']) {
      fs.writeFileSync(tokenFile(), stale);
      const config = loadGatewayConfig(validEnv());
      expect(config.token).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.readFileSync(tokenFile(), 'utf8').trim()).toBe(config.token);
    }
    expect(fs.readdirSync(path.dirname(tokenFile()))).toEqual(['gateway-token']);
  });

  it('generates a different token for a different local index folder', () => {
    const other = loadGatewayConfig(validEnv({ D365_LOCAL_INDEX_DB_PATH: path.join(root, 'other', 'custom_index.db') }));
    expect(other.token).not.toBe(loadGatewayConfig(validEnv()).token);
  });

  it('uses D365_GATEWAY_TOKEN as given and writes no file', () => {
    const config = loadGatewayConfig(validEnv({ D365_GATEWAY_TOKEN: ` ${TOKEN} ` }));
    expect(config.token).toBe(TOKEN);
    expect(config.tokenFile).toBeNull();
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
  });

  it('keeps a generated token in memory for an in-memory index', () => {
    const config = loadGatewayConfig(validEnv({ D365_LOCAL_INDEX_DB_PATH: ':memory:' }));
    expect(config.token.length).toBeGreaterThanOrEqual(32);
    expect(config.tokenFile).toBeNull();
  });

  it('rejects a short, placeholder or whitespace-containing token without echoing it', () => {
    const short = loadError(validEnv({ D365_GATEWAY_TOKEN: 'shorttoken-secret' }));
    expect(short.problems).toEqual([expect.stringMatching(/^D365_GATEWAY_TOKEN: token is 17 characters; at least 32 are required/)]);
    expect(short.message).not.toContain('shorttoken-secret');

    const placeholder = 'change-me-to-a-strong-random-secret-min-32-chars';
    const placeholderError = loadError(validEnv({ D365_GATEWAY_TOKEN: placeholder }));
    expect(placeholderError.problems).toEqual([expect.stringMatching(/^D365_GATEWAY_TOKEN: token is a documentation placeholder/)]);
    expect(placeholderError.message).not.toContain(placeholder);

    const spaced = `${TOKEN} ${TOKEN}`;
    const spacedError = loadError(validEnv({ D365_GATEWAY_TOKEN: spaced }));
    expect(spacedError.problems).toEqual([expect.stringMatching(/whitespace/)]);
    expect(spacedError.message).not.toContain(TOKEN);
  });

  it('creates no token file when the configuration is invalid', () => {
    expect(problemsOf(validEnv({ D365_GATEWAY_PORT: '0' }))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('reports a token it cannot store', () => {
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, '');
    const error = loadError(validEnv({ D365_LOCAL_INDEX_DB_PATH: path.join(blocker, 'custom_index.db') }));
    expect(error.problems).toEqual([expect.stringMatching(/^D365_GATEWAY_TOKEN: cannot store the generated token/)]);
  });
});

describe('loadGatewayConfig standard index', () => {
  const withToken = (overrides: NodeJS.ProcessEnv) => validEnv({ D365_GATEWAY_TOKEN: TOKEN, ...overrides });

  it('is off unless set', () => {
    expect(loadGatewayConfig(withToken({})).standardIndexDbPath).toBeNull();
  });

  it('accepts an existing index file', () => {
    const file = path.join(root, 'standard.db');
    fs.writeFileSync(file, '');
    expect(loadGatewayConfig(withToken({ D365_GATEWAY_STANDARD_INDEX_DB_PATH: file })).standardIndexDbPath).toBe(file);
  });

  it('rejects a missing file, a folder, :memory: and the custom index itself', () => {
    const name = 'D365_GATEWAY_STANDARD_INDEX_DB_PATH';
    expect(problemsOf(withToken({ [name]: path.join(root, 'missing.db') }))).toEqual([
      expect.stringMatching(/^D365_GATEWAY_STANDARD_INDEX_DB_PATH: file does not exist/),
    ]);
    expect(problemsOf(withToken({ [name]: root }))).toEqual([expect.stringMatching(/: is not a file/)]);
    expect(problemsOf(withToken({ [name]: ':memory:' }))).toEqual([expect.stringMatching(/not :memory:/)]);
    const custom = path.join(root, 'custom_index.db');
    fs.writeFileSync(custom, '');
    expect(problemsOf(withToken({ [name]: custom, D365_LOCAL_INDEX_DB_PATH: custom }))).toEqual([
      expect.stringMatching(/must differ from D365_LOCAL_INDEX_DB_PATH/),
    ]);
  });
});

describe('loadGatewayConfig numeric settings', () => {
  it('applies the defaults', () => {
    const config = loadGatewayConfig(validEnv({ D365_GATEWAY_TOKEN: TOKEN }));
    expect(config).toMatchObject({
      hostedUrl: 'https://d365.example.com/mcp',
      hostedApiKey: HOSTED_KEY,
      customMetadataDir: fs.realpathSync(customDir),
      host: '127.0.0.1',
      port: 3101,
      appVersion: '',
      privatePrefixes: [],
      upstreamTimeoutMs: 15_000,
      reindexTtlMs: 30_000,
      workspace: {
        workspaceDir: '',
        customMetadataDir: fs.realpathSync(customDir),
        targetProject: '',
        targetPackage: '',
        targetModel: '',
        targetSolution: '',
      },
    });
  });

  it('defaults the local index to ./.d365/custom_index.db', () => {
    const config = loadGatewayConfig(validEnv({ D365_LOCAL_INDEX_DB_PATH: undefined, D365_GATEWAY_TOKEN: TOKEN }));
    expect(config.localIndexDbPath).toBe(path.resolve('./.d365/custom_index.db'));
  });

  it('accepts ports 1 to 65535 and nothing else', () => {
    for (const port of ['1', '3101', '65535']) {
      expect(loadGatewayConfig(validEnv({ D365_GATEWAY_PORT: port, D365_GATEWAY_TOKEN: TOKEN })).port).toBe(Number(port));
    }
    for (const port of ['0', '65536', '-1', '80.5', 'abc', '1e3', '0x50']) {
      expect(problemsOf(validEnv({ D365_GATEWAY_PORT: port }))).toEqual([
        'D365_GATEWAY_PORT: must be an integer from 1 to 65535',
      ]);
    }
  });

  it('bounds the upstream timeout and the reindex TTL', () => {
    const env = (overrides: NodeJS.ProcessEnv) => validEnv({ D365_GATEWAY_TOKEN: TOKEN, ...overrides });
    expect(loadGatewayConfig(env({ D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '1000' })).upstreamTimeoutMs).toBe(1000);
    expect(loadGatewayConfig(env({ D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '120000' })).upstreamTimeoutMs).toBe(120_000);
    expect(loadGatewayConfig(env({ D365_GATEWAY_REINDEX_TTL_MS: '1000' })).reindexTtlMs).toBe(1000);
    expect(loadGatewayConfig(env({ D365_GATEWAY_REINDEX_TTL_MS: '3600000' })).reindexTtlMs).toBe(3_600_000);

    expect(problemsOf(env({ D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '999' }))).toEqual([
      'D365_GATEWAY_UPSTREAM_TIMEOUT_MS: must be an integer from 1000 to 120000',
    ]);
    expect(problemsOf(env({ D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '120001' }))).toHaveLength(1);
    expect(problemsOf(env({ D365_GATEWAY_REINDEX_TTL_MS: '999' }))).toEqual([
      'D365_GATEWAY_REINDEX_TTL_MS: must be an integer from 1000 to 3600000',
    ]);
    expect(problemsOf(env({ D365_GATEWAY_REINDEX_TTL_MS: '3600001' }))).toHaveLength(1);
  });
});

describe('loadGatewayConfig optional settings', () => {
  it('parses private prefixes, the app version and the workspace settings', () => {
    const config = loadGatewayConfig(
      validEnv({
        D365_GATEWAY_TOKEN: TOKEN,
        D365_GATEWAY_PRIVATE_PREFIXES: ' Contoso, ,Fabrikam ,,',
        D365_APP_VERSION: ' 10.0.2645.136 ',
        D365_VISUAL_STUDIO_WORKSPACE_DIR: 'C:\\Repos\\Workspace',
        D365_TARGET_PROJECT: 'My.rnrproj',
        D365_TARGET_PACKAGE: 'MyPackage',
        D365_TARGET_MODEL: 'My Model',
        D365_TARGET_SOLUTION: 'My.sln',
      })
    );
    expect(config.privatePrefixes).toEqual(['Contoso', 'Fabrikam']);
    expect(config.appVersion).toBe('10.0.2645.136');
    expect(config.workspace).toMatchObject({
      workspaceDir: 'C:\\Repos\\Workspace',
      targetProject: 'My.rnrproj',
      targetPackage: 'MyPackage',
      targetModel: 'My Model',
      targetSolution: 'My.sln',
    });
  });
});

describe('loadGatewayConfig private prefixes', () => {
  const prefixesOf = (value: string) => loadGatewayConfig(validEnv({ D365_GATEWAY_TOKEN: TOKEN, D365_GATEWAY_PRIVATE_PREFIXES: value })).privatePrefixes;

  it('accepts plain identifier prefixes that the name filter can match', () => {
    for (const prefix of ['Contoso', 'contoso_', '_Contoso', 'Fabrikam2', 'Ärztehaus']) {
      const [accepted] = prefixesOf(prefix);
      expect(accepted).toBe(prefix);
      expect(containsPrivateName({ name: `${prefix}CustTable` }, [accepted]), prefix).toBe(true);
    }
  });

  it('rejects an entry that could never match instead of silently filtering nothing', () => {
    for (const prefix of ['Contoso*', '@Contoso', 'Contoso.', 'Contoso:', '3M', 'Contoso Ltd', 'Contoso-']) {
      // What makes them useless: the filter finds no identifier that starts with them.
      expect(containsPrivateName({ name: `${prefix}CustTable` }, [prefix]), prefix).toBe(false);
      expect(problemsOf(validEnv({ D365_GATEWAY_PRIVATE_PREFIXES: prefix })), prefix).toEqual([
        expect.stringMatching(/^D365_GATEWAY_PRIVATE_PREFIXES: entry 1 is not a plain name prefix/),
      ]);
    }
  });

  it('names each bad entry by position, keeps the good ones valid, and does not echo the values', () => {
    const problems = problemsOf(validEnv({ D365_GATEWAY_PRIVATE_PREFIXES: 'Contoso, @Fabrikam ,,Valid_,Fab*rikam' }));
    expect(problems).toEqual([
      expect.stringMatching(/^D365_GATEWAY_PRIVATE_PREFIXES: entry 2 /),
      expect.stringMatching(/^D365_GATEWAY_PRIVATE_PREFIXES: entry 4 /),
    ]);
    expect(problems.join('\n')).not.toMatch(/Fabrikam|Fab\*rikam/);
  });
});

describe('loadGatewayConfig error reporting', () => {
  it('reports every problem at once', () => {
    const error = loadError({
      D365_HOSTED_MCP_URL: 'http://d365.example.com/mcp',
      D365_CUSTOM_METADATA_DIR: path.join(root, 'nope'),
      D365_LOCAL_INDEX_DB_PATH: path.join(root, 'd365_index.db'),
      D365_INDEX_DB_PATH: path.join(root, 'd365_index.db'),
      D365_GATEWAY_PORT: '0',
      D365_GATEWAY_TOKEN: 'short',
      D365_GATEWAY_UPSTREAM_TIMEOUT_MS: '5',
      D365_GATEWAY_REINDEX_TTL_MS: 'soon',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GatewayConfigError');
    expect(error.problems.map((problem) => problem.split(':')[0]).sort()).toEqual([
      'D365_CUSTOM_METADATA_DIR',
      'D365_GATEWAY_PORT',
      'D365_GATEWAY_REINDEX_TTL_MS',
      'D365_GATEWAY_TOKEN',
      'D365_GATEWAY_UPSTREAM_TIMEOUT_MS',
      'D365_HOSTED_API_KEY',
      'D365_HOSTED_MCP_URL',
      'D365_LOCAL_INDEX_DB_PATH',
    ]);
    for (const problem of error.problems) expect(error.message).toContain(problem);
  });

  it('never puts the hosted key or the token in an error', () => {
    const secretToken = 'short-token-secret';
    const keyFile = path.join(root, 'hosted.key');
    fs.writeFileSync(keyFile, HOSTED_KEY);
    const broken: NodeJS.ProcessEnv[] = [
      validEnv({ D365_GATEWAY_TOKEN: secretToken, D365_GATEWAY_PORT: 'x', D365_HOSTED_MCP_URL: 'http://d365.example.com' }),
      validEnv({ D365_HOSTED_API_KEY_FILE: keyFile, D365_GATEWAY_TOKEN: secretToken }),
      validEnv({ D365_CUSTOM_METADATA_DIR: path.join(root, 'nope'), D365_LOCAL_INDEX_DB_PATH: path.join(root, 'd365_index.db') }),
    ];
    for (const env of broken) {
      const error = loadError(env);
      const text = `${error.message}\n${error.problems.join('\n')}\n${error.stack ?? ''}`;
      expect(text).not.toContain(HOSTED_KEY);
      expect(text).not.toContain(secretToken);
    }
  });
});

describe('gatewayConfigSchema', () => {
  it('validates without touching the token file', () => {
    const parsed = gatewayConfigSchema.safeParse(validEnv());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.token).toBeNull();
    expect(fs.existsSync(path.join(root, 'state'))).toBe(false);
  });

  it('ignores unrelated environment variables', () => {
    expect(gatewayConfigSchema.safeParse({ ...validEnv(), PATH: '/usr/bin', MCP_PORT: '3000' }).success).toBe(true);
  });
});
