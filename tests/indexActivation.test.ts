import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activateIndexFile } from '../src/indexer/indexActivation.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-index-activation-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('activateIndexFile', () => {
  it('replaces the target and clears stale SQLite sidecars', () => {
    const target = path.join(root, 'index.db');
    const candidate = path.join(root, 'index.db.candidate');
    fs.writeFileSync(target, 'old');
    fs.writeFileSync(`${target}-wal`, 'wal');
    fs.writeFileSync(`${target}-shm`, 'shm');
    fs.writeFileSync(candidate, 'new');

    activateIndexFile(candidate, target);

    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.existsSync(candidate)).toBe(false);
    expect(fs.existsSync(`${target}-wal`)).toBe(false);
    expect(fs.existsSync(`${target}-shm`)).toBe(false);
  });

  it('rejects a candidate on another filesystem path', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-index-other-'));
    const candidate = path.join(other, 'candidate.db');
    fs.writeFileSync(candidate, 'new');
    try {
      expect(() => activateIndexFile(candidate, path.join(root, 'index.db'))).toThrow(/staged next to the target/);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
