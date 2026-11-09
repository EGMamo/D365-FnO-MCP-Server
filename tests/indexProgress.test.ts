import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexProgress } from '../src/indexer/buildIndex.js';
import { createProgressLine, runIndexPass, type ProgressOutput } from '../src/cli/index-command.js';

// The real implementation unless a test replaces it once, to fail a scan after the counter painted.
vi.mock('../src/indexer/buildIndex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/indexer/buildIndex.js')>();
  return { ...actual, buildIndex: vi.fn(actual.buildIndex) };
});

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLEAR = '\r\x1b[2K';

let root: string;
let packagesDir: string;
/** Everything written to the fake terminal, in order. */
let chunks: string[];
/** Terminal writes and console output in one order, to check what comes before what. */
let timeline: string[];
let consoleLines: string[];
let consoleErrors: string[];

/** A tiny PackagesLocalDirectory: three objects and one label file. */
function stagePackages(directory: string): void {
  const layout: [string, string, string][] = [
    ['AxTable', 'AxTableSample.xml', 'SampleTable'],
    ['AxClass', 'AxClassSample.xml', 'SampleClass'],
    ['AxEnum', 'AxEnumSample.xml', 'SampleEnum'],
  ];
  for (const [typeDir, fixture, name] of layout) {
    const dir = path.join(directory, 'TestPackage', 'TestModel', typeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(fixturesDir, fixture), path.join(dir, `${name}.xml`));
  }
  const labelDir = path.join(directory, 'TestPackage', 'TestModel', 'AxLabelFile', 'LabelResources', 'en-US');
  fs.mkdirSync(labelDir, { recursive: true });
  fs.writeFileSync(path.join(labelDir, 'SampleLabels.en-US.label.txt'), 'Account=Account\nAmount=Amount\n');
}

/** A fake stdout that records its writes. `isTTY` is left off when undefined, as a pipe does. */
function fakeOutput(isTTY?: boolean): ProgressOutput {
  const output: ProgressOutput = {
    write: (chunk: string) => {
      chunks.push(chunk);
      timeline.push(`write:${chunk}`);
      return true;
    },
  };
  if (isTTY !== undefined) output.isTTY = isTTY;
  return output;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-index-progress-cli-'));
  packagesDir = path.join(root, 'PackagesLocalDirectory');
  stagePackages(packagesDir);
  chunks = [];
  timeline = [];
  consoleLines = [];
  consoleErrors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.join(' '));
    timeline.push(`log:${args.join(' ')}`);
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.join(' '));
    timeline.push(`error:${args.join(' ')}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runIndexPass progress', () => {
  it('passes the callback to the scan', async () => {
    const calls: IndexProgress[] = [];

    const { stats } = await runIndexPass(packagesDir, ':memory:', true, (progress) => calls.push({ ...progress }));

    expect(calls[0]).toEqual({ files: 0, done: false });
    expect(calls[calls.length - 1]).toEqual({ files: stats.total, done: true });
  });

  it('writes nothing to stdout, which prepare-bundle needs for its one JSON line', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runIndexPass(packagesDir, ':memory:', true);

    expect(write).not.toHaveBeenCalled();
  });
});

describe('createProgressLine', () => {
  function line(enabled = true) {
    return createProgressLine(fakeOutput(true), enabled);
  }

  it('does nothing when disabled', () => {
    const progress = line(false);

    progress.update({ files: 0, done: false });
    progress.update({ files: 9, done: true });
    progress.finish();

    expect(chunks).toEqual([]);
  });

  it('paints the first update at once, then at most every 100 ms', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1));
    const progress = line();

    progress.update({ files: 0, done: false });
    progress.update({ files: 10, done: false });
    vi.advanceTimersByTime(99);
    progress.update({ files: 20, done: false });
    expect(chunks).toEqual([`${CLEAR}Scanned 0 files`]);

    vi.advanceTimersByTime(1);
    progress.update({ files: 30, done: false });
    progress.update({ files: 40, done: false });
    expect(chunks).toEqual([`${CLEAR}Scanned 0 files`, `${CLEAR}Scanned 30 files`]);
  });

  it('writes the count as a plain number', () => {
    const progress = line();

    progress.update({ files: 1234567, done: false });

    expect(chunks).toEqual([`${CLEAR}Scanned 1234567 files`]);
  });

  it('paints a clock that stepped backwards instead of freezing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12));
    const progress = line();

    progress.update({ files: 1, done: false });
    vi.setSystemTime(new Date(2026, 0, 1, 11));
    progress.update({ files: 2, done: false });

    expect(chunks).toEqual([`${CLEAR}Scanned 1 files`, `${CLEAR}Scanned 2 files`]);
  });

  it('shows the finishing text at once and ends its line, so nothing needs clearing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1));
    const progress = line();

    progress.update({ files: 5, done: false });
    progress.update({ files: 5, done: true });
    progress.finish();
    progress.finish();

    expect(chunks).toEqual([`${CLEAR}Scanned 5 files`, `${CLEAR}Scanned 5 files, finishing up...\n`]);
  });

  it('clears an open line once, and only when something was painted', () => {
    const idle = line();
    idle.finish();
    expect(chunks).toEqual([]);

    const progress = line();
    progress.update({ files: 3, done: false });
    progress.finish();
    progress.finish();

    expect(chunks).toEqual([`${CLEAR}Scanned 3 files`, CLEAR]);
  });

  it('ignores updates after it has finished', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1));
    const progress = line();
    progress.update({ files: 1, done: false });
    progress.finish();

    vi.advanceTimersByTime(500);
    progress.update({ files: 2, done: false });

    expect(chunks).toEqual([`${CLEAR}Scanned 1 files`, CLEAR]);
  });

  it('stops writing after a write fails and never throws', () => {
    const write = vi.fn(() => {
      throw new Error('EPIPE');
    });
    const progress = createProgressLine({ isTTY: true, write }, true);

    expect(() => {
      progress.update({ files: 0, done: false });
      progress.update({ files: 1, done: true });
      progress.finish();
    }).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
