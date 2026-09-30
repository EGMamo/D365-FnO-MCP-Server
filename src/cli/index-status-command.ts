import fs from 'node:fs';
import path from 'node:path';
import { checkIndexStatus, servedIndexFromInfo, type IndexStatus, type ServedIndex } from '../indexer/indexStatus.js';
import { redactUrl } from '../indexer/remoteIndex.js';
import { IndexUploadClient, normalizeServerUrl } from '../indexer/uploadClient.js';

/**
 * Reports whether the index a server serves is still current for the local
 * packages folder: what changed since it was built, and whether a newer local
 * index is waiting to be uploaded. Read-only; builds and uploads nothing.
 *
 * `--json` prints one JSON object on stdout (used by the Visual Studio
 * extension). Exit code 0 means the check ran, whatever it found.
 */

export interface IndexStatusCommandOptions {
  packagesDir?: string;
  dbPath?: string;
  server?: string;
  json?: boolean;
  list?: string;
  fetchImpl?: typeof fetch;
}

function age(iso: string | null | undefined, now: number): string {
  if (!iso) return 'unknown';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const hours = Math.max(0, (now - time) / 3_600_000);
  const ago = hours < 1 ? 'less than an hour ago' : hours < 48 ? `${Math.floor(hours)} hour(s) ago` : `${Math.floor(hours / 24)} day(s) ago`;
  return `${iso} (${ago})`;
}

function printHuman(status: IndexStatus): void {
  const now = Date.now();
  if (status.server) {
    const objects = status.server.objects === null ? '' : `, ${status.server.objects.toLocaleString('en-US')} objects`;
    console.log(`Server index: built ${age(status.server.builtAt, now)}${status.server.source ? `, ${status.server.source}` : ''}${objects}`);
    if (status.server.xrefImportedAt) console.log(`  XRef imported ${age(status.server.xrefImportedAt, now)}`);
  }
  if (status.local) console.log(`Local index:  built ${age(status.local.builtAt, now)}, ${status.local.objects.toLocaleString('en-US')} objects`);
  console.log(`Scanned ${status.scannedFiles.toLocaleString('en-US')} file(s) in ${(status.scanMs / 1000).toFixed(1)} s ` +
    `(compared with the ${status.basis === 'local-index' ? 'local index' : 'server build time'})`);
  const removed = status.removed === null ? '' : `, ${status.removed} removed`;
  console.log(`Changes: ${status.added} added, ${status.changed} changed${removed}`);
  for (const { model, files } of status.models.slice(0, 10)) console.log(`  ${model}: ${files}`);
  for (const file of status.files) console.log(`  ${file.kind.padEnd(7)} ${file.path}`);
  if (status.upToDate) {
    console.log('\nThe index is up to date.');
  } else {
    console.log('\nThe index is out of date:');
    for (const reason of status.reasons) console.log(`  - ${reason}`);
  }
}

export async function indexStatusCommand(
  options: IndexStatusCommandOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const fail = (message: string): number => {
    if (options.json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    else console.error(message);
    return 1;
  };

  const packagesDir = options.packagesDir ?? env.D365_PACKAGES_DIR;
  if (!packagesDir) return fail('No packages folder. Pass --packages-dir or set D365_PACKAGES_DIR.');
  if (!fs.existsSync(packagesDir) || !fs.statSync(packagesDir).isDirectory()) return fail(`The packages folder "${packagesDir}" does not exist.`);

  const list = options.list === undefined ? 20 : Number(options.list);
  if (!Number.isInteger(list) || list < 0) return fail(`--list must be a whole number (got '${options.list}').`);

  let server: ServedIndex | null = null;
  const serverUrl = options.server ?? env.D365_MCP_SERVER_URL;
  if (serverUrl) {
    const apiKey = env.D365_MCP_API_KEY;
    if (!apiKey) return fail('Set D365_MCP_API_KEY to ask the server which index it serves (never pass it on the command line).');
    try {
      const client = new IndexUploadClient(normalizeServerUrl(serverUrl), apiKey, options.fetchImpl);
      server = servedIndexFromInfo(await client.info());
    } catch (err) {
      return fail(`Could not read the served index from ${redactUrl(serverUrl)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const dbPath = path.resolve(options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db');
  let status: IndexStatus;
  try {
    status = await checkIndexStatus({ packagesDir, dbPath, server, listLimit: list });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (options.json) process.stdout.write(`${JSON.stringify(status)}\n`);
  else printHuman(status);
  return 0;
}
