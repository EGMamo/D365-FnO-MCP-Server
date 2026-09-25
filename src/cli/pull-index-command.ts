import path from 'path';
import { redactUrl, syncIndexFromManifest } from '../indexer/remoteIndex.js';
import { VERSION } from '../version.js';

/**
 * Downloads the published index without indexing anything locally. Reads the
 * manifest URL and DB path from the environment so `.env` works as for `serve`.
 */
export async function pullIndexCommand(
  options: { url?: string; dbPath?: string; force?: boolean },
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const url = options.url ?? env.D365_INDEX_URL;
  if (!url) {
    console.error('No manifest URL. Pass --url <manifest-url> or set D365_INDEX_URL.');
    return 1;
  }
  const dbPath = path.resolve(options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db');

  console.log(`Pulling published index from ${redactUrl(url)} -> ${dbPath}`);
  console.log('Stop any server that has this database open before pulling.');

  try {
    const result = await syncIndexFromManifest({
      manifestUrl: url,
      dbPath,
      force: options.force === true,
      expectedServerVersion: VERSION,
    });
    const { manifest } = result;
    console.log(
      result.status === 'up-to-date'
        ? '\nLocal index already matches the published version.'
        : '\nDownloaded the published index.'
    );
    console.log(`  version       : ${manifest.version}`);
    console.log(`  built at      : ${manifest.builtAt}`);
    console.log(`  server version: ${manifest.serverVersion}`);
    console.log(`  objects       : ${manifest.stats.objects}`);
    console.log(`  labels        : ${manifest.stats.labels}`);
    console.log(`  usage rows    : ${manifest.stats.usageRows}`);
    console.log(`  gzip bytes    : ${manifest.db.bytes}`);
    console.log(`  sha256        : ${manifest.db.sha256}`);
    return 0;
  } catch (err) {
    console.error(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
