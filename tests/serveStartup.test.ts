import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repoRoot, 'src', 'index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
/** 40 characters, so a leak of the key is easy to spot and the key passes the length check. */
const apiKey = 'serve-startup-test-only-key-'.padEnd(40, '0');
const LISTENING_LOG = 'MCP HTTP transport listening';
const TIMEOUT_MS = 120_000;
const WAIT_MS = 90_000;

interface Serve {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
}

let root: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-serve-startup-'));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Runs `serve` from source in a temp directory, so no repo `.env` is loaded and nothing needs a build. */
function startServe(extraEnv: Record<string, string> = {}): Serve {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string' && !/^(D365_|MCP_|DOTENV_)/.test(pair[0])
    )
  );
  const child = spawn(process.execPath, ['--import', tsx, entry, 'serve'], {
    cwd: root,
    env: {
      ...inherited,
      MCP_API_KEY: apiKey,
      MCP_PORT: '0',
      D365_INDEX_DB_PATH: path.join(root, 'index.db'),
      D365_KNOWLEDGE_FILTER: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

/** The complete lines of a stream; a partly received last line is left out. */
const completeLines = (text: string): string[] => text.split('\n').slice(0, -1);

/** The port in the structured listening line, or null while it has not been logged. */
function listeningPort(stderr: string): number | null {
  for (const line of completeLines(stderr)) {
    if (!line.startsWith('{')) continue;
    const parsed = JSON.parse(line) as { message?: string; port?: number };
    if (parsed.message === LISTENING_LOG && typeof parsed.port === 'number') return parsed.port;
  }
  return null;
}

/** Polls until `probe` returns a value; rejects with the server's log when it exits first or time runs out. */
async function waitFor<T>(serve: Serve, probe: () => T | null, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    const { exitCode, signalCode } = serve.child;
    if (exitCode !== null || signalCode !== null) {
      throw new Error(`serve exited (${exitCode ?? signalCode}) before ${what}. Log:\n${serve.stderr()}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. Log:\n${serve.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Stops the server and waits until its output streams are closed, so the assertions see all of it. */
async function stop(serve: Serve): Promise<void> {
  if (serve.child.exitCode !== null || serve.child.signalCode !== null) return;
  const closed = once(serve.child, 'close');
  serve.child.kill('SIGTERM');
  await closed;
}

/** The pretty-printed JSON object in the output: it starts on a line of its own and ends at the first `}` in column 0. */
function printedEntry(stdout: string): { servers: Record<string, unknown> } {
  const match = /^\{$[\s\S]*?^\}$/m.exec(stdout);
  if (!match) throw new Error('No client entry found in the output.');
  return JSON.parse(match[0]) as { servers: Record<string, unknown> };
}

/** The structured log must stay one JSON object per line: the entry belongs on stdout, never between them. */
function expectStructuredLog(stderr: string): void {
  const objects = completeLines(stderr).filter((line) => line.startsWith('{'));
  expect(objects.length).toBeGreaterThan(0);
  for (const line of objects) expect(() => JSON.parse(line)).not.toThrow();
}

describe('serve startup output', () => {
  it('serve prints the MCP URL and a paste-ready entry once listening', async () => {
    const serve = startServe();
    const port = await waitFor(serve, () => listeningPort(serve.stderr()), 'the listening log line');
    const url = `http://localhost:${port}/mcp`;

    // The last line of the output: a server on every interface also says what to do from another machine.
    const stdout = await waitFor(
      serve,
      () => (serve.stdout().includes('when connecting from another machine.') ? serve.stdout() : null),
      'the printed client entry'
    );
    await stop(serve);

    expect(stdout).toContain(`D365 MCP server listening on ${url}`);
    expect(stdout).toContain('Bearer ${input:d365-mcp-api-key}');
    expect(stdout).toContain('The key is MCP_API_KEY (setup saves it in your .env file), or the key named default in MCP_API_KEYS; it is not printed.');
    expect(printedEntry(stdout).servers['d365-fno']).toEqual({
      type: 'http',
      url,
      headers: { Authorization: 'Bearer ${input:d365-mcp-api-key}' },
    });
    expect(serve.stdout().includes(apiKey)).toBe(false);
    expect(serve.stderr().includes(apiKey)).toBe(false);
    expectStructuredLog(serve.stderr());
  }, TIMEOUT_MS);

  it('prints the host the server was told to bind', async () => {
    const serve = startServe({ MCP_HOST: '127.0.0.1' });
    const port = await waitFor(serve, () => listeningPort(serve.stderr()), 'the listening log line');
    const url = `http://127.0.0.1:${port}/mcp`;

    const stdout = await waitFor(
      serve,
      () => (serve.stdout().includes('(X-API-Key also works).') ? serve.stdout() : null),
      'the printed client entry'
    );
    await stop(serve);

    expect(stdout).toContain(`D365 MCP server listening on ${url}`);
    expect(printedEntry(stdout).servers['d365-fno']).toMatchObject({ url });
    // Bound to one interface, so the URL is already the one to use.
    expect(stdout).not.toContain('replace localhost');
    expect(serve.stdout().includes(apiKey)).toBe(false);
    expect(serve.stderr().includes(apiKey)).toBe(false);
  }, TIMEOUT_MS);

  it('prints nothing in hosted artifact mode, where the listener is not ready to serve', async () => {
    const serve = startServe({
      D365_ARTIFACT_STORE_PATH: path.join(root, 'empty-artifacts'),
      D365_INDEX_DB_PATH: path.join(root, 'hosted', 'd365_index.db'),
    });

    const [code] = (await once(serve.child, 'close')) as [number | null];

    expect(code).toBe(1);
    // It did get as far as listening, which is where `serve` would have printed the entry.
    expect(listeningPort(serve.stderr())).not.toBeNull();
    expect(serve.stdout()).toBe('');
  }, TIMEOUT_MS);

  it('prints nothing when the port is already taken', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    try {
      const address = occupied.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener.');
      const serve = startServe({ MCP_HOST: '127.0.0.1', MCP_PORT: String(address.port) });

      const [code] = (await once(serve.child, 'close')) as [number | null];

      expect(code).toBe(1);
      expect(serve.stderr()).toContain('EADDRINUSE');
      expect(serve.stdout()).toBe('');
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
    }
  }, TIMEOUT_MS);
});
