import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVE_KEY_INPUT_ID,
  buildClientEntry,
  printClientEntry,
  printServeClientEntry,
  serveEndpoint,
} from '../src/utils/clientEntry.js';
import { parseApiKeys } from '../src/server/apiKeys.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Captures what the printer writes, one entry per call. */
function capture(): { writes: string[]; write: (text: string) => void } {
  const writes: string[] = [];
  return { writes, write: (text) => void writes.push(text) };
}

/** What the gateway printed for this entry before the printer was extracted, as compact JSON with its key order. */
const GATEWAY_ENTRY_JSON =
  '{"inputs":[{"id":"d365-gateway-token","type":"promptString","description":"D365 gateway token","password":true}],' +
  '"servers":{"d365-fno":{"type":"http","url":"http://127.0.0.1:3101/mcp","headers":{"Authorization":"Bearer ${input:d365-gateway-token}"}}}}';

describe('buildClientEntry', () => {
  it('gives an Authorization header with a Bearer prefix by default', () => {
    const entry = buildClientEntry({
      url: 'http://127.0.0.1:3101/mcp',
      inputId: 'some-input',
      inputDescription: 'Some description',
    });

    expect(entry.servers['d365-fno']?.headers).toEqual({ Authorization: 'Bearer ${input:some-input}' });
  });

  it('gives the bare input reference for an X-API-Key header, with no Bearer prefix', () => {
    const entry = buildClientEntry({
      url: 'http://localhost:3000/mcp',
      header: 'X-API-Key',
      inputId: 'd365-mcp-api-key',
      inputDescription: 'D365 FnO MCP API key',
    });

    expect(entry.servers['d365-fno']?.headers).toEqual({ 'X-API-Key': '${input:d365-mcp-api-key}' });
    expect(JSON.stringify(entry)).not.toContain('Bearer');
  });

  it('uses a custom entry name when one is given', () => {
    const entry = buildClientEntry({
      name: 'other-name',
      url: 'http://localhost:3000/mcp',
      inputId: 'id',
      inputDescription: 'description',
    });

    expect(Object.keys(entry.servers)).toEqual(['other-name']);
  });
});

describe('printClientEntry', () => {
  it('prints the gateway entry byte for byte', () => {
    const entry = buildClientEntry({
      name: 'd365-fno',
      url: 'http://127.0.0.1:3101/mcp',
      header: 'Authorization',
      inputId: 'd365-gateway-token',
      inputDescription: 'D365 gateway token',
    });
    const heading = 'D365 gateway listening on http://127.0.0.1:3101/mcp (hosted server: hosted.example.com)';
    const instruction =
      'Register it in place of the hosted d365-fno entry: .vscode/mcp.json for VS Code, .mcp.json for Visual Studio.';
    const notes = [
      'The token is the value of D365_GATEWAY_TOKEN.',
      'Other clients send the same URL with an "Authorization: Bearer <token>" header.',
    ];
    const { writes, write } = capture();

    printClientEntry({ heading, instruction, entry, notes }, write);

    expect(writes).toEqual([`${heading}\n`, instruction, JSON.stringify(entry, null, 2), `\n${notes.join('\n')}`]);
    const printed = JSON.parse(writes[2] ?? '') as unknown;
    expect(printed).toEqual({
      inputs: [{ id: 'd365-gateway-token', type: 'promptString', description: 'D365 gateway token', password: true }],
      servers: {
        'd365-fno': {
          type: 'http',
          url: 'http://127.0.0.1:3101/mcp',
          headers: { Authorization: 'Bearer ${input:d365-gateway-token}' },
        },
      },
    });
    // toEqual ignores key order; the compact form does not.
    expect(JSON.stringify(printed)).toBe(GATEWAY_ENTRY_JSON);
    expect(writes[2]).toBe(JSON.stringify(JSON.parse(GATEWAY_ENTRY_JSON), null, 2));
  });

  it('writes to the console by default', () => {
    const entry = buildClientEntry({ url: 'http://localhost:3000/mcp', inputId: 'id', inputDescription: 'description' });
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));

    printClientEntry({ heading: 'heading', instruction: 'instruction', entry, notes: ['note'] });

    expect(spy).toHaveBeenCalledTimes(4);
    expect(logged).toEqual(['heading\n', 'instruction', JSON.stringify(entry, null, 2), '\nnote']);
  });
});

describe('serveEndpoint', () => {
  it.each([
    // [configured host, port, address the socket reports, expected URL]
    ['', 3000, '::', 'http://localhost:3000/mcp'],
    ['', 3000, '0.0.0.0', 'http://localhost:3000/mcp'],
    ['0:0:0:0:0:0:0:0', 3000, '::', 'http://localhost:3000/mcp'],
    ['::0', 3000, '::', 'http://localhost:3000/mcp'],
    ['0', 3000, '0.0.0.0', 'http://localhost:3000/mcp'],
    ['127.0.0.1', 3000, '127.0.0.1', 'http://127.0.0.1:3000/mcp'],
    ['::1', 3000, '::1', 'http://[::1]:3000/mcp'],
    ['localhost', 3000, '::1', 'http://localhost:3000/mcp'],
    ['myvm', 8080, '10.0.0.4', 'http://myvm:8080/mcp'],
    ['fe80::1', 3000, 'fe80::1', 'http://[fe80::1]:3000/mcp'],
    // An empty host binds every interface, so a stray address can never produce an empty host name.
    ['', 3000, '10.0.0.4', 'http://localhost:3000/mcp'],
  ])('maps host %j and bound address %j to a URL a client can use', (host, port, boundAddress, expected) => {
    const url = serveEndpoint({ host, port, boundAddress });

    expect(url).toBe(expected);
    expect(() => new URL(url)).not.toThrow();
    expect(new URL(url).port).toBe(String(port));
  });

  it('falls back to the configured host when the socket address is not known', () => {
    expect(serveEndpoint({ host: '', port: 3000 })).toBe('http://localhost:3000/mcp');
    expect(serveEndpoint({ host: '127.0.0.1', port: 3000 })).toBe('http://127.0.0.1:3000/mcp');
    expect(serveEndpoint({ host: '::1', port: 3000 })).toBe('http://[::1]:3000/mcp');
  });

  it('judges a wildcard bind by the bound address, not by the spelling of the configured host', () => {
    // 'myvm' cannot be a wildcard spelling, but the socket says it listens on every interface.
    expect(serveEndpoint({ host: 'myvm', port: 3000, boundAddress: '0.0.0.0' })).toBe('http://localhost:3000/mcp');
  });
});

describe('printServeClientEntry', () => {
  /** Prints with a capturing writer and returns what was written as the console would show it. */
  function printed(options: Parameters<typeof printServeClientEntry>[0]): { writes: string[]; text: string } {
    const { writes, write } = capture();
    printServeClientEntry(options, write);
    return { writes, text: writes.map((chunk) => `${chunk}\n`).join('') };
  }

  /** The JSON object written between the instruction and the notes. */
  const entryOf = (writes: string[]) => JSON.parse(writes[2] ?? '') as ReturnType<typeof buildClientEntry>;

  it('says where the server listens and prints a paste-ready entry with a Bearer header', () => {
    const { writes, text } = printed({ host: '127.0.0.1', port: 4123, boundAddress: '127.0.0.1', apiKeyNames: ['default'] });

    expect(text).toContain('D365 MCP server listening on http://127.0.0.1:4123/mcp');
    expect(writes[0]).toBe('D365 MCP server listening on http://127.0.0.1:4123/mcp\n');
    expect(SERVE_KEY_INPUT_ID).toBe('d365-mcp-api-key');
    expect(entryOf(writes)).toEqual({
      inputs: [{ id: 'd365-mcp-api-key', type: 'promptString', description: 'D365 FnO MCP API key', password: true }],
      servers: {
        'd365-fno': {
          type: 'http',
          url: 'http://127.0.0.1:4123/mcp',
          headers: { Authorization: 'Bearer ${input:d365-mcp-api-key}' },
        },
      },
    });
    expect(text).toContain('Bearer ${input:d365-mcp-api-key}');
  });

  it('says the entry replaces any existing d365-fno entry instead of adding a second one', () => {
    const { text } = printed({ host: '', port: 3000, boundAddress: '::', apiKeyNames: ['default'] });

    expect(text).toContain('replaces any existing "d365-fno" entry');
    expect(text).toContain('.vscode/mcp.json');
    expect(text).toContain('.mcp.json');
  });

  it('says where the key comes from when the only key is the one named default', () => {
    const { text } = printed({ host: '', port: 3000, boundAddress: '::', apiKeyNames: ['default'] });

    expect(text).toContain('The key is MCP_API_KEY (setup saves it in your .env file), or the key named default in MCP_API_KEYS; it is not printed.');
    expect(text).not.toContain('accepts');
  });

  it('names the keys and their count when the server has named keys', () => {
    const { text } = printed({ host: '', port: 3000, boundAddress: '::', apiKeyNames: ['alice', 'bob'] });

    expect(text).toContain('This server accepts 2 API keys (alice, bob). Enter your own; key values are never printed.');
    expect(text).not.toContain('MCP_API_KEY');
  });

  it('uses the singular for one named key', () => {
    const { text } = printed({ host: '', port: 3000, boundAddress: '::', apiKeyNames: ['alice'] });

    expect(text).toContain('This server accepts 1 API key (alice).');
  });

  it('names a legacy key that sits beside named keys like any other key', () => {
    const { text } = printed({ host: '', port: 3000, boundAddress: '::', apiKeyNames: ['default', 'alice'] });

    expect(text).toContain('This server accepts 2 API keys (default, alice).');
  });

  it('tells other clients about the Authorization and X-API-Key headers', () => {
    const { text } = printed({ host: '127.0.0.1', port: 3000, boundAddress: '127.0.0.1', apiKeyNames: ['default'] });

    expect(text).toContain('Other clients send the same URL with an "Authorization: Bearer <key>" header (X-API-Key also works).');
  });

  it.each([
    ['every interface (IPv6 wildcard)', '', '::'],
    ['every interface (IPv4 wildcard)', '0.0.0.0', '0.0.0.0'],
  ])('adds the localhost note when the server listens on %s', (_label, host, boundAddress) => {
    const { text } = printed({ host, port: 3000, boundAddress, apiKeyNames: ['default'] });

    expect(text).toContain("replace localhost with this machine's name when connecting from another machine");
  });

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['localhost', '::1'],
    ['myvm', '10.0.0.4'],
  ])('leaves the localhost note out when the server binds %s', (host, boundAddress) => {
    const { text } = printed({ host, port: 3000, boundAddress, apiKeyNames: ['default'] });

    expect(text).not.toContain('replace localhost');
  });

  it('decides the note from the configured host when the socket address is not known', () => {
    expect(printed({ host: '', port: 3000, apiKeyNames: ['default'] }).text).toContain('replace localhost');
    expect(printed({ host: '127.0.0.1', port: 3000, apiKeyNames: ['default'] }).text).not.toContain('replace localhost');
  });

  it('never prints a key value: it takes key names only', () => {
    const key = 'k'.repeat(40);
    const { keys } = parseApiKeys(undefined, key);
    expect(keys).toHaveLength(1);

    const { text } = printed({ host: '', port: 3000, boundAddress: '::', apiKeyNames: keys.map((entry) => entry.name) });

    expect(text).not.toContain(key);
    // @ts-expect-error a key entry carries the secret and must not be accepted where only names belong
    printServeClientEntry({ host: '', port: 3000, apiKeyNames: keys }, () => undefined);
  });

  it('writes to the console by default, as one block per write', () => {
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));

    printServeClientEntry({ host: '127.0.0.1', port: 3000, boundAddress: '127.0.0.1', apiKeyNames: ['default'] });

    expect(logged).toHaveLength(4);
    expect(logged[0]).toBe('D365 MCP server listening on http://127.0.0.1:3000/mcp\n');
  });
});

describe('import boundary', () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  /** Modules that validate the server's environment eagerly and exit the process on a problem. */
  const forbidden = ['config.js', 'configLoader.js', path.join('server', 'start.js')].map((file) => path.join(srcRoot, file));

  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
      item.isDirectory() ? sourceFiles(path.join(dir, item.name)) : item.name.endsWith('.ts') ? [path.join(dir, item.name)] : []
    );

  /** Absolute paths (with the `.js` suffix as written) of every relative module a file imports. */
  function relativeImports(file: string): string[] {
    const specifiers = [...fs.readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"](\.[^'"]*)['"]/g)];
    return specifiers.map((match) => path.resolve(path.dirname(file), match[1] ?? ''));
  }

  it('keeps the shared client entry and the gateway free of the eagerly validated server modules', () => {
    const files = [path.join(srcRoot, 'utils', 'clientEntry.ts'), ...sourceFiles(path.join(srcRoot, 'gateway'))];
    expect(files.length).toBeGreaterThan(1);

    const offenders = files.flatMap((file) =>
      relativeImports(file)
        .filter((target) => forbidden.includes(target))
        .map((target) => `${path.relative(srcRoot, file)} imports ${path.relative(srcRoot, target)}`)
    );

    expect(offenders).toEqual([]);
  });

  it('reads the imports of the modules it checks', () => {
    // The gateway has its own config.js; the guard must see it and tell it from src/config.js.
    const imports = relativeImports(path.join(srcRoot, 'gateway', 'server.ts'));
    expect(imports).toContain(path.join(srcRoot, 'gateway', 'config.js'));
    expect(imports).toContain(path.join(srcRoot, 'utils', 'clientEntry.js'));
    expect(imports).not.toContain(path.join(srcRoot, 'config.js'));
  });
});
