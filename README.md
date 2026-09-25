# D365 FnO MCP Server

A Model Context Protocol (MCP) server that gives AI coding assistants first-class access to a Dynamics 365 Finance & Operations codebase: AOT metadata search, label lookup, and grounded X++ code generation.

## Features

- **Metadata search** — search AOT objects, inspect table schemas, class hierarchies, method signatures, EDTs, enums, form data sources, and raw element XML.
- **Label lookup** — resolve label IDs and full-text search label files across packages.
- **X++ generators with grounding** — Chain of Command extensions, table/class extensions, plain classes, RunBase batch jobs, and SysOperation classes. Generators validate their inputs against the index and fail closed rather than emit code for objects that do not exist.
- **Dual MCP transport** — Streamable HTTP (API-key protected) for remote/shared use, and stdio for local clients such as Claude Desktop, Claude Code, or VS Code.
- **SQLite index** — a local, incrementally updated index of `PackagesLocalDirectory`, so lookups are fast and offline.
- **CLI** — `setup`, `doctor`, `index`, and `serve` commands for a scripted, one-command onboarding.

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
d365-fno-mcp-server setup     # interactively creates a .env file (generates an API key)
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
| `MCP_API_KEY` | _(required)_ | API key for HTTP authentication. Must be **at least 32 characters**. Still required in stdio mode for config validation. |
| `D365_PACKAGES_DIR` | _(required)_ | Path to `PackagesLocalDirectory`. |
| `D365_INDEX_DB_PATH` | `./d365_index.db` | Location of the SQLite index file. |
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

See `.env.example` for a starting point.

## CLI reference

```
d365-fno-mcp-server <command> [options]

Commands:
  serve                     Start the MCP server (default command)
  index [--force]           Run a foreground indexing pass
  index-xref               Import a consistent compiler-usage snapshot from SQL Server
      --db-path <path>      SQLite index path (default ./d365_index.db)
      --allow-empty        Intentionally replace usage data with an empty snapshot
      --allow-source-locks Allow serializable source reads if snapshot isolation is off
      --store-raw          Retain original SQL rows (off by default)
  doctor                    Validate environment and report issues (exit 1 on failure)
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
```

Flags accept `--flag`, `--flag=value`, and `--flag value` forms.

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

## Transport modes

### HTTP (default, `MCP_TRANSPORT=http`)

Streamable HTTP endpoint at `http://localhost:3000/mcp`. Every request must present the API key as either `X-API-Key: <key>` or `Authorization: Bearer <key>`.

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
        "MCP_API_KEY": "unused-in-stdio-but-required-min-32-characters",
        "D365_PACKAGES_DIR": "K:/AosService/PackagesLocalDirectory"
      }
    }
  }
}
```

In stdio mode, background indexing is skipped unless `D365_INDEX_ON_START=1`.

## Indexing

`d365-fno-mcp-server index` scans `D365_PACKAGES_DIR` and populates the SQLite index.

- **Incremental by default** — files whose path and modification time are unchanged since the last pass are skipped, so re-indexing after a sync is fast.
- **Label files are incremental too** — label source mtimes are tracked separately so unchanged `.label.txt` files are skipped on later passes.
- **Raw XML storage** — full element XML is stored by default for backward compatibility. Set `D365_INDEX_STORE_RAW_XML=0` to shrink the database; raw XML requests will fall back to reading the original source file from disk.
- **Search index rebuilds** — FTS indexes are rebuilt only when objects or labels changed during the run.
- **`--force`** — ignores mtimes and re-parses every file without deleting the database or its independently imported compiler usage snapshot. It is *not* required after upgrading the server. For a corrupt SQLite file, first back it up/move it explicitly; `--force` will not destroy it.
- **Upgrading an existing index** — schema changes are additive, so an existing `d365_index.db` keeps working; just run `npm run index` again without `--force`. Unchanged AOT objects stay skipped, and any `raw_xml` already stored is preserved even if you set `D365_INDEX_STORE_RAW_XML=0` (the flag only stops writing new raw XML). The first upgraded run reprocesses label files once to populate label mtime tracking, after which labels are skipped like every other file.
- **Pruning** — entries whose source files no longer exist (deleted or renamed objects) are removed at the end of a full pass, along with their cross-references and labels.
- **Collisions** — when two files declare the same object name, the collision is counted and reported so duplicate/overlayed metadata is visible rather than silently overwritten.

Index statistics are also available at runtime through the `get_index_stats` tool.

## MCP tools

Metadata:
`search_symbols`, `get_table_schema`, `get_class_hierarchy`, `get_method_signature`, `find_references`, `find_usages`, `get_usage_snapshot_status`, `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_element_xml`, `list_objects`, `get_index_stats`, `get_visual_studio_workspace`

Labels:
`resolve_label`, `search_labels`

X++ generators (grounded against the index):
`create_coc_extension`, `create_table_extension`, `create_class_extension`, `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`

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

The default `mssql` driver does not provide Windows trusted/LocalDB authentication simply by adding
`Integrated Security=true`. Use an authentication/endpoint configuration supported by the installed
driver; Windows-native authentication requires a separately validated integration. Keep TLS
certificate verification enabled on remote connections.

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

## Development

```

Build before running the full suite: compiled-server integration tests launch `dist/src/index.js`
and use real SDK clients over stdio and HTTP. They cover tool discovery, resources/prompts, disabled
writes, and startup indexing flags. `.worktrees` are excluded from discovery. CI runs Node 24 on
Linux and Windows; these checks do not substitute for a live Finance Operations compiler test.

An opt-in SQL contract test executes only read queries against a populated development xref
database. Set `D365_RUN_SQL_INTEGRATION=1` and `D365_XREF_CONNECTION_STRING`, then run
`npx vitest run tests/xrefSql.live.test.ts`. If source locks are acceptable, additionally set
`D365_TEST_ALLOW_SOURCE_LOCKS=1`. Without opt-in this test is reported as skipped, not live-validated.bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint src/ tests/
npm run build       # emits to dist/
npm test            # vitest run
npm run dev         # tsx watch src/index.ts
```

## Security notes

- **API key** — `MCP_API_KEY` must be at least 32 characters; generate one with `openssl rand -hex 32`. It is compared on every HTTP request; the `/health` endpoint is the only unauthenticated route.
- **Rate limiting** — requests are limited per client IP (`RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_MS`). Limiting is deliberately keyed on IP only, so rotating credentials cannot bypass the limit.
- **Trust proxy** — `TRUST_PROXY_HOPS` defaults to `0`, meaning `X-Forwarded-For` is ignored and the socket address is used. Only raise it when the server genuinely sits behind that many trusted proxies; otherwise clients can spoof their IP and evade rate limiting.
- **Session limits** — `MAX_CONCURRENT_SESSIONS` and `SESSION_IDLE_TIMEOUT_MS` bound memory use and clean up abandoned sessions.
- **Exposure** — the server grants read access to your source metadata and should not be exposed to untrusted networks. Prefer binding to localhost or fronting it with TLS.

## License

MIT — see [LICENSE](LICENSE).
