# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A role-separated [user and administrator guide](docs/user-and-admin-guide.md), and expanded security knowledge on naming, grants, extensions, and non-admin testing.
- `MCP_LOG_LEVEL` filters the structured stderr log (`DEBUG` by default, or `INFO`, `WARN`, `ERROR`, `FATAL`, `SILENT`).
- Code quality tools, adapted from GitHub community projects (all MIT):
  - `check_xpp_best_practices`: heuristic X++ checks modelled on AppChecker's rule catalog.
  - `find_field_access`: read vs write uses of a table field, after TRUDUtils.
  - `index-bp` command and `get_bp_findings` tool: import and query `xppbp.exe` XML logs, as produced by d365fo.tools.
- `convert_security_customizations`: turns a Security configuration export into AOT security XML, after D365FOSecurityConverter.
- Table methods stored under `<SourceCode><Methods>` are now indexed. Run `index --force` to pick them up in an existing index.
- `llms-install.md` and `glama.json` so MCP directories and AI agents can install the server.
- The `xpp-developer`, `performance-reviewer` and `security-reviewer` agents use the new tools.

- Security model indexing: `AxSecurityRole`, `AxSecurityDuty`, `AxSecurityPrivilege` (plus
  role/duty extensions) and `AxMenuItemDisplay/Action/Output` are indexed. Privilege entry-point
  and data-entity grants go to a new `ax_security_grants` table. Role/duty/privilege/menu-item
  links are stored as cross-references. The index schema version is now `2`. Run `index` again
  (no `--force` needed) to pick up the new types.
- Security tools: `get_security_object`, `find_security_path`, `analyze_sod_conflicts` and
  `diff_roles`. `search_symbols`, `list_objects` and `get_element_xml` accept the new object types.
- Knowledge topic `20-security-model`.
- Data entity and agent-exposure tools: `check_entity_odata_readiness`, `create_data_entity`,
  `create_security_privilege`, `create_readonly_role_for_entities` and `create_odata_action`.
  Table indexes and entity keys are parsed on demand from the stored XML, so no re-index is needed.
- Knowledge topic `21-exposing-fno-to-agents`.
- `index-trace` command: imports Trace Parser (`AxTrace`) aggregates from SQL Server
  (`D365_TRACE_CONNECTION_STRING`) or a JSON file into the local index, one replaceable import
  per `--source`.
- Trace tools: `list_trace_sessions`, `find_n_plus_one`, `find_slow_sql`, `get_top_methods` and
  `search_trace`. Findings link methods to AOT objects and SQL tables to their indexes and table
  group. Default thresholds come from the FastTrack Trace Parser Agent (MIT).
- `publish-index` and `upload-index` remove imported trace data from the published copy.
- Knowledge topic `22-performance-antipatterns`.
- `analyze_batch_class`: reports a class's batch framework and inheritance, batch capability,
  `BatchRetryable` status, pack/unpack versioning and idempotency or set-based hints, together
  with KQL for its batch telemetry.
- `generate_kql_query`: KQL templates for F&O batch telemetry, X++ exceptions and slow SQL in
  Application Insights, and for Commerce store health in Log Analytics. Queries are generated,
  never executed. Adapted from the FastTrack FSCM Telemetry Samples (MIT).
- Knowledge topic `23-batch-and-telemetry`.
- `index-release-plans` command: imports Microsoft release plans for the F&O products (or
  `--all-products`) from releaseplans.microsoft.com, following every feed page, or from a saved
  JSON file. It is the only command that downloads from a public internet source.
- Release plan tools: `search_release_plans` (keywords, product, wave, status, details by plan ID)
  and `check_feature_impact` (maps a feature or AOT name fragments to indexed objects and to
  matching or referencing objects in the packages you name).
- Local agents in `agents/`: `xpp-developer`, `performance-reviewer`, `security-reviewer` and
  `release-planner`, as GitHub Copilot custom agents and Claude Code subagents generated from
  `agents/source/` by `npm run build:agents`. They use this server and the Microsoft Learn MCP
  server, and a test checks that every tool they name exists. Setup in `docs/local-agents.md`.
- `docs/responsible-ai-faq.md`: what the server reads, stores, sends and logs, who can access it,
  and the limits of its results.
- `docs/roadmap.md`: expansion roadmap drawn from Microsoft's Dynamics 365 FastTrack
  implementation assets, with a catalog of its AI ERP agents.
- `index-status` command: compares the local packages folder with the local index and with the
  index a server serves (`--server`), and reports added, changed and removed files per model and
  whether a newer local index still needs uploading. `--json` for tools.
- Visual Studio extension: *Check Index Freshness* runs `index-status` with the saved settings and
  offers *Update Index*, which re-runs index, XRef import and upload incrementally without opening
  the Index and Upload window.
- Index uploads: `POST/PUT/GET/DELETE /admin/index/uploads` accept a packaged index whole or in
  chunks (per-chunk SHA-256, resend on mismatch), verify the assembled package, the decompressed
  database and its object count, then swap it in without a restart (open sessions reconnect).
  Uploads are enabled per key with `D365_INDEX_UPLOAD_KEYS`; `D365_INDEX_PUBLISH_URL` publishes a
  verified upload to Blob Storage so restarts keep it. `GET /admin/index` reports the served index
  and whether the caller may upload.
- `upload-index` command: snapshot, compress (gzip, Brotli or none; fastest/balanced/smallest),
  upload in parallel chunks with retries, compare the server's SHA-256, `--progress json` events.
- Visual Studio 2022/2026 extension (`vs-extension/`): *Configure Connection* writes a `.mcp.json`
  for Copilot after testing the server and stores the key in Windows Credential Manager; *Test
  Connection*; *Index and Upload* indexes a chosen `PackagesLocalDirectory`, imports the XRef
  database and uploads with the chosen compression and chunking. CI builds the `.vsix`.
- `publish-index --compression/--level`; manifests record `db.encoding` and `db.rawSha256`, and
  `pull-index`/hosted start-up verify the decompressed database too.
- `index --packages-dir/--db-path`.
- `index-xref` signs in with Windows authentication (`Trusted_Connection=yes`) through the optional
  `msnodesqlv8` driver, which also reaches LocalDB.

- Hosted mode: `D365_INDEX_URL` makes `serve` download a published index (manifest + gzip SQLite,
  SHA-256 verified) into local disk before listening, so the server runs read-only on Azure App
  Service without a `PackagesLocalDirectory`.
- `MCP_API_KEYS`: named API keys (`name=key,...`) alongside the legacy `MCP_API_KEY`; requests log
  the key name only and a session is bound to the key that opened it.
- `publish-index` (compact `VACUUM INTO` copy, gzip, versioned and `latest` manifests, optional
  `--relative-paths`), `pull-index`, and `doctor --hosted`.
- `ax_meta` build metadata (`built_at`, server version, raw-XML setting); `get_index_stats` reports
  it and `get_index_staleness` reports `mode: "published"` on a hosted server.
- `MCP_HOST` to bind a single interface; graceful shutdown that closes sessions before exit.
- `Dockerfile`, `.dockerignore`, `scripts/publish-index.ps1`, Bicep infrastructure with a runbook
  (`infra/`), a `deploy.yml` workflow (OIDC → ACR → App Service), a CI job that builds and
  smoke-tests the image, and `docs/hosted-deployment.md` with Visual Studio / Claude Code / VS Code
  client configuration.

### Changed

- Upgraded glob to 13, fast-xml-parser to 5, ESLint to 10 and Vitest to 5, and moved the CI and deploy workflows to action versions that run on Node 24. `npm ci` no longer reports deprecated packages or audit findings.
- `D365_PACKAGES_DIR` is required only for indexing; `MCP_API_KEY` is no longer required for stdio.
- `getIndexStats().lastIndexed` now reports the recorded build time instead of the call time.
- `mssql` moved to `optionalDependencies`; the container image and `--omit=optional` installs leave
  it out and `index-xref` explains how to install it.
- Configuration parsing is a pure `loadConfig()` (`src/configLoader.ts`) with tests.
- Manifest `db.gzip` is a boolean alongside the new `db.encoding`; older gzip manifests still load.

### Removed

- `docs/vs-addin-plan.md`: the extension that applies generated code was not pursued; the Visual
  Studio extension now handles connection setup and index uploads instead.

### Added (initial scaffold)

- Initial project scaffold: strict TypeScript configuration, ESLint flat config, and build pipeline.
- AOT metadata parsers and indexer covering tables, classes, enums, EDTs, forms, and labels, with all object types wired into the indexer.
- SQLite index with incremental passes (path + mtime based), `--force` full rebuild, stale-entry pruning, rename detection, and duplicate-name collision reporting.
- MCP metadata tools: `search_symbols`, `get_table_schema`, `get_class_hierarchy`, `get_method_signature`, `find_references`, `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_element_xml`, `list_objects`, `get_index_stats`.
- MCP label tools: `resolve_label`, `search_labels`.
- X++ generators grounded against the index with validation gates: `create_coc_extension`, `create_table_extension`, `create_class_extension`, `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`.
- stdio transport in addition to the Streamable HTTP transport, for local MCP clients.
- CLI with `serve`, `index`, `doctor`, and `setup` commands, including non-interactive setup flags.
- Packaging and documentation polish: comprehensive README, `files`/`keywords` metadata, CHANGELOG, and a GitHub Actions CI workflow running typecheck, lint, build, and tests (now on Node 24).

### Fixed

- `search_symbols` matches name prefixes (`Cust` finds `CustTable`), ranks exact names first and
  falls back to a substring match on the name.
- Object lookups by name are case-insensitive, as X++ names are; an exact spelling still wins.
- `search_labels` treats `%` and `_` in the query as literal text.
- A hosted server no longer fails to start when a large index takes longer than five minutes to
  download: the download timeout is now a two-minute stall timeout.
- `setup` refuses to overwrite an existing `.env` unless `--force` is given, and a replaced file is
  made owner-only again.
- Parser and indexer robustness issues, including interface declarations and enum implicit counter edge cases.
- Chain of Command wrappers now preserve the original method's access modifier and `static` flag.
- Generators fail closed on ungrounded Chain of Command and table extension input instead of emitting unverified code.
- Transport-level server leaks and unbounded concurrent sessions; session lifecycle is now pre-checked against the session cap.
- stdout is kept clean in stdio mode so JSON-RPC framing is never corrupted by log output.

### Security

- HTTP transport requires an API key of at least 32 characters on every request (`X-API-Key` or `Authorization: Bearer`), with `/health` as the only unauthenticated route.
- Rate limiting is keyed on client IP only, preventing bypass through credential rotation.
- Proxy trust is opt-in via `TRUST_PROXY_HOPS` (default `0`), so `X-Forwarded-For` cannot be spoofed to evade rate limiting by default.
- Concurrent session cap and idle-session timeout bound resource usage.
- Tools never read the source file an index names when the index was downloaded or uploaded, so a
  crafted index cannot make `get_element_xml` return server files such as the process environment.
- Decoding an uploaded or downloaded index stops at the declared size (compression bombs), the
  manifest SAS is only forwarded to a database on the manifest's own host, and only the key that
  started an upload may send its chunks or complete it.
- X++ best-practice checks, method extraction and security export parsing run in linear time on
  hostile input (a 500 KB method used to block the server for about a minute), `find_field_access`
  no longer loads every candidate's XML at once, and tool array inputs have upper bounds.
- Keys containing `change-me` are refused; `.env.example` no longer ships a usable placeholder key.
- CI's token is read-only, Dependabot is configured, and `SECURITY.md` explains how to report a
  vulnerability.
