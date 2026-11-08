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
  gateway                   Start the local gateway: your custom models are indexed on this machine and, with a
                            hosted server, merged with its standard index (without one it runs in local mode).
                            Listens on 127.0.0.1 only and prints an MCP client entry (the bearer token itself is
                            never printed). Environment:
      D365_HOSTED_MCP_URL        Hosted MCP endpoint, https:// unless loopback (empty: local mode)
      D365_HOSTED_API_KEY        Developer key; or D365_HOSTED_API_KEY_FILE with the key in a file (hosted mode)
      D365_CUSTOM_METADATA_DIR   Folder with your custom models (legacy alias D365_PROJECT_DIR; required)
      D365_LOCAL_INDEX_DB_PATH   Custom index file (default ./.d365/custom_index.db; must differ from D365_INDEX_DB_PATH)
      D365_GATEWAY_PORT          Loopback port (default 3101)
      D365_GATEWAY_TOKEN         Bearer token for agents, 32+ characters (default: generated beside the custom index)
      D365_APP_VERSION           Four-part version of your PackagesLocalDirectory, declared to the hosted server
      D365_GATEWAY_PRIVATE_PREFIXES  Object-name prefixes that are never sent to the hosted server (comma separated)
      D365_GATEWAY_STANDARD_INDEX_DB_PATH  Optional standard index, read-only; forwarded tools then run locally over both
      D365_GATEWAY_UPSTREAM_TIMEOUT_MS  Wait for the hosted server before using local results (default 15000)
      D365_GATEWAY_REINDEX_TTL_MS       Longest the custom index is served without a re-check (default 30000)
  acquire                   Run one private acquisition/build/validation/publication cycle
      --config <file>       Worker JSON config (default D365_ACQUISITION_CONFIG)
      --run-id <id>         Stable run identifier for restart idempotency (default UTC timestamp)
  prepare-bundle            Worker build step: index acquired UDE assets and write the bundle options
      --sources <file>      sources.json written by the acquire step
      --db-path <path>      New SQLite index to build (must not exist yet)
      --bundle-options <path> CreateArtifactBundleOptions JSON to write (never overwritten)
      --release-id <id>     Release identity for the manifest (default ude-<applicationVersion>)
  index                     No longer supported: full local indexes are built only by the hosted worker
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
  index-docs                 Store a documentation site for search_docs and get_doc_page (network unless --from-dir)
      --url <url>            Start page to crawl (same site, HTML pages, robots.txt respected)
      --scope <prefix>       Only crawl URLs starting with this (default: the start page's folder)
      --sitemap <url>        Also queue the pages listed in this sitemap.xml
      --max-pages <n>        Stop after this many requests (default 2000)
      --delay-ms <n>         Pause between requests (default 500)
      --from-dir <folder>    Import local .md/.html files instead of crawling
      --base-url <url>       With --from-dir: site URL the folder's files map to
      --include <a,b>        Only store these folders (relative to --from-dir or --scope), e.g. dev-tools,sysadmin
      --source <label>       Label for this import; re-importing a label replaces it (default: site host or folder name)
      --db-path <path>       SQLite index path (default D365_INDEX_DB_PATH or ./d365_index.db)
  doctor                    Validate environment and report issues (exit 1 on failure)
                            Also checks the gateway settings and the hosted server when D365_HOSTED_MCP_URL is set
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
  fetch-model               Download the embedding model for the knowledge filter (network; once)
      --dir <dir>            Models directory (default models/ at the package root)
  knowledge-check           Validate topic headers and cache topic vectors for the knowledge filter
      --kb-dir <dir>         Override the knowledge base resources directory
  setup [--non-interactive] Create a .env configuration file. It asks how you will use it: local only (your
                            custom models, no hosted server), or a hosted server plus your custom models, and
                            then whether that server is already deployed or should be deployed now. It checks
                            each answer as you give it and offers to run doctor.
      --mode <local|hosted> local: index only your custom models here. hosted: use a hosted server too
      --custom-dir <dir>    Folder with your custom models (both modes)
      --index-path <path>   Where to keep the local index (local; default ./.d365/custom_index.db)
      --hosted-url <url>    Hosted MCP endpoint, https:// unless loopback (hosted, already deployed)
      --hosted-api-key-file <file>  File holding your developer key (hosted; preferred)
      --hosted-api-key <key>        Your developer key (hosted; visible in the process list, so prefer the file)
      --deploy              Deploy a new hosted server on Azure first (hosted; run from a clone of the repository,
                            with the Azure CLI, PowerShell 7 and the GitHub CLI signed in). With --non-interactive
                            it needs --yes, --environment-name, --dataverse-url and --worker-application-id, and
                            takes --subscription-id, --location, --resource-group, --cost-profile, --alert-email,
                            --repository and --developer-name
      --force               Replace an existing .env
  keys new <name>           Create a developer key on a hosted server, shown once, and print the command the
                            developer runs. Uses the server's admin key (D365_MCP_ADMIN_KEY or --admin-key-file)
      --server <url>        The hosted server, for example https://<your-app>.azurewebsites.net
  keys list                 List the developer keys of a hosted server (--server)
  keys revoke <name>        Revoke a developer key; its sessions end at once (--server)
  keys reset-admin          Make a new admin key, shown once, keeping the developer keys; writes the registry itself
      --registry <kind>     file (with --path <file>) or azure-blob (with --account-url <url> [--container <name>])
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
