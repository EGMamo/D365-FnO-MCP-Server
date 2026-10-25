import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import { stripVTControlCharacters } from 'util';
import { parse } from 'dotenv';
import { gatewayConfigSchema } from '../src/gateway/config.js';
import { normalizePathAnswer, setupCommand, type SetupOptions } from '../src/cli/setup.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const HOSTED_URL = 'https://hosted.example.com/mcp';
const HOSTED_KEY = 'hosted-key-0123456789-abcdef';

/** A <Package>/<Model>/AxTable/<Name>.xml tree under `root`, enough for the metadata checks to pass. */
function stageMetadata(root: string): string {
  const dir = path.join(root, 'TestPackage', 'TestModel', 'AxTable');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, 'AxTableSample.xml'), path.join(dir, 'SampleTable.xml'));
  return root;
}

interface Session {
  code: number;
  /** What the prompts wrote to the injected output stream. */
  out: string;
  /** Everything setup reported through console.log / console.warn / console.error. */
  logs: string;
  errors: string;
  cwd: string;
  envText: string | null;
  env: Record<string, string>;
  runDoctor: ReturnType<typeof vi.fn>;
  runIndex: ReturnType<typeof vi.fn>;
}

/** A fake terminal: `isTTY` and a raw-mode stub, so readline takes its terminal path. */
function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => unknown } {
  return Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
}

/**
 * Types each answer only once its question is on screen, as a person does. Answers typed ahead are never
 * echoed, so a test that feeds them all at once cannot tell a hidden prompt from a visible one.
 */
function typeWhenAsked(input: PassThrough, output: PassThrough, steps: Array<[question: string, answer: string]>): void {
  let seen = '';
  let next = 0;
  output.on('data', (chunk: Buffer | string) => {
    seen += stripVTControlCharacters(String(chunk));
    const answers: string[] = [];
    while (next < steps.length && seen.includes(steps[next][0])) {
      const [question, answer] = steps[next];
      next += 1;
      seen = seen.slice(seen.indexOf(question) + question.length);
      answers.push(answer);
    }
    // On the next tick, like a person: typing from inside the output handler would run while readline is still
    // writing the question, and its echo would reach the muted sink only after the Enter had muted it again.
    if (answers.length > 0) {
      setImmediate(() => {
        for (const answer of answers) {
          for (const char of answer) input.write(char);
          input.write('\r');
        }
      });
    }
  });
}

function typeLine(input: PassThrough, text: string, terminal: boolean): void {
  if (!terminal) {
    input.write(`${text}\n`);
    return;
  }
  for (const char of text) input.write(char);
  input.write('\r');
}

describe('setup (interactive)', () => {
  let root: string;
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'setup-interactive-')));
    logged = [];
    errored = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void logged.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errored.push(args.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Runs setup with `answers` fed to the prompt in a single write, so every test also covers piped input
   * that arrives before the first question is asked. `tty` feeds a fake terminal key by key instead.
   */
  async function runSetup(
    answers: string[],
    options: Partial<SetupOptions> & {
      tty?: boolean;
      end?: boolean;
      after?: (input: PassThrough) => void;
      /** Takes over feeding the input, instead of writing `answers` up front. */
      drive?: (input: PassThrough, output: PassThrough) => void;
    } = {}
  ): Promise<Session> {
    const { tty = false, end = false, after, drive, ...rest } = options;
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const input = tty ? fakeTty() : new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (chunk) => (out += String(chunk)));
    for (const answer of answers) typeLine(input, answer, tty);
    if (drive) drive(input, output);
    if (after) after(input);
    if (end) input.end();

    const runDoctor = vi.fn().mockResolvedValue(0);
    const runIndex = vi.fn().mockResolvedValue(0);
    const code = await setupCommand({
      nonInteractive: false,
      cwd,
      input,
      output,
      terminal: tty,
      runDoctor,
      runIndex,
      ...rest,
    });
    const envPath = path.join(cwd, '.env');
    const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : null;
    return {
      code,
      out,
      logs: logged.join('\n'),
      errors: errored.join('\n'),
      cwd,
      envText,
      env: envText === null ? {} : parse(envText),
      runDoctor,
      runIndex,
    };
  }

  describe('local mode', () => {
    it('writes a loopback-bound .env, then runs the checks and the index it was asked for', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', packages, '', '', 'y', 'y', 'y']);

      expect(session.code).toBe(0);
      expect(session.env.MCP_TRANSPORT).toBe('http');
      expect(session.env.MCP_PORT).toBe('3000');
      expect(session.env.MCP_HOST).toBe('127.0.0.1');
      expect(session.env.MCP_API_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(session.env.D365_PACKAGES_DIR).toBe(packages);
      expect(session.env.D365_INDEX_DB_PATH).toBe('./d365_index.db');
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(session.cwd, '.env')).mode & 0o777).toBe(0o600);
      }

      expect(session.runDoctor).toHaveBeenCalledTimes(1);
      const [doctorEnv] = session.runDoctor.mock.calls[0] as [NodeJS.ProcessEnv];
      expect(doctorEnv.MCP_API_KEY).toBe(session.env.MCP_API_KEY);
      expect(doctorEnv.D365_PACKAGES_DIR).toBe(packages);
      expect(doctorEnv.D365_INDEX_DB_PATH).toBe(path.join(session.cwd, 'd365_index.db'));

      expect(session.runIndex).toHaveBeenCalledTimes(1);
      const [indexOptions] = session.runIndex.mock.calls[0] as [{ packagesDir: string; dbPath: string }];
      expect(indexOptions).toEqual({ packagesDir: packages, dbPath: path.join(session.cwd, 'd365_index.db') });

      expect(session.logs).toContain('Wrote ');
      expect(session.logs).toContain('Next: run `d365-fno-mcp-server serve`.');
      expect(session.logs).not.toContain(session.env.MCP_API_KEY);
      expect(session.out).not.toContain(session.env.MCP_API_KEY);
    });

    it('does not bind to loopback when the developer answers no', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', packages, '', '', 'n', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.env).not.toHaveProperty('MCP_HOST');
    });

    it('names the steps still to run when the follow-ups are declined', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', packages, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.runDoctor).not.toHaveBeenCalled();
      expect(session.runIndex).not.toHaveBeenCalled();
      expect(session.logs).toContain(
        'Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server index`, then `d365-fno-mcp-server serve`.'
      );
    });

    it('re-asks a packages folder that fails its check, saying why', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const missing = path.join(root, 'nowhere');
      const session = await runSetup(['1', missing, packages, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain(missing);
      expect(session.out.toLowerCase()).toContain('does not exist');
      expect(session.env.D365_PACKAGES_DIR).toBe(packages);
    });

    it('re-asks a blank packages folder instead of asking doctor to explain it', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', '', packages, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).not.toContain('Run `d365-fno-mcp-server setup`');
      expect(session.env.D365_PACKAGES_DIR).toBe(packages);
    });

    it('re-asks a short typed key without quoting it', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const typed = 'tooShortKey9';
      const session = await runSetup(['1', packages, typed, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('at least 32');
      expect(session.out).not.toContain(typed);
      expect(session.logs).not.toContain(typed);
      expect(session.env.MCP_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    });

    it('keeps a typed key of 32 or more characters', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const key = 'k'.repeat(40);
      const session = await runSetup(['1', packages, key, '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.env.MCP_API_KEY).toBe(key);
    });

    it('accepts a folder pasted with surrounding quotes and writes the unquoted path', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', `"${packages}"`, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_PACKAGES_DIR).toBe(packages);
    });

    it('reads a packages folder whose name holds a space and a hash back unchanged', async () => {
      const packages = stageMetadata(path.join(root, 'Packages Local #2'));
      const session = await runSetup(['1', packages, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_PACKAGES_DIR).toBe(packages);
    });

    it('re-asks an answer to the first question that is neither 1 nor 2', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['3', '1', packages, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_PACKAGES_DIR).toBe(packages);
    });

    it('judges the new answers, not the .env that was already loaded into process.env', async () => {
      vi.stubEnv('D365_HOSTED_MCP_URL', 'https://stale.example.com/mcp');
      vi.stubEnv('MCP_API_KEYS', 'old=' + 'o'.repeat(40));
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', packages, '', '', 'y', 'n', 'y']);

      expect(session.code).toBe(0);
      const [doctorEnv] = session.runDoctor.mock.calls[0] as [NodeJS.ProcessEnv];
      expect(doctorEnv.D365_HOSTED_MCP_URL).toBeUndefined();
      expect(doctorEnv.MCP_API_KEYS).toBeUndefined();
    });

    it('builds the index before it runs the checks, so the checks judge the finished setup', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const order: string[] = [];
      const session = await runSetup(['1', packages, '', '', 'y', 'y', 'y'], {
        runIndex: vi.fn(async () => (order.push('index'), 0)),
        runDoctor: vi.fn(async () => (order.push('doctor'), 0)),
      });

      expect(session.code).toBe(0);
      expect(order).toEqual(['index', 'doctor']);
    });

    it('keeps .env and still exits 0 when a follow-up reports failures, naming the retry', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const runDoctor = vi.fn().mockResolvedValue(1);
      const session = await runSetup(['1', packages, '', '', 'y', 'n', 'y'], { runDoctor });

      expect(session.code).toBe(0);
      expect(session.envText).not.toBeNull();
      expect(session.logs).toContain('`d365-fno-mcp-server doctor`');
      expect(session.logs).toContain('`d365-fno-mcp-server index`');
    });

    it('keeps .env and still exits 0 when the index run fails', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const runIndex = vi.fn().mockResolvedValue(1);
      const session = await runSetup(['1', packages, '', '', 'y', 'y', 'n'], { runIndex });

      expect(session.code).toBe(0);
      expect(session.envText).not.toBeNull();
      expect(session.logs).toContain('`d365-fno-mcp-server index`');
    });
  });

  describe('local mode: index path, defaults, terminal and secrets', () => {
    it('asks again for an index DB path that is an existing folder, and suggests a file name', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const folder = path.join(root, 'IndexFolder');
      fs.mkdirSync(folder);
      const session = await runSetup(['1', packages, '', folder, '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain(`"${folder}" is a folder. Give a file name`);
      expect(session.out).toContain(path.join(folder, 'd365_index.db'));
      expect(session.env.D365_INDEX_DB_PATH).toBe('./d365_index.db');
    });

    it('asks again for an index DB path below a file', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const blocker = path.join(root, 'blocker');
      fs.writeFileSync(blocker, 'x');
      const session = await runSetup(['1', packages, '', path.join(blocker, 'data', 'index.db'), '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('is not a folder');
      expect(session.env.D365_INDEX_DB_PATH).toBe('./d365_index.db');
    });

    it('asks again, instead of crashing, for an index DB path on a drive that does not exist', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const missing = path.resolve('/no-such-drive-xyz/data/index.db');
      const missingRoot = path.parse(missing).root;
      const real = fs.existsSync.bind(fs);
      vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
        const text = String(target);
        return text === missingRoot || text.startsWith(path.resolve('/no-such-drive-xyz')) ? false : real(target);
      });
      const session = await runSetup(['1', packages, '', missing, '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('drive or share');
      expect(session.env.D365_INDEX_DB_PATH).toBe('./d365_index.db');
    });

    it('says in plain words that a key is too short or a placeholder', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', packages, 'short', 'change-me-'.repeat(5), '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('The key is 5 characters; at least 32 are required.');
      expect(session.out).toContain('The key is a documentation placeholder');
      expect(session.out).not.toMatch(/MCP_API_KEY:|'default'/);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('asks again for an index DB path in a folder it cannot write in', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const readOnly = path.join(root, 'read-only');
      fs.mkdirSync(readOnly);
      fs.chmodSync(readOnly, 0o500);
      try {
        const session = await runSetup(['1', packages, '', path.join(readOnly, 'data', 'index.db'), '', 'y', 'n', 'n']);

        expect(session.code).toBe(0);
        expect(session.out).toContain('you cannot write in');
        expect(session.env.D365_INDEX_DB_PATH).toBe('./d365_index.db');
      } finally {
        fs.chmodSync(readOnly, 0o700);
      }
    });

    it.skipIf(process.platform === 'win32')('asks again for a packages folder whose name a .env file cannot hold', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const odd = stageMetadata(path.join(root, 'Packages\tTab'));
      const session = await runSetup(['1', odd, packages, '', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('cannot be saved in a .env file');
      expect(session.env.D365_PACKAGES_DIR).toBe(packages);
    });

    it('asks again for a value a .env file cannot hold, instead of failing after the last question', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', packages, '', './a\tb/index.db', '', 'y', 'n', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('cannot be saved in a .env file');
      expect(session.env.D365_INDEX_DB_PATH).toBe('./d365_index.db');
    });

    it('takes the defaults when every question is answered with Enter', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['', packages, '', '', '', '', '']);

      expect(session.code).toBe(0);
      expect(session.env.MCP_HOST).toBe('127.0.0.1');
      expect(session.env.D365_INDEX_DB_PATH).toBe('./d365_index.db');
      expect(session.runIndex).toHaveBeenCalledTimes(1);
      expect(session.runDoctor).toHaveBeenCalledTimes(1);
      expect(session.logs).toContain('Next: run `d365-fno-mcp-server serve`.');
    });

    it('releases the terminal before the index and the checks start, so Ctrl-C can stop them', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const rawCalls: boolean[] = [];
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode(mode: boolean) {
          rawCalls.push(mode);
          return this;
        },
      });
      const output = new PassThrough();
      const rawWhenRun: Array<boolean | undefined> = [];
      typeWhenAsked(input, output, [
        ['Choose 1 or 2', '1'],
        ['PackagesLocalDirectory path', packages],
        ['MCP API key', ''],
        ['Index DB path', ''],
        ['Bind to this machine only', 'y'],
        ['Build the index now?', 'y'],
        ['Run the checks now?', 'y'],
      ]);
      fs.mkdirSync(path.join(root, 'work'), { recursive: true });

      const code = await setupCommand({
        nonInteractive: false,
        cwd: path.join(root, 'work'),
        input,
        output,
        terminal: true,
        runIndex: vi.fn(async () => (rawWhenRun.push(rawCalls.at(-1)), 0)),
        runDoctor: vi.fn(async () => (rawWhenRun.push(rawCalls.at(-1)), 0)),
      });

      expect(code).toBe(0);
      expect(rawWhenRun).toEqual([false, false]);
    });

    it('passes the terminal type on, so the index does not draw a counter on a dumb terminal', async () => {
      vi.stubEnv('TERM', 'dumb');
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const session = await runSetup(['1', packages, '', '', 'y', 'y', 'y']);

      const [, indexEnv] = session.runIndex.mock.calls[0] as [unknown, NodeJS.ProcessEnv];
      const [doctorEnv] = session.runDoctor.mock.calls[0] as [NodeJS.ProcessEnv];
      expect(indexEnv.TERM).toBe('dumb');
      expect(doctorEnv.TERM).toBe('dumb');
    });

    it('says where a generated key was saved, and stays quiet when the key was typed', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const generated = await runSetup(['1', packages, '', '', 'y', 'n', 'n']);
      expect(generated.logs).toContain(`Generated an API key and saved it as MCP_API_KEY in ${path.join(generated.cwd, '.env')}.`);
      expect(generated.logs).not.toContain(generated.env.MCP_API_KEY);

      fs.rmSync(path.join(generated.cwd, '.env'));
      logged.length = 0;
      const typed = await runSetup(['1', packages, 'k'.repeat(40), '', 'y', 'n', 'n']);
      expect(typed.code).toBe(0);
      expect(typed.logs).not.toContain('Generated an API key');
    });

    it('never echoes the API key it is typed, when each answer is typed as its question appears', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const key = 'localkey-0123456789-abcdefghijklmnop';
      const session = await runSetup([], {
        tty: true,
        drive: (input, output) =>
          typeWhenAsked(input, output, [
            ['Choose 1 or 2', '1'],
            ['PackagesLocalDirectory path', packages],
            ['MCP API key', key],
            ['Index DB path', ''],
            ['Bind to this machine only', 'y'],
            ['Build the index now?', 'n'],
            ['Run the checks now?', 'n'],
          ]),
      });

      expect(session.code).toBe(0);
      expect(session.env.MCP_API_KEY).toBe(key);
      expect(session.out).not.toContain(key);
      expect(session.out).not.toContain('localkey');
      expect(session.logs).not.toContain(key);
    });
  });

  describe('hosted mode', () => {
    it('writes a key-file .env that the gateway schema accepts, and never asks to build an index', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const keyFile = path.join(root, 'hosted-api-key');
      fs.writeFileSync(keyFile, `${HOSTED_KEY}\n`);
      const session = await runSetup(['2', HOSTED_URL, 'f', keyFile, custom, 'y']);

      expect(session.code).toBe(0);
      expect(session.env.D365_HOSTED_MCP_URL).toBe(HOSTED_URL);
      expect(session.env.D365_HOSTED_API_KEY_FILE).toBe(keyFile);
      expect(session.env).not.toHaveProperty('D365_HOSTED_API_KEY');
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(custom);
      expect(session.env).not.toHaveProperty('D365_PROJECT_DIR');
      expect(session.env).not.toHaveProperty('MCP_API_KEY');
      expect(gatewayConfigSchema.safeParse(session.env).success).toBe(true);

      expect(session.runIndex).not.toHaveBeenCalled();
      expect(session.runDoctor).toHaveBeenCalledTimes(1);
      const [doctorEnv] = session.runDoctor.mock.calls[0] as [NodeJS.ProcessEnv];
      expect(doctorEnv.D365_HOSTED_MCP_URL).toBe(HOSTED_URL);
      expect(doctorEnv.MCP_API_KEY).toBeUndefined();
      expect(session.logs).toContain('Next: run `d365-fno-mcp-server gateway`.');
      expect(session.logs).not.toContain(HOSTED_KEY);
    });

    it('stores a typed hosted key in .env without echoing it anywhere else', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['2', HOSTED_URL, 'k', HOSTED_KEY, custom, 'n'], { tty: true });

      expect(session.code).toBe(0);
      expect(session.env.D365_HOSTED_API_KEY).toBe(HOSTED_KEY);
      expect(session.env).not.toHaveProperty('D365_HOSTED_API_KEY_FILE');
      expect(session.out).not.toContain(HOSTED_KEY);
      expect(session.logs).not.toContain(HOSTED_KEY);
      expect(session.errors).not.toContain(HOSTED_KEY);
      expect(session.logs).toContain('Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server gateway`.');
    });

    it('normalises the hosted URL the way the gateway does', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['2', 'https://Hosted.Example.com', 'k', HOSTED_KEY, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_HOSTED_MCP_URL).toBe('https://hosted.example.com/mcp');
    });

    it('re-asks an insecure URL and a key with a space, without quoting the key', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const spaced = 'has a space 0123456789';
      const session = await runSetup([
        '2', 'http://hosted.example.com/mcp', HOSTED_URL, 'k', spaced, HOSTED_KEY, custom, 'n',
      ]);

      expect(session.code).toBe(0);
      expect(session.out).toContain('https://');
      expect(session.out).not.toContain(spaced);
      expect(session.env.D365_HOSTED_MCP_URL).toBe(HOSTED_URL);
      expect(session.env.D365_HOSTED_API_KEY).toBe(HOSTED_KEY);
    });

    it('reads a custom folder with a space and a hash back unchanged through dotenv and the gateway schema', async () => {
      const custom = stageMetadata(path.join(root, 'Models #2', 'Jo Smith'));
      const session = await runSetup(['2', HOSTED_URL, 'k', HOSTED_KEY, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(custom);
      const parsed = gatewayConfigSchema.safeParse(session.env);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.customMetadataDir).toBe(fs.realpathSync(custom));
    });

    it('accepts an empty custom folder with a notice, because a new models folder starts empty', async () => {
      const empty = path.join(root, 'EmptyModels');
      fs.mkdirSync(empty);
      const session = await runSetup(['2', HOSTED_URL, 'k', HOSTED_KEY, empty, 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(empty);
      expect(session.out + session.logs).toMatch(/no D365 metadata/i);
    });
  });

  describe('hosted mode: plain wording and hidden key', () => {
    it('never echoes the hosted key it is typed, when each answer is typed as its question appears', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup([], {
        tty: true,
        drive: (input, output) =>
          typeWhenAsked(input, output, [
            ['Choose 1 or 2', '2'],
            ['Hosted MCP URL', HOSTED_URL],
            ['read it from a file (f)', 'k'],
            ['Hosted API key: ', HOSTED_KEY],
            ['Folder with your custom models', custom],
            ['Run the checks now?', 'n'],
          ]),
      });

      expect(session.code).toBe(0);
      expect(session.env.D365_HOSTED_API_KEY).toBe(HOSTED_KEY);
      expect(session.out).not.toContain(HOSTED_KEY);
      expect(session.out).not.toContain('hosted-key');
    });

    it('speaks in plain words when URL and key file answers are blank or wrong', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const keyFolder = path.join(root, 'a-folder');
      fs.mkdirSync(keyFolder);
      const emptyKey = path.join(root, 'empty.key');
      fs.writeFileSync(emptyKey, '');
      const goodKey = path.join(root, 'good.key');
      fs.writeFileSync(goodKey, `${HOSTED_KEY}\n`);
      const missingKey = path.join(root, 'missing.key');

      const session = await runSetup([
        '2',
        '', 'not a url', 'http://hosted.example.com/mcp', 'https://user:pw@hosted.example.com/mcp', HOSTED_URL,
        'f',
        '', missingKey, keyFolder, emptyKey, goodKey,
        custom,
        'n',
      ]);

      expect(session.code).toBe(0);
      const out = session.out;
      expect(out).toContain('A hosted MCP URL is required, for example https://<your-app>.azurewebsites.net/mcp.');
      expect(out).toContain('That is not a full URL.');
      expect(out).toContain('Use an https:// URL; http:// is accepted only for localhost.');
      expect(out).toContain('Leave the user name and password out of the URL');
      expect(out).toContain('A key file path is required.');
      expect(out).toContain('There is no file at that path.');
      expect(out).toContain('That is a folder, not a file.');
      expect(out).toContain('That file is empty.');
      expect(out).not.toContain(missingKey);
      expect(out).not.toContain(emptyKey);
      expect(out).not.toMatch(/D365_|ENOENT|EISDIR|legacy alias/);
      expect(out).not.toContain('pw@');
      expect(session.env.D365_HOSTED_API_KEY_FILE).toBe(goodKey);
    });

    it.skipIf(process.platform === 'win32')('asks again for a custom folder and a key file whose names a .env file cannot hold', async () => {
      const odd = stageMetadata(path.join(root, 'Models\tTab'));
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const oddKey = path.join(root, 'key\tfile');
      fs.writeFileSync(oddKey, HOSTED_KEY);
      const goodKey = path.join(root, 'good.key');
      fs.writeFileSync(goodKey, HOSTED_KEY);
      const session = await runSetup(['2', HOSTED_URL, 'f', oddKey, goodKey, odd, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.out.match(/cannot be saved in a \.env file/g)).toHaveLength(2);
      expect(session.env.D365_HOSTED_API_KEY_FILE).toBe(goodKey);
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(custom);
    });

    it('does not repeat a key that was typed where the key file belongs', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const goodKey = path.join(root, 'good.key');
      fs.writeFileSync(goodKey, HOSTED_KEY);
      const session = await runSetup(['2', HOSTED_URL, 'f', HOSTED_KEY, goodKey, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('There is no file at that path.');
      expect(session.out).not.toContain('hosted-key');
    });

    it('asks again for a blank key and a missing folder in plain words', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const missing = path.join(root, 'nope');
      const session = await runSetup(['2', HOSTED_URL, 'k', '', HOSTED_KEY, '', missing, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('A hosted API key is required.');
      expect(session.out).toContain('A folder is required.');
      expect(session.out).toContain(`There is no folder at "${missing}".`);
      expect(session.out).not.toMatch(/D365_|legacy alias/);
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(custom);
    });
  });

  describe('when the prompt cannot finish', () => {
    it('exits 1 and writes nothing when the input ends before the questions are answered', async () => {
      const session = await runSetup(['1'], { end: true });

      expect(session.code).toBe(1);
      expect(session.envText).toBeNull();
      expect(session.errors).toContain('Input ended before setup finished; nothing was written.');
      expect(session.errors).toContain('--non-interactive');
      expect(session.runDoctor).not.toHaveBeenCalled();
    });

    it('exits 1 and writes nothing when the input is empty', async () => {
      const session = await runSetup([], { end: true });

      expect(session.code).toBe(1);
      expect(session.envText).toBeNull();
    });

    it('exits 130 and writes nothing on Ctrl-C at a prompt', async () => {
      const session = await runSetup(['1'], { tty: true, after: (input) => void input.write('\x03') });

      expect(session.code).toBe(130);
      expect(session.envText).toBeNull();
      expect(session.runDoctor).not.toHaveBeenCalled();
    });

    it('delivers a last answer that has no trailing newline before the input ends', async () => {
      const packages = stageMetadata(path.join(root, 'PackagesLocalDirectory'));
      const cwd = path.join(root, 'work');
      fs.mkdirSync(cwd, { recursive: true });
      const input = new PassThrough();
      input.write(['1', packages, '', '', 'y', 'n'].join('\n') + '\n');
      input.write('n');
      input.end();
      const code = await setupCommand({
        nonInteractive: false,
        cwd,
        input,
        output: new PassThrough(),
        terminal: false,
        runDoctor: vi.fn().mockResolvedValue(0),
        runIndex: vi.fn().mockResolvedValue(0),
      });

      expect(code).toBe(0);
      expect(fs.existsSync(path.join(cwd, '.env'))).toBe(true);
    });

    it('leaves an existing .env alone and says to pass --force', async () => {
      const cwd = path.join(root, 'work');
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(path.join(cwd, '.env'), 'EXISTING=1\n');
      const session = await runSetup(['1']);

      expect(session.code).toBe(1);
      expect(session.errors).toContain('--force');
      expect(fs.readFileSync(path.join(cwd, '.env'), 'utf-8')).toBe('EXISTING=1\n');
    });
  });
});

describe('normalizePathAnswer', () => {
  const cwd = path.join(os.tmpdir(), 'normalize-cwd');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('trims, and leaves a blank answer blank', () => {
    expect(normalizePathAnswer('  ', cwd)).toBe('');
    expect(normalizePathAnswer(`  ${path.join(cwd, 'a')}  `, cwd)).toBe(path.join(cwd, 'a'));
  });

  it('strips one pair of surrounding double or single quotes, as Copy as path adds', () => {
    expect(normalizePathAnswer(`"${path.join(cwd, 'a b')}"`, cwd)).toBe(path.join(cwd, 'a b'));
    expect(normalizePathAnswer(`'${path.join(cwd, 'a b')}'`, cwd)).toBe(path.join(cwd, 'a b'));
  });

  it('resolves a relative path against the given folder, not the process folder', () => {
    expect(normalizePathAnswer('data/index.db', cwd)).toBe(path.join(cwd, 'data', 'index.db'));
  });

  it('expands a leading ~/ to the home folder', () => {
    const home = path.join(os.tmpdir(), 'normalize-home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    expect(normalizePathAnswer('~/hosted.key', cwd)).toBe(path.join(home, 'hosted.key'));
  });
});
