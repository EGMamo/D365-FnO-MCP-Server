import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export type PromptEndReason = 'eof' | 'interrupt';

/** Thrown by `ask` when input ended or the user pressed Ctrl-C before the answer was complete. */
export class PromptEndedError extends Error {
  constructor(readonly reason: PromptEndReason) {
    super(reason === 'interrupt' ? 'Setup was interrupted.' : 'Input ended before every question was answered.');
    this.name = 'PromptEndedError';
  }
}

export interface AskOptions {
  /** Return a reason to re-ask, or undefined to accept the answer. The reason must never contain a secret answer. */
  validate?: (answer: string) => string | undefined | Promise<string | undefined>;
  /** Do not echo typed input. */
  secret?: boolean;
  /** Used when the answer is blank. Never printed for secrets. */
  default?: string;
}

export interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Force readline terminal mode on or off. Tests pass it; production derives it from stdin. */
  terminal?: boolean;
}

export interface Prompt {
  ask(question: string, options?: AskOptions): Promise<string>;
  /** Releases stdin (raw mode off, paused), drops unread answers and ends pending asks. Safe to call twice. */
  close(): void;
}

/**
 * One readline interface and one queue of lines for a whole interactive session. `rl.question()` is
 * avoided on purpose: it loses lines that arrive in the same chunk, never settles at end of input and
 * drops an unterminated final line. Asks are sequential; do not run two at once.
 */
export function createPrompt(streams: PromptStreams = {}): Prompt {
  const input: NodeJS.ReadableStream = streams.input ?? process.stdin;
  const output: NodeJS.WritableStream = streams.output ?? process.stdout;
  // Never leave `terminal` undefined: readline would pick terminal mode from stdout alone and echo piped answers.
  const terminal = streams.terminal ?? (input as { isTTY?: boolean }).isTTY === true;

  // Muted between questions, so keys typed before a question is asked (while the previous answer is checked, or
  // a secret pasted early) are never echoed. A question that shows its answer unmutes the sink for its duration.
  let muted = true;
  const sink = new Writable({
    decodeStrings: false,
    write(chunk: string, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  // readline reads `columns` (and listens for 'resize') on its output in terminal mode.
  Object.defineProperty(sink, 'columns', { get: () => (output as { columns?: number }).columns });

  // No history: Up would recall an earlier answer at a later question, a typed key included.
  const rl = createInterface({ input, output: sink, terminal, historySize: 0 });
  // Readline listens for resizes on the sink it was given, which is not the real output.
  const onResize = () => {
    sink.emit('resize');
  };
  if (terminal) output.on('resize', onResize);
  const buffered: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let ended: PromptEndedError | undefined;
  let closed = false;

  const end = (reason: PromptEndReason) => {
    ended ??= new PromptEndedError(reason);
    for (const waiter of waiters.splice(0)) waiter.reject(ended);
  };
  const release = () => {
    closed = true;
    input.removeListener('close', onInputClose);
    output.removeListener('resize', onResize);
  };
  const close = () => {
    if (closed) return;
    release();
    rl.close(); // also restores raw mode and pauses stdin
  };
  const onInputClose = () => {
    end('eof'); // stream.destroy() emits only 'close' on the input; readline does not notice
    close();
  };

  // The 'line' event fires even when no question is pending, so no answer is lost between asks.
  rl.on('line', (line) => {
    // Readline goes on with the rest of a burst of keys before the pending ask can react, so the sink is muted
    // here: whatever follows this line is typed ahead of a question that has not been asked yet.
    muted = true;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else buffered.push(line);
  });
  rl.on('close', () => {
    release();
    end('eof');
  });
  rl.on('SIGINT', () => {
    buffered.length = 0; // answers typed before Ctrl-C must not carry the run on
    end('interrupt');
    close();
  });
  rl.on('error', () => {
    end('eof');
    close();
  });
  input.once('close', onInputClose);

  const nextLine = (): Promise<string> => {
    const line = buffered.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (ended) return Promise.reject(ended);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  async function ask(question: string, options: AskOptions = {}): Promise<string> {
    const secret = options.secret === true;
    const hint = options.default && !secret ? ` [${options.default}]` : '';
    const text = `${question}${hint}: `;
    for (;;) {
      if (ended && buffered.length === 0) throw ended;
      if (secret) {
        // The question goes straight to the output; whatever readline redraws with it, typed-ahead keys included, stays muted.
        output.write(text);
        if (!closed) {
          rl.setPrompt('');
          rl.prompt(true);
        }
      } else if (closed || buffered.length > 0) {
        // Written straight to the output. rl.prompt() throws once closed, and a redraw would print whatever is typed
        // ahead on readline's line: that may be the start of a secret asked for later. On a terminal the answer typed
        // ahead was not echoed when it was typed, so it is shown here, next to its question.
        output.write(terminal && buffered.length > 0 ? `${text}${buffered[0]}\n` : text);
      } else {
        muted = false;
        rl.setPrompt(text);
        // Keep the cursor after anything already typed ahead, so the rest of the answer lands where it belongs.
        rl.prompt(true);
      }
      let raw: string;
      try {
        raw = await nextLine();
      } catch (error) {
        muted = true;
        output.write('\n'); // leave the shell prompt on a fresh line
        throw error;
      }
      muted = true;
      if (options.secret || !terminal) output.write('\n'); // a real terminal echoes the newline itself
      const answer = raw.trim() || options.default || '';
      const problem = await options.validate?.(answer);
      if (problem === undefined) return answer;
      output.write(`${problem}\n`);
      if (terminal && !closed) {
        // Keys typed while the answer was being checked were meant for the questions after it. They would now
        // answer this one, or show up at its prompt: a typed-ahead key included.
        buffered.length = 0;
        rl.write(null, { ctrl: true, name: 'e' }); // to the end first: Ctrl-U clears only what is left of the cursor
        rl.write(null, { ctrl: true, name: 'u' });
      }
    }
  }

  return {
    ask,
    close: () => {
      buffered.length = 0; // an ask after close() rejects, even when answers were still queued
      close();
    },
  };
}
