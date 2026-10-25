import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createPrompt, PromptEndedError, type Prompt, type PromptStreams } from '../src/cli/prompt.js';

// Made-up value; only ever typed into fake streams.
const SECRET = 'hunter2-VERY-SECRET-0123456789abcdef';
const HANG_MS = 300;

/** A stdin stand-in: `isTTY` true and a `setRawMode` that records every call. */
class FakeTty extends PassThrough {
  readonly isTTY = true;
  readonly rawCalls: boolean[] = [];

  setRawMode(mode: boolean): this {
    this.rawCalls.push(mode);
    return this;
  }
}

type Outcome<T> = { state: 'resolved'; value: T } | { state: 'rejected'; error: unknown } | { state: 'hung' };

/** Races a promise against a short timer so a regression fails the test instead of stalling the suite. */
async function settled<T>(promise: Promise<T>, ms = HANG_MS): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'hung' }), ms);
  });
  const outcome = promise.then(
    (value): Outcome<T> => ({ state: 'resolved', value }),
    (error: unknown): Outcome<T> => ({ state: 'rejected', error })
  );
  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The answer of an ask that must resolve. Failure messages never carry the answer. */
async function answerOf(ask: Promise<string>): Promise<string> {
  const outcome = await settled(ask);
  if (outcome.state === 'hung') throw new Error(`ask() did not settle within ${HANG_MS} ms`);
  if (outcome.state === 'rejected') throw outcome.error;
  return outcome.value;
}

/** The error of an ask that must reject with a PromptEndedError. */
async function endedWith(ask: Promise<string>): Promise<PromptEndedError> {
  const outcome = await settled(ask);
  if (outcome.state === 'hung') throw new Error(`ask() did not settle within ${HANG_MS} ms`);
  if (outcome.state === 'resolved') throw new Error('ask() resolved with an answer; it should have rejected');
  if (!(outcome.error instanceof PromptEndedError)) throw outcome.error;
  return outcome.error;
}

/** Lets stream callbacks that were queued by the last write run before output is read. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function capture(stream: PassThrough) {
  let raw = '';
  stream.on('data', (chunk: Buffer | string) => {
    raw += String(chunk);
  });
  return { raw: () => raw, text: () => stripVTControlCharacters(raw) };
}

const opened: Prompt[] = [];

function open(streams: PromptStreams): Prompt {
  const prompt = createPrompt(streams);
  opened.push(prompt);
  return prompt;
}

/** Piped input: readline's non-terminal mode, as in CI and `printf ... | d365-fno-mcp-server setup`. */
function piped() {
  const input = new PassThrough();
  const output = new PassThrough();
  const out = capture(output);
  return { input, output, out, prompt: open({ input, output, terminal: false }) };
}

/** A fake terminal: readline's terminal mode with echo and raw mode. */
function terminal() {
  const input = new FakeTty();
  const output = new PassThrough();
  const out = capture(output);
  return { input, output, out, prompt: open({ input, output, terminal: true }) };
}

// readline changes its behaviour on a dumb terminal; these tests are about a capable one wherever they run.
beforeEach(() => {
  vi.stubEnv('TERM', 'xterm-256color');
});

afterEach(() => {
  for (const prompt of opened.splice(0)) prompt.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('createPrompt: answers and validation', () => {
  it('re-asks until validate accepts, with all answers delivered in one write', async () => {
    const { input, out, prompt } = piped();
    const seen: string[] = [];
    input.write('nope\nstill-bad\n/good/path\n');

    const answer = await answerOf(
      prompt.ask('Packages dir', {
        validate: (value) => {
          seen.push(value);
          return value.startsWith('/') ? undefined : `"${value}" is not an absolute path`;
        },
      })
    );
    await flush();

    expect(answer).toBe('/good/path');
    expect(seen).toEqual(['nope', 'still-bad', '/good/path']);
    expect(out.text()).toBe(
      [
        'Packages dir: ',
        '"nope" is not an absolute path',
        'Packages dir: ',
        '"still-bad" is not an absolute path',
        'Packages dir: ',
        '',
      ].join('\n')
    );
  });

  it('delivers answers that arrive after the question is asked', async () => {
    const { input, prompt } = piped();

    const first = answerOf(prompt.ask('First'));
    input.write('one\n');
    expect(await first).toBe('one');

    const second = answerOf(prompt.ask('Second'));
    input.write('two\nthree\n');
    expect(await second).toBe('two');
    expect(await answerOf(prompt.ask('Third'))).toBe('three');
  });

  it('splits CRLF line endings', async () => {
    const { input, prompt } = piped();
    input.write('a\r\nb\r\n');

    expect(await answerOf(prompt.ask('A'))).toBe('a');
    expect(await answerOf(prompt.ask('B'))).toBe('b');
  });

  it('trims the answer', async () => {
    const { input, prompt } = piped();
    input.write('   /some/path \t\n');

    expect(await answerOf(prompt.ask('Path'))).toBe('/some/path');
  });

  it('takes the default for a blank answer and prints it in brackets', async () => {
    const { input, out, prompt } = piped();
    input.write('\n');

    const answer = await answerOf(prompt.ask('Index DB path', { default: './d365_index.db' }));
    await flush();

    expect(answer).toBe('./d365_index.db');
    expect(out.text()).toBe('Index DB path [./d365_index.db]: \n');
  });

  it('prints no bracketed hint for an empty default', async () => {
    const { input, out, prompt } = piped();
    input.write('\n');

    expect(await answerOf(prompt.ask('Optional', { default: '' }))).toBe('');
    await flush();

    expect(out.text()).toBe('Optional: \n');
  });

  it('treats a whitespace-only answer as blank', async () => {
    const { input, prompt } = piped();
    input.write('   \t \n');

    expect(await answerOf(prompt.ask('Name', { default: 'fallback' }))).toBe('fallback');
  });

  it('returns an empty string for a blank answer without a default', async () => {
    const { input, prompt } = piped();
    input.write('\n');

    expect(await answerOf(prompt.ask('Optional'))).toBe('');
  });

  it('applies the default before validate runs', async () => {
    const { input, prompt } = piped();
    input.write('\n');
    const seen: string[] = [];

    await answerOf(
      prompt.ask('Name', {
        default: 'fallback',
        validate: (value) => {
          seen.push(value);
          return undefined;
        },
      })
    );

    expect(seen).toEqual(['fallback']);
  });

  it('keeps asking when the default itself fails validation', async () => {
    const { input, prompt } = piped();
    input.write('\n/typed\n');

    const answer = await answerOf(
      prompt.ask('Dir', { default: 'relative', validate: (value) => (value.startsWith('/') ? undefined : 'must be absolute') })
    );

    expect(answer).toBe('/typed');
  });

  it('accepts an async validate and waits for it', async () => {
    const { input, out, prompt } = piped();
    input.write('bad\ngood\n');
    const calls: string[] = [];

    const answer = await answerOf(
      prompt.ask('Value', {
        validate: async (value) => {
          calls.push(value);
          await flush();
          return value === 'good' ? undefined : 'not good enough';
        },
      })
    );
    await flush();

    expect(answer).toBe('good');
    expect(calls).toEqual(['bad', 'good']);
    expect(out.text()).toContain('not good enough');
  });

  it('rejects when validate throws and still works for the next ask', async () => {
    const { input, prompt } = piped();
    input.write('first\nsecond\n');

    const failed = await settled(
      prompt.ask('Value', {
        validate: async () => {
          throw new Error('checker broke');
        },
      })
    );
    expect(failed).toMatchObject({ state: 'rejected', error: { message: 'checker broke' } });

    expect(await answerOf(prompt.ask('Again'))).toBe('second');
  });
});

describe('createPrompt: end of input', () => {
  it('delivers lines that were piped before the input ended, then rejects with eof', async () => {
    const { input, out, prompt } = piped();
    input.write('/p\n\n\n');
    input.end();

    expect(await answerOf(prompt.ask('A'))).toBe('/p');
    expect(await answerOf(prompt.ask('B', { default: 'def-b' }))).toBe('def-b');
    expect(await answerOf(prompt.ask('C', { default: 'def-c', secret: true }))).toBe('def-c');

    const error = await endedWith(prompt.ask('D'));
    expect(error.reason).toBe('eof');
    expect(error.name).toBe('PromptEndedError');
    await flush();
    expect(out.text()).not.toContain('def-c');
  });

  it('delivers queued answers after end of input has already closed the interface, printing each question', async () => {
    // readline throws ERR_USE_AFTER_CLOSE on prompt() once closed, so the question must be written directly.
    const { input, out, prompt } = piped();
    input.write('one\ntwo\n');
    input.end();
    await flush();

    expect(await answerOf(prompt.ask('First'))).toBe('one');
    expect(await answerOf(prompt.ask('Second'))).toBe('two');
    await flush();
    expect(out.text()).toBe('First: \nSecond: \n');
    expect((await endedWith(prompt.ask('Third'))).reason).toBe('eof');
  });

  it.each([
    ['end()', (input: PassThrough) => input.end()],
    ['destroy()', (input: PassThrough) => input.destroy()],
    ['destroy(error)', (input: PassThrough) => input.destroy(new Error('boom'))],
  ])('rejects a pending ask with eof when the input is closed by %s', async (_name, finish) => {
    const { input, prompt } = piped();
    const pending = endedWith(prompt.ask('Q'));

    finish(input);

    expect((await pending).reason).toBe('eof');
  });

  it.each([
    ['end()', (input: PassThrough) => input.end()],
    ['destroy()', (input: PassThrough) => input.destroy()],
    ['destroy(error)', (input: PassThrough) => input.destroy(new Error('boom'))],
  ])('rejects an ask made after the input was closed by %s', async (_name, finish) => {
    const { input, prompt } = piped();

    finish(input);
    await flush();

    expect((await endedWith(prompt.ask('Q'))).reason).toBe('eof');
  });

  it('delivers a final line that has no trailing newline', async () => {
    const { input, prompt } = piped();
    input.write('first\nlast-without-newline');
    input.end();

    expect(await answerOf(prompt.ask('A'))).toBe('first');
    expect(await answerOf(prompt.ask('B'))).toBe('last-without-newline');
    expect((await endedWith(prompt.ask('C'))).reason).toBe('eof');
  });

  it('delivers a lone final line without a newline to a pending ask', async () => {
    const { input, prompt } = piped();
    const pending = answerOf(prompt.ask('Continue? (Y/n)'));

    input.write('y');
    input.end();

    expect(await pending).toBe('y');
  });

  it('rejects with eof on empty input', async () => {
    const { input, prompt } = piped();
    input.end();

    expect((await endedWith(prompt.ask('Q'))).reason).toBe('eof');
  });

  it('ends a terminal session on Ctrl-D at an empty line and releases raw mode', async () => {
    const { input, prompt } = terminal();
    const pending = endedWith(prompt.ask('Q'));

    input.write('\x04');

    expect((await pending).reason).toBe('eof');
    expect(input.rawCalls).toEqual([true, false]);
  });
});

describe('createPrompt: secrets', () => {
  it('never echoes a secret on a terminal, and shows the question and returns the value', async () => {
    const { input, out, prompt } = terminal();
    const pending = answerOf(prompt.ask('API key', { secret: true }));

    for (const char of SECRET) input.write(char);
    input.write('\r');
    const answer = await pending;
    await flush();

    expect(answer).toBe(SECRET);
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).not.toContain('hunter2');
    expect(out.text()).toBe('API key: \n');
  });

  it('control: the same terminal harness does echo an ordinary answer', async () => {
    // Without this, removing the muting code would not fail any test: a piped interface never echoes.
    const { input, out, prompt } = terminal();
    const pending = answerOf(prompt.ask('Name'));

    for (const char of 'visible-text') input.write(char);
    input.write('\r');
    await pending;
    await flush();

    expect(out.text()).toContain('visible-text');
  });

  it('control: secret false echoes in the same harness as a secret that does not', async () => {
    const echoed = terminal();
    const echoedAnswer = answerOf(echoed.prompt.ask('API key', { secret: false }));
    echoed.input.write(`${SECRET}\r`);
    await echoedAnswer;
    await flush();

    const muted = terminal();
    const mutedAnswer = answerOf(muted.prompt.ask('API key', { secret: true }));
    muted.input.write(`${SECRET}\r`);
    await mutedAnswer;
    await flush();

    expect(echoed.out.text()).toContain(SECRET);
    expect(muted.out.text()).not.toContain(SECRET);
  });

  it('does not echo a secret that was typed before its question was asked', async () => {
    const { input, out, prompt } = terminal();
    for (const char of 'first') input.write(char);
    input.write('\r');
    for (const char of SECRET) input.write(char);
    input.write('\r');

    const name = await answerOf(prompt.ask('Name'));
    const key = await answerOf(prompt.ask('API key', { secret: true }));
    await flush();

    expect([name, key]).toEqual(['first', SECRET]);
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).not.toContain('hunter2');
  });

  it('does not echo a secret typed while the previous answer is still being validated', async () => {
    const { input, out, prompt } = terminal();
    let finishValidation: () => void = () => undefined;
    const validating = new Promise<void>((resolve) => {
      finishValidation = resolve;
    });
    const first = prompt.ask('Packages folder', { validate: async () => (await validating, undefined) });

    input.write('folder\r');
    await flush();
    // The developer pastes the key while the folder is still being checked.
    for (const char of SECRET) input.write(char);
    input.write('\r');
    await flush();
    finishValidation();
    expect(await answerOf(first)).toBe('folder');

    const key = await answerOf(prompt.ask('API key', { secret: true }));
    await flush();

    expect(key).toBe(SECRET);
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).not.toContain('hunter2');
  });

  it('does not echo a secret that arrives in the same burst as the previous answer', async () => {
    const { input, out, prompt } = terminal();
    const first = answerOf(prompt.ask('Name'));
    // One chunk, as a paste or a script driving the terminal delivers it: readline processes every key
    // of it before the pending ask has had a chance to react to the first line.
    input.write(`first\r${SECRET}\r`);
    expect(await first).toBe('first');

    const key = await answerOf(prompt.ask('API key', { secret: true }));
    await flush();

    expect(key).toBe(SECRET);
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).not.toContain('hunter2');
  });

  it('keeps a half-typed secret hidden and finishes it when the question comes', async () => {
    const { input, out, prompt } = terminal();
    const first = prompt.ask('Packages folder');
    input.write('folder\r');
    expect(await answerOf(first)).toBe('folder');

    for (const char of 'hunter2-par') input.write(char);
    await flush();
    const key = answerOf(prompt.ask('API key', { secret: true }));
    for (const char of 'tial') input.write(char);
    input.write('\r');

    expect(await key).toBe('hunter2-partial');
    await flush();
    expect(out.raw()).not.toContain('hunter2');
  });

  it('shows a half-typed ordinary answer again when its question is asked', async () => {
    const { input, out, prompt } = terminal();
    const first = prompt.ask('Packages folder');
    input.write('folder\r');
    await answerOf(first);

    for (const char of 'par') input.write(char);
    await flush();
    const second = answerOf(prompt.ask('Name'));
    for (const char of 'tial') input.write(char);
    input.write('\r');

    expect(await second).toBe('partial');
    await flush();
    expect(out.text()).toContain('par');
  });

  it('does not echo a secret when TERM is dumb', async () => {
    vi.stubEnv('TERM', 'dumb');
    const { input, out, prompt } = terminal();
    const pending = answerOf(prompt.ask('API key', { secret: true }));

    input.write('dumb-term-secret\r');
    await pending;
    await flush();

    expect(out.raw()).not.toContain('dumb-term-secret');
  });

  it('keeps the secret out of a re-ask message and releases the mute afterwards', async () => {
    const { input, out, prompt } = terminal();
    const pending = answerOf(
      prompt.ask('API key', {
        secret: true,
        validate: (value) => (value.length >= 32 ? undefined : `must be at least 32 characters (got ${value.length})`),
      })
    );

    input.write('short-secret\r');
    await flush();
    const afterFailure = out.text();
    input.write(`${'y'.repeat(32)}\r`);
    const key = await pending;

    expect(key).toBe('y'.repeat(32));
    expect(afterFailure).toContain('must be at least 32 characters (got 12)');
    expect(out.raw()).not.toContain('short-secret');

    const next = answerOf(prompt.ask('Path'));
    input.write('/visible\r');
    await next;
    await flush();

    expect(out.text()).toContain('/visible');
  });

  it('never prints a default for a secret', async () => {
    const { input, out, prompt } = piped();
    input.write('\n');

    const answer = await answerOf(prompt.ask('API key', { secret: true, default: 'generated-default-key' }));
    await flush();

    expect(answer).toBe('generated-default-key');
    expect(out.text()).toBe('API key: \n');
  });

  it('writes a newline after a secret so the next prompt starts on its own line', async () => {
    const { input, out, prompt } = piped();
    input.write('s3cret-value\nplain\n');

    await answerOf(prompt.ask('Key', { secret: true }));
    await answerOf(prompt.ask('Name'));
    await flush();

    expect(out.text()).toBe('Key: \nName: \n');
  });
});

describe('createPrompt: terminal handling', () => {
  it('rejects with interrupt on Ctrl-C, restores raw mode, pauses stdin and ends the line', async () => {
    const { input, out, prompt } = terminal();
    const pending = endedWith(prompt.ask('Q'));

    input.write('abc');
    input.write('\x03');
    const error = await pending;
    await flush();

    expect(error.reason).toBe('interrupt');
    expect(input.rawCalls).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
    expect(out.raw().endsWith('\n')).toBe(true);
    expect((await endedWith(prompt.ask('Again'))).reason).toBe('interrupt');
  });

  it('turns terminal mode on from an input that is a TTY when it is not told', async () => {
    const input = new FakeTty();
    const output = new PassThrough();
    const prompt = open({ input, output });
    const pending = answerOf(prompt.ask('API key', { secret: true }));

    input.write('derived-terminal-secret\r');
    await pending;

    expect(input.rawCalls).toEqual([true]);
  });

  it('derives terminal mode from the input rather than the output', async () => {
    // Readline alone would pick terminal mode from a TTY output and echo piped answers.
    const ttyOutput = () => Object.assign(new PassThrough(), { isTTY: true, columns: 80 });

    const derivedInput = new PassThrough();
    const derivedOutput = ttyOutput();
    const derivedOut = capture(derivedOutput);
    const derived = open({ input: derivedInput, output: derivedOutput });
    const derivedAnswer = answerOf(derived.ask('Name'));
    derivedInput.write('piped-answer\n');
    await derivedAnswer;
    await flush();

    const forcedInput = new PassThrough();
    const forcedOutput = ttyOutput();
    const forcedOut = capture(forcedOutput);
    const forced = open({ input: forcedInput, output: forcedOutput, terminal: true });
    const forcedAnswer = answerOf(forced.ask('Name'));
    forcedInput.write('piped-answer\n');
    await forcedAnswer;
    await flush();

    expect(forcedOut.text()).toContain('piped-answer');
    expect(derivedOut.text()).not.toContain('piped-answer');
  });
});

describe('createPrompt: close', () => {
  it('rejects an ask made after close(), and close() can be called twice', async () => {
    const { prompt } = piped();

    prompt.close();
    prompt.close();

    expect((await endedWith(prompt.ask('Q'))).reason).toBe('eof');
  });

  it('rejects an ask made after close() even when answers were still queued', async () => {
    const { input, prompt } = piped();
    input.write('unread-one\nunread-two\n');
    await flush();

    prompt.close();

    expect((await endedWith(prompt.ask('Q'))).reason).toBe('eof');
  });

  it('rejects a pending ask when close() is called', async () => {
    const { prompt } = piped();
    const pending = endedWith(prompt.ask('Q'));

    prompt.close();

    expect((await pending).reason).toBe('eof');
  });

  it('releases raw mode on close()', async () => {
    const { input, prompt } = terminal();

    prompt.close();

    expect(input.rawCalls).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
  });

  it('leaves no listener on the injected input after close()', () => {
    const input = new PassThrough();
    const snapshot = () => Object.fromEntries(input.eventNames().map((name) => [String(name), input.listenerCount(name)]));
    const before = snapshot();

    const prompt = createPrompt({ input, output: new PassThrough(), terminal: false });
    prompt.close();

    expect(snapshot()).toEqual(before);
  });

  it('leaves no close listener when end of input closes a stream that never emits close', async () => {
    const input = new PassThrough({ autoDestroy: false });
    const before = input.listenerCount('close');
    const prompt = open({ input, output: new PassThrough(), terminal: false });
    const pending = endedWith(prompt.ask('Q'));

    input.end();
    await pending;

    expect(input.listenerCount('close')).toBe(before);
  });

  it('leaves no close listener on the injected input after a terminal session ends', async () => {
    const input = new FakeTty();
    const before = input.listenerCount('close');
    const prompt = createPrompt({ input, output: new PassThrough(), terminal: true });
    const pending = endedWith(prompt.ask('Q'));

    input.write('\x03');
    await pending;

    expect(input.listenerCount('close')).toBe(before);
  });
});

describe('createPrompt: history, Ctrl-C, rejected answers and resizing', () => {
  it('does not recall a typed secret with the Up arrow at a later question', async () => {
    const { input, out, prompt } = terminal();
    const key = answerOf(prompt.ask('API key', { secret: true }));
    input.write(`${SECRET}\r`);
    expect(await key).toBe(SECRET);

    const next = answerOf(prompt.ask('Index DB path'));
    input.write('\x1b[A'); // Up arrow
    await flush();
    input.write('\r');

    expect(await next).toBe('');
    await flush();
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).not.toContain('hunter2');
  });

  it('drops answers that were queued behind a Ctrl-C', async () => {
    const { input, prompt } = terminal();
    input.write('one\rtwo\r');
    input.write('\x03');

    const ended = await endedWith(prompt.ask('Name'));

    expect(ended.reason).toBe('interrupt');
  });

  it('forgets what was typed ahead when an answer is rejected', async () => {
    const { input, out, prompt } = terminal();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const first = prompt.ask('Packages folder', {
      validate: async () => {
        attempts += 1;
        if (attempts > 1) return undefined;
        await gate;
        return 'does not exist';
      },
    });

    input.write('wrong\r');
    await flush();
    // While the folder is checked the developer goes on: a whole answer for the next question, and half of another.
    input.write(`${SECRET}\r`);
    for (const char of 'hunter2-par') input.write(char);
    await flush();
    release();
    await flush();
    input.write('right\r');

    expect(await answerOf(first)).toBe('right');
    await flush();
    expect(out.text()).toContain('does not exist');
    expect(out.raw()).not.toContain('hunter2');
  });

  it('keeps typed-ahead answers when the answer is accepted', async () => {
    const { input, prompt } = terminal();
    input.write('first\rsecond\r');

    expect(await answerOf(prompt.ask('One', { validate: async () => undefined }))).toBe('first');
    expect(await answerOf(prompt.ask('Two'))).toBe('second');
  });

  it('keeps queued answers after a rejected answer when the input is not a terminal', async () => {
    // A script pipes the wrong answer and the right one on purpose; only a person at a keyboard types ahead by accident.
    const { input, prompt } = piped();
    input.write('wrong\nright\n');

    const answer = await answerOf(prompt.ask('Folder', { validate: (value) => (value === 'right' ? undefined : 'no') }));

    expect(answer).toBe('right');
  });

  it('redraws the line when the terminal is resized, and stops listening on close', async () => {
    const input = new FakeTty();
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const out = capture(output);
    const before = output.listenerCount('resize');
    const prompt = open({ input, output, terminal: true });
    const pending = prompt.ask('Name');
    await flush();
    const drawn = out.raw().length;

    output.columns = 40;
    output.emit('resize');

    expect(out.raw().length).toBeGreaterThan(drawn);
    input.write('x\r');
    await pending;
    prompt.close();
    expect(output.listenerCount('resize')).toBe(before);
  });
});

describe('createPrompt: answers already typed ahead', () => {
  it('does not echo the start of a secret that was typed ahead, when an ordinary question is answered from the queue', async () => {
    const { input, out, prompt } = terminal();
    // One chunk: a whole answer, then the first part of the next one (a secret) with no Enter yet.
    input.write('first\rhunter2-par');

    expect(await answerOf(prompt.ask('Name'))).toBe('first');
    const key = answerOf(prompt.ask('API key', { secret: true }));
    input.write('tial\r');

    expect(await key).toBe('hunter2-partial');
    await flush();
    expect(out.raw()).not.toContain('hunter2');
  });

  it('shows a question next to the answer that was typed ahead for it, on its own line', async () => {
    const { input, out, prompt } = terminal();
    input.write('one\rtwo\r');

    expect(await answerOf(prompt.ask('First'))).toBe('one');
    expect(await answerOf(prompt.ask('Second'))).toBe('two');
    await flush();

    expect(out.text()).toBe('First: one\nSecond: two\n');
  });

  it('forgets the whole typed-ahead line after a rejection, also when the cursor was moved left inside it', async () => {
    const { input, out, prompt } = terminal();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const first = prompt.ask('Packages folder', {
      validate: async () => {
        attempts += 1;
        if (attempts > 1) return undefined;
        await gate;
        return 'does not exist';
      },
    });

    input.write('wrong\r');
    await flush();
    for (const char of 'hunter2-typo') input.write(char);
    input.write('\x1b[D\x1b[D\x1b[D'); // Left x3: the cursor now sits inside the typed-ahead text
    await flush();
    release();
    await flush();
    input.write('right\r');

    expect(await answerOf(first)).toBe('right');
    await flush();
    expect(out.raw()).not.toContain('hunter2');
  });

  it('returns a secret that was queued before the input ended, without echoing it', async () => {
    const { input, out, prompt } = piped();
    input.write(`${SECRET}\n`);
    input.end();
    await flush();

    expect(await answerOf(prompt.ask('API key', { secret: true }))).toBe(SECRET);
    await flush();
    expect(out.raw()).not.toContain('hunter2');
  });

  it('ends cleanly when Ctrl-D arrives while an answer is still being checked', async () => {
    const { input, prompt } = terminal();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = prompt.ask('Packages folder', { validate: async () => (await gate, 'does not exist') });

    input.write('wrong\r');
    await flush();
    input.write('\x04'); // Ctrl-D on an empty line closes readline
    await flush();
    release();

    expect((await endedWith(pending)).reason).toBe('eof');
  });
});
