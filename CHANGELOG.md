# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
