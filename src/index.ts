#!/usr/bin/env node
import { parseArgs, flagString, HELP_TEXT } from './cli/args.js';
import { VERSION } from './version.js';

/** Reads a boolean flag given as `--flag` or `--flag=true`. */
function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

export interface CliResult {
  code: number;
  /** True when the command owns the process lifecycle (the server keeps running). */
  keepAlive?: boolean;
}

export async function run(argv: string[]): Promise<CliResult> {
  const { command, flags, positionals } = parseArgs(argv);

  if (flags.help === true || flags.h === true || command === 'help') {
    console.log(HELP_TEXT);
    return { code: 0 };
  }
  if (flags.version === true || flags.v === true || command === 'version') {
    console.log(VERSION);
    return { code: 0 };
  }

  switch (command) {
    case 'serve': {
      // Imported lazily so `index`/`doctor`/`setup` never load the MCP server,
      // its transports, or the strict runtime config validation.
      const { startServer } = await import('./server/start.js');
      await startServer();
      return { code: 0, keepAlive: true };
    }
    case 'index': {
      const { indexCommand } = await import('./cli/index-command.js');
      return {
        code: await indexCommand({
          force: flags.force === true || flags.force === 'true',
          packagesDir: flagString(flags, 'packages-dir'),
          dbPath: flagString(flags, 'db-path'),
        }),
      };
    }
    case 'acquire': {
      const { acquireCommand } = await import('./cli/acquire-command.js');
      return {
        code: await acquireCommand({
          config: flagString(flags, 'config'),
          runId: flagString(flags, 'run-id'),
        }),
      };
    }
    case 'index-trace': {
      const { indexTraceCommand } = await import('./cli/index-trace-command.js');
      const maxRows = flagString(flags, 'max-rows');
      return {
        code: await indexTraceCommand({
          connectionString: flagString(flags, 'connection-string'),
          fromJson: flagString(flags, 'from-json'),
          source: flagString(flags, 'source'),
          trace: flagString(flags, 'trace'),
          maxRows: maxRows === undefined ? undefined : Number(maxRows),
          dbPath: flagString(flags, 'db-path'),
        }),
      };
    }
    case 'index-release-plans': {
      const { indexReleasePlansCommand } = await import('./cli/index-release-plans-command.js');
      const products = flagString(flags, 'products');
      return {
        code: await indexReleasePlansCommand({
          fromJson: flagString(flags, 'from-json'),
          url: flagString(flags, 'url'),
          allProducts: flagBool(flags, 'all-products'),
          products: products?.split(',').map((p) => p.trim()).filter(Boolean),
          dbPath: flagString(flags, 'db-path'),
        }),
      };
    }
    case 'index-xref': {
      const { indexXrefCommand } = await import('./cli/index-xref-command.js');
      return {
        code: await indexXrefCommand({
          connectionString: flagString(flags, 'connection-string'),
          dbPath: flagString(flags, 'db-path'),
          allowEmpty: flags['allow-empty'] === true || flags['allow-empty'] === 'true',
          allowSourceLocks: flags['allow-source-locks'] === true || flags['allow-source-locks'] === 'true',
          storeRaw: flags['store-raw'] === true || flags['store-raw'] === 'true',
        }),
      };
    }
    case 'index-bp': {
      const { indexBpCommand } = await import('./cli/index-bp-command.js');
      return {
        code: await indexBpCommand({
          files: positionals,
          model: flagString(flags, 'model'),
          dbPath: flagString(flags, 'db-path'),
          allowEmpty: flagBool(flags, 'allow-empty'),
        }),
      };
    }
    case 'doctor': {
      const { doctorCommand } = await import('./cli/doctor.js');
      return { code: await doctorCommand(process.env) };
    }
    case 'index-status': {
      const { indexStatusCommand } = await import('./cli/index-status-command.js');
      return {
        code: await indexStatusCommand({
          packagesDir: flagString(flags, 'packages-dir'),
          dbPath: flagString(flags, 'db-path'),
          json: flagBool(flags, 'json'),
          list: flagString(flags, 'list'),
        }),
      };
    }
    case 'digest': {
      const { digestCommand } = await import('./cli/digest.js');
      return {
        code: await digestCommand({
          file: flagString(flags, 'file'),
          slug: flagString(flags, 'slug'),
          dryRun: flags['dry-run'] === true || flags['dry-run'] === 'true',
          force: flags.force === true || flags.force === 'true',
          kbDir: flagString(flags, 'kb-dir'),
          dbPath: flagString(flags, 'db-path'),
        }),
      };
    }
    case 'fetch-model': {
      const { fetchModelCommand } = await import('./cli/fetch-model-command.js');
      return { code: await fetchModelCommand({ dir: flagString(flags, 'dir') }) };
    }
    case 'knowledge-check': {
      const { knowledgeCheckCommand } = await import('./cli/knowledge-check-command.js');
      return { code: await knowledgeCheckCommand({ kbDir: flagString(flags, 'kb-dir') }) };
    }
    case 'setup': {
      const { setupCommand } = await import('./cli/setup.js');
      const code = await setupCommand({
        nonInteractive: flags['non-interactive'] === true || flags['non-interactive'] === 'true',
        packagesDir: flagString(flags, 'packages-dir'),
        apiKey: flagString(flags, 'api-key'),
        dbPath: flagString(flags, 'db-path'),
        transport: flagString(flags, 'transport'),
        force: flagBool(flags, 'force'),
      });
      return { code };
    }
    case 'artifact': {
      const { artifactCommand } = await import('./cli/artifact-command.js');
      return {
        code: await artifactCommand({
          action: positionals[0],
          bundleDir: flagString(flags, 'bundle-dir'),
          bundleId: flagString(flags, 'bundle-id'),
          expectedRevision: flagString(flags, 'expected-revision'),
          json: flagBool(flags, 'json'),
          verify: flagBool(flags, 'verify'),
        }),
      };
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP_TEXT);
      return { code: 1 };
  }
}

async function main() {
  const { config } = await import('dotenv');
  config({ quiet: true });

  const result = await run(process.argv.slice(2));
  // `serve` keeps the event loop alive on its own; exiting here would kill it.
  if (!result.keepAlive || result.code !== 0) {
    process.exit(result.code);
  }
}

main().catch((err: unknown) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
