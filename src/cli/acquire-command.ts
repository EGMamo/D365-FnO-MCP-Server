import fs from 'node:fs';
import path from 'node:path';
import {
  AzureArtifactPublisher,
  LocalArtifactPublisher,
  runAcquisitionWorker,
  validateAcquisitionWorkerConfig,
  type AcquisitionWorkerConfig,
  type ArtifactPublisher,
} from '../indexer/acquisitionWorker.js';

interface LocalDestination {
  type: 'local';
  storeRoot: string;
}

interface AzureDestination {
  type: 'azure-blob';
  accountUrl: string;
  containerName: string;
  managedIdentityClientId?: string;
}

interface AcquisitionFile extends Omit<AcquisitionWorkerConfig, 'runId'> {
  destination: LocalDestination | AzureDestination;
}

function parseConfiguration(file: string, runId: string): AcquisitionFile {
  const resolved = path.resolve(file);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8')) as AcquisitionFile;
  if (!parsed || typeof parsed !== 'object') throw new Error('Worker configuration must be an object.');
  validateAcquisitionWorkerConfig({ ...parsed, runId });
  if (!parsed.destination || !['local', 'azure-blob'].includes(parsed.destination.type)) {
    throw new Error('destination.type must be local or azure-blob.');
  }
  if (parsed.destination.type === 'local' && !parsed.destination.storeRoot) {
    throw new Error('destination.storeRoot is required.');
  }
  if (
    parsed.destination.type === 'azure-blob' &&
    (!parsed.destination.accountUrl || !parsed.destination.containerName)
  ) {
    throw new Error('Azure destination accountUrl and containerName are required.');
  }
  if (parsed.destination.type === 'azure-blob') {
    const accountUrl = new URL(parsed.destination.accountUrl);
    if (
      accountUrl.protocol !== 'https:' ||
      accountUrl.username ||
      accountUrl.password ||
      accountUrl.search ||
      accountUrl.hash
    ) {
      throw new Error('Azure accountUrl must be an HTTPS origin without credentials or query parameters.');
    }
  }
  return parsed;
}

async function createPublisher(destination: AcquisitionFile['destination']): Promise<ArtifactPublisher> {
  if (destination.type === 'local') return new LocalArtifactPublisher(destination.storeRoot);
  const { createAzureBlobArtifactStore } = await import('../indexer/azureBlobArtifactStoreSdk.js');
  const store = createAzureBlobArtifactStore(destination);
  await store.verifyContainer();
  return new AzureArtifactPublisher(store);
}

export async function acquireCommand(
  options: { config?: string; runId?: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const configFile = options.config ?? env.D365_ACQUISITION_CONFIG;
  if (!configFile) {
    console.error('Set D365_ACQUISITION_CONFIG or pass --config.');
    return 1;
  }
  const runId = options.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error('Acquisition worker cancelled.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const parsed = parseConfiguration(configFile, runId);
    const publisher = await createPublisher(parsed.destination);
    const status = await runAcquisitionWorker(
      { ...parsed, runId },
      publisher,
      { signal: abort.signal }
    );
    console.log(
      JSON.stringify({
        runId: status.runId,
        state: status.state,
        bundleId: status.bundleId,
        pointerRevision: status.pointerRevision,
        statusFile: path.join(path.resolve(parsed.runsRoot), runId, 'status.json'),
      })
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Acquisition worker failed: ${message}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
