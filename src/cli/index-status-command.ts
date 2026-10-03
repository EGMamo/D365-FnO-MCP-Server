import fs from 'node:fs';
import path from 'node:path';
import { checkIndexStatus, type IndexStatus } from '../indexer/indexStatus.js';

/**
 * Reports whether the local index is current for the packages folder and what
 * changed since it was built. Read-only; builds nothing.
 *
 * `--json` prints one JSON object on stdout (used by the Visual Studio
 * extension). Exit code 0 means the check ran, whatever it found.
 */

export interface IndexStatusCommandOptions {
  packagesDir?: string;
  dbPath?: string;
  json?: boolean;
  list?: string;
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
  if (status.local) console.log(`Local index:  built ${age(status.local.builtAt, now)}, ${status.local.objects.toLocaleString('en-US')} objects`);
  console.log(`Scanned ${status.scannedFiles.toLocaleString('en-US')} file(s) in ${(status.scanMs / 1000).toFixed(1)} s (compared with the local index)`);
  console.log(`Changes: ${status.added} added, ${status.changed} changed, ${status.removed} removed`);
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

  const dbPath = path.resolve(options.dbPath ?? env.D365_INDEX_DB_PATH ?? './d365_index.db');
  let status: IndexStatus;
  try {
    status = await checkIndexStatus({ packagesDir, dbPath, listLimit: list });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (options.json) process.stdout.write(`${JSON.stringify(status)}\n`);
  else printHuman(status);
  return 0;
}
