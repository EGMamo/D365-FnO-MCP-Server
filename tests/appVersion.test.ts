import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHttpApp, type SessionContext } from '../src/server/httpTransport.js';
import {
  buildSessionInstructions,
  classifySdkDrift,
  compareAppVersions,
  detectAppVersionFromPackagesDir,
  parseAppVersion,
  readDeclaredClientVersion,
  CLIENT_SDK_VERSION_HEADER,
} from '../src/indexer/appVersion.js';

const INDEX_VERSION = '10.0.2645.136';

describe('parseAppVersion', () => {
  it('parses a four-part version', () => {
    expect(parseAppVersion('10.0.2645.136')).toMatchObject({
      major: 10, minor: 0, build: 2645, revision: 136, text: '10.0.2645.136',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseAppVersion('  10.0.2645.136 ')?.text).toBe('10.0.2645.136');
  });

  it('normalises leading zeroes so padded and unpadded versions compare equal', () => {
    expect(parseAppVersion('10.00.2645.0136')?.text).toBe('10.0.2645.136');
  });

  // A three-part marketing version is not silently widened: guessing the
  // missing part would produce a confident but wrong comparison.
  it.each([
    ['three parts', '10.0.39'],
    ['five parts', '10.0.2645.136.1'],
    ['non-numeric', 'PU63'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['trailing text', '10.0.2645.136-preview'],
  ])('rejects %s', (_label, value) => {
    expect(parseAppVersion(value)).toBeNull();
  });

  it.each([null, undefined, 42, {}])('rejects the non-string %s', (value) => {
    expect(parseAppVersion(value as unknown as string)).toBeNull();
  });
});

describe('compareAppVersions', () => {
  const v = (text: string) => parseAppVersion(text)!;

  it('orders by each part in turn', () => {
    expect(compareAppVersions(v('10.0.2541.0'), v('10.0.2645.0'))).toBeLessThan(0);
    expect(compareAppVersions(v('10.0.2645.200'), v('10.0.2645.136'))).toBeGreaterThan(0);
    expect(compareAppVersions(v('10.0.2645.136'), v('10.0.2645.136'))).toBe(0);
  });

  it('compares numerically rather than lexically', () => {
    // '9' sorts after '10' as text; as numbers it must sort before.
    expect(compareAppVersions(v('10.0.9.0'), v('10.0.10.0'))).toBeLessThan(0);
  });
});

describe('detectAppVersionFromPackagesDir', () => {
  it('reads the version from the UDE layout', () => {
    const dir = path.join('C:', 'Users', 'dev', 'AppData', 'Local', 'Microsoft', 'Dynamics365', INDEX_VERSION, 'PackagesLocalDirectory');
    expect(detectAppVersionFromPackagesDir(dir)).toBe(INDEX_VERSION);
  });

  it('prefers the nearest version-shaped ancestor', () => {
    const dir = path.join(path.sep, 'sdk', '10.0.1000.1', 'nested', INDEX_VERSION, 'PackagesLocalDirectory');
    expect(detectAppVersionFromPackagesDir(dir)).toBe(INDEX_VERSION);
  });

  it('returns null for a classic AOS layout that does not name a version', () => {
    expect(detectAppVersionFromPackagesDir(path.join(path.sep, 'AosService', 'PackagesLocalDirectory'))).toBeNull();
  });

  it.each([null, undefined, '', '   '])('returns null for %s', (value) => {
    expect(detectAppVersionFromPackagesDir(value)).toBeNull();
  });
});

describe('classifySdkDrift', () => {
  it('reports a match when the versions are equal', () => {
    expect(classifySdkDrift(INDEX_VERSION, INDEX_VERSION)).toMatchObject({ code: 'match', severity: 'none' });
  });

  // A different build is a different release wave, where objects genuinely
  // appear and disappear, so this is the only case raised to `warning`.
  it('warns when the client is an older build', () => {
    expect(classifySdkDrift('10.0.2541.21', INDEX_VERSION)).toMatchObject({
      code: 'older-build',
      severity: 'warning',
      clientVersion: '10.0.2541.21',
      indexVersion: INDEX_VERSION,
    });
  });

  // Hotfix drift happens constantly; warning at full strength would train
  // users to ignore the message.
  it('only raises a notice when the client is an older revision of the same build', () => {
    expect(classifySdkDrift('10.0.2645.100', INDEX_VERSION)).toMatchObject({
      code: 'older-revision',
      severity: 'notice',
    });
  });

  it('notes a stale index when the client is newer', () => {
    expect(classifySdkDrift('10.0.2700.1', INDEX_VERSION)).toMatchObject({
      code: 'client-newer',
      severity: 'notice',
    });
  });

  it('does not compare when the client declared nothing', () => {
    expect(classifySdkDrift(null, INDEX_VERSION)).toMatchObject({
      code: 'client-unknown',
      severity: 'info',
      clientVersion: null,
      declaredClientVersion: null,
    });
  });

  it('keeps an unparseable declaration verbatim without comparing', () => {
    expect(classifySdkDrift('PU63', INDEX_VERSION)).toMatchObject({
      code: 'client-unknown',
      severity: 'info',
      clientVersion: null,
      declaredClientVersion: 'PU63',
    });
  });

  it('does not compare when the index records no version', () => {
    expect(classifySdkDrift(INDEX_VERSION, null)).toMatchObject({
      code: 'index-unknown',
      severity: 'info',
      indexVersion: null,
    });
  });
});

describe('buildSessionInstructions', () => {
  it('states the indexed version even when nothing is declared', () => {
    const { text, drift } = buildSessionInstructions({ indexVersion: INDEX_VERSION });
    expect(text).toContain(INDEX_VERSION);
    expect(text).toContain(CLIENT_SDK_VERSION_HEADER);
    expect(drift.code).toBe('client-unknown');
  });

  it('includes the build timestamp when known', () => {
    const { text } = buildSessionInstructions({ indexVersion: INDEX_VERSION, builtAt: '2024-06-01T00:00:00.000Z' });
    expect(text).toContain('2024-06-01T00:00:00.000Z');
  });

  it('warns loudly when the client is an older build', () => {
    const { text, drift } = buildSessionInstructions({ indexVersion: INDEX_VERSION, clientVersion: '10.0.2541.21' });
    expect(drift.severity).toBe('warning');
    expect(text).toContain('WARNING');
    expect(text).toContain('10.0.2541.21');
    expect(text).toContain(INDEX_VERSION);
  });

  it('does not warn when the versions match', () => {
    const { text, drift } = buildSessionInstructions({ indexVersion: INDEX_VERSION, clientVersion: INDEX_VERSION });
    expect(drift.severity).toBe('none');
    expect(text).not.toContain('WARNING');
    expect(text).not.toContain('NOTICE');
  });

  it('uses a notice rather than a warning for revision-only drift', () => {
    const { text } = buildSessionInstructions({ indexVersion: INDEX_VERSION, clientVersion: '10.0.2645.100' });
    expect(text).toContain('NOTICE');
    expect(text).not.toContain('WARNING');
  });

  it('says a comparison is impossible when the index records no version', () => {
    const { text } = buildSessionInstructions({ indexVersion: null, clientVersion: INDEX_VERSION });
    expect(text).toContain('does not record');
    expect(text).not.toContain('WARNING');
  });
});

describe('readDeclaredClientVersion', () => {
  it('reads a single header value', () => {
    expect(readDeclaredClientVersion({ [CLIENT_SDK_VERSION_HEADER]: ` ${INDEX_VERSION} ` })).toBe(INDEX_VERSION);
  });

  it('accepts a one-element array', () => {
    expect(readDeclaredClientVersion({ [CLIENT_SDK_VERSION_HEADER]: [INDEX_VERSION] })).toBe(INDEX_VERSION);
  });

  // A repeated header is ambiguous; picking one would be arbitrary.
  it('rejects a repeated header', () => {
    expect(readDeclaredClientVersion({ [CLIENT_SDK_VERSION_HEADER]: [INDEX_VERSION, '10.0.1.1'] })).toBeNull();
  });

  it('returns null for a missing or blank header', () => {
    expect(readDeclaredClientVersion({})).toBeNull();
    expect(readDeclaredClientVersion({ [CLIENT_SDK_VERSION_HEADER]: '   ' })).toBeNull();
  });

  // The value is attacker-controlled and ends up in instructions and logs.
  it('caps an absurdly long value', () => {
    const value = readDeclaredClientVersion({ [CLIENT_SDK_VERSION_HEADER]: 'x'.repeat(500) });
    expect(value).toHaveLength(64);
  });
});

describe('the HTTP transport passes the declared version to the server factory', () => {
  const API_KEY = 'test-api-key-1234567890-abcdefghijklmnop';
  const started: Server[] = [];

  async function initialize(headers: Record<string, string>): Promise<SessionContext | undefined> {
    let seen: SessionContext | undefined;
    const app = createHttpApp(
      (context) => {
        seen = context;
        return new McpServer({ name: 'test', version: '0.0.0' });
      },
      {
        port: 0,
        apiKeys: [{ name: 'test', key: API_KEY }],
        version: '0.1.0',
        rateLimitMaxRequests: 10_000,
        rateLimitWindowMs: 60_000,
        requestTimeoutMs: 5_000,
      },
    );
    const server = await new Promise<Server>((resolve) => {
      const created = app.listen(0, () => resolve(created));
    });
    started.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-Key': API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } },
      }),
    });
    await res.text();
    server.close();
    return seen;
  }

  it('forwards the declared SDK version', async () => {
    const context = await initialize({ [CLIENT_SDK_VERSION_HEADER]: '10.0.2541.21' });
    expect(context?.clientSdkVersion).toBe('10.0.2541.21');
  });

  it('forwards null when the client declares nothing', async () => {
    const context = await initialize({});
    expect(context?.clientSdkVersion).toBeNull();
  });
});
