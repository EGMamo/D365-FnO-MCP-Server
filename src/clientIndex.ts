#!/usr/bin/env node
import { parseArgs } from './cli/args.js';
import { CLIENT_HELP_TEXT } from './cli/clientArgs.js';
import { VERSION } from './version.js';

/**
 * Entry point of the developer package (`d365-fno-mcp`): setup, gateway, doctor, help and version only. It
 * imports nothing of the server, the key administration or the deploy walkthrough; tests/packageBoundary.test.ts
 * keeps it that way.
 */
export async function runClient(argv: string[]): Promise<{ code: number; keepAlive?: boolean }> {
  const { command, flags, positionals } = parseArgs(argv);
  if (flags.help === true || command === 'help') {
    console.log(CLIENT_HELP_TEXT);
    return { code: 0 };
  }
  if (flags.version === true || command === 'version') {
    console.log(VERSION);
    return { code: 0 };
  }
  // parseArgs makes `serve` the default command; the developer package has none, so no word means help.
  if (argv.length === 0 || (command === 'serve' && positionals.length === 0 && !argv.includes('serve'))) {
    console.log(CLIENT_HELP_TEXT);
    return { code: 0 };
  }
  switch (command) {
    case 'setup': {
      const { parseSetupFlags, setupCommand, DEVELOPER_BIN } = await import('./cli/setup.js');
      const parsed = parseSetupFlags(flags);
      if ('error' in parsed) {
        console.error(parsed.error);
        return { code: 1 };
      }
      return { code: await setupCommand({ ...parsed.options, edition: { bin: DEVELOPER_BIN } }) };
    }
    case 'gateway': {
      const { startGateway } = await import('./gateway/server.js');
      return { code: await startGateway(process.env), keepAlive: true };
    }
    case 'doctor': {
      const { doctorCommand } = await import('./cli/doctor.js');
      return { code: await doctorCommand(process.env, { bin: 'd365-fno-mcp', edition: 'developer' }) };
    }
    default:
      console.error(`Unknown command: ${command}. The developer package has setup, gateway, doctor, help and version; the server commands are in the operator package (d365-fno-mcp-server).\n`);
      console.error(CLIENT_HELP_TEXT);
      return { code: 1 };
  }
}

async function main(): Promise<void> {
  const { config } = await import('dotenv');
  config({ quiet: true });
  const result = await runClient(process.argv.slice(2));
  if (!result.keepAlive || result.code !== 0) process.exit(result.code);
}

// Only when run as the program, so tests can import runClient.
if (process.argv[1] && /clientIndex\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`Fatal: ${String(err)}`);
    process.exit(1);
  });
}
