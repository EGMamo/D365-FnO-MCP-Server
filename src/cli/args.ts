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
      --compression <c>     gzip (default), brotli or none
      --level <l>           fastest, balanced (default) or smallest
  upload-index              Package the local index and upload it to a running server (API key in D365_MCP_API_KEY)
      --server <url>        Server base URL (default D365_MCP_SERVER_URL), e.g. https://<app>.azurewebsites.net
      --db-path <path>      Source SQLite index (default D365_INDEX_DB_PATH or ./d365_index.db)
      --compression <c>     gzip (default), brotli or none
      --level <l>           fastest, balanced (default) or smallest
      --chunk-size <MiB>    Chunk size in MiB (default 32); each chunk carries its own SHA-256
      --no-chunks           Send the whole package in a single request
      --parallel <n>        Chunks in flight at once (default 4)
      --retries <n>         Retries per chunk (default 4)
      --relative-paths      Rewrite indexed file paths relative to D365_PACKAGES_DIR in the uploaded copy
      --allow-no-raw-xml    Upload even if raw XML was not stored
      --integrity-check     Run PRAGMA integrity_check on the copy instead of quick_check
      --work-dir <dir>      Where to stage the package (default: the system temp folder)
      --progress json       One JSON event per line on stdout (used by the Visual Studio extension)
      --stop-on-stdin-close Cancel cleanly (abort the server upload, delete the staging copy) when stdin closes
  index-status              Report whether the served index is current for the local packages folder
      --packages-dir <dir>  PackagesLocalDirectory to check (default D365_PACKAGES_DIR)
      --db-path <path>      Local SQLite index (default D365_INDEX_DB_PATH or ./d365_index.db)
      --server <url>        Compare with the index this server serves (API key in D365_MCP_API_KEY)
      --list <n>            Changed files to list (default 20)
      --json                Print one JSON object on stdout (used by the Visual Studio extension)
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
      --force               Replace an existing .env

Options:
  -h, --help                Show help
  -v, --version             Show version

Flags accept --flag, --flag=value, and --flag value forms.
`;
