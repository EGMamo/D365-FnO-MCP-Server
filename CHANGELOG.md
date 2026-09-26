# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- `D365_PACKAGES_DIR` is required only for indexing; `MCP_API_KEY` is no longer required for stdio.
- `getIndexStats().lastIndexed` now reports the recorded build time instead of the call time.
- `mssql` moved to `optionalDependencies`; the container image and `--omit=optional` installs leave
  it out and `index-xref` explains how to install it.
- Configuration parsing is a pure `loadConfig()` (`src/configLoader.ts`) with tests.
- Manifest `db.gzip` is a boolean alongside the new `db.encoding`; older gzip manifests still load.

### Removed

- `docs/vs-addin-plan.md`: the extension that applies generated code was not pursued; the Visual
  Studio extension now handles connection setup and index uploads instead.

- Initial project scaffold: strict TypeScript configuration, ESLint flat config, and build pipeline.
- AOT metadata parsers and indexer covering tables, classes, enums, EDTs, forms, and labels, with all object types wired into the indexer.
- SQLite index with incremental passes (path + mtime based), `--force` full rebuild, stale-entry pruning, rename detection, and duplicate-name collision reporting.
- MCP metadata tools: `search_symbols`, `get_table_schema`, `get_class_hierarchy`, `get_method_signature`, `find_references`, `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_element_xml`, `list_objects`, `get_index_stats`.
- MCP label tools: `resolve_label`, `search_labels`.
- X++ generators grounded against the index with validation gates: `create_coc_extension`, `create_table_extension`, `create_class_extension`, `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`.
- stdio transport in addition to the Streamable HTTP transport, for local MCP clients.
- CLI with `serve`, `index`, `doctor`, and `setup` commands, including non-interactive setup flags.
- Packaging and documentation polish: comprehensive README, `files`/`keywords` metadata, CHANGELOG, and a GitHub Actions CI workflow running typecheck, lint, build, and tests on Node 22.

### Fixed

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
