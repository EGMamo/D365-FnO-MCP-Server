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
  acquire                   Run one private acquisition/build/validation/publication cycle
      --config <file>       Worker JSON config (default D365_ACQUISITION_CONFIG)
      --run-id <id>         Stable run identifier for restart idempotency (default UTC timestamp)
  prepare-bundle            Worker build step: index acquired UDE assets and write the bundle options
      --sources <file>      sources.json written by the acquire step
      --db-path <path>      New SQLite index to build (must not exist yet)
      --bundle-options <path> CreateArtifactBundleOptions JSON to write (never overwritten)
      --release-id <id>     Release identity for the manifest (default ude-<applicationVersion>)
  index [--force]           Run a foreground indexing pass
      --packages-dir <dir>  PackagesLocalDirectory to index (default D365_PACKAGES_DIR)
      --db-path <path>      SQLite index path (default D365_INDEX_DB_PATH or ./d365_index.db)
  index-xref                 Import compiler cross-reference snapshot from SQL Server
      --connection-string    SQL Server connection string (prefer D365_XREF_CONNECTION_STRING)
      --db-path <path>       SQLite index path (default D365_INDEX_DB_PATH or ./d365_index.db)
      --allow-empty          Explicitly permit replacing the snapshot with no references
      --allow-source-locks   Allow serializable source reads if snapshot isolation is disabled
      --store-raw            Retain raw SQL rows (larger database; off by default)
  index-trace                Import Trace Parser (AxTrace) aggregates for the trace tools
      --connection-string    Trace database connection string (prefer D365_TRACE_CONNECTION_STRING)
      --from-json <file>     Import aggregates from a JSON file instead of SQL Server
      --source <label>       Label for this import; re-importing a label replaces it (default: database or file name)
      --trace <name>         Only this TraceName (default: every trace in the database)
      --max-rows <n>         Per-session cap for methods and SQL statements (default 1000)
      --db-path <path>       SQLite index path (default D365_INDEX_DB_PATH or ./d365_index.db)
  index-bp <file...>         Import compiler best-practice logs (Dynamics.AX.<Model>.xppbp.xml) for get_bp_findings
      --model <name>         Model name (default: taken from the file name)
      --allow-empty          Replace the previous import even if the logs contain no diagnostics
      --db-path <path>       SQLite index path (default D365_INDEX_DB_PATH or ./d365_index.db)
  index-release-plans        Store Microsoft release plans for the release plan tools (network; opt-in)
      --from-json <file>     Import a saved releaseplans.microsoft.com feed instead of downloading
      --url <url>            Feed URL (default https://releaseplans.microsoft.com/en-US/allreleaseplans/)
      --products <a,b>       Product names to keep (default: Finance, SCM, Commerce, Project Operations, HR, cross-app)
      --all-products         Keep every product in the feed
      --db-path <path>       SQLite index path (default D365_INDEX_DB_PATH or ./d365_index.db)
  doctor                    Validate environment and report issues (exit 1 on failure)
  index-status              Report whether the local index is current for the packages folder
      --packages-dir <dir>  PackagesLocalDirectory to check (default D365_PACKAGES_DIR)
      --db-path <path>      Local SQLite index (default D365_INDEX_DB_PATH or ./d365_index.db)
      --list <n>            Changed files to list (default 20)
      --json                Print one JSON object on stdout
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
      --transport <mode>    http only (default http)
      --force               Replace an existing .env
  artifact publish         Validate and idempotently upload a local bundle
      --bundle-dir <dir>   Validated local artifact bundle directory
  artifact status          Inspect remote deployment pointers (use --verify to validate bundles)
      --verify              Materialize and validate active/previous bundles
  artifact promote         Validate and promote a remotely complete bundle
      --bundle-id <id>     Immutable sha256 bundle ID
      --expected-revision <n> Required pointer revision for optimistic concurrency
  artifact rollback        Validate and activate the previous bundle
      --expected-revision <n> Required pointer revision for optimistic concurrency
  artifact commands accept --json and use D365_ARTIFACT_* configuration.

Options:
  -h, --help                Show help
  -v, --version             Show version

Flags accept --flag, --flag=value, and --flag value forms.
`;
