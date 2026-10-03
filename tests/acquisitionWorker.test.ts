import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcquisitionWorkerError,
  LocalArtifactPublisher,
  runAcquisitionWorker,
  validateAcquisitionWorkerConfig,
  type AcquisitionRunContext,
  type AcquisitionWorkerConfig,
  type ArtifactPublisher,
} from '../src/indexer/acquisitionWorker.js';
import {
  INDEX_SCHEMA_VERSION,
  META_KEYS,
  openDb,
  setMeta,
  upsertObject,
} from '../src/indexer/db.js';
import type {
  ArtifactCompatibilityPolicy,
  ArtifactProvenance,
  CapabilityInventory,
} from '../src/indexer/artifactContract.js';

const TIME = '2026-10-04T00:00:00.000Z';
const HASHES = ['a', 'b', 'c'].map((character) => character.repeat(64));

const policy: ArtifactCompatibilityPolicy = {
  serverVersion: '0.1.0',
  minimumIndexSchemaVersion: INDEX_SCHEMA_VERSION,
  maximumIndexSchemaVersion: INDEX_SCHEMA_VERSION,
  requiredCapabilities: ['codeMetadata', 'dataModelMetadata', 'securityGraphs'],
};

const provenance: ArtifactProvenance = {
  packagesLocalDirectory: {
    sourceId: 'packages',
    version: '10.0.2500.1',
    acquiredAt: TIME,
    sha256: HASHES[0],
    bytes: 1,
  },
  vsixAssets: [{
    sourceId: 'ude-tools',
    version: '10.0.2500.1',
    acquiredAt: TIME,
    sha256: HASHES[1],
    bytes: 1,
  }],
  dbrefx: {
    sourceId: 'xref',
    version: '10.0.2500.1',
    acquiredAt: TIME,
    sha256: HASHES[2],
    bytes: 1,
  },
  optionalInputs: [],
};

const capabilities: CapabilityInventory = {
  codeMetadata: { completeness: 'complete', itemCount: 1 },
  dataModelMetadata: { completeness: 'complete', itemCount: 1 },
  uiFormPatterns: { completeness: 'complete', itemCount: 0 },
  workflowServiceMetadata: { completeness: 'complete', itemCount: 0 },
  reportingAnalytics: { completeness: 'partial', itemCount: 0 },
  labelsResources: { completeness: 'complete', itemCount: 0 },
  extensions: { completeness: 'complete', itemCount: 0 },
  reports: { completeness: 'partial', itemCount: 0 },
  securityGraphs: { completeness: 'complete', itemCount: 0 },
};

let root: string;
let config: AcquisitionWorkerConfig;
let storeRoot: string;

function writeCandidate(context: AcquisitionRunContext): void {
  fs.mkdirSync(path.dirname(context.sourceDatabase), { recursive: true });
  const db = openDb(context.sourceDatabase);
  upsertObject(db, {
    type: 'Class',
    name: 'WorkerFixture',
    package: 'ApplicationSuite',
    model: 'ApplicationSuite',
    file_path: path.join(context.workDirectory, 'packages', 'WorkerFixture.xml'),
    raw_xml: '<AxClass><Name>WorkerFixture</Name></AxClass>',
    file_mtime: 1,
  });
  setMeta(db, META_KEYS.builtAt, TIME);
  setMeta(db, META_KEYS.serverVersion, '0.1.0');
  setMeta(db, META_KEYS.appVersion, '10.0.2500.1');
  setMeta(db, META_KEYS.appVersionSource, 'configured');
  setMeta(db, META_KEYS.schemaVersion, String(INDEX_SCHEMA_VERSION));
  setMeta(db, META_KEYS.storeRawXml, '1');
  db.close();
  fs.writeFileSync(context.bundleOptionsFile, JSON.stringify({
    applicationVersion: '10.0.2500.1',
    sdkVersion: '10.0.2500.1',
    releaseId: 'service-update-2500',
    generatorVersion: '0.1.0',
    minimumServerVersion: '0.1.0',
    maximumServerVersion: '0.1.99',
    requiredCapabilities: policy.requiredCapabilities,
    capabilities,
    provenance,
    createdAt: TIME,
    relativePathsRoot: context.workDirectory,
    integrityCheck: true,
  }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-acquisition-worker-'));
  storeRoot = path.join(root, 'published');
  config = {
    runsRoot: path.join(root, 'runs'),
    runId: 'scheduled-2026-10-04',
    sourceDatabase: 'candidate/index.db',
    bundleOptionsFile: 'bundle-options.json',
    acquire: [{ name: 'acquire-assets', executable: 'unused' }],
    build: [{ name: 'build-index', executable: 'unused' }],
    policy,
    timeoutMs: 5_000,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scheduled acquisition worker', () => {
  it('builds, validates, publishes, records evidence, and cleans the run workspace', async () => {
    const executed: string[] = [];
    const status = await runAcquisitionWorker(
      config,
      new LocalArtifactPublisher(storeRoot),
      {},
      {
        executeCommand: async (command, context) => {
          executed.push(command.name);
          if (command.name === 'build-index') writeCandidate(context);
        },
      }
    );

    expect(executed).toEqual(['acquire-assets', 'build-index']);
    expect(status.state).toBe('succeeded');
    expect(status.bundleId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(status.pointerRevision).toBe(1);
    expect(status.validation?.status).toBe('passed');
    expect(Object.values(status.phases).every((phase) => phase.state === 'succeeded')).toBe(true);
    expect(fs.existsSync(path.join(config.runsRoot, config.runId, 'work'))).toBe(false);
    expect(JSON.parse(
      fs.readFileSync(path.join(config.runsRoot, config.runId, 'status.json'), 'utf8')
    )).toMatchObject({ state: 'succeeded', pointerRevision: 1 });
  });

  it('returns the completed status without rerunning an idempotent run ID', async () => {
    const execute = vi.fn(async (command: { name: string }, context: AcquisitionRunContext) => {
      if (command.name === 'build-index') writeCandidate(context);
    });
    const publisher = new LocalArtifactPublisher(storeRoot);
    const first = await runAcquisitionWorker(config, publisher, {}, { executeCommand: execute });
    const second = await runAcquisitionWorker(config, publisher, {}, { executeCommand: execute });

    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not publish a bundle that fails final validation and redacts failure details', async () => {
    const publisher: ArtifactPublisher = { publish: vi.fn() };

    await expect(runAcquisitionWorker(config, publisher, {}, {
      executeCommand: async (command, context) => {
        if (command.name === 'build-index') writeCandidate(context);
      },
      validateBundle: () => {
        throw new Error('validation failed at https://example.invalid/file?sig=secret token=abc');
      },
    })).rejects.toMatchObject({
      status: {
        state: 'failed',
        phases: { validate: { state: 'failed' }, publish: { state: 'skipped' } },
      },
    });

    expect(publisher.publish).not.toHaveBeenCalled();
    const persisted = fs.readFileSync(
      path.join(config.runsRoot, config.runId, 'status.json'),
      'utf8'
    );
    expect(persisted).not.toContain('secret');
    expect(persisted).not.toContain('example.invalid');
  });

  it('restarts a failed run safely with a clean workspace and incremented attempt', async () => {
    let shouldFail = true;
    const execute = async (command: { name: string }, context: AcquisitionRunContext) => {
      if (command.name === 'acquire-assets' && shouldFail) {
        fs.writeFileSync(path.join(context.workDirectory, 'partial'), 'partial');
        throw new Error('transient acquisition failure');
      }
      if (command.name === 'build-index') writeCandidate(context);
    };
    await expect(
      runAcquisitionWorker(config, new LocalArtifactPublisher(storeRoot), {}, { executeCommand: execute })
    ).rejects.toBeInstanceOf(AcquisitionWorkerError);

    shouldFail = false;
    const status = await runAcquisitionWorker(
      config,
      new LocalArtifactPublisher(storeRoot),
      {},
      { executeCommand: execute }
    );
    expect(status.state).toBe('succeeded');
    expect(status.attempt).toBe(2);
    expect(fs.existsSync(path.join(config.runsRoot, config.runId, 'work', 'partial'))).toBe(false);
  });

  it('recovers a run whose prior worker exited without removing its lock', async () => {
    const runDirectory = path.join(config.runsRoot, config.runId);
    fs.mkdirSync(runDirectory, { recursive: true });
    fs.writeFileSync(path.join(runDirectory, '.lock'), JSON.stringify({ pid: 2_147_483_647 }));
    fs.writeFileSync(path.join(runDirectory, 'status.json'), JSON.stringify({
      schemaVersion: 1,
      runId: config.runId,
      attempt: 1,
      state: 'running',
      startedAt: TIME,
      currentPhase: 'build',
      phases: {},
    }));

    const status = await runAcquisitionWorker(
      config,
      new LocalArtifactPublisher(storeRoot),
      {},
      {
        executeCommand: async (command, context) => {
          if (command.name === 'build-index') writeCandidate(context);
        },
      }
    );

    expect(status.state).toBe('succeeded');
    expect(status.attempt).toBe(2);
  });

  it('cancels an in-flight phase and still cleans the workspace', async () => {
    const controller = new AbortController();
    const promise = runAcquisitionWorker(
      config,
      { publish: vi.fn() },
      { signal: controller.signal },
      {
        executeCommand: async (_command, context) => {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
      }
    );
    controller.abort(new Error('operator cancelled'));

    await expect(promise).rejects.toMatchObject({ status: { state: 'cancelled' } });
    expect(fs.existsSync(path.join(config.runsRoot, config.runId, 'work'))).toBe(false);
  });

  it('times out a phase and records an explicit cancellation result', async () => {
    config.timeoutMs = 10;
    await expect(runAcquisitionWorker(
      config,
      { publish: vi.fn() },
      {},
      {
        executeCommand: async (_command, context) => {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
      }
    )).rejects.toMatchObject({
      status: { state: 'cancelled', error: expect.stringMatching(/timed out/) },
    });
  });

  it('rejects paths that escape the run and invalid timeout configuration', () => {
    expect(() => validateAcquisitionWorkerConfig({
      ...config,
      sourceDatabase: '../outside.db',
    })).toThrow(/within the run work directory/);
    expect(() => validateAcquisitionWorkerConfig({
      ...config,
      timeoutMs: 0,
    })).toThrow(/positive integer/);
  });
});
