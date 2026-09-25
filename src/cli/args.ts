export interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** Short aliases expanded to their long flag names. */
const SHORT_FLAGS: Record<string, string> = {
  h: 'help',
  v: 'version',
};

/**
 * Minimal argv parser supporting `--flag`, `--flag=value`, `--flag value`,
 * and the `-h` / `-v` short aliases.
 * Kept dependency-free on purpose: the CLI surface is small and stable.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      const short = arg.length === 2 && arg.startsWith('-') ? SHORT_FLAGS[arg.slice(1)] : undefined;
      if (short) {
        flags[short] = true;
      } else {
        positionals.push(arg);
      }
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    const nextIsShortFlag =
      next !== undefined && next.length === 2 && next.startsWith('-') && next[1] in SHORT_FLAGS;
    if (next !== undefined && !next.startsWith('--') && !nextIsShortFlag) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = true;
    }
  }

  const command = positionals.shift() ?? 'serve';
  return { command, flags, positionals };
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export const HELP_TEXT = `d365-fno-mcp-server <command> [options]

Commands:
  serve                     Start the MCP server (default command)
  index [--force]           Run a foreground indexing pass
  index-xref                 Import compiler cross-reference snapshot from SQL Server
      --connection-string    SQL Server connection string (prefer D365_XREF_CONNECTION_STRING)
      --db-path <path>       SQLite index path (default ./d365_index.db)
      --allow-empty         Explicitly permit replacing the snapshot with no references
      --allow-source-locks  Allow serializable source reads if snapshot isolation is disabled
      --store-raw           Retain raw SQL rows (larger database; off by default)
  doctor [--hosted]         Validate environment and report issues (exit 1 on failure)
                            --hosted checks a published-index deployment (implied by D365_INDEX_URL)
  pull-index                Download the published index instead of building one
      --url <manifest-url>  Manifest URL (default D365_INDEX_URL), e.g. .../indexes/latest/manifest.json?<sas>
      --db-path <path>      Destination SQLite path (default D365_INDEX_DB_PATH or ./d365_index.db)
      --force               Re-download even when the local copy already matches
  publish-index             Package the index for the hosted server: <out>/<version>/ + <out>/latest/manifest.json
      --db-path <path>      Source SQLite index (default D365_INDEX_DB_PATH or ./d365_index.db)
      --out <dir>           Output directory (default ./publish)
      --db-url-prefix <url> Absolute URL prefix for the database blob (default: relative ../<version>/)
      --allow-no-raw-xml    Publish even if raw XML was not stored (get_element_xml then fails on the host)
      --integrity-check     Run PRAGMA integrity_check instead of quick_check (slow on large indexes)
      --relative-paths      Rewrite indexed file paths relative to D365_PACKAGES_DIR in the published copy
  digest --file <path>      Validate a draft knowledge base article and add it if it passes
      --slug <slug>          Filename slug override (kebab-case, no number prefix)
      --dry-run              Validate only, do not write the file
      --force                Write despite a near-duplicate match (missing sections/secrets still block)
      --kb-dir <dir>         Override the knowledge base resources directory
      --db-path <path>       Index DB to cross-check mentioned identifiers against
  setup [--non-interactive] Create a .env configuration file
      --packages-dir <dir>  D365 PackagesLocalDirectory path
      --api-key <key>       MCP API key (>= 32 chars; generated when omitted)
      --db-path <path>      SQLite index path (default ./d365_index.db)
      --transport <mode>    http or stdio (default http)

Options:
  -h, --help                Show help
  -v, --version             Show version

Flags accept --flag, --flag=value, and --flag value forms.
`;
