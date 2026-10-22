# D365 FnO MCP Server

A Model Context Protocol (MCP) server that gives AI coding assistants first-class access to a Dynamics 365 Finance & Operations codebase: AOT metadata search, label lookup, and grounded X++ code generation.

## Features

- **Metadata search** — search AOT objects, inspect table schemas, class hierarchies, method signatures, EDTs, enums, form data sources, and raw element XML.
- **Security model analysis**: traces Role → Duty → Privilege → entry point (including extensions and sub-roles), answers "who can open this form?", compares roles, and checks segregation-of-duties rules you supply.
- **Exposing F&O to AI agents**: checks whether a data entity is OData-ready and generates read-only entities, privileges, read-only roles and OData actions, all grounded against the index.
- **Performance trace analysis**: imports Trace Parser (`AxTrace`) aggregates and reports N+1 queries, slow SQL and top methods, each linked back to the X++ object, and the table indexes and table group involved.
- **Batch and telemetry helpers**: classifies batch classes (RunBaseBatch / SysOperation), checks batch capability, `BatchRetryable`, pack/unpack versioning and idempotency, and generates ready-to-run KQL for F&O batch telemetry, X++ exceptions, slow SQL and Commerce store health.
- **Documentation search** (optional): imports a documentation site (crawled, or a local folder of markdown/HTML) into the local index and searches it offline with `search_docs` and `get_doc_page`.
- **Release plan awareness** (optional): imports Microsoft release plans for Finance, SCM, Commerce, Project Operations and HR, searches them offline, and maps a feature to the indexed objects and your packages' customizations that it may affect.
- **Label lookup** — resolve label IDs and full-text search label files across packages.
- **X++ generators with grounding** — Chain of Command extensions, table/class extensions, plain classes, RunBase batch jobs, and SysOperation classes. Generators validate their inputs against the index and fail closed rather than emit code for objects that do not exist.
- **Hosted MCP transport** — Streamable HTTP protected by named API keys for remote/shared use.
- **SQLite index** — an incrementally built D365 SDK index; production candidates are built, validated and atomically promoted by Azure automation.
- **CLI** — `setup`, `doctor`, `index`, `index-status` and `serve`, plus import commands for compiler cross-references, Trace Parser data, best-practice logs and release plans (see the [CLI reference](#cli-reference)).
- **Artifact operations** — `artifact publish`, `artifact status`, `artifact promote` and `artifact rollback` provide idempotent Azure Blob publication and optimistic-concurrency deployment control.
- **Hosted mode** — a read-only Azure API serves the active Azure-built index. Developer machines never build, upload or activate production indexes. See [docs/hosted-deployment.md](docs/hosted-deployment.md).
- **Visual Studio extension** — exposes one loopback MCP gateway for Copilot, proxies the hosted tools, keeps the Azure key in Windows Credential Manager, reports the installed SDK version and adds local workspace tools. See [docs/visual-studio-extension.md](docs/visual-studio-extension.md).
- **Hybrid gateway** — `gateway` runs a loopback MCP endpoint that indexes only your custom models on your machine, forwards everything else to the hosted server and merges both into search, label, schema, reference and impact answers. The contents of your custom code are never sent to the hosted server. See [docs/hybrid-gateway.md](docs/hybrid-gateway.md).
- **User and operator guide** — [docs/user-and-admin-guide.md](docs/user-and-admin-guide.md) separates developer workflows from server configuration, index maintenance, and access controls.

## Prerequisites

- Node.js **24 or higher**
- A local D365 FnO `PackagesLocalDirectory` (or a copy of it)

## Installation

From a clone:

```bash
npm install
npm run build
npm link          # exposes the `d365-fno-mcp-server` binary globally
```

Alternatively, install the local checkout globally:

```bash
npm install -g .
```

The package is not published to npm yet, so `npx d365-fno-mcp-server` is not available.

## Quick start

```bash
d365-fno-mcp-server setup     # interactively creates a .env file (generates an API key; --force replaces an existing one)
d365-fno-mcp-server doctor    # validates config, packages dir, and DB access
d365-fno-mcp-server index     # builds the SQLite index (first run takes a while)
d365-fno-mcp-server serve     # starts the MCP server
```

Non-interactive setup, for scripts and CI:

```bash
d365-fno-mcp-server setup --non-interactive \
  --packages-dir "K:/AosService/PackagesLocalDirectory" \
  --api-key "$(openssl rand -hex 32)" \
  --db-path ./d365_index.db \
  --transport http
```

## Configuration

Configuration comes from environment variables (a `.env` file in the working directory is loaded automatically). Validation is strict: an invalid value aborts startup with a descriptive error.

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `http` | Must remain `http`; the server exposes Streamable HTTP only. |
| `MCP_PORT` | `3000` | HTTP listen port (HTTP transport only). |
| `MCP_HOST` | _(all interfaces)_ | Interface to bind, e.g. `127.0.0.1` to keep a local server off the network. |
| `MCP_API_KEYS` | _(empty)_ | Named API keys for HTTP authentication: `name=key,name=key` (commas or newlines), each key **at least 32 characters**. Only the name is logged, and a session can only be used with the key that opened it. |
| `MCP_API_KEY` | _(empty)_ | Single legacy key, reported under the name `default`. At least one key is required. |
| `D365_PACKAGES_DIR` | _(empty)_ | Path to `PackagesLocalDirectory`. Required by `index`, `index-status` and local `doctor`; the hosted API receives an Azure-built database instead. |
| `D365_APP_VERSION` | _(empty)_ | Four-part D365 application version of this host's `PackagesLocalDirectory`, e.g. `10.0.2645.136`. Only needed when the packages path does not name the version — Unified Developer Experience paths (`…\Dynamics365\<version>\PackagesLocalDirectory`) are detected automatically. See [SDK version warnings](#sdk-version-warnings). |
| `D365_INDEX_DB_PATH` | `./d365_index.db` | Location of the SQLite index file. |
| `D365_ARTIFACT_STORE_PATH` | _(empty)_ | Hosted mode only. With `D365_ARTIFACT_SOURCE=local`: immutable artifact-store root containing `deployment-pointers.json` and `bundles/`. With `azure-blob`: this replica's instance-local materialization directory. Startup validates the active bundle into `D365_INDEX_DB_PATH` and opens the local snapshot read-only. |
| `D365_ARTIFACT_SOURCE` | `local` | `azure-blob` makes each replica pull the active bundle from Blob Storage at startup (see [Hosted startup from Azure Blob](#hosted-startup-from-azure-blob)). |
| `D365_ARTIFACT_ACCOUNT_URL` | _(empty)_ | Storage account origin, e.g. `https://<account>.blob.core.windows.net`. Required for `azure-blob` and the `artifact` commands. No SAS or key is accepted. |
| `D365_ARTIFACT_CONTAINER` | _(empty)_ | Artifact container name. Required for `azure-blob` and the `artifact` commands. |
| `D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID` | _(empty)_ | Client ID of a user-assigned managed identity; empty uses the default `DefaultAzureCredential` chain. |
| `D365_ARTIFACT_REQUIRED_CAPABILITIES` | _(empty)_ | Comma-separated capabilities the active bundle must declare `complete`, for hosted startup and the `artifact` commands. Empty requires the ones the indexer covers completely, which is none yet (see `src/indexer/capabilityCoverage.ts`). A value that names no capability, or an unknown one, fails validation. |
| `D365_INDEX_STORE_RAW_XML` | `1` | Set to `0` to keep full AOT XML out of `ax_objects.raw_xml` and reduce DB size. `get_element_xml` then reads the source XML from `file_path` on demand, so source files must remain available. |
| `D365_KNOWLEDGE_FILTER` | `1` | Passes index tool results through the knowledge base filter (see [Knowledge filter](#knowledge-filter)). Set to `0` for raw results. |
| `D365_EMBEDDING_MODEL_DIR` | _(empty)_ | Folder holding the embedding model files. Empty uses `models/all-MiniLM-L6-v2` at the package root, where `fetch-model` puts it. |
| `D365_ENABLE_WRITE_TOOLS` | `0` | Set to `1` to register metadata preview/apply tools. Model writes also require `D365_WRITABLE_MODELS`. |
| `D365_CUSTOM_METADATA_DIR` | _(empty)_ | The **Folder for your own custom metadata** configured in the Finance Operations Visual Studio extension. Required for write tools. |
| `D365_VISUAL_STUDIO_WORKSPACE_DIR` | _(empty)_ | Folder containing the Visual Studio `.sln` or `.slnx` solution and Finance Operations `.rnrproj` projects. Enables workspace discovery and automatic project membership updates. |
| `D365_TARGET_SOLUTION` | _(empty)_ | Relative/absolute `.sln` or `.slnx` path. Required when multiple solutions are present unless supplied per call. |
| `D365_TARGET_PROJECT` | _(empty)_ | Default `.rnrproj` path or unique display name. Required when project selection is ambiguous unless supplied per call. |
| `D365_TARGET_PACKAGE` | _(empty)_ | Default custom package. If omitted, resolve a unique matching model descriptor; do not assume package and model names are identical. |
| `D365_TARGET_MODEL` | _(empty)_ | Default model. The selected `.rnrproj` project's `<Model>` must match it. |
| `D365_WRITABLE_MODELS` | _(empty)_ | Comma-separated literal `Package/Model` allowlist. An empty list rejects all metadata writes. Spaces in model names are supported. |
| `D365_PROJECT_DIR` | _(empty)_ | Deprecated compatibility alias for `D365_CUSTOM_METADATA_DIR`. |
| `D365_BYPASS_PRUNE_GUARD` | `0` | Set to `1` to skip the "scan must overlap at least half of the previously indexed objects" prune guard. The zero-scan and parse-error guards still apply. Use only for an intentional large deletion. |
| `RATE_LIMIT_MAX_REQUESTS` | `500` | Max requests per client IP per rate-limit window. |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in milliseconds (15 minutes). |
| `MCP_REQUEST_TIMEOUT_MS` | `120000` | Per-request timeout in milliseconds. |
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops. `0` ignores `X-Forwarded-For`; set this to the real hop count **only** when behind a trusted proxy. |
| `MAX_CONCURRENT_SESSIONS` | `100` | Max simultaneous MCP sessions; further sessions receive HTTP `503`. |
| `MAX_SESSIONS_PER_API_KEY` | `0` | Max simultaneous sessions one API key may hold; further sessions for that key receive HTTP `429`. `0` applies only `MAX_CONCURRENT_SESSIONS`. Set it when several named keys share a server, so one client cannot lock the others out. |
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Idle sessions are closed after this period (swept every 60s). |
| `MCP_LOG_LEVEL` | `INFO` | Lowest level written to the structured stderr log: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL` or `SILENT`. |

CLI commands also read these; the server ignores them:

| Variable | Used by | Description |
| --- | --- | --- |
| `D365_XREF_CONNECTION_STRING` | `index-xref` | SQL Server connection string for `DynamicsXrefDB` (read-only login). |
| `D365_TRACE_CONNECTION_STRING` | `index-trace` | SQL Server connection string for the Trace Parser `AxTrace` database. |

Prefer these variables to `--connection-string` on the command line, where other users of the
machine can see it in the process list.

See `.env.example` for a starting point.

### Artifact operator workflow

Artifact commands use `DefaultAzureCredential`; in Azure automation, prefer a managed identity
and grant it only Blob Data Contributor access to the artifact container. Configure
`D365_ARTIFACT_ACCOUNT_URL`, `D365_ARTIFACT_CONTAINER`, and the `D365_ARTIFACT_*` compatibility
settings shown in `.env.example`. No SAS token or account key is accepted or logged.

```bash
d365-fno-mcp-server artifact publish --bundle-dir ./artifact-store/bundles/<sha256>
d365-fno-mcp-server artifact status --verify --json
d365-fno-mcp-server artifact promote \
  --bundle-id sha256:<64 lowercase hex characters> \
  --expected-revision 3 --json
d365-fno-mcp-server artifact rollback --expected-revision 4 --json
```

Promotion and rollback fail when the expected pointer revision is stale. Promotion first
materializes and validates every remote bundle file, while publication uses create-only blob
conditions and verifies each upload, so retries are safe and incomplete uploads cannot be promoted.

### Hosted startup from Azure Blob

With `D365_ARTIFACT_SOURCE=azure-blob`, every API replica materializes the active bundle itself:

1. The HTTP listener starts unready: `GET /health` answers `503 {"status":"starting"}` and MCP
   requests get `503` until the index is open. `GET /live` answers `200` throughout.
2. The replica reads `deployment-pointers.json` with its managed identity (grant it only
   **Storage Blob Data Reader** on the container) and pins that pointer revision and ETag.
3. It removes interrupted downloads and superseded bundles from `D365_ARTIFACT_STORE_PATH`, checks
   free local disk against the manifest's declared sizes, and downloads the pinned immutable bundle
   into a staging directory with size, SHA-256 and ETag checks.
4. It validates manifest, hashes, compatibility, provenance, validation report and SQLite
   integrity, atomically publishes the local bundle directory, records the pinned pointers, and
   atomically activates the database into `D365_INDEX_DB_PATH`. An already materialized copy of the
   same bundle is revalidated and reused instead of downloaded again.
5. It opens the index read-only, runs a representative query and only then reports ready.

Any failure logs `Artifact startup failed; refusing to serve` and exits with code 1, so the platform
restarts the replica. `D365_ARTIFACT_STORE_PATH` and `D365_INDEX_DB_PATH` must be on instance-local
disk (for App Service, not the `/home` share) with room for the bundle. When the two paths can
be hard-linked (one mount) the active database is a link to the bundle's file, so the replica holds
a single copy; otherwise it is copied and needs room for a second one.
A promotion takes effect when a replica restarts; for App Service, warm a staging slot running the
same image against
`/health` (`WEBSITE_SWAP_WARMUP_PING_PATH=/health`, `WEBSITE_SWAP_WARMUP_PING_STATUSES=200`) and
swap, and roll back by promoting the previous pointer and restarting.

## CLI reference

```
d365-fno-mcp-server <command> [options]

Commands:
  serve                     Start the MCP server (default command)
  gateway                   Start the local hybrid gateway: your custom models are indexed on this machine and
                            merged with the hosted server's standard index. Listens on 127.0.0.1 only and prints
                            an MCP client entry (the bearer token itself is never printed). Environment:
      D365_HOSTED_MCP_URL        Hosted MCP endpoint, https:// unless loopback (required)
      D365_HOSTED_API_KEY        Hosted API key; or D365_HOSTED_API_KEY_FILE with the key in a file (one required)
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
```

### Knowledge filter

`d365-fno-assistant-knowledge/resources/` (see its own README) is a curated, project-agnostic
markdown knowledge base. Clients can read it as `d365kb://{slug}` resources, but its main job is to
shape index results: every metadata, label, security, entity, trace, telemetry, code-quality and
release-plan tool result passes through it before it reaches the client.

- **Filter** drops rows a topic marks as noise, such as `XppMetadata`/`XppSource` build-output
  mirrors, and reports how many were removed.
- **Rank** moves rows a topic prefers to the front.
- **Annotate** attaches up to three matching topics with a one-line note, found by the topic's
  header rules and, with the embedding model installed, by meaning.

**Task guidance.** For a multi-step request, the client calls `get_task_guidance` with the user's
request first (the server's instructions tell it to). The request is matched clause by clause, so
"post the arrival journals and create product receipts using the packing slip id" finds the topics
for each part. The result lists the topics that apply, a coverage rating (`strong`, `partial` or
`none`) and the clauses no topic covers, which tells you where the knowledge base has a gap. The
request is kept for the MCP session: later index and generator calls get the task's topics attached
once, on the tools those topics name. The embedding model reads English only, so the client passes
the request in English and translates one written in another language.

The filter only removes, reorders or adds notes. It never adds or renames objects, so every name in
a result still comes from the index. The tool's own JSON stays the first content item, and the
knowledge section is a second item: `{"knowledge": {"notes": [...], "filtered": [...], "reordered": [...]}}`.

Each topic starts with an optional YAML header that drives this:

```yaml
---
appliesTo:
  tools: [get_class_hierarchy, search_symbols]  # tools the topic may act on (omit for all)
  objectTypes: [Class]                          # rows or arguments of these types trigger the note
match:
  names: ['*_Extension']                        # object names that trigger the note (glob)
  tools: [analyze_batch_class]                  # tools whose every call gets the note
filter:
  exclude: [{ field: file_path, pattern: '*XppMetadata*' }]
rank:
  prefer: [{ field: name, pattern: '*_Extension' }]
note: "One line the client sees with the result."
---
```

The embedding model is all-MiniLM-L6-v2 (Apache-2.0, about 90 MB), run on the CPU inside the
server through the WebAssembly build of ONNX Runtime. There is no API call or cost. The Docker
image includes it. For a local install run `npm run build`, `npm run fetch-model` (one hash-pinned
download) and `npm run knowledge-check`, which validates every header and caches the topic vectors
so the server starts without embedding the knowledge base. Without the model the filter still runs
on header rules, and the server logs that it did so.

### Adding to the knowledge base

Only the server owner adds knowledge, in the repository during development. MCP clients cannot add
or change topics, and the image ships with the topics that were merged. Run each draft through the
digester, which validates before writing anything:

```bash
npm run digest -- --file ./my-draft.md            # validate + write if it passes
npm run digest -- --file ./my-draft.md --dry-run   # validate only, report findings
npm run digest -- --file ./my-draft.md --force     # write despite a duplicate match
npm run knowledge-check                            # after adding or editing topics
```

The digester checks:
- **Structure** — a `# Title` and a `## Pattern` section are required, and a header, if present,
  must be valid (these always block the write, even with `--force`); `When to use this`,
  `Gotchas / notes`, and `Related` are recommended.
- **Sanitization** — likely un-redacted emails, connection-string secrets, and API keys always
  block the write, even with `--force`. Probable company-prefixed object names (for example,
  `ABCSalesTable`) and IPv4-shaped strings (which also match D365 version numbers such as
  `10.0.39.0`) are warnings only because those heuristics are prone to false positives.
- **Duplicates by meaning** — with the embedding model installed, the draft's passages are compared
  with every topic's passages. A draft that says the same as an existing topic in different words
  (62% or more) is blocked unless you pass `--force`, and 50% or more is reported as an overlap.
  On the shipped topics a reworded copy scores about 64% and unrelated drafts stay under 30%, while
  the closest pair of distinct topics (form groups and form patterns) scores 67%, so a block can
  mean "extend that topic instead".
- **Duplicates by wording** — bag-of-words similarity; 80% or more blocks without `--force`.
- **Feasibility** — cross-checks PascalCase identifiers mentioned in the draft against the
  indexed AOT metadata (pass `--db-path`) and reports which ones weren't found, so you can verify
  or replace them with `<Prefix>`/`<Model>` placeholders.

## Visual Studio 2022/2026 and unified Finance Operations development

The MCP server runs as a separate process, so Visual Studio does **not** automatically transmit its
active solution, selected project, current model, Power Platform connection, or Application Explorer
selection over MCP. Configure those server-side so every write has a deterministic target:

```dotenv
D365_ENABLE_WRITE_TOOLS=1
D365_VISUAL_STUDIO_WORKSPACE_DIR=C:\Source\MySolution
D365_CUSTOM_METADATA_DIR=C:\Source\Metadata
D365_TARGET_SOLUTION=MySolution.slnx
D365_TARGET_PROJECT=MyFinanceOperationsProject
D365_TARGET_PACKAGE=MyCustomPackage
D365_TARGET_MODEL=MyCustomModel
D365_WRITABLE_MODELS=MyCustomPackage/MyCustomModel
```

`D365_CUSTOM_METADATA_DIR` must be the same path configured in Visual Studio under **Extensions >
Dynamics 365 > Configure Metadata > Folder for your own custom metadata**. The reference metadata
folders in that Visual Studio configuration should include the downloaded
`PackagesLocalDirectory`. Run `d365-fno-mcp-server doctor` after configuring these values.

The read-only `get_visual_studio_workspace` tool reads actual `.sln`/`.slnx` membership, reports literal
project/model information and configuration provenance, and lists AOT elements. It does not infer
that every nearby project belongs to the chosen solution. With no solution, it supports standalone
`.rnrproj` discovery. Duplicate display names require explicit paths.

**Safety change for existing users:** `write_table_extension` now only prepares a preview. It never
writes files. To persist an extension:

1. Call `write_table_extension` to ground the table/EDTs/labels and inspect the resolved project,
   descriptor-backed package/model, XML, hashes, and planned project change.
2. Save and unload/close the selected Visual Studio project and stop other writers/builds.
3. Explicitly call `apply_table_extension_change` with the preview's `changeId` and
   `acknowledgeOfflineProject: true`. IDs expire after five minutes, belong to that MCP server
   session, and are consumed on apply. They do not survive a server restart.
4. Apply rechecks project/descriptor/metadata inputs. It rejects stale previews and existing target
   files, writes `<package>/<model>/AxTableExtension/<Table>.<Extension>.xml`, and adds the matching
   unconditional project Content entry only if the offline project representation is supported.
5. Reload the project and verify the result in Visual Studio. A successful apply is not a successful
   compile, database synchronization, or deployment.

Existing metadata files are never overwritten, paths are contained under the configured custom
metadata root, and a project/model mismatch is rejected. Keep the solution and metadata under source
control so Visual Studio and the MCP server operate on the same files.
Descriptor identity and explicit writable-model authorization are checked, not just descriptor-file
existence. SDK/import-dependent or conditional/dynamic project configurations that cannot be
resolved safely by the offline reader are reported as unsupported rather than evaluated.
**This includes ordinary `.rnrproj` files with the standard `Microsoft.Common.targets` or Dynamics
BuildTasks imports.** Read-only inspection can report saved literal properties, but project-integrated
preview/apply is currently blocked for these files until a trusted native adapter can establish the
effective project/model. Do not remove required imports to bypass this guard.

Locks/journals protect cooperating MCP writers and provide evidence for manual reconciliation after
a crash. They cannot control an arbitrary editor, and multi-file/power-loss atomicity is not
guaranteed. If a result reports `recoveryRequired`, stop further writes and reconcile the reported
artifacts before retrying; do not simply delete a lock or blindly replay a consumed change ID.

Visual Studio remains authoritative for compilation, best-practice checks, database synchronization,
debugging, and deployment. After a write, refresh Solution/Application Explorer, build the project,
run DB synchronization when required, and use the installed Finance Operations extension and Power
Platform Tools to deploy to the connected unified developer environment. The MCP intentionally does
not automate undocumented Visual Studio UI commands, credentials, or deployment actions.
Native IDE state, native metadata-provider authoring, compiler execution, and dependency evaluation
are reported as unavailable until the planned Windows adapter has passed a sandbox compatibility
proof. Visual Studio's MCP client support alone does not establish F&O extension compatibility.

Microsoft setup references:

- [Install and configure Finance Operations development tools](https://learn.microsoft.com/power-platform/developer/unified-experience/finance-operations-install-config-tools)
- [Create and build Finance Operations projects](https://learn.microsoft.com/training/modules/customize-visual-studio-finance-operations/2-projects)
- [Manage metadata with Application Explorer](https://learn.microsoft.com/training/modules/customize-visual-studio-finance-operations/3-metadata)

## Hosted mode

Production indexing is an Azure responsibility:

1. A scheduled Azure worker authenticates noninteractively, downloads the D365 SDK assets, builds a
   sibling SQLite candidate, imports approved supporting data and validates its schema, integrity,
   counts and SDK version.
2. The worker emits an immutable validated bundle and atomically updates one revisioned
   active/previous pointer document. Rollback swaps pointers; it never mutates a bundle.
3. The read-only MCP API validates the selected bundle, copies SQLite to local disk, atomically
   activates that local snapshot and opens it read-only. It has no upload route.
4. The Visual Studio extension connects Copilot to a local loopback gateway. The gateway forwards
   hosted tools with the installed SDK version and adds local workspace capabilities.

The Azure acquisition worker is intentionally separate from the public API and is the only
production component allowed to build or promote an index. See
[`docs/hosted-deployment.md`](docs/hosted-deployment.md) and the guided
[`Azure resource plan`](docs/azure-resource-guide.md).

## Hybrid gateway (hosted standard index plus your custom code)

The hosted server knows only standard Microsoft and ISV metadata, and uploads are removed, so an
agent connected to it alone cannot see your custom tables, extensions, labels or the custom code that
calls standard objects. `gateway` closes that gap on the developer's machine:

```bash
export D365_HOSTED_MCP_URL=https://<app>.azurewebsites.net/mcp
export D365_HOSTED_API_KEY_FILE="$HOME/.d365/hosted-api-key"
export D365_CUSTOM_METADATA_DIR=/path/to/custom/metadata
npm run gateway      # or: d365-fno-mcp-server gateway
```

It indexes only `D365_CUSTOM_METADATA_DIR` into a separate SQLite file (`./.d365/custom_index.db`),
listens on `127.0.0.1:3101` behind a bearer token (generated on first start unless you set
`D365_GATEWAY_TOKEN`), and prints a client entry. Register that URL as `d365-fno` in `.mcp.json` or
`.vscode/mcp.json` in place of the hosted entry. Searches, labels, table schemas, class hierarchies,
references and impact analysis merge the hosted and the local answers and tag each row
`source: "local"` or `"hosted"`; tools that name one object go to whichever side owns it; everything
else is forwarded. Write tools stay off. If the hosted server is down, the gateway still answers
from the custom index and says so in a warning.

Custom code stays on the machine, but tool arguments, which can contain custom object names, are
sent to the hosted server for most tools. `D365_GATEWAY_PRIVATE_PREFIXES` blocks names with your prefixes.
With `D365_GATEWAY_STANDARD_INDEX_DB_PATH` pointing at a standard index built with `index`, the tools
that would otherwise be forwarded (security analysis, entity readiness, BP findings, generators) run
on the machine over the standard and custom models together, and nothing is sent upstream for them.
The gateway's variables are not part of the `serve` configuration table above; they are listed in
[docs/hybrid-gateway.md](docs/hybrid-gateway.md#1-configure) and `.env.example`, with the routing
table, the exact [privacy](docs/hybrid-gateway.md#privacy) statement, failure modes and known gaps.

## Transport

### HTTP (default, `MCP_TRANSPORT=http`)

Streamable HTTP endpoint at `http://localhost:3000/mcp`. Every request must present one of the configured API keys (`MCP_API_KEYS=alice=<key>,bob=<key>` or the single `MCP_API_KEY`) as either `X-API-Key: <key>` or `Authorization: Bearer <key>`.

```json
{
  "mcpServers": {
    "d365-fno": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "X-API-Key": "your-api-key" }
    }
  }
}
```

Health check (no auth): `GET http://localhost:3000/health` → `{ "status": "ok", "version": "0.1.0" }`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Readiness and server version: `503 {"status":"starting"}` while a hosted replica is still activating its artifact bundle, then `200`. |
| `GET /live` | none | Liveness: `200` whenever the process is serving HTTP. |
| `POST`, `GET`, `DELETE /mcp` | API key | MCP Streamable HTTP endpoint. |

## Indexing

`d365-fno-mcp-server index` scans `D365_PACKAGES_DIR` and populates the SQLite index.

- **Incremental by default** — files whose path and modification time are unchanged since the last pass are skipped, so re-indexing after a sync is fast.
- **Label files are incremental too** — label files are read from `AxLabelFile/LabelResources/<language>/<LabelFile>.<language>.label.txt`, and their mtimes are tracked separately so unchanged files are skipped on later passes. Labels are stored under the id code uses without the `@`: `MyLabels:Greeting` for `@MyLabels:Greeting`, and `SYS1` for a legacy `@SYS1`.
- **Raw XML storage** — full element XML is stored by default for backward compatibility. Set `D365_INDEX_STORE_RAW_XML=0` to shrink the database; raw XML requests will fall back to reading the original source file from disk.
- **Search index updates** — triggers keep the FTS indexes current row by row, so an incremental run touches only the changed rows. A first build, `--force`, or a run after an interrupted one rebuilds them once at the end instead.
- **Fixed-depth scan, batched writes** — only `<Package>/<Model>/Ax<Type>/` is read, never `bin/` or `XppMetadata/` (a folder that is not a packages root, such as a single package, falls back to a full search). Files are read ahead of parsing and written 500 per transaction.
- **`--force`** — ignores mtimes and re-parses every file without deleting the database or its independently imported compiler usage snapshot. It is *not* required after upgrading the server. For a corrupt SQLite file, first back it up/move it explicitly; `--force` will not destroy it.
- **Upgrading an existing index** — schema changes are additive, so an existing `d365_index.db` keeps working; just run `npm run index` again without `--force`. Unchanged AOT objects stay skipped, and any `raw_xml` already stored is preserved even if you set `D365_INDEX_STORE_RAW_XML=0` (the flag only stops writing new raw XML). The first upgraded run re-reads every label file once (indexes older than schema 3 stored labels under different ids), after which labels are skipped like every other file. `index-status` reports an index built by an older schema as out of date.
- **Pruning** — entries whose source files no longer exist (deleted or renamed objects) are removed at the end of a full pass, along with their cross-references and labels.
- **Collisions** — when two files declare the same object name, the collision is counted and reported so duplicate/overlayed metadata is visible rather than silently overwritten.

Index statistics are also available at runtime through the `get_index_stats` tool.

## SDK version warnings

A server answers from one indexed SDK snapshot. When a client's own `PackagesLocalDirectory` is a
different build, the tools can describe objects, fields, methods and labels that do not exist on the
client's side, so every session is told which application version it is talking to.

The server records the application version at index time: Unified Developer Experience paths
(`…\Dynamics365\10.0.2645.136\PackagesLocalDirectory`) name it, and layouts that do not — such as the
classic `K:\AosService\PackagesLocalDirectory` — take it from `D365_APP_VERSION`. The version travels
inside the index file, so an index served from an artifact bundle keeps it.

A client declares its own version in one of two ways:

| Transport | How to declare |
| --- | --- |
| HTTP | The `X-D365-Client-Sdk-Version` request header on `initialize`, e.g. `X-D365-Client-Sdk-Version: 10.0.2645.136`. |

The result is sent as the MCP `instructions` at session start:

| Case | Message |
| --- | --- |
| Versions match | States the indexed version; no warning. |
| Client is an **older build** (`10.0.2541.21` vs `10.0.2645.136`) | **Warning.** Different release waves add and remove objects, so answers may not apply. Also logged server-side. |
| Client is an older **revision** of the same build | Notice only. Hotfix drift is constant and rarely changes metadata shape. |
| Client is **newer** than the index | Notice that the index is behind. |
| Client declared nothing, or the value is unparseable | States the indexed version and how to declare one. |

Nothing is ever blocked: exploring newer metadata while planning an upgrade is a legitimate use.
Versions must be four-part (`major.minor.build.revision`); a three-part marketing version such as
`10.0.39` is reported as undeclared rather than guessed at.

## MCP tools

Metadata:
`search_symbols`, `list_objects`, `list_packages`, `list_models`, `get_table_schema`, `get_class_hierarchy`, `get_method_signature`, `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_query_datasources`, `get_data_entity_details`, `get_element_xml`, `find_references`, `analyze_impact`, `find_usages`, `get_usage_snapshot_status`, `get_index_stats`, `get_index_staleness`, `get_visual_studio_workspace`

Labels:
`resolve_label`, `resolve_label_by_language`, `search_labels`, `search_labels_fts`

Security (roles, duties, privileges and menu items are indexed, including role/duty extensions):
`get_security_object` (role/duty/privilege, optionally flattened with sub-roles and extensions), `find_security_path` (which roles, duties and privileges reach a form, class, report, menu item or data entity), `analyze_sod_conflicts` (report roles holding both duties of a user-supplied segregation-of-duties rule), `diff_roles` (compare two roles' effective duties and privileges)

Data entities and agent exposure (previews only; table and entity keys are read from the stored XML):
`check_entity_odata_readiness` (public names, key backed by a unique index, unsupported fields, OData URL, granting privileges/roles), `create_data_entity` (read-only entity for a table, keyed on its natural key), `create_security_privilege` (menu item and data entity grants with view/maintain presets), `create_readonly_role_for_entities` (privilege + duty + role granting Read on a list of entities, e.g. for an AI agent), `create_odata_action` (entity extension with a `[SysODataActionAttribute]` method)

Performance traces (after `index-trace`; see below):
`list_trace_sessions`, `find_n_plus_one` (method lines with many cheap statements), `find_slow_sql` (slowest statements by max or total time, with table indexes), `get_top_methods` (by exclusive, inclusive or database time), `search_trace` (methods, SQL text and tables)

Batch and telemetry:
`analyze_batch_class` (framework, batch capability, retryability, pack/unpack and idempotency findings, plus KQL for the class), `generate_kql_query` (KQL templates for Application Insights and Log Analytics; see below)

Release plans (after `index-release-plans`; see below):
`search_release_plans` (keywords, product, wave and status as of today, or full details by plan ID), `check_feature_impact` (maps a feature or AOT name fragments to indexed objects, and to the objects in your packages that match or reference them)

Documentation (after `index-docs`; see below):
`search_docs` (full-text search with stemming over imported documentation pages, best sections first), `get_doc_page` (one page as markdown, in parts for long pages)

Code quality (heuristic checks modelled on AppChecker and TRUDUtils; not a replacement for the compiler):
`get_method_source` (one method's X++ from stored XML, case-insensitive, size-capped), `check_xpp_best_practices` (tts balance, breakpoints, direct SQL, row-by-row DML in loops, nested `while select`, unused `forupdate`, CoC without `next`, empty `catch`, missing docs; on an indexed object or pasted source), `find_field_access` (read vs write uses of a table field across indexed code; needs raw XML), `get_bp_findings` (compiler best-practice results after `index-bp`)

Security customizations:
`convert_security_customizations` (turns a Security configuration export into AOT role, duty and privilege XML files, with an optional prefix or renames and checks against the index; returns files and writes nothing)

X++ generators (grounded against the index):
`create_coc_extension`, `create_table_extension`, `create_class_extension`, `create_event_handler`, `create_form_event_handler`, `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`

Generated files: every generator above, the data entity and security generators and
`convert_security_customizations` end their result with a `{"generatedFiles":[...]}` item. It lists
each AOT file with its `aotType` (the folder, e.g. `AxClass`), `name` and complete `content`; class
generators give the `AxClass` XML (declaration and one entry per method), not only the X++ listing.
Nothing is written: the agent saves the files with its own editing tools, so you review a normal diff.
Where `D365_CUSTOM_METADATA_DIR` is set (local `serve` and the hybrid gateway; never the hosted server),
each file also gets a `target`: the absolute `path`, `package`, `model`, the `projectItem` to add to
the `.rnrproj` (`AxClass\\MyClass`), the selected `project`, and whether the file `exists`, is
`inProject`, and is `writable` (the model is listed in `D365_WRITABLE_MODELS` and no file of that name
exists). The model comes from `D365_TARGET_MODEL`, or the project selected with
`D365_VISUAL_STUDIO_WORKSPACE_DIR`/`D365_TARGET_PROJECT`; without one, `targets` says why there are none.

Write tools (only with `D365_ENABLE_WRITE_TOOLS=1`):
`write_table_extension`, `apply_table_extension_change`

Resources and prompts:
`d365kb://{slug}` knowledge base topics, and the `d365_pattern_assistant` prompt. Index tool results also carry matching topic notes, and `get_task_guidance` matches a whole request against the knowledge base (see [Knowledge filter](#knowledge-filter)).

## Optional compiler cross-reference usage data

Development VMs can generate compiler cross-reference data in the `DynamicsXrefDB` SQL Server
database. This is different from the structural AOT metadata index: it records compiler-resolved
references such as method calls and object/field references. The database is only as current as the
last IDE cross-reference generation/build.

The importer requires the `.mdf`/`.ldf` database files to be attached or restored to a reachable SQL
Server instance. The raw MDF file cannot be read directly by this application. Set a connection
string in `D365_XREF_CONNECTION_STRING`, preferably through a secret manager or an untracked `.env`
file rather than a literal command in shell history. Use a read-only SQL login with access to the
xref tables and their schema metadata. For example, configure the following locally with real
values (never commit them):

```dotenv
D365_XREF_CONNECTION_STRING="Server=devvm;Database=DynamicsXrefDB;User Id=<read-only-user>;Password=<secret>;Encrypt=true;TrustServerCertificate=false"
```

```text
d365-fno-mcp-server index-xref --db-path ./d365_index.db
```

To sign in as the current Windows user (a local SQL Server or LocalDB on a development VM), use
`Trusted_Connection=yes` (or `Integrated Security=SSPI`) and install the optional native driver
where the CLI is installed: `npm install msnodesqlv8` (add `-g` for a global install), plus ODBC
Driver 17 or 18 for SQL Server. The connection string is then passed to ODBC, with
`Driver={ODBC Driver 17 for SQL Server}` added when it names none. `index-trace` works the same way.
Keep TLS certificate verification enabled on remote connections.

The importer probes `dbo` columns and uniqueness constraints before reading. Modern
`References`/`Names` tables are joined in SQL and consumed through one backpressured stream, so the
`References` heap does not need a synthetic unique paging key. `SysXRef*References` variants are
accepted only when they expose verifiable `SourcePath`/`TargetPath` columns. Unrecognized schemas
fail explicitly, rather than importing guessed or partially resolved rows.

Snapshot isolation must be enabled by the database administrator. If unavailable, the explicit
`--allow-source-locks` option permits a serializable read transaction; this can block compiler writes
until the import finishes. The importer never changes the source database's settings or data.

The complete import is staged in connection-local temporary SQLite storage. Only a successful,
row-count-verified import replaces the live usage snapshot in one transaction. Query failures,
unresolved references, cancellation, or a competing import leave the previous complete snapshot
available. An empty source is rejected unless `--allow-empty` is supplied. `--store-raw` retains the
original SQL rows for diagnosis; it is off by default to avoid unnecessary database growth.

SQL identifiers come from allowlisted tables and inspected columns. The driver is loaded only by
this command, so indexing and serving do not require SQL Server. Refresh the snapshot after relevant
compiler cross-reference updates.

The `find_usages` MCP tool searches these compiler-derived rows by target object and optional method.
Its results may include source/target methods, decoded compiler reference kinds such as
`MethodCall`, `TypeReference`, and `MethodOverride`, line/column, and the source table. Numeric kinds
not present in the compiler `CrossReferenceKind` enum are retained as `Unknown(<value>)` instead of
being silently mislabeled.
Check `get_usage_snapshot_status` before interpreting an empty result: no import, legacy rows without
recorded provenance, and an intentionally empty successful snapshot are distinct states. The import
timestamp does not prove that the compiler database itself is current. `find_references` remains the
separate structural/declared relationship query and should not be interpreted as a compiler call graph.

## Optional performance trace data (Trace Parser)

Trace Parser imports an `.etl` trace into an `AxTrace` SQL Server database. `index-trace` reads
per-session aggregates from it (session totals, per-method call counts and times, and SQL
statements with their tables) and stores them in the local index. Set the connection string in
`D365_TRACE_CONNECTION_STRING` (read-only login, same guidance as for XRef):

```text
d365-fno-mcp-server index-trace --db-path ./d365_index.db --trace "Sales order posting"
```

Without SQL Server access, import a JSON file with the same fields:

```text
d365-fno-mcp-server index-trace --from-json ./trace.json --source posting-trace
```

```json
{
  "sessions": [{ "session_id": "1", "trace_name": "Posting", "user_name": "admin", "total_ms": 12000, "db_ms": 8000, "db_calls": 5200 }],
  "methods": [{ "session_id": "1", "method_name": "SalesFormLetter::run", "calls": 1, "inclusive_ms": 11000, "exclusive_ms": 50, "db_ms": 10, "db_calls": 4, "worst_line_db_calls": 3, "worst_line_db_ms": 8 }],
  "statements": [{ "session_id": "1", "statement": "SELECT ... FROM SALESLINE ...", "table_names": "SALESLINE", "method_name": "SalesLine::find", "executions": 400, "total_ms": 900, "max_ms": 12 }]
}
```

The command checks the `AxTrace` columns before reading and fails if they are missing. Queries are
parameterized, and methods and statements are capped per session (`--max-rows`). Each `--source`
label is one import: importing it again replaces it in one transaction, and a failed import keeps
the previous data. The N+1 (more than 100 calls, under 5 ms average) and slow SQL (over 5 s)
defaults come from the FastTrack Trace Parser Agent (MIT License, Copyright (c) Microsoft
Corporation), and each tool accepts its own thresholds.

Traces contain user names and SQL text. They stay in the local index unless the private Azure
worker explicitly includes the import in a production candidate.

## Telemetry queries (KQL)

`generate_kql_query` returns KQL text for you to run in Application Insights or Log Analytics.
The server never connects to Azure. Scenarios:

| Target | Scenarios |
|---|---|
| Application Insights (`customEvents`, `exceptions`) | `batch-failures`, `batch-failures-over-time`, `batch-long-running-tasks`, `batch-throttling`, `batch-throttled-vs-running`, `batch-thread-availability`, `batch-priority-distribution`, `batch-queue-sizes`, `batch-exceptions`, `xpp-exceptions`, `slow-sql` |
| Log Analytics (Commerce Store Monitoring Agent) | `store-heartbeat`, `store-commerce-events`, `store-db-metrics`, `store-perf` |

Optional filters:
- `timespan` (for example `24h`) or `startTime`/`endTime`
- `environmentId`
- `batchJobIds`
- `className`, which is checked against the index
- `computer`

Values are escaped as KQL string literals. Each result lists its target and prerequisites. Batch
events need 10.0.44 (build 7.0.7606.126+) or 10.0.45 (build 7.0.7690.21+) or later, with batch
telemetry enabled in *Monitoring and telemetry parameters*. `analyze_batch_class` includes the
failure and long-running queries for the analysed class.

Query shapes and field names are adapted from Microsoft's Dynamics-365-FastTrack-FSCM-Telemetry-Samples
(MIT License, Copyright (c) Microsoft Corporation).

## Optional release plans

`index-release-plans` downloads the public feed behind
[releaseplans.microsoft.com](https://releaseplans.microsoft.com) and stores the Finance, Supply
Chain Management, Commerce, Project Operations, Human Resources and F&O cross-app features in the
local index. It and `index-docs` are the only commands that call the public internet, and they run only when you start them.
The MCP tools read the local copy.

```text
d365-fno-mcp-server index-release-plans --db-path ./d365_index.db
```

The feed returns 100 features per page, so a full download reads about 13 pages and takes around a
minute. Each import replaces the previous one in one transaction; a failed import keeps the old data.
Without internet access, save the feed JSON elsewhere (one page, an array of pages, or an array of
features) and import it with `--from-json`. Release plans are public and may be included in an
Azure-built production candidate.

`check_feature_impact` is a name-based heuristic: it turns the feature name into AOT prefixes
(vendor → `Vend`, warehouse → `WHS`, …) or uses the `terms` you pass, and with `packages` lists
your objects that match or extend, use or reference the matching objects. Use it to decide what to
regression test, not as a Microsoft impact analysis.

Microsoft announced it would stop publishing release plans after September 2026 in favour of the
Microsoft AI at Work roadmap. If the feed is gone, the command fails and the last imported copy stays
in the index; `--from-json` still works with a saved feed. The paging and product scope follow the FastTrack Release Planner Helper
(MIT License, Copyright (c) Microsoft Corporation).

## Optional documentation sites

`index-docs` stores a documentation site, such as guides for finance and operations development,
integration and administration, in the local index. `search_docs` and `get_doc_page` read that copy,
so the server never calls the site. Imported pages are reference material. They are separate from
the curated [knowledge base](#knowledge-filter): they never filter or annotate other tools' results,
and the digester is not involved.

```text
# Crawl a site: same host, under the start page's folder (or --scope), robots.txt respected
d365-fno-mcp-server index-docs --url https://docs.example.com/fno/ --source fno-docs --db-path ./d365_index.db

# Or import a local copy (for example a cloned docs repository) of .md/.html files
d365-fno-mcp-server index-docs --from-dir ./docs-repo/articles --base-url https://docs.example.com/fno --source fno-docs
```

For the finance and operations docs on Microsoft Learn, import a sparse clone of the public
`MicrosoftDocs/Dynamics-365-Unified-Operations-Public` repository instead of crawling the site.
`--include` keeps only the folders you want:

```text
git clone --depth 1 --filter=blob:none --sparse https://github.com/MicrosoftDocs/Dynamics-365-Unified-Operations-Public
cd Dynamics-365-Unified-Operations-Public
git sparse-checkout set articles/fin-ops-core/dev-itpro
d365-fno-mcp-server index-docs --from-dir articles/fin-ops-core/dev-itpro \
  --base-url https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro --source fno-learn \
  --include dev-tools,extensibility,dev-ref,perf-test,user-interface,data-entities,business-events,power-platform,sysadmin,deployment,database,lifecycle-services,migration-upgrade,organization-administration \
  --db-path ./d365_index.db
```

Folder imports skip `includes` and `media` folders, map `index.md` to its folder URL, and drop
Learn-only markup (`[!INCLUDE]`, `:::image`, `[!div]`) while keeping `[!NOTE]`-style alerts as
labels. An `--include` name that matches no files is reported.

The crawler fetches one page at a time with `--delay-ms` between requests (default 500), follows
links on HTML pages, skips pages marked `noindex` and non-HTML files, and stops at `--max-pages`
(default 2000), saying so when links were left. With `--include`, pages outside those folders are
still read for their links but are not stored. Each page is split into its `##`/`###` sections, and
long sections are split again, so a search hit points at the part of the page that matched.
Re-importing a `--source` label replaces that source in one transaction and keeps the others; a run
that finds no pages leaves the old copy in place. Check the site's terms before importing it,
and keep private documentation out of a hosted index that other people can query.

## Local agents (GitHub Copilot and Claude Code)

[`agents/`](agents) contains four ready-made agents: `xpp-developer`, `performance-reviewer`,
`security-reviewer` and `release-planner`. They come as GitHub Copilot custom agents
(`agents/github-copilot/*.agent.md`, for VS Code and Copilot CLI) and as Claude Code subagents
(`agents/claude-code/*.md`). Each uses a focused set of this server's tools plus the Microsoft
Learn MCP server, and none of them can use the write tools. Register the servers as `d365-fno`
and `microsoft-learn`, then copy the files into `.github/agents/` or `.claude/agents/` in your X++
repo. Setup, client configs and customization: [docs/local-agents.md](docs/local-agents.md).
Edit `agents/source/` and run `npm run build:agents` to regenerate both formats.

What the server reads, stores, sends and logs, and the limits of its results:
[docs/responsible-ai-faq.md](docs/responsible-ai-faq.md).

## Development

```bash
npm install
npm run check       # typecheck, lint, build, knowledge headers, full test suite
npm run test:e2e    # rebuild and run the compiled HTTP/MCP suite only
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/ tests/
npm run build       # emits to dist/
npm test            # vitest run
npm run dev         # tsx watch src/index.ts
docker build -t d365-fno-mcp-server:local .   # hosted image (needs Docker with BuildKit)
```

Build before running the full suite: compiled-server integration tests launch `dist/src/index.js`
and use real SDK clients over HTTP. They cover tool discovery, resources/prompts, disabled
writes and indexing, an offline project write, a prebuilt index served without a packages directory
under named API keys, SDK version warnings, and nonzero startup failures when the port is occupied.
`npm run check` and `npm run test:e2e` build first so these tests always use current code.
`.worktrees` are excluded from discovery. CI runs `npm run check` on Node 24 on Linux and Windows
and builds and smoke-tests the container image; these checks do not substitute for a live Finance
Operations compiler test.

The current readiness evidence and remaining work are tracked in
[docs/production-readiness.md](docs/production-readiness.md).

An opt-in SQL contract test executes only read queries against a populated development xref
database. Set `D365_RUN_SQL_INTEGRATION=1` and `D365_XREF_CONNECTION_STRING`, then run
`npx vitest run tests/xrefSql.live.test.ts`. If source locks are acceptable, additionally set
`D365_TEST_ALLOW_SOURCE_LOCKS=1`. Without opt-in this test is reported as skipped, not live-validated.

`mssql` is an optional dependency: only `index-xref` and `index-trace` load it, so the container image and
`npm install --omit=optional` leave it out.

## Security notes

- **API keys** — every key must be at least 32 characters; generate one per person with `openssl rand -hex 32` and list them in `MCP_API_KEYS`. Each request is checked against every key in constant time, only the key's name is logged, and a session is bound to the key that opened it. The `/health` and `/live` endpoints are the only unauthenticated routes.
- **Rate limiting** — requests are limited per client IP (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`). Limiting is deliberately keyed on IP only, so rotating credentials cannot bypass the limit.
- **Trust proxy** — `TRUST_PROXY_HOPS` defaults to `0`, meaning `X-Forwarded-For` is ignored and the socket address is used. Only raise it when the server genuinely sits behind that many trusted proxies; otherwise clients can spoof their IP and evade rate limiting.
- **Session limits** — `MAX_CONCURRENT_SESSIONS`, `MAX_SESSIONS_PER_API_KEY` and `SESSION_IDLE_TIMEOUT_MS` bound memory use and clean up abandoned sessions.
- **Exposure** — the server grants read access to your source metadata and should not be exposed to untrusted networks. It binds every interface unless `MCP_HOST` says otherwise; set `MCP_HOST=127.0.0.1` for a local server, and front a shared one with TLS (App Service terminates HTTPS in hosted mode).
- **Write tools over HTTP** — with `D365_ENABLE_WRITE_TOOLS=1` every API key can use the write tools. Enable them only on a local or single-user server. No tool adds or changes knowledge base topics.
- **Data and AI use** — see the [Responsible AI and security FAQ](docs/responsible-ai-faq.md) for what the server reads, stores and sends, and how to review AI output that uses it.
- **Reporting a vulnerability** — see [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| HTTP `401 Unauthorized` | The key is missing or wrong. Send it as `X-API-Key: <key>` or `Authorization: Bearer <key>`, exactly as listed in `MCP_API_KEYS`. |
| Startup fails with `key for '<name>' is N characters` | Keys need at least 32 characters. Generate one with `openssl rand -hex 32`. |
| Startup fails with `documentation placeholder` | The key is still the sample value from an old `.env.example`. Generate a real one. |
| HTTP `403 Session belongs to a different API key` | A client reused another key's `mcp-session-id`. Reconnect so the client starts a new session. |
| HTTP `404 Session not found` | The session expired (`SESSION_IDLE_TIMEOUT_MS`) or the server restarted. Reconnect. |
| `index` logs `Pruning skipped` and deleted objects stay in the index | The scan overlapped less than half of the objects already indexed, usually a wrong or partly mounted `D365_PACKAGES_DIR`. Fix the path; set `D365_BYPASS_PRUNE_GUARD=1` only for an intended large deletion. |
| `index-xref` says the `mssql` or `msnodesqlv8` driver is missing | Install it where the CLI is installed: `npm install mssql`, and for Windows sign-in also `npm install msnodesqlv8` plus ODBC Driver 17 or 18. |
| `get_element_xml` cannot read the source file | The index was built with `D365_INDEX_STORE_RAW_XML=0` and the file has moved, or the index is served from an artifact bundle. Rebuild with raw XML stored. |
| Anything else | Run `d365-fno-mcp-server doctor`; it checks configuration, paths and index access. |

## License

MIT — see [LICENSE](LICENSE).
