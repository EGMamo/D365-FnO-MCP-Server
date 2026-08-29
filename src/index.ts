#!/usr/bin/env node
import { parseArgs, flagString, HELP_TEXT } from './cli/args.js';

const CLI_VERSION = '0.1.0';

export interface CliResult {
  code: number;
  /** True when the command owns the process lifecycle (the server keeps running). */
  keepAlive?: boolean;
}

export async function run(argv: string[]): Promise<CliResult> {
  const { command, flags } = parseArgs(argv);

  if (flags.help === true || flags.h === true || command === 'help') {
    console.log(HELP_TEXT);
    return { code: 0 };
  }
  if (flags.version === true || flags.v === true || command === 'version') {
    console.log(CLI_VERSION);
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
      return { code: await indexCommand({ force: flags.force === true || flags.force === 'true' }) };
    }
    case 'doctor': {
      const { doctorCommand } = await import('./cli/doctor.js');
      return { code: await doctorCommand() };
    }
    case 'setup': {
      const { setupCommand } = await import('./cli/setup.js');
      const code = await setupCommand({
        nonInteractive: flags['non-interactive'] === true || flags['non-interactive'] === 'true',
        packagesDir: flagString(flags, 'packages-dir'),
        apiKey: flagString(flags, 'api-key'),
        dbPath: flagString(flags, 'db-path'),
        transport: flagString(flags, 'transport'),
      });
      return { code };
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP_TEXT);
      return { code: 1 };
  }
}

async function main() {
  const { config } = await import('dotenv');
  config();

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
