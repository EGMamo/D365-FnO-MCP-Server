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
    const code = await setupCommand({
      nonInteractive: false,
      cwd,
      input,
      output,
      terminal: tty,
      runDoctor,
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
    };
  }

  describe('local mode', () => {
    it('asks for the custom folder and an optional index path, writes local mode, and runs the checks', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['1', custom, '', 'y']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('1) Local only: index my custom models here. No hosted server.');
      expect(session.out).toContain('2) Hosted: a hosted server for the standard application, plus my custom models indexed here.');
      expect(session.env).toEqual({ D365_CUSTOM_METADATA_DIR: custom });
      const parsed = gatewayConfigSchema.safeParse({ ...session.env, D365_LOCAL_INDEX_DB_PATH: path.join(root, 's', 'i.db') });
      expect(parsed.success && parsed.data.hostedUrl).toBeNull();
      expect(session.runDoctor).toHaveBeenCalledTimes(1);
      expect(session.logs).toContain('Next: run `d365-fno-mcp-server gateway`.');
      expect(session.out).not.toMatch(/PackagesLocalDirectory|API key|Hosted MCP URL/);
    });

    it('writes the index path when one is given, and re-asks one that is a folder', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const folder = path.join(root, 'afolder');
      fs.mkdirSync(folder);
      const session = await runSetup(['1', custom, folder, './state/custom.db', 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('is a folder. Give a file name');
      expect(session.env.D365_LOCAL_INDEX_DB_PATH).toBe('./state/custom.db');
      expect(session.logs).toContain('Next: run `d365-fno-mcp-server doctor`, then `d365-fno-mcp-server gateway`.');
    });

    it('re-asks a custom folder that does not exist', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['1', path.join(root, 'missing'), custom, '', 'n']);
      expect(session.code).toBe(0);
      expect(session.out).toContain('There is no folder at');
    });

    it('re-asks an answer to the first question that is neither 1 nor 2', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['3', '1', custom, '', 'n']);
      expect(session.code).toBe(0);
      expect(session.out).toContain('Answer 1 or 2.');
    });

    it('takes the developer package command name in every printed step', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['1', custom, '', 'n'], { edition: { bin: 'd365-fno-mcp' } });
      expect(session.envText).toMatch(/^# Generated by `d365-fno-mcp setup` \(local mode/);
      expect(session.logs).toContain('Next: run `d365-fno-mcp doctor`, then `d365-fno-mcp gateway`.');
    });

    it('refuses a flag of the removed full-local-index mode before asking anything', async () => {
      const session = await runSetup([], { removedFlags: ['packages-dir'], end: true });
      expect(session.code).toBe(1);
      expect(session.errors).toContain('--packages-dir is no longer supported');
      expect(session.out).toBe('');
    });
  });

  describe('hosted mode: deployed or not', () => {
    it('asks whether the server is already deployed', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['2', '1', HOSTED_URL, 'k', HOSTED_KEY, custom, 'n']);
      expect(session.code).toBe(0);
      expect(session.out).toContain('Is the hosted server already deployed?');
      expect(session.out).toContain('1) Yes: I have its URL and a developer key.');
      expect(session.out).toContain('2) No: deploy one now.');
    });

    it('in the developer package, answering "deploy" prints the operator command and writes nothing', async () => {
      const session = await runSetup(['2', '2'], { edition: { bin: 'd365-fno-mcp' } });
      expect(session.code).toBe(1);
      expect(session.errors).toContain('Run: npx d365-fno-mcp-server setup --mode hosted --deploy');
      expect(session.envText).toBeNull();
    });

    it('in the operator package, asks the deploy questions first and runs the plan only after the prompt closed', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const events: string[] = [];
      const deploy = {
        ask: vi.fn(async (prompt: { ask: (q: string) => Promise<string> }) => {
          events.push(`asked ${await prompt.ask('Environment name')}`);
          return {
            run: async () => {
              events.push('ran');
              return { hostedUrl: 'https://new.example.com/mcp', key: 'b'.repeat(64) };
            },
          };
        }),
        fromFlags: vi.fn(),
      };
      const session = await runSetup(['2', '2', 'dev', custom, 'y'], { edition: { bin: 'd365-fno-mcp-server', deploy } });

      expect(session.code).toBe(0);
      expect(events).toEqual(['asked dev', 'ran']);
      expect(session.env).toEqual({
        D365_HOSTED_MCP_URL: 'https://new.example.com/mcp',
        D365_HOSTED_API_KEY: 'b'.repeat(64),
        D365_CUSTOM_METADATA_DIR: custom,
      });
      expect(session.runDoctor).toHaveBeenCalledTimes(1);
      expect(session.logs).not.toContain('b'.repeat(64));
    });

    it('writes nothing when the deploy questions end in a no', async () => {
      const deploy = { ask: vi.fn(async () => null), fromFlags: vi.fn() };
      const session = await runSetup(['2', '2'], { edition: { bin: 'd365-fno-mcp-server', deploy } });
      expect(session.code).toBe(1);
      expect(session.logs).toContain('Nothing was deployed and nothing was written.');
      expect(session.envText).toBeNull();
    });
  });

  describe('hosted mode', () => {
    it('writes a key-file .env that the gateway schema accepts, and never asks to build an index', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const keyFile = path.join(root, 'hosted-api-key');
      fs.writeFileSync(keyFile, `${HOSTED_KEY}\n`);
      const session = await runSetup(['2', '1', HOSTED_URL, 'f', keyFile, custom, 'y']);

      expect(session.code).toBe(0);
      expect(session.env.D365_HOSTED_MCP_URL).toBe(HOSTED_URL);
      expect(session.env.D365_HOSTED_API_KEY_FILE).toBe(keyFile);
      expect(session.env).not.toHaveProperty('D365_HOSTED_API_KEY');
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(custom);
      expect(session.env).not.toHaveProperty('D365_PROJECT_DIR');
      expect(session.env).not.toHaveProperty('MCP_API_KEY');
      expect(gatewayConfigSchema.safeParse(session.env).success).toBe(true);

      expect(session.runDoctor).toHaveBeenCalledTimes(1);
      const [doctorEnv] = session.runDoctor.mock.calls[0] as [NodeJS.ProcessEnv];
      expect(doctorEnv.D365_HOSTED_MCP_URL).toBe(HOSTED_URL);
      expect(doctorEnv.MCP_API_KEY).toBeUndefined();
      expect(session.logs).toContain('Next: run `d365-fno-mcp-server gateway`.');
      expect(session.logs).not.toContain(HOSTED_KEY);
    });

    it('stores a typed hosted key in .env without echoing it anywhere else', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const session = await runSetup(['2', '1', HOSTED_URL, 'k', HOSTED_KEY, custom, 'n'], { tty: true });

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
      const session = await runSetup(['2', '1', 'https://Hosted.Example.com', 'k', HOSTED_KEY, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_HOSTED_MCP_URL).toBe('https://hosted.example.com/mcp');
    });

    it('re-asks an insecure URL and a key with a space, without quoting the key', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const spaced = 'has a space 0123456789';
      const session = await runSetup([
        '2', '1', 'http://hosted.example.com/mcp', HOSTED_URL, 'k', spaced, HOSTED_KEY, custom, 'n',
      ]);

      expect(session.code).toBe(0);
      expect(session.out).toContain('https://');
      expect(session.out).not.toContain(spaced);
      expect(session.env.D365_HOSTED_MCP_URL).toBe(HOSTED_URL);
      expect(session.env.D365_HOSTED_API_KEY).toBe(HOSTED_KEY);
    });

    it('reads a custom folder with a space and a hash back unchanged through dotenv and the gateway schema', async () => {
      const custom = stageMetadata(path.join(root, 'Models #2', 'Jo Smith'));
      const session = await runSetup(['2', '1', HOSTED_URL, 'k', HOSTED_KEY, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(custom);
      const parsed = gatewayConfigSchema.safeParse(session.env);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.customMetadataDir).toBe(fs.realpathSync(custom));
    });

    it('accepts an empty custom folder with a notice, because a new models folder starts empty', async () => {
      const empty = path.join(root, 'EmptyModels');
      fs.mkdirSync(empty);
      const session = await runSetup(['2', '1', HOSTED_URL, 'k', HOSTED_KEY, empty, 'n']);

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
            ['Choose 1 or 2', '1'],
            ['Hosted MCP URL', HOSTED_URL],
            ['read it from a file (f)', 'k'],
            ['Developer key: ', HOSTED_KEY],
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
        '1',
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
      const session = await runSetup(['2', '1', HOSTED_URL, 'f', oddKey, goodKey, odd, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.out.match(/cannot be saved in a \.env file/g)).toHaveLength(2);
      expect(session.env.D365_HOSTED_API_KEY_FILE).toBe(goodKey);
      expect(session.env.D365_CUSTOM_METADATA_DIR).toBe(custom);
    });

    it('does not repeat a key that was typed where the key file belongs', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const goodKey = path.join(root, 'good.key');
      fs.writeFileSync(goodKey, HOSTED_KEY);
      const session = await runSetup(['2', '1', HOSTED_URL, 'f', HOSTED_KEY, goodKey, custom, 'n']);

      expect(session.code).toBe(0);
      expect(session.out).toContain('There is no file at that path.');
      expect(session.out).not.toContain('hosted-key');
    });

    it('asks again for a blank key and a missing folder in plain words', async () => {
      const custom = stageMetadata(path.join(root, 'Metadata'));
      const missing = path.join(root, 'nope');
      const session = await runSetup(['2', '1', HOSTED_URL, 'k', '', HOSTED_KEY, '', missing, custom, 'n']);

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
      input.write(['1', packages, ''].join('\n') + '\n');
      input.write('n');
      input.end();
      const code = await setupCommand({
        nonInteractive: false,
        cwd,
        input,
        output: new PassThrough(),
        terminal: false,
        runDoctor: vi.fn().mockResolvedValue(0),
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
