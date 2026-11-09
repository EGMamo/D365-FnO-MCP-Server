import { createKeyRegistry, type KeyRegistry } from './keyRegistry.js';
import { createFileRegistryStore } from './keyRegistryFile.js';

/** The registry settings, as `configLoader` reads them. */
export type KeyRegistrySettings =
  | { kind: 'file'; path: string }
  | { kind: 'azure-blob'; accountUrl: string; container: string };

/** Opens the configured registry; the Azure SDK is loaded only for a blob registry. Throws when it cannot be read. */
export async function openKeyRegistry(settings: KeyRegistrySettings, managedIdentityClientId = ''): Promise<KeyRegistry> {
  if (settings.kind === 'file') return createKeyRegistry(createFileRegistryStore(settings.path));
  const { azureRegistryBlob, createBlobRegistryStore } = await import('./keyRegistryBlob.js');
  const blob = await azureRegistryBlob(settings.accountUrl, settings.container, managedIdentityClientId || undefined);
  return createKeyRegistry(createBlobRegistryStore(blob));
}
