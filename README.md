# D365 FnO MCP Server

A Model Context Protocol (MCP) server that gives AI coding assistants first-class access to a Dynamics 365 Finance & Operations codebase: AOT metadata search, label lookup, and grounded X++ code generation.

## Features

- **Metadata search** — search AOT objects, inspect table schemas, class hierarchies, method signatures, EDTs, enums, form data sources, and raw element XML.
- **Security model analysis**: traces Role → Duty → Privilege → entry point (including extensions and sub-roles), answers "who can open this form?", compares roles, and checks segregation-of-duties rules you supply.
- **Exposing F&O to AI agents**: checks whether a data entity is OData-ready and generates read-only entities, privileges, read-only roles and OData actions, all grounded against the index.
- **Performance trace analysis**: imports Trace Parser (`AxTrace`) aggregates and reports N+1 queries, slow SQL and top methods, each linked back to the X++ object, and the table indexes and table group involved.
- **Batch and telemetry helpers**: classifies batch classes (RunBaseBatch / SysOperation), checks batch capability, `BatchRetryable`, pack/unpack versioning and idempotency, and generates ready-to-run KQL for F&O batch telemetry, X++ exceptions, slow SQL and Commerce store health.
- **Release plan awareness** (optional): imports Microsoft release plans for Finance, SCM, Commerce, Project Operations and HR, searches them offline, and maps a feature to the indexed objects and your packages' customizations that it may affect.
- **Label lookup** — resolve label IDs and full-text search label files across packages.
- **X++ generators with grounding** — Chain of Command extensions, table/class extensions, plain classes, RunBase batch jobs, and SysOperation classes. Generators validate their inputs against the index and fail closed rather than emit code for objects that do not exist.
- **Dual MCP transport** — Streamable HTTP (API-key protected) for remote/shared use, and stdio for local clients such as Claude Desktop, Claude Code, or VS Code.
- **SQLite index** — a local, incrementally updated index of `PackagesLocalDirectory`, so lookups are fast and offline.
- **CLI** — `setup`, `doctor`, `index` and `serve` for onboarding, plus import commands for compiler cross-references, Trace Parser data, best-practice logs and release plans, and `publish-index`, `pull-index`, `upload-index` and `index-status` for sharing an index (see the [CLI reference](#cli-reference)).
- **Hosted mode** — run the server read-only on Azure App Service. It downloads a published index at start-up (`D365_INDEX_URL`), so developers connect over HTTPS with a personal API key and install nothing locally. See [docs/hosted-deployment.md](docs/hosted-deployment.md).
- **Index uploads** — `upload-index` sends a freshly built index to a running server, compressed (gzip, Brotli or none) and in parallel chunks, each carrying its own SHA-256. The server checks the whole package and the decompressed database before it switches over (`D365_INDEX_UPLOAD_KEYS`).
- **Visual Studio extension** — sets up the MCP connection for Copilot in Visual Studio 2022/2026 (`.mcp.json` plus a connection test), and indexes `PackagesLocalDirectory` and the XRef database and uploads the result from inside the IDE. See [docs/visual-studio-extension.md](docs/visual-studio-extension.md).
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
| `MCP_TRANSPORT` | `http` | Transport to serve on: `http` or `stdio`. |
| `MCP_PORT` | `3000` | HTTP listen port (HTTP transport only). |
| `MCP_HOST` | _(all interfaces)_ | Interface to bind, e.g. `127.0.0.1` to keep a local server off the network. |
| `MCP_API_KEYS` | _(empty)_ | Named API keys for HTTP authentication: `name=key,name=key` (commas or newlines), each key **at least 32 characters**. Only the name is logged, and a session can only be used with the key that opened it. |
| `MCP_API_KEY` | _(empty)_ | Single legacy key, reported under the name `default`. The HTTP transport needs at least one key from either variable; stdio needs none. |
| `D365_PACKAGES_DIR` | _(empty)_ | Path to `PackagesLocalDirectory`. Required by `index`, `doctor` and `D365_INDEX_ON_START=1`; a server that serves a published index does not need it. |
| `D365_INDEX_DB_PATH` | `./d365_index.db` | Location of the SQLite index file. |
| `D365_INDEX_URL` | _(empty)_ | Manifest URL of a published index (see [Hosted mode](#hosted-mode-azure-app-service)). When set, `serve` downloads and verifies the index before listening; `D365_INDEX_ON_START=1` and write tools are refused. |
| `D365_INDEX_UPLOAD_KEYS` | _(empty)_ | Comma-separated key names from `MCP_API_KEYS` that may upload a new index to `/admin/index/uploads` (HTTP transport only). Empty disables uploads. See [docs/visual-studio-extension.md](docs/visual-studio-extension.md#server-setup). |
| `D365_INDEX_UPLOAD_MAX_GB` | `50` | Largest upload package accepted. |
| `D365_INDEX_UPLOAD_MAX_CHUNK_MB` | `256` | Largest upload chunk accepted. |
| `D365_INDEX_UPLOAD_DIR` | `<index folder>/.uploads` | Upload scratch folder; must be on the same volume as `D365_INDEX_DB_PATH`. |
| `D365_INDEX_PUBLISH_URL` | _(empty)_ | Blob container URL with a create+write SAS. Verified uploads are published there (`<version>/` then `latest/manifest.json`) so a restarted hosted server serves them again. |
| `D365_INDEX_ON_START` | `0` | Set to `1` to run a background indexing pass on startup (also enables indexing on start in stdio mode). |
| `D365_INDEX_STORE_RAW_XML` | `1` | Set to `0` to keep full AOT XML out of `ax_objects.raw_xml` and reduce DB size. `get_element_xml` then reads the source XML from `file_path` on demand, so source files must remain available. |
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
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` | Idle sessions are closed after this period (swept every 60s). |
| `MCP_LOG_LEVEL` | `DEBUG` | Lowest level written to the structured stderr log: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL` or `SILENT`. |

CLI commands also read these; the server ignores them:

| Variable | Used by | Description |
| --- | --- | --- |
| `D365_XREF_CONNECTION_STRING` | `index-xref` | SQL Server connection string for `DynamicsXrefDB` (read-only login). |
| `D365_TRACE_CONNECTION_STRING` | `index-trace` | SQL Server connection string for the Trace Parser `AxTrace` database. |
| `D365_MCP_SERVER_URL` | `upload-index`, `index-status` | Base URL of the server to upload to or compare with. |
| `D365_MCP_API_KEY` | `upload-index`, `index-status` | API key sent to that server. |

Prefer these variables to `--connection-string` on the command line, where other users of the
machine can see it in the process list.

See `.env.example` for a starting point.

## CLI reference

```
d365-fno-mcp-server <command> [options]

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
```

### Adding to the knowledge base with `digest`

`d365-fno-assistant-knowledge/resources/` (see its own README) is a curated, project-agnostic
markdown knowledge base exposed to MCP clients as `d365kb://{slug}` resources. Rather than hand-
writing and numbering files yourself, run them through the digester, which validates before
writing anything:

```bash
npm run digest -- --file ./my-draft.md            # validate + write if it passes
npm run digest -- --file ./my-draft.md --dry-run   # validate only, report findings
npm run digest -- --file ./my-draft.md --force     # write despite a near-duplicate match
```

The digester checks:
- **Structure** — a `# Title` and a `## Pattern` section are required (missing either always
  blocks the write, even with `--force`); `When to use this`, `Gotchas / notes`, and `Related`
  are recommended.
- **Sanitization** — flags likely un-redacted emails, connection-string secrets, API keys, and
  company-prefixed object names (e.g. `ABCSalesTable`); these always block the write, even with
  `--force`. IPv4-shaped strings (which also match D365 version numbers like `10.0.39.0`) are
  reported as a warning only, since they're not reliably distinguishable from a real IP.
- **Duplicates** — compares the draft against every existing topic with bag-of-words similarity;
  near-duplicates (≥80% similar) block by default and require `--force` to add anyway.
- **Feasibility** — cross-checks PascalCase identifiers mentioned in the draft against the
  indexed AOT metadata (pass `--db-path`) and reports which ones weren't found, so you can verify
  or replace them with `<Prefix>`/`<Model>` placeholders.

The same validation is available to an MCP client as the `digest_knowledge` tool (feature-flagged
behind `D365_ENABLE_WRITE_TOOLS=1`, same as the other write tools), so an assistant can hand over a
sanitized draft directly instead of you running the CLI.

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

## Hosted mode (Azure App Service)

Instead of every developer indexing locally, one scheduled job builds the index and the server
runs on Azure, read-only, with no `PackagesLocalDirectory` of its own:

1. On a machine that has `PackagesLocalDirectory`, `scripts/publish-index.ps1` runs `index`,
   `index-xref` (against a `DynamicsXrefDB` copy in Azure SQL) and `publish-index`, uploads the
   result to Blob Storage and restarts the web app.
2. The web app starts with `D365_INDEX_URL` pointing at `.../indexes/latest/manifest.json?<sas>`.
   `serve` fetches the manifest, streams the gzip database through a SHA-256 check into local disk,
   verifies it, and only then listens. A stale local copy is served when the download fails.
3. Developers add the HTTPS endpoint and their `X-API-Key` to Visual Studio 2022/2026, Claude Code
   or VS Code. Nothing is installed locally.

`doctor --hosted` validates such a deployment (manifest reachable, keys configured, write tools off,
`TRUST_PROXY_HOPS=1` behind the App Service front end). The Bicep template, runbook and client
configuration live in [`infra/`](infra/README.md) and [`docs/hosted-deployment.md`](docs/hosted-deployment.md);
`Dockerfile` builds the image. Write tools stay disabled on the host; generators still return code
and XML for Visual Studio to apply.

A hosted server can also take an index directly: with `D365_INDEX_UPLOAD_KEYS` set, `upload-index`
(or the Visual Studio extension's **Index and Upload** window) sends a new index over HTTPS in
verified chunks. With `D365_INDEX_PUBLISH_URL` set, the server also publishes it to Blob Storage so
it survives restarts. See [docs/visual-studio-extension.md](docs/visual-studio-extension.md).

## Transport modes

### HTTP (default, `MCP_TRANSPORT=http`)

Streamable HTTP endpoint at `http://localhost:3000/mcp`. Every request must present one of the configured API keys (`MCP_API_KEYS=alice=<key>,bob=<key>` or the single `MCP_API_KEY`) as either `X-API-Key: <key>` or `Authorization: Bearer <key>`.

```json
{
  "mcpServers": {
    "d365-fno": {
      "url": "http://localhost:3000/mcp",
      "headers": { "X-API-Key": "your-api-key" }
    }
  }
}
```

Health check (no auth): `GET http://localhost:3000/health` → `{ "status": "ok", "version": "0.1.0" }`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness and server version. |
| `POST`, `GET`, `DELETE /mcp` | API key | MCP Streamable HTTP endpoint. |
| `GET /admin/index` | API key | The index being served and whether the caller's key may upload. |
| `/admin/index/uploads[/<id>[/chunks/<n>\|/complete]]` | key in `D365_INDEX_UPLOAD_KEYS` | Chunked index upload used by `upload-index` and the Visual Studio extension. |

### stdio (`MCP_TRANSPORT=stdio`)

For local MCP clients such as Claude Desktop, Claude Code, or VS Code. Logs are written to stderr so stdout stays reserved for JSON-RPC framing.

```json
{
  "mcpServers": {
    "d365-fno": {
      "command": "d365-fno-mcp-server",
      "args": ["serve"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "D365_PACKAGES_DIR": "K:/AosService/PackagesLocalDirectory",
        "D365_INDEX_DB_PATH": "C:/d365-mcp/d365_index.db"
      }
    }
  }
}
```

In stdio mode no API key is needed, background indexing is skipped unless `D365_INDEX_ON_START=1`, and
`D365_INDEX_DB_PATH` should be absolute because the client decides the working directory.

## Indexing

`d365-fno-mcp-server index` scans `D365_PACKAGES_DIR` and populates the SQLite index.

- **Incremental by default** — files whose path and modification time are unchanged since the last pass are skipped, so re-indexing after a sync is fast.
- **Label files are incremental too** — label files are read from `AxLabelFile/LabelResources/<language>/<LabelFile>.<language>.label.txt`, and their mtimes are tracked separately so unchanged files are skipped on later passes. Labels are stored under the id code uses without the `@`: `MyLabels:Greeting` for `@MyLabels:Greeting`, and `SYS1` for a legacy `@SYS1`.
- **Raw XML storage** — full element XML is stored by default for backward compatibility. Set `D365_INDEX_STORE_RAW_XML=0` to shrink the database; raw XML requests will fall back to reading the original source file from disk.
- **Search index rebuilds** — FTS indexes are rebuilt only when objects or labels changed during the run.
- **`--force`** — ignores mtimes and re-parses every file without deleting the database or its independently imported compiler usage snapshot. It is *not* required after upgrading the server. For a corrupt SQLite file, first back it up/move it explicitly; `--force` will not destroy it.
- **Upgrading an existing index** — schema changes are additive, so an existing `d365_index.db` keeps working; just run `npm run index` again without `--force`. Unchanged AOT objects stay skipped, and any `raw_xml` already stored is preserved even if you set `D365_INDEX_STORE_RAW_XML=0` (the flag only stops writing new raw XML). The first upgraded run re-reads every label file once (indexes older than schema 3 stored labels under different ids), after which labels are skipped like every other file. `index-status` and the Visual Studio **Check Index Freshness** command report an index built by an older schema as out of date.
- **Pruning** — entries whose source files no longer exist (deleted or renamed objects) are removed at the end of a full pass, along with their cross-references and labels.
- **Collisions** — when two files declare the same object name, the collision is counted and reported so duplicate/overlayed metadata is visible rather than silently overwritten.

Index statistics are also available at runtime through the `get_index_stats` tool.

## MCP tools

Metadata:
`search_symbols`, `list_objects`, `list_packages`, `list_models`, `get_table_schema`, `get_class_hierarchy`, `get_method_signature`, `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_query_datasources`, `get_data_entity_details`, `get_element_xml`, `find_references`, `find_usages`, `get_usage_snapshot_status`, `get_index_stats`, `get_index_staleness`, `get_visual_studio_workspace`

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

Code quality (heuristic checks modelled on AppChecker and TRUDUtils; not a replacement for the compiler):
`check_xpp_best_practices` (tts balance, breakpoints, direct SQL, row-by-row DML in loops, nested `while select`, unused `forupdate`, CoC without `next`, empty `catch`, missing docs; on an indexed object or pasted source), `find_field_access` (read vs write uses of a table field across indexed code; needs raw XML), `get_bp_findings` (compiler best-practice results after `index-bp`)

Security customizations:
`convert_security_customizations` (turns a Security configuration export into AOT role, duty and privilege XML files, with an optional prefix or renames and checks against the index; returns files and writes nothing)

X++ generators (grounded against the index):
`create_coc_extension`, `create_table_extension`, `create_class_extension`, `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`

Write tools (only with `D365_ENABLE_WRITE_TOOLS=1`):
`write_table_extension`, `apply_table_extension_change`, `digest_knowledge`

Resources and prompts:
`d365kb://{slug}` knowledge base topics, and the `d365_pattern_assistant` prompt.

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

The importer probes `dbo` columns and unique keys before reading. Modern `References`/`Names`
tables are joined in SQL and read in bounded pages; `SysXRef*References` variants are accepted only
when they expose verifiable `SourcePath`/`TargetPath` columns and a unique ordering key. Unrecognized
schemas fail explicitly, rather than importing guessed or partially resolved rows.

Snapshot isolation must be enabled by the database administrator. If unavailable, the explicit
`--allow-source-locks` option permits a serializable read transaction; this can block compiler writes
until the import finishes. The importer never changes the source database's settings or data.

The complete import is staged in connection-local temporary SQLite storage. Only a successful,
row-count-verified import replaces the live usage snapshot in one transaction. Query failures,
unresolved references, cancellation, or a competing import leave the previous complete snapshot
available. An empty source is rejected unless `--allow-empty` is supplied. `--store-raw` retains the
original SQL rows for diagnosis; it is off by default to avoid unnecessary database growth.

SQL identifiers come from allowlisted tables and inspected columns/keys, and paging values are
parameterized. The driver is loaded only by this command, so indexing and serving do not require
SQL Server. Refresh the snapshot after relevant compiler cross-reference updates.

The `find_usages` MCP tool searches these compiler-derived rows by target object and optional method.
Its results may include source/target methods, reference kind, line/column, and the source table.
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

Traces contain user names and SQL text. They stay in the local index: `publish-index` and
`upload-index` remove every trace table from the copy they produce.

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
local index. It is the only command that calls the public internet, and it runs only when you start it.
The MCP tools read the local copy.

```text
d365-fno-mcp-server index-release-plans --db-path ./d365_index.db
```

The feed returns 100 features per page, so a full download reads about 13 pages and takes around a
minute. Each import replaces the previous one in one transaction; a failed import keeps the old data.
Without internet access, save the feed JSON elsewhere (one page, an array of pages, or an array of
features) and import it with `--from-json`. Release plans are public, so `publish-index` keeps them.

`check_feature_impact` is a name-based heuristic: it turns the feature name into AOT prefixes
(vendor → `Vend`, warehouse → `WHS`, …) or uses the `terms` you pass, and with `packages` lists
your objects that match or extend, use or reference the matching objects. Use it to decide what to
regression test, not as a Microsoft impact analysis.

Microsoft announced it would stop publishing release plans after September 2026 in favour of the
Microsoft AI at Work roadmap. If the feed is gone, the command fails and the last imported copy stays
in the index; `--from-json` still works with a saved feed. The paging and product scope follow the FastTrack Release Planner Helper
(MIT License, Copyright (c) Microsoft Corporation).

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
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/ tests/
npm run build       # emits to dist/
npm test            # vitest run
npm run dev         # tsx watch src/index.ts
docker build -t d365-fno-mcp-server:local .   # hosted image (needs Docker with BuildKit)
```

Build before running the full suite: compiled-server integration tests launch `dist/src/index.js`
and use real SDK clients over stdio and HTTP. They cover tool discovery, resources/prompts, disabled
writes, startup indexing flags, and hosted mode (a published index served from a local HTTP fixture
with named API keys). `.worktrees` are excluded from discovery. CI runs Node 24 on Linux and Windows
and builds and smoke-tests the container image; these checks do not substitute for a live Finance
Operations compiler test.

An opt-in SQL contract test executes only read queries against a populated development xref
database. Set `D365_RUN_SQL_INTEGRATION=1` and `D365_XREF_CONNECTION_STRING`, then run
`npx vitest run tests/xrefSql.live.test.ts`. If source locks are acceptable, additionally set
`D365_TEST_ALLOW_SOURCE_LOCKS=1`. Without opt-in this test is reported as skipped, not live-validated.

`mssql` is an optional dependency: only `index-xref` and `index-trace` load it, so the container image and
`npm install --omit=optional` leave it out.

## Security notes

- **API keys** — every key must be at least 32 characters; generate one per person with `openssl rand -hex 32` and list them in `MCP_API_KEYS`. Each request is checked against every key in constant time, only the key's name is logged, and a session is bound to the key that opened it. The `/health` endpoint is the only unauthenticated route.
- **Rate limiting** — requests are limited per client IP (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`). Limiting is deliberately keyed on IP only, so rotating credentials cannot bypass the limit.
- **Trust proxy** — `TRUST_PROXY_HOPS` defaults to `0`, meaning `X-Forwarded-For` is ignored and the socket address is used. Only raise it when the server genuinely sits behind that many trusted proxies; otherwise clients can spoof their IP and evade rate limiting.
- **Session limits** — `MAX_CONCURRENT_SESSIONS` and `SESSION_IDLE_TIMEOUT_MS` bound memory use and clean up abandoned sessions.
- **Exposure** — the server grants read access to your source metadata and should not be exposed to untrusted networks. It binds every interface unless `MCP_HOST` says otherwise; set `MCP_HOST=127.0.0.1` for a local server, and front a shared one with TLS (App Service terminates HTTPS in hosted mode).
- **Write tools over HTTP** — with `D365_ENABLE_WRITE_TOOLS=1` every API key can use the write tools, including `digest_knowledge`, which adds knowledge base articles that all clients read. Enable them only on a local or single-user server.
- **Data and AI use** — see the [Responsible AI and security FAQ](docs/responsible-ai-faq.md) for what the server reads, stores and sends, and how to review AI output that uses it.
- **Reporting a vulnerability** — see [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| HTTP `401 Unauthorized` | The key is missing or wrong. Send it as `X-API-Key: <key>` or `Authorization: Bearer <key>`, exactly as listed in `MCP_API_KEYS`. |
| Startup fails with `key for '<name>' is N characters` | Keys need at least 32 characters. Generate one with `openssl rand -hex 32`. |
| Startup fails with `documentation placeholder` | The key is still the sample value from an old `.env.example`. Generate a real one. |
| HTTP `403 Session belongs to a different API key` | A client reused another key's `mcp-session-id`. Reconnect so the client starts a new session. |
| HTTP `404 Session not found` | The session expired (`SESSION_IDLE_TIMEOUT_MS`) or the server restarted or activated an uploaded index. Reconnect. |
| `get_index_stats` reports 0 objects in a stdio client | The client started the server in another working directory. Make `D365_INDEX_DB_PATH` absolute and run `index` against that path. |
| `index` logs `Pruning skipped` and deleted objects stay in the index | The scan overlapped less than half of the objects already indexed, usually a wrong or partly mounted `D365_PACKAGES_DIR`. Fix the path; set `D365_BYPASS_PRUNE_GUARD=1` only for an intended large deletion. |
| `index-xref` says the `mssql` or `msnodesqlv8` driver is missing | Install it where the CLI is installed: `npm install mssql`, and for Windows sign-in also `npm install msnodesqlv8` plus ODBC Driver 17 or 18. |
| `get_element_xml` cannot read the source file | The index was built with `D365_INDEX_STORE_RAW_XML=0` and the file has moved, or the index is served from a published copy. Rebuild with raw XML stored. |
| Anything else | Run `d365-fno-mcp-server doctor` (add `--hosted` for a published-index server); it checks configuration, paths and index access. |

## License

MIT — see [LICENSE](LICENSE).
