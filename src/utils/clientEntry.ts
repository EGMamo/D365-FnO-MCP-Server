import { isIPv6 } from 'node:net';
import { LEGACY_API_KEY_NAME } from '../server/apiKeys.js';

/**
 * The MCP client entry (VS Code `.vscode/mcp.json` / Visual Studio `.mcp.json` shape) that `serve` and `gateway`
 * print once they listen. This module must stay free of `src/config.ts`, `src/configLoader.ts` and
 * `src/server/start.ts`: the gateway imports it, and those modules validate the server's environment eagerly.
 */

/** Name agents and the prebuilt agent definitions expect for the D365 server entry; shared so a pasted entry replaces the old one. */
export const CLIENT_ENTRY_NAME = 'd365-fno';

export interface ClientEntryOptions {
  /** Entry name under "servers"; defaults to `d365-fno`. */
  name?: string;
  url: string;
  /** `Authorization` sends `Bearer <input>`, `X-API-Key` sends the input as is; defaults to `Authorization`. */
  header?: 'Authorization' | 'X-API-Key';
  /** The input id the client asks the secret under; the VS Code form of a secret prompt. */
  inputId: string;
  inputDescription: string;
}

export interface ClientEntry {
  inputs: Array<{ id: string; type: 'promptString'; description: string; password: true }>;
  servers: Record<string, { type: 'http'; url: string; headers: Record<string, string> }>;
}

/** Builds the entry object; property order is part of the printed text, so keep it as is. */
export function buildClientEntry(options: ClientEntryOptions): ClientEntry {
  const reference = '${input:' + options.inputId + '}';
  const headerName = options.header ?? 'Authorization';
  return {
    inputs: [{ id: options.inputId, type: 'promptString', description: options.inputDescription, password: true }],
    servers: {
      [options.name ?? CLIENT_ENTRY_NAME]: {
        type: 'http',
        url: options.url,
        headers: { [headerName]: headerName === 'Authorization' ? 'Bearer ' + reference : reference },
      },
    },
  };
}

export interface ClientEntryPrintout {
  /** First line, followed by a blank line. */
  heading: string;
  /** Says where the entry goes. */
  instruction: string;
  entry: ClientEntry;
  /** Lines printed after a blank line, below the entry. */
  notes: readonly string[];
}

/** Prints a client entry that points at a server, ready to paste. Writes to stdout unless told otherwise. */
export function printClientEntry(printout: ClientEntryPrintout, write: (text: string) => void = (text) => console.log(text)): void {
  write(`${printout.heading}\n`);
  write(printout.instruction);
  write(JSON.stringify(printout.entry, null, 2));
  write(`\n${printout.notes.join('\n')}`);
}

/** The input id the printed `serve` entry asks the API key under; the docs use it, and the Visual Studio extension rewrites `d365-fno-api-key`. */
export const SERVE_KEY_INPUT_ID = 'd365-mcp-api-key';

/** What the socket reports when it listens on every interface: IPv6 (the default) or IPv4. */
const WILDCARD_ADDRESSES: ReadonlySet<string> = new Set(['::', '0.0.0.0']);

export interface ServeEndpointOptions {
  /** The configured `MCP_HOST`: an empty string means every interface. */
  host: string;
  /** The port the socket is bound to, which differs from `MCP_PORT` when that is 0. */
  port: number;
  /** The address the socket reports; it tells wildcard spellings (`0`, `::0`, ...) apart from a chosen interface. */
  boundAddress?: string;
}

export interface ServeEntryOptions extends ServeEndpointOptions {
  /** Names only: a key value must never reach the printer. */
  apiKeyNames: readonly string[];
}

/** True when the server answers on every interface; falls back to the configured host when the socket address is unknown. */
function listensOnEveryInterface(options: ServeEndpointOptions): boolean {
  return options.boundAddress === undefined ? options.host === '' : WILDCARD_ADDRESSES.has(options.boundAddress);
}

/**
 * The URL a client on this machine uses to reach `serve`. A wildcard bind prints `localhost`; otherwise the
 * configured host is printed as typed (an IPv6 literal gets brackets, which a URL requires).
 */
export function serveEndpoint(options: ServeEndpointOptions): string {
  const host = options.host === '' || listensOnEveryInterface(options) ? 'localhost' : options.host;
  return `http://${isIPv6(host) ? `[${host}]` : host}:${options.port}/mcp`;
}

/** Says which key to enter; key values are never printed. */
function describeServeKeys(names: readonly string[]): string {
  if (names.length === 1 && names[0] === LEGACY_API_KEY_NAME) return 'The key is MCP_API_KEY (setup saves it in your .env file), or the key named default in MCP_API_KEYS; it is not printed.';
  return `This server accepts ${names.length} API key${names.length === 1 ? '' : 's'} (${names.join(', ')}). Enter your own; key values are never printed.`;
}

/** Prints the MCP URL of a listening `serve` and a client entry that points at it, ready to paste. */
export function printServeClientEntry(options: ServeEntryOptions, write?: (text: string) => void): void {
  const url = serveEndpoint(options);
  const notes = [
    describeServeKeys(options.apiKeyNames),
    'Other clients send the same URL with an "Authorization: Bearer <key>" header (X-API-Key also works).',
  ];
  if (listensOnEveryInterface(options)) {
    notes.push("The URL uses localhost because the server listens on every interface; replace localhost with this machine's name when connecting from another machine.");
  }
  printClientEntry(
    {
      heading: `D365 MCP server listening on ${url}`,
      instruction:
        'Add the input under "inputs" and the entry under "servers" in .vscode/mcp.json (VS Code) or .mcp.json (Visual Studio). ' +
        `It replaces any existing "${CLIENT_ENTRY_NAME}" entry (hosted server or gateway); keep one at a time so the agents' ${CLIENT_ENTRY_NAME} tool names stay valid.`,
      entry: buildClientEntry({
        url,
        header: 'Authorization',
        inputId: SERVE_KEY_INPUT_ID,
        inputDescription: 'D365 FnO MCP API key',
      }),
      notes,
    },
    write
  );
}
