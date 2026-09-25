import path from 'path';
import { publishIndex } from '../indexer/publishIndex.js';
import { VERSION } from '../version.js';

export interface PublishIndexCommandOptions {
  dbPath?: string;
  out?: string;
  dbUrlPrefix?: string;
  allowNoRawXml?: boolean;
  integrityCheck?: boolean;
  relativePaths?: boolean;
}

/**
 * Packages the local index for upload. Reads defaults from the environment so
 * the same `.env` that drives `index` also drives publishing.
 */
export async function publishIndexCommand(
  options: PublishIndexCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const dbPath = options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db';
  const out = options.out ?? './publish';

  let relativePathsRoot: string | undefined;
  if (options.relativePaths) {
    if (!env.D365_PACKAGES_DIR) {
      console.error('--relative-paths needs D365_PACKAGES_DIR so the prefix to strip is known.');
      return 1;
    }
    relativePathsRoot = env.D365_PACKAGES_DIR;
  }

  console.log(`Publishing ${path.resolve(dbPath)} -> ${path.resolve(out)}`);
  try {
    const result = await publishIndex({
      dbPath,
      outDir: out,
      serverVersion: VERSION,
      dbUrlPrefix: options.dbUrlPrefix,
      allowNoRawXml: options.allowNoRawXml === true,
      integrityCheck: options.integrityCheck === true,
      relativePathsRoot,
    });
    const { manifest } = result;
    console.log('\nPublished:');
    console.log(`  version       : ${result.version}`);
    console.log(`  folder        : ${result.versionDir}`);
    console.log(`  latest        : ${result.latestManifestPath}`);
    console.log(`  built at      : ${manifest.builtAt}`);
    console.log(`  objects       : ${manifest.stats.objects}`);
    console.log(`  labels        : ${manifest.stats.labels}`);
    console.log(`  usage rows    : ${manifest.stats.usageRows}`);
    console.log(`  xref imported : ${manifest.xref?.importedAt ?? 'none'}`);
    console.log(`  db bytes      : ${manifest.db.rawBytes}`);
    console.log(`  gzip bytes    : ${manifest.db.bytes}`);
    console.log(`  sha256        : ${manifest.db.sha256}`);
    console.log(`\nUpload the '${result.version}' folder first and latest/manifest.json last.`);
    return 0;
  } catch (err) {
    console.error(`Publish failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
