import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  artifactBundleDirectory,
  createArtifactBundle,
  publishStagedArtifactDirectory,
  validateArtifactBundle,
  type CreateArtifactBundleOptions,
  type ValidatedArtifactBundle,
} from './artifactBundle.js';
import {
  promoteArtifactBundle,
  readArtifactPointers,
} from './artifactPointers.js';
import {
  ARTIFACT_CAPABILITY_NAMES,
  type ArtifactCompatibilityPolicy,
  type ArtifactValidationReport,
} from './artifactContract.js';
import {
  AzureBlobArtifactStore,
  type ArtifactPointerSnapshot,
} from './azureBlobArtifactStore.js';
import { DEFAULT_REQUIRED_CAPABILITIES } from './capabilityCoverage.js';
import { INDEX_SCHEMA_VERSION } from './db.js';
import { VERSION } from '../version.js';

const ACQUISITION_PHASES = [
  'acquire',
  'build',
  'bundle',
  'validate',
  'publish',
  'cleanup',
] as const;

export type AcquisitionPhase = (typeof ACQUISITION_PHASES)[number];
export type AcquisitionPhaseState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface AcquisitionCommand {
  name: string;
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface AcquisitionWorkerConfig {
  runsRoot: string;
  runId: string;
  sourceDatabase: string;
  bundleOptionsFile: string;
  acquire: AcquisitionCommand[];
  build: AcquisitionCommand[];
  /** Omitted fields default to this build's server version, index schema and complete capabilities. */
  policy?: Partial<ArtifactCompatibilityPolicy>;
  timeoutMs: number;
  retainWorkDirectory?: boolean;
}

export interface AcquisitionRunContext {
  runDirectory: string;
  workDirectory: string;
  sourceDatabase: string;
  bundleOptionsFile: string;
  signal: AbortSignal;
}

export interface AcquisitionStepContext extends AcquisitionRunContext {
  /** Receives the step's stdout and stderr; under the run directory so it outlives cleanup. */
  logFile: string;
}

export interface AcquisitionPhaseRecord {
  state: AcquisitionPhaseState;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface AcquisitionRunStatus {
  schemaVersion: 1;
  runId: string;
  attempt: number;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  currentPhase: AcquisitionPhase | null;
  phases: Record<AcquisitionPhase, AcquisitionPhaseRecord>;
  bundleId?: string;
  pointerRevision?: number;
  validation?: {
    status: ArtifactValidationReport['status'];
    checks: ArtifactValidationReport['checks'];
  };
  error?: string;
}

export interface ArtifactPublisher {
  publish(
    bundle: ValidatedArtifactBundle,
    policy: ArtifactCompatibilityPolicy,
    signal: AbortSignal
  ): Promise<{ revision: number }>;
}

export interface AcquisitionWorkerDependencies {
  now?: () => Date;
  executeCommand?: (
    command: AcquisitionCommand,
    context: AcquisitionStepContext
  ) => Promise<void>;
  createBundle?: (
    sourceDatabase: string,
    storeRoot: string,
    options: CreateArtifactBundleOptions
  ) => ValidatedArtifactBundle;
  validateBundle?: (
    directory: string,
    policy: ArtifactCompatibilityPolicy
  ) => ValidatedArtifactBundle;
}

export class AcquisitionWorkerError extends Error {
  constructor(
    message: string,
    readonly status: AcquisitionRunStatus,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AcquisitionWorkerError';
  }
}

function initialPhases(): Record<AcquisitionPhase, AcquisitionPhaseRecord> {
  return Object.fromEntries(
    ACQUISITION_PHASES.map((phase) => [phase, { state: 'pending' }])
  ) as Record<AcquisitionPhase, AcquisitionPhaseRecord>;
}

function statusFile(runDirectory: string): string {
  return path.join(runDirectory, 'status.json');
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readPreviousStatus(file: string): AcquisitionRunStatus | undefined {
  if (!fs.existsSync(file)) return undefined;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AcquisitionRunStatus>;
  if (value.schemaVersion !== 1 || typeof value.attempt !== 'number') {
    throw new Error(`Existing acquisition status is invalid: ${file}`);
  }
  return value as AcquisitionRunStatus;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bhttps?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(
      /\b(token|secret|password|sig|sas|authorization)\s*[=:]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .slice(0, 1000);
}

function resolveWithin(root: string, relative: string, label: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(`${label} must be a relative path.`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const fromRoot = path.relative(resolvedRoot, resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`${label} must stay within the run work directory.`);
  }
  return resolved;
}

function validateCommands(commands: AcquisitionCommand[], label: string): void {
  for (const [index, command] of commands.entries()) {
    if (!command || typeof command !== 'object') {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    if (typeof command.name !== 'string' || !command.name.trim()) {
      throw new Error(`${label}[${index}].name is required.`);
    }
    if (typeof command.executable !== 'string' || !command.executable.trim()) {
      throw new Error(`${label}[${index}].executable is required.`);
    }
    if (command.args !== undefined && (
      !Array.isArray(command.args) ||
      command.args.some((argument) => typeof argument !== 'string')
    )) {
      throw new Error(`${label}[${index}].args must be an array of strings.`);
    }
    if (command.cwd !== undefined) {
      if (typeof command.cwd !== 'string' || path.isAbsolute(command.cwd)) {
        throw new Error(`${label}[${index}].cwd must be a relative path.`);
      }
    }
    if (command.env !== undefined && (
      typeof command.env !== 'object' ||
      command.env === null ||
      Array.isArray(command.env)
    )) {
      throw new Error(`${label}[${index}].env must be an object.`);
    }
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
        throw new Error(`${label}[${index}].env contains an invalid entry.`);
      }
    }
  }
}

const RUN_LOCK_HEARTBEAT_INTERVAL_MS = 5_000;
const RUN_LOCK_STALE_AFTER_MS = 30_000;

interface RunLockOwner {
  pid: number;
  instanceId: string;
  heartbeatAt: string;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function writeRunLock(file: string, owner: RunLockOwner, flag: 'wx' | 'w' = 'w'): void {
  fs.writeFileSync(file, JSON.stringify(owner), {
    encoding: 'utf8',
    flag,
    mode: 0o600,
  });
}

function acquireRunLock(file: string, runId: string): RunLockOwner {
  const owner = { pid: process.pid, instanceId: randomUUID(), heartbeatAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeRunLock(file, owner, 'wx');
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: Partial<RunLockOwner>;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunLockOwner>;
      } catch {
        fs.rmSync(file, { force: true });
        continue;
      }
      const heartbeat = Date.parse(existing.heartbeatAt ?? '');
      const isLive =
        typeof existing.instanceId === 'string' &&
        existing.instanceId.length > 0 &&
        isProcessRunning(existing.pid ?? 0) &&
        Number.isFinite(heartbeat) &&
        Date.now() - heartbeat < RUN_LOCK_STALE_AFTER_MS;
      if (isLive) {
        throw new Error(`Acquisition run ${runId} is already in progress.`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not acquire the lock for acquisition run ${runId}.`);
}

function refreshRunLock(file: string, owner: RunLockOwner): void {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunLockOwner>;
    if (current.instanceId !== owner.instanceId) return;
    writeRunLock(file, { ...owner, heartbeatAt: new Date().toISOString() });
  } catch {
    // The owner will fail on its next guarded operation if the lock disappears.
  }
}

function releaseRunLock(file: string, owner: RunLockOwner): void {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RunLockOwner>;
    if (current.instanceId === owner.instanceId) fs.rmSync(file, { force: true });
  } catch {
    // A missing or replaced lock is no longer owned by this process instance.
  }
}

/** The configured compatibility policy with every omitted field set to what this build serves. */
export function resolveAcquisitionPolicy(
  policy: Partial<ArtifactCompatibilityPolicy> = {}
): ArtifactCompatibilityPolicy {
  return {
    ...policy,
    serverVersion: policy.serverVersion ?? VERSION,
    minimumIndexSchemaVersion: policy.minimumIndexSchemaVersion ?? INDEX_SCHEMA_VERSION,
    maximumIndexSchemaVersion: policy.maximumIndexSchemaVersion ?? INDEX_SCHEMA_VERSION,
    requiredCapabilities: policy.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES,
  };
}

export function validateAcquisitionWorkerConfig(config: AcquisitionWorkerConfig): void {
  if (!config || typeof config !== 'object') throw new Error('Worker configuration must be an object.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(config.runId)) {
    throw new Error('runId must contain only letters, numbers, dots, underscores, and hyphens.');
  }
  if (!config.runsRoot?.trim()) throw new Error('runsRoot is required.');
  if (!Array.isArray(config.acquire)) throw new Error('acquire must be an array.');
  if (!Array.isArray(config.build)) throw new Error('build must be an array.');
  if (
    config.policy !== undefined &&
    (!config.policy || typeof config.policy !== 'object' || Array.isArray(config.policy))
  ) {
    throw new Error('policy must be an object.');
  }
  const validationRoot = path.join(path.parse(path.resolve(config.runsRoot)).root, 'run-work');
  resolveWithin(validationRoot, config.sourceDatabase, 'sourceDatabase');
  resolveWithin(validationRoot, config.bundleOptionsFile, 'bundleOptionsFile');
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive integer.');
  }
  if (!config.acquire.length) throw new Error('At least one acquisition command is required.');
  if (!config.build.length) throw new Error('At least one build command is required.');
  validateCommands(config.acquire, 'acquire');
  validateCommands(config.build, 'build');
  const policy = resolveAcquisitionPolicy(config.policy);
  if (!policy.serverVersion) throw new Error('policy.serverVersion is required.');
  if (!Array.isArray(policy.requiredCapabilities)) {
    throw new Error('policy.requiredCapabilities must be an array.');
  }
  const capabilities = new Set<string>(ARTIFACT_CAPABILITY_NAMES);
  if (policy.requiredCapabilities.some((capability) => !capabilities.has(capability))) {
    throw new Error('policy.requiredCapabilities contains an unknown capability.');
  }
  if (
    !Number.isSafeInteger(policy.minimumIndexSchemaVersion) ||
    !Number.isSafeInteger(policy.maximumIndexSchemaVersion) ||
    policy.minimumIndexSchemaVersion > policy.maximumIndexSchemaVersion
  ) {
    throw new Error('The index schema compatibility range is invalid.');
  }
}

function expand(value: string, context: AcquisitionRunContext): string {
  return value
    .replaceAll('${RUN_DIR}', context.runDirectory)
    .replaceAll('${WORK_DIR}', context.workDirectory)
    .replaceAll('${SOURCE_DB}', context.sourceDatabase)
    .replaceAll('${BUNDLE_OPTIONS_FILE}', context.bundleOptionsFile);
}

/** `<run>/logs/<phase>-<position>-<step name>.log`; retries of a run append to the same file. */
export function acquisitionStepLogFile(
  runDirectory: string,
  phase: AcquisitionPhase,
  index: number,
  name: string
): string {
  const safeName = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return path.join(runDirectory, 'logs', `${phase}-${index + 1}-${safeName || 'step'}.log`);
}

async function executeAcquisitionCommand(
  command: AcquisitionCommand,
  context: AcquisitionStepContext
): Promise<void> {
  context.signal.throwIfAborted();
  const cwd = command.cwd
    ? resolveWithin(context.workDirectory, command.cwd, `${command.name}.cwd`)
    : context.workDirectory;
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(context.logFile), { recursive: true });
  // Step output can name internal hosts or echo inputs. The mode keeps the log private on POSIX;
  // on Windows it inherits the runs root's ACL, which the worker setup limits to SYSTEM and
  // Administrators. Steps must not print credentials either way.
  const log = fs.openSync(context.logFile, 'a', 0o600);
  try {
    fs.writeSync(log, `[${new Date().toISOString()}] ${command.name}: started\n`);
    const child = spawn(command.executable, (command.args ?? []).map((arg) => expand(arg, context)), {
      cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(command.env ?? {}).map(([key, value]) => [key, expand(value, context)])
        ),
      },
      signal: context.signal,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else {
          reject(
            new Error(
              `Command step "${command.name}" failed with ${
                signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
              }. Output: ${context.logFile}`
            )
          );
        }
      });
    });
  } finally {
    fs.closeSync(log);
  }
}

function parseBundleOptions(file: string): CreateArtifactBundleOptions {
  if (!fs.statSync(file).isFile()) throw new Error(`Bundle options file is not a file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CreateArtifactBundleOptions;
}

async function runCommands(
  phase: AcquisitionPhase,
  commands: AcquisitionCommand[],
  context: AcquisitionRunContext,
  execute: NonNullable<AcquisitionWorkerDependencies['executeCommand']>
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    context.signal.throwIfAborted();
    await execute(command, {
      ...context,
      logFile: acquisitionStepLogFile(context.runDirectory, phase, index, command.name),
    });
  }
}

export class LocalArtifactPublisher implements ArtifactPublisher {
  constructor(private readonly storeRoot: string) {}

  async publish(
    bundle: ValidatedArtifactBundle,
    policy: ArtifactCompatibilityPolicy,
    signal: AbortSignal
  ): Promise<{ revision: number }> {
    signal.throwIfAborted();
    const destination = artifactBundleDirectory(this.storeRoot, bundle.manifest.bundleId);
    const bundlesRoot = path.dirname(destination);
    fs.mkdirSync(bundlesRoot, { recursive: true });
    const stagingRoot = fs.mkdtempSync(path.join(bundlesRoot, '.uploading-'));
    const staging = path.join(stagingRoot, path.basename(destination));
    try {
      fs.cpSync(bundle.directory, staging, { recursive: true, force: false });
      validateArtifactBundle(staging, policy);
      publishStagedArtifactDirectory(staging, destination);
    } catch (error) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw error;
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
    signal.throwIfAborted();
    // promoteArtifactBundle refuses a bundle that is not newer than the active one, reading only
    // the active manifest: the active bundle may predate the current policy.
    const pointers = readArtifactPointers(this.storeRoot);
    const promoted = promoteArtifactBundle(
      this.storeRoot,
      bundle.manifest.bundleId,
      pointers.revision,
      policy
    );
    return { revision: promoted.revision };
  }
}

export class AzureArtifactPublisher implements ArtifactPublisher {
  constructor(private readonly store: AzureBlobArtifactStore) {}

  async publish(
    bundle: ValidatedArtifactBundle,
    policy: ArtifactCompatibilityPolicy,
    signal: AbortSignal
  ): Promise<{ revision: number }> {
    signal.throwIfAborted();
    await this.store.uploadBundle(bundle.directory, policy);
    signal.throwIfAborted();
    let promoted: ArtifactPointerSnapshot | undefined;
    await this.store.withAcquisitionLease(async (writer) => {
      signal.throwIfAborted();
      const current = await this.store.readPointers();
      promoted = await writer.promote(
        bundle.manifest.bundleId,
        current.pointers.revision,
        policy
      );
    });
    if (!promoted) throw new Error('Azure artifact promotion did not return a pointer snapshot.');
    return { revision: promoted.pointers.revision };
  }
}

export async function runAcquisitionWorker(
  config: AcquisitionWorkerConfig,
  publisher: ArtifactPublisher,
  options: { signal?: AbortSignal } = {},
  dependencies: AcquisitionWorkerDependencies = {}
): Promise<AcquisitionRunStatus> {
  validateAcquisitionWorkerConfig(config);
  const policy = resolveAcquisitionPolicy(config.policy);
  const now = dependencies.now ?? (() => new Date());
  const execute = dependencies.executeCommand ?? executeAcquisitionCommand;
  const createBundle = dependencies.createBundle ?? createArtifactBundle;
  const validateBundle = dependencies.validateBundle ?? validateArtifactBundle;
  const runDirectory = path.join(path.resolve(config.runsRoot), config.runId);
  const workDirectory = path.join(runDirectory, 'work');
  const localStore = path.join(workDirectory, 'artifact-candidate');
  const file = statusFile(runDirectory);
  fs.mkdirSync(runDirectory, { recursive: true });

  const previous = readPreviousStatus(file);
  if (previous?.state === 'succeeded') return previous;

  const lockFile = path.join(runDirectory, '.lock');
  const lockOwner = acquireRunLock(lockFile, config.runId);
  const lockHeartbeat = setInterval(() => refreshRunLock(lockFile, lockOwner), RUN_LOCK_HEARTBEAT_INTERVAL_MS);
  lockHeartbeat.unref();
  let status: AcquisitionRunStatus;
  try {
    fs.rmSync(workDirectory, { recursive: true, force: true });
    fs.mkdirSync(workDirectory, { recursive: true });
    const startedAt = now().toISOString();
    status = {
      schemaVersion: 1,
      runId: config.runId,
      attempt: (previous?.attempt ?? 0) + 1,
      state: 'running',
      startedAt,
      currentPhase: null,
      phases: initialPhases(),
    };
    writeJsonAtomic(file, status);
  } catch (error) {
    clearInterval(lockHeartbeat);
    releaseRunLock(lockFile, lockOwner);
    throw error;
  }

  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(options.signal?.reason ?? new Error('Acquisition run cancelled.'));
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error(`Acquisition run timed out after ${config.timeoutMs}ms.`)),
    config.timeoutMs
  );
  timeout.unref();
  const context: AcquisitionRunContext = {
    runDirectory,
    workDirectory,
    sourceDatabase: resolveWithin(workDirectory, config.sourceDatabase, 'sourceDatabase'),
    bundleOptionsFile: resolveWithin(workDirectory, config.bundleOptionsFile, 'bundleOptionsFile'),
    signal: controller.signal,
  };
  let bundle: ValidatedArtifactBundle | undefined;
  let completedPhases = false;

  const persist = () => writeJsonAtomic(file, status);
  const phase = async (name: AcquisitionPhase, action: () => void | Promise<void>) => {
    controller.signal.throwIfAborted();
    status.currentPhase = name;
    status.phases[name] = { state: 'running', startedAt: now().toISOString() };
    persist();
    try {
      await action();
      status.phases[name] = {
        ...status.phases[name],
        state: 'succeeded',
        completedAt: now().toISOString(),
      };
      persist();
    } catch (error) {
      status.phases[name] = {
        ...status.phases[name],
        state: 'failed',
        completedAt: now().toISOString(),
        error: safeError(error),
      };
      persist();
      throw error;
    }
  };

  try {
    await phase('acquire', () => runCommands('acquire', config.acquire, context, execute));
    await phase('build', () => runCommands('build', config.build, context, execute));
    await phase('bundle', () => {
      bundle = createBundle(
        context.sourceDatabase,
        localStore,
        parseBundleOptions(context.bundleOptionsFile)
      );
      status.bundleId = bundle.manifest.bundleId;
    });
    await phase('validate', () => {
      if (!bundle) throw new Error('Artifact bundle was not created.');
      bundle = validateBundle(bundle.directory, policy);
      status.validation = {
        status: bundle.validationReport.status,
        checks: bundle.validationReport.checks,
      };
    });
    await phase('publish', async () => {
      if (!bundle) throw new Error('Validated artifact bundle is unavailable.');
      const result = await publisher.publish(bundle, policy, controller.signal);
      status.pointerRevision = result.revision;
    });
    completedPhases = true;
  } catch (error) {
    status.state = controller.signal.aborted ? 'cancelled' : 'failed';
    status.error = safeError(controller.signal.aborted ? controller.signal.reason : error);
    for (const name of ACQUISITION_PHASES) {
      if (status.phases[name].state === 'pending') status.phases[name] = { state: 'skipped' };
    }
  } finally {
    try {
      status.currentPhase = 'cleanup';
      status.phases.cleanup = { state: 'running', startedAt: now().toISOString() };
      persist();
      if (!config.retainWorkDirectory) {
        fs.rmSync(workDirectory, { recursive: true, force: true });
      }
      status.phases.cleanup = {
        ...status.phases.cleanup,
        state: 'succeeded',
        completedAt: now().toISOString(),
      };
      if (completedPhases) status.state = 'succeeded';
    } catch (cleanupError) {
      status.phases.cleanup = {
        ...status.phases.cleanup,
        state: 'failed',
        completedAt: now().toISOString(),
        error: safeError(cleanupError),
      };
      status.state = 'failed';
      status.error = safeError(cleanupError);
    }
    clearTimeout(timeout);
    clearInterval(lockHeartbeat);
    options.signal?.removeEventListener('abort', abortFromCaller);
    status.currentPhase = null;
    status.completedAt = now().toISOString();
    persist();
    releaseRunLock(lockFile, lockOwner);
  }

  if (status.state !== 'succeeded') {
    throw new AcquisitionWorkerError(
      `Acquisition run ${config.runId} ${status.state}: ${status.error ?? 'unknown failure'}`,
      status
    );
  }
  return status;
}
