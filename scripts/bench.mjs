/**
 * Read-path benchmark over a deterministic synthetic corpus (npm run bench [-- --objects 50000]; requires npm run build).
 * Measures corpus build, FTS rebuild, and per-call latency percentiles for the hot lookup paths on a
 * disk-backed database. The corpus is synthetic: it shows relative cost and regressions, not the
 * latency of a real Finance and Operations install.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  getAllObjects,
  getObjectByName,
  getObjectHeader,
  openDb,
  openDbReadOnly,
  rebuildFts,
  rebuildLabelsFts,
  upsertLabels,
  searchLabelsFts,
  searchSymbols,
  suggestObjectNames,
  upsertFields,
  upsertMethods,
  upsertObject,
} from '../dist/src/indexer/db.js';

const argIdx = process.argv.indexOf('--objects');
const OBJECTS = argIdx > 0 ? Math.max(100, Number(process.argv[argIdx + 1]) || 20000) : 20000;
const CALLS = 300;
const LABEL_ROWS = OBJECTS * 5;
const TYPES = ['Table', 'Class', 'Form', 'Enum', 'Edt', 'Query'];

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function measure(name, fn, calls = CALLS) {
  for (let i = 0; i < 20; i++) fn(i);
  const times = [];
  for (let i = 0; i < calls; i++) {
    const t = performance.now();
    fn(i);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { name, calls, p50_ms: +pct(times, 50).toFixed(3), p95_ms: +pct(times, 95).toFixed(3), p99_ms: +pct(times, 99).toFixed(3) };
}

function build(db) {
  for (let i = 0; i < OBJECTS; i++) {
    const type = TYPES[i % TYPES.length];
    const id = upsertObject(db, {
      type,
      name: `Bench${type}${i}`,
      package: `Pkg${i % 40}`,
      model: `Model${i % 10}`,
      file_path: `/synthetic/${i}.xml`,
      raw_xml: `<${type}><Name>Bench${type}${i}</Name></${type}>`,
      file_mtime: 1,
    });
    if (type === 'Table') upsertFields(db, id, Array.from({ length: 12 }, (_, f) => ({ name: `Field${f}`, type: 'String', edt: 'Name', label_id: null })));
    if (type === 'Class') upsertMethods(db, id, Array.from({ length: 8 }, (_, m) => ({ name: `method${m}`, return_type: 'void', modifiers: 'public', params: [] })));
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-bench-'));
const file = path.join(dir, 'bench.db');
try {
  const rw = openDb(file);
  let t = performance.now();
  build(rw);
  const buildMs = performance.now() - t;
  t = performance.now();
  rebuildFts(rw);
  const ftsMs = performance.now() - t;
  const labels = Array.from({ length: LABEL_ROWS }, (_, i) => ({
    labelId: `@Bench${i}`,
    value: `Synthetic label text number ${i} for account ${i % 977}`,
    language: ['en-us', 'de', 'fr', 'es', 'nl'][i % 5],
  }));
  t = performance.now();
  for (let i = 0; i < labels.length; i += 10000) upsertLabels(rw, labels.slice(i, i + 10000), `/synthetic/labels${i}.txt`);
  const labelBuildMs = performance.now() - t;
  t = performance.now();
  rebuildLabelsFts(rw);
  const labelFtsMs = performance.now() - t;
  rw.close();

  const db = openDbReadOnly(file);
  const mid = Math.floor(OBJECTS / 2);
  const results = [
    measure('searchSymbols prefix', (i) => searchSymbols(db, `BenchTable${(i * 7) % OBJECTS}`, undefined, 20)),
    measure('searchSymbols type-filtered', (i) => searchSymbols(db, 'BenchClass', 'Class', 20)),
    measure('getObjectHeader exact', (i) => getObjectHeader(db, `BenchTable${(i * 6) % OBJECTS - ((i * 6) % OBJECTS) % 6}`, 'Table')),
    measure('getObjectHeader lowercase', () => getObjectHeader(db, `benchtable${mid - (mid % 6)}`, 'Table')),
    measure('getObjectByName table (12 fields)', () => getObjectByName(db, `BenchTable${mid - (mid % 6)}`, 'Table')),
    measure('suggestObjectNames typo', () => suggestObjectNames(db, `BenchTabl${mid - (mid % 6)}`, 'Table')),
    measure('searchLabelsFts', (i) => searchLabelsFts(db, `account ${i % 977}`, 'en-us', 20)),
    measure('getAllObjects page (package filter)', (i) => getAllObjects(db, undefined, `Pkg${i % 40}`, 0, 50)),
  ];
  db.close();
  console.log(JSON.stringify({ objects: OBJECTS, node: process.version, buildMs: Math.round(buildMs), ftsRebuildMs: Math.round(ftsMs), labelRows: LABEL_ROWS, labelBuildMs: Math.round(labelBuildMs), labelFtsRebuildMs: Math.round(labelFtsMs), dbBytes: fs.statSync(file).size, results }, null, 2));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
