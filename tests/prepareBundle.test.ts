import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBundleCommand } from '../src/cli/prepare-bundle-command.js';
import { createArtifactBundle, validateArtifactBundle, type CreateArtifactBundleOptions } from '../src/indexer/artifactBundle.js';
import { ARTIFACT_DATABASE_FILE } from '../src/indexer/artifactContract.js';
import {
  LocalArtifactPublisher,
  resolveAcquisitionPolicy,
  runAcquisitionWorker,
  type AcquisitionRunContext,
} from '../src/indexer/acquisitionWorker.js';
import { DEFAULT_REQUIRED_CAPABILITIES } from '../src/indexer/capabilityCoverage.js';
import { INDEX_SCHEMA_VERSION, openDbReadOnly } from '../src/indexer/db.js';
import { prepareArtifactBackedIndex } from '../src/server/artifactStartup.js';
import { VERSION } from '../src/version.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const APP_VERSION = '10.0.2645.124';
const ACQUIRED_AT = '2025-10-04T05:30:00.1234567Z';

let root: string;
let packagesDir: string;
let sourcesFile: string;
let dbPath: string;
let optionsFile: string;
let stdout: string[];
let stderr: string[];

/** A tiny UDE layout: `<cache root>/<application version>/PackagesLocalDirectory/<Package>/<Model>/<AxType>`. */
function stagePackages(directory: string): void {
  const layout: [string, string, string][] = [
    ['AxTable', 'AxTableSample.xml', 'SampleTable'],
    ['AxClass', 'AxClassSample.xml', 'SampleClass'],
    ['AxForm', 'AxFormSample.xml', 'SampleForm'],
    ['AxSecurityRole', 'AxSecurityRoleSample.xml', 'SampleClerkRole'],
    ['AxSecurityDuty', 'AxSecurityDutySample.xml', 'SampleMaintainDuty'],
    ['AxSecurityPrivilege', 'AxSecurityPrivilegeSample.xml', 'SampleEntityView'],
    ['AxMenuItemDisplay', 'AxMenuItemDisplaySample.xml', 'SampleMenuItem'],
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

function acquiredFile(fileName: string, hashCharacter: string, bytes: number) {
  return { fileName, sha256: hashCharacter.repeat(64), bytes, acquiredAt: ACQUIRED_AT };
}

function sourcesDocument(packagesLocalDirectory = packagesDir): Record<string, unknown> {
  return {
    schemaVersion: 1,
    applicationVersion: APP_VERSION,
    dataverseEnvironmentUri: 'https://contoso.crm.dynamics.com/',
    packagesLocalDirectory,
    sources: {
      systemmetadata: acquiredFile('systemmetadata.zip', 'A', 4_000_000_000),
      finopsvsix22: acquiredFile('FinOps22.vsix', 'b', 2_000),
      crossreference: acquiredFile('DYNAMICSXREFDB.bak', 'C', 3_000),
    },
  };
}

/** Writes `sources.json` the way Windows PowerShell 5.1 does: UTF-8 with a BOM. */
function writeSources(document: Record<string, unknown>, file = sourcesFile): void {
  fs.writeFileSync(file, `﻿${JSON.stringify(document, null, 2)}`, 'utf8');
}

function readOptions(file = optionsFile): CreateArtifactBundleOptions {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CreateArtifactBundleOptions;
}

function prepare(releaseId?: string): Promise<number> {
  return prepareBundleCommand({ sources: sourcesFile, dbPath, bundleOptions: optionsFile, releaseId });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-prepare-bundle-'));
  packagesDir = path.join(root, 'cache', APP_VERSION, 'PackagesLocalDirectory');
  stagePackages(packagesDir);
  sourcesFile = path.join(root, 'sources.json');
  dbPath = path.join(root, 'candidate', 'd365_index.db');
  optionsFile = path.join(root, 'bundle-options.json');
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stdout.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('prepare-bundle', () => {
  it('indexes the acquired PackagesLocalDirectory and writes bundle options the producer accepts', async () => {
    const document = sourcesDocument();
    // Further downloads may be listed; they are not bundle provenance.
    (document.sources as Record<string, unknown>).finopsvsix = acquiredFile('FinOps.vsix', 'd', 1_000);
    writeSources(document);

    expect(await prepare()).toBe(0);

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual({
      applicationVersion: APP_VERSION,
      objects: 7,
      releaseId: `ude-${APP_VERSION}`,
      bundleOptionsFile: optionsFile,
    });
    expect(fs.readFileSync(optionsFile)[0]).toBe('{'.charCodeAt(0));
    const options = readOptions();
    const source = (sourceId: string, hashCharacter: string, bytes: number) => ({
      sourceId,
      version: APP_VERSION,
      acquiredAt: '2025-10-04T05:30:00.123Z',
      sha256: hashCharacter.repeat(64),
      bytes,
    });
    expect(options).toEqual({
      applicationVersion: APP_VERSION,
      sdkVersion: APP_VERSION,
      releaseId: `ude-${APP_VERSION}`,
      generatorVersion: VERSION,
      minimumServerVersion: VERSION,
      maximumServerVersion: VERSION,
      requiredCapabilities: [...DEFAULT_REQUIRED_CAPABILITIES],
      capabilities: expect.any(Object),
      provenance: {
        packagesLocalDirectory: source('systemmetadata', 'a', 4_000_000_000),
        vsixAssets: [source('finopsvsix22', 'b', 2_000)],
        dbrefx: source('crossreference', 'c', 3_000),
        optionalInputs: [],
      },
      relativePathsRoot: packagesDir,
      integrityCheck: true,
    });
    expect(options.capabilities.codeMetadata).toMatchObject({ completeness: 'partial', itemCount: 1 });
    expect(options.capabilities.labelsResources).toMatchObject({ completeness: 'partial', itemCount: 2 });
    expect(options.capabilities.securityGraphs).toMatchObject({ completeness: 'partial', itemCount: 4 });
    expect(options.capabilities.reports.completeness).toBe('absent');

    const bundle = createArtifactBundle(dbPath, path.join(root, 'store'), options);
    expect(validateArtifactBundle(bundle.directory, resolveAcquisitionPolicy()).manifest.d365).toEqual({
      applicationVersion: APP_VERSION,
      sdkVersion: APP_VERSION,
      releaseId: `ude-${APP_VERSION}`,
    });
    const bundled = openDbReadOnly(path.join(bundle.directory, ARTIFACT_DATABASE_FILE));
    const paths = bundled.prepare('SELECT file_path FROM ax_objects').all() as { file_path: string }[];
    bundled.close();
    expect(paths.every((row) => row.file_path.startsWith(`TestPackage${path.sep}`))).toBe(true);
  });

  it('feeds a full acquisition run that the API accepts with its default required capabilities', async () => {
    const storeRoot = path.join(root, 'published');
    const status = await runAcquisitionWorker(
      {
        runsRoot: path.join(root, 'runs'),
        runId: 'ude-first-run',
        sourceDatabase: 'candidate/d365_index.db',
        bundleOptionsFile: 'bundle-options.json',
        acquire: [{ name: 'acquire-ude-assets', executable: 'unused' }],
        build: [{ name: 'prepare-bundle', executable: 'unused' }],
        timeoutMs: 60_000,
      },
      new LocalArtifactPublisher(storeRoot),
      {},
      {
        executeCommand: async (command, context: AcquisitionRunContext) => {
          const sources = path.join(context.workDirectory, 'sources.json');
          if (command.name === 'acquire-ude-assets') writeSources(sourcesDocument(), sources);
          if (command.name !== 'prepare-bundle') return;
          const code = await prepareBundleCommand({
            sources,
            dbPath: context.sourceDatabase,
            bundleOptions: context.bundleOptionsFile,
            releaseId: 'service-update-45',
          });
          if (code !== 0) throw new Error(`prepare-bundle exited with ${code}: ${stderr.join('\n')}`);
        },
      }
    );

    expect(status.state).toBe('succeeded');
    const prepared = prepareArtifactBackedIndex({
      storePath: storeRoot,
      indexDbPath: path.join(root, 'api', 'd365_index.db'),
      serverVersion: VERSION,
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
    });
    expect(prepared.bundle.manifest.bundleId).toBe(status.bundleId);
    expect(prepared.bundle.manifest.d365.releaseId).toBe('service-update-45');
    expect(prepared.bundle.manifest.compatibility.requiredCapabilities).toEqual([...DEFAULT_REQUIRED_CAPABILITIES]);
  });

  it('fails before indexing when the SDK folder does not name the declared version', async () => {
    writeSources({ ...sourcesDocument(), applicationVersion: '10.0.2645.125' });

    expect(await prepare()).toBe(1);

    expect(stderr.join('\n')).toMatch(
      /names application version 10\.0\.2645\.124, but sources\.json declares 10\.0\.2645\.125/
    );
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(optionsFile)).toBe(false);
    expect(stdout).toEqual([]);
  });

  it('fails when the SDK folder names no application version', async () => {
    const unversioned = path.join(root, 'AosService', 'PackagesLocalDirectory');
    stagePackages(unversioned);
    writeSources(sourcesDocument(unversioned));

    expect(await prepare()).toBe(1);

    expect(stderr.join('\n')).toMatch(/names application version <none>, but sources\.json declares 10\.0\.2645\.124/);
    expect(fs.existsSync(optionsFile)).toBe(false);
  });

  it('rejects a sources file with a missing source, an unknown key or a malformed entry', async () => {
    const missing = sourcesDocument();
    delete (missing.sources as Record<string, unknown>).crossreference;
    writeSources(missing);
    expect(await prepare()).toBe(1);
    expect(stderr.pop()).toMatch(/sources\.crossreference: /);

    writeSources({ ...sourcesDocument(), clientSecret: 'not-here' });
    expect(await prepare()).toBe(1);
    expect(stderr.pop()).toMatch(/Unrecognized key: "clientSecret"/);

    const malformed = sourcesDocument();
    (malformed.sources as Record<string, unknown>).finopsvsix22 = { ...acquiredFile('x.vsix', 'b', 1), sha256: 'abc' };
    writeSources(malformed);
    expect(await prepare()).toBe(1);
    expect(stderr.pop()).toMatch(/sources\.finopsvsix22\.sha256: /);

    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(optionsFile)).toBe(false);
  });

  it('refuses to overwrite an existing bundle options file', async () => {
    writeSources(sourcesDocument());
    fs.writeFileSync(optionsFile, 'previous');

    expect(await prepare()).toBe(1);

    expect(stderr.join('\n')).toContain(`Refusing to overwrite the existing bundle options file ${optionsFile}`);
    expect(fs.readFileSync(optionsFile, 'utf8')).toBe('previous');
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('refuses to index into an existing database', async () => {
    writeSources(sourcesDocument());
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(`${dbPath}-wal`, '');

    expect(await prepare()).toBe(1);

    expect(stderr.join('\n')).toContain(`Refusing to reuse the existing index ${dbPath}`);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(optionsFile)).toBe(false);
  });

  it('refuses an SDK without labels or security objects', async () => {
    fs.rmSync(path.join(packagesDir, 'TestPackage', 'TestModel', 'AxLabelFile'), { recursive: true });
    writeSources(sourcesDocument());

    expect(await prepare()).toBe(1);

    expect(stderr.join('\n')).toMatch(/The index has nothing for labelsResources; the PackagesLocalDirectory looks incomplete/);
    expect(fs.existsSync(optionsFile)).toBe(false);
  });

  it('records source files that could not be indexed in the capability notes', async () => {
    // A directory named like a label file cannot be read, like a locked or corrupt file.
    fs.mkdirSync(path.join(packagesDir, 'TestPackage', 'TestModel', 'AxLabelFile', 'LabelResources', 'en-US', 'Broken.en-US.label.txt'));
    writeSources(sourcesDocument());

    expect(await prepare()).toBe(0);

    expect(stderr.join('\n')).toMatch(/1 files could not be indexed \(\{"Label":1\}\)/);
    expect(readOptions().capabilities.labelsResources).toMatchObject({
      completeness: 'partial',
      note: expect.stringMatching(/ 1 source files of this kind could not be indexed\.$/),
    });
  });

  it('rejects a release identity the manifest cannot carry', async () => {
    writeSources(sourcesDocument());

    expect(await prepare('release 45')).toBe(1);

    expect(stderr.pop()).toMatch(/d365\.releaseId: /);
    expect(fs.existsSync(optionsFile)).toBe(false);
  });
});
