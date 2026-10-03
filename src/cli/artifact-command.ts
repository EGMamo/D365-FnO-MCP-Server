import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from '../version.js';
import { INDEX_SCHEMA_VERSION } from '../indexer/db.js';
import {
  ARTIFACT_CAPABILITY_NAMES,
  type ArtifactCapabilityName,
  type ArtifactCompatibilityPolicy,
} from '../indexer/artifactContract.js';
import { validateArtifactBundle } from '../indexer/artifactBundle.js';
import {
  createAzureBlobArtifactStore,
  type AzureBlobArtifactStoreOptions,
} from '../indexer/azureBlobArtifactStoreSdk.js';
import type {
  ArtifactPointerSnapshot,
  AzureBlobArtifactStore,
  AzureBlobArtifactWriter,
} from '../indexer/azureBlobArtifactStore.js';

export type ArtifactAction = 'publish' | 'status' | 'promote' | 'rollback';

export interface ArtifactCommandOptions {
  action?: string;
  bundleDir?: string;
  bundleId?: string;
  expectedRevision?: string;
  json?: boolean;
  verify?: boolean;
  store?: AzureBlobArtifactStore;
  env?: NodeJS.ProcessEnv;
}

function output(options: ArtifactCommandOptions, value: unknown): void {
  if (options.json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function fail(options: ArtifactCommandOptions, message: string): number {
  if (options.json) output(options, { error: message });
  else console.error(message);
  return 1;
}

function requiredString(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

function capabilities(value: string | undefined): ArtifactCapabilityName[] {
  if (!value?.trim()) return [...ARTIFACT_CAPABILITY_NAMES];
  const result = value.split(',').map((item) => item.trim()).filter(Boolean);
  const allowed = new Set<string>(ARTIFACT_CAPABILITY_NAMES);
  if (result.some((item) => !allowed.has(item))) {
    throw new Error(`--required-capabilities contains an unknown capability.`);
  }
  return [...new Set(result)] as ArtifactCapabilityName[];
}

function policy(env: NodeJS.ProcessEnv): ArtifactCompatibilityPolicy {
  const minimum = Number(env.D365_ARTIFACT_MIN_INDEX_SCHEMA_VERSION ?? INDEX_SCHEMA_VERSION);
  const maximum = Number(env.D365_ARTIFACT_MAX_INDEX_SCHEMA_VERSION ?? INDEX_SCHEMA_VERSION);
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum < minimum) {
    throw new Error('D365_ARTIFACT_MIN_INDEX_SCHEMA_VERSION and MAX must be valid schema versions.');
  }
  return {
    serverVersion: env.D365_ARTIFACT_SERVER_VERSION?.trim() || VERSION,
    minimumIndexSchemaVersion: minimum,
    maximumIndexSchemaVersion: maximum,
    requiredCapabilities: capabilities(env.D365_ARTIFACT_REQUIRED_CAPABILITIES),
  };
}

function createStore(env: NodeJS.ProcessEnv): AzureBlobArtifactStore {
  const accountUrl = requiredString(env.D365_ARTIFACT_ACCOUNT_URL, 'D365_ARTIFACT_ACCOUNT_URL');
  const containerName = requiredString(env.D365_ARTIFACT_CONTAINER, 'D365_ARTIFACT_CONTAINER');
  const options: AzureBlobArtifactStoreOptions = {
    accountUrl,
    containerName,
    managedIdentityClientId: env.D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID?.trim() || undefined,
  };
  return createAzureBlobArtifactStore(options);
}

function writer(store: AzureBlobArtifactStore, action: (writer: AzureBlobArtifactWriter) => Promise<void>) {
  return store.withAcquisitionLease(async (artifactWriter) => action(artifactWriter));
}

function revision(value: string | undefined): number {
  return positiveInteger(value, '--expected-revision');
}

function bundleId(value: string | undefined): string {
  return requiredString(value, '--bundle-id');
}

export async function artifactCommand(options: ArtifactCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  try {
    const action = options.action as ArtifactAction | undefined;
    if (!action || !['publish', 'status', 'promote', 'rollback'].includes(action)) {
      return fail(options, 'Artifact action must be one of: publish, status, promote, rollback.');
    }
    const store = options.store ?? createStore(env);
    const checkedPolicy = policy(env);

    if (action === 'status') {
      await store.verifyContainer();
      const snapshot = await store.readPointers();
      const result: Record<string, unknown> = {
        pointers: snapshot.pointers,
        etag: snapshot.etag,
      };
      if (options.verify) {
        const verified: Record<string, string> = {};
        let verificationFailed = false;
        for (const pointer of [snapshot.pointers.active, snapshot.pointers.previous]) {
          if (!pointer) continue;
          const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-artifact-status-'));
          try {
            await store.materializeBundle(pointer.bundleId, {
              localStoreRoot: temporary,
              policy: checkedPolicy,
            });
            verified[pointer.bundleId] = 'passed';
          } catch (error) {
            verificationFailed = true;
            verified[pointer.bundleId] = error instanceof Error ? `failed: ${error.message}` : `failed: ${String(error)}`;
          } finally {
            fs.rmSync(temporary, { recursive: true, force: true });
          }
        }
        result.verification = verified;
        output(options, result);
        return verificationFailed ? 1 : 0;
      }
      output(options, result);
      return 0;
    }

    if (action === 'publish') {
      const directory = path.resolve(requiredString(options.bundleDir, '--bundle-dir'));
      if (!fs.statSync(directory).isDirectory()) throw new Error(`Bundle directory does not exist: ${directory}`);
      const validated = validateArtifactBundle(directory, checkedPolicy);
      let result = validated.manifest;
      await writer(store, async (artifactWriter) => {
        const uploaded = await artifactWriter.uploadBundle(directory, checkedPolicy);
        result = uploaded.manifest;
      });
      output(options, { action, bundleId: result.bundleId, manifest: result });
      return 0;
    }

    if (action === 'promote') {
      const target = bundleId(options.bundleId);
      let snapshot: ArtifactPointerSnapshot | undefined;
      await store.withAcquisitionLease(async (artifactWriter) => {
        snapshot = await artifactWriter.promote(target, revision(options.expectedRevision), checkedPolicy);
      });
      if (!snapshot) throw new Error('Promotion did not return a pointer snapshot.');
      output(options, { action, ...snapshot });
      return 0;
    }

    let snapshot: ArtifactPointerSnapshot | undefined;
    await store.withAcquisitionLease(async (artifactWriter) => {
      snapshot = await artifactWriter.rollback(revision(options.expectedRevision), checkedPolicy);
    });
    if (!snapshot) throw new Error('Rollback did not return a pointer snapshot.');
    output(options, { action, ...snapshot });
    return 0;
  } catch (error) {
    return fail(options, error instanceof Error ? error.message : String(error));
  }
}
