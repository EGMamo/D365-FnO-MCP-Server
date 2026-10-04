# D365 FnO MCP Server — Project Rules & Context

## Project Purpose
A **Model Context Protocol (MCP) server** for Microsoft Dynamics 365 Finance & Operations (D365 FnO),
targeting developers. Gives AI agents deep insight into **local AOT source code** — tables, classes,
forms, data entities, EDTs, enums, labels, security objects, cross-references — by indexing
`PackagesLocalDirectory` XML files into SQLite. Optional imports add XRef usages, Trace Parser
captures and Microsoft release plans.

> **No live D365 environment connection.** Pure code intelligence tool; it never calls OData,
> Dataverse or Application Insights (KQL is generated, not executed).

## Tech Stack
- **Runtime**: Node.js 24+, TypeScript (ESNext modules, strict mode)
- **MCP Transport**: Streamable HTTP (`MCP_TRANSPORT=http`, `/mcp`)
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **Indexing**: AOT XML -> `fast-xml-parser` -> SQLite via Node's built-in `node:sqlite`
- **Auth (HTTP)**: API keys (`X-API-Key` or `Authorization: Bearer`), named keys in `MCP_API_KEYS`, >= 32 chars, sessions bound to the key
- **Hosted mode**: read-only from the active validated artifact bundle in the local
  `D365_ARTIFACT_STORE_PATH`; see `docs/hosted-deployment.md`
- **Optional**: `mssql` (only for `index-xref` / `index-trace`)

## Key Design Decisions
- Read-only by default. Generators return previews; file writes need `D365_ENABLE_WRITE_TOOLS=1`, are two-step (`write_table_extension` -> `apply_table_extension_change`) and are refused in hosted mode
- Every generator is grounded: it resolves referenced objects/fields/EDTs against the index and reports what it could not resolve
- Network use is opt-in: Azure artifact publication through `artifact`/`acquire` and
  `index-release-plans` (public feed)
- Trace data stays local and is not included in artifact bundles
- Index is incremental (file mtime-based)

## MCP Tools (54)
- **Metadata** (`tools/metadata.ts`): search_symbols, get_table_schema, get_class_hierarchy, get_method_signature, find_references, find_usages, get_enum_values, get_edt_details, get_form_datasources, get_query_datasources, get_data_entity_details, get_element_xml, list_objects, list_packages, list_models, get_index_staleness, get_index_stats, get_usage_snapshot_status
- **Labels** (`tools/labels.ts`): resolve_label, search_labels, resolve_label_by_language, search_labels_fts
- **Generators** (`tools/generators.ts`): create_coc_extension, create_table_extension, create_class_extension, generate_xpp_class, create_runbase_batch, create_sys_operation
- **Entities / integration** (`tools/entities.ts`): check_entity_odata_readiness, create_data_entity, create_security_privilege, create_readonly_role_for_entities, create_odata_action
- **Security** (`tools/security.ts`): get_security_object, find_security_path, analyze_sod_conflicts, diff_roles
- **Code quality** (`tools/codeQuality.ts`, analysis in `src/xpp/`): check_xpp_best_practices, find_field_access, get_bp_findings (after `index-bp`)
- **Security customizations** (`tools/security.ts`, `src/security/converter.ts`): convert_security_customizations
- **Traces** (`tools/traces.ts`): list_trace_sessions, get_top_methods, find_slow_sql, find_n_plus_one, search_trace
- **Telemetry / batch** (`tools/telemetry.ts`): generate_kql_query, analyze_batch_class
- **Release plans** (`tools/releasePlans.ts`): search_release_plans, check_feature_impact
- **Workspace / writes** (`tools/workspace.ts`, `tools/writers.ts`): get_visual_studio_workspace, write_table_extension, apply_table_extension_change
- **Knowledge** (`tools/knowledge.ts`, `knowledge/`): `d365kb://` resources and the knowledge filter that annotates index tool results (topics in `d365-fno-assistant-knowledge/`)

## File Structure
```
src/
  index.ts                # CLI entry point (serve, index, index-xref, index-trace, index-bp,
                          #   index-release-plans, index-status, acquire, artifact, digest, doctor, setup)
  config.ts, configLoader.ts  # Zod env validation
  cli/                    # One module per command
  server/                 # start.ts (tool registration), httpTransport.ts, apiKeys.ts, artifactStartup.ts
  indexer/                # scanner, parser, db schema, buildIndex, xref/trace/release-plan importers, artifact bundles
  tools/                  # MCP tool handlers (see above)
  security/model.ts       # Role/duty/privilege flattening
  validation/grounding.ts # Object resolution and naming checks for generators
  workspace/              # Visual Studio workspace discovery and safe offline writes
  knowledge/              # Knowledge digest
tests/                    # vitest
docs/                     # roadmap, hosted deployment, local agents, RAI FAQ
agents/                   # source/ -> github-copilot/*.agent.md + claude-code/*.md (npm run build:agents)
infra/                    # Azure infrastructure plan (template not yet added)
```

## D365 FnO AOT File Layout (PackagesLocalDirectory)
```
PackagesLocalDirectory/
  <PackageName>/
    Descriptor/*.xml      → model descriptors
    <ModelName>/
      AxTable/ AxTableExtension/ AxClass/ AxForm/ AxQuery/ AxEnum/ AxEdt/
      AxDataEntityView/ AxSecurityRole/ AxSecurityDuty/ AxSecurityPrivilege/
      AxMenuItemAction/ AxMenuItemDisplay/ AxMenuItemOutput/   *.xml
      AxLabelFile/        *.label.txt → labels
```

## Main Environment Variables (.env)
```
MCP_TRANSPORT=http
MCP_HOST= / MCP_PORT=3000
MCP_API_KEYS=name=<32+ chars>,other=<32+ chars>
D365_PACKAGES_DIR=K:\\AosService\\PackagesLocalDirectory
D365_CUSTOM_METADATA_DIR=     # optional extra metadata root
D365_INDEX_DB_PATH=./d365_index.db
D365_ARTIFACT_STORE_PATH=     # hosted mode: local artifact-store root
D365_ENABLE_WRITE_TOOLS=0     # local only
RATE_LIMIT_MAX_REQUESTS / RATE_LIMIT_WINDOW_MS / TRUST_PROXY_HOPS
MAX_CONCURRENT_SESSIONS / SESSION_IDLE_TIMEOUT_MS / MCP_REQUEST_TIMEOUT_MS
```
See the README Configuration table for the full list.

## Coding Conventions
- Use `zod` for all input validation (tool inputs + env vars)
- Use named exports
- Keep tool handlers thin; put schema and shared queries in `src/indexer/`
- Never invent AOT names: resolve against the index and report unresolved names
- Errors returned from tools should be user-friendly strings (MCP clients display them)
- Agents: edit `agents/source/*.md`, never the generated files; run `npm run build:agents`
- Tests: vitest; open databases through `openDb`; run `npm run build` before the full suite (integration tests use `dist/`)

## References
- MCP Spec: https://modelcontextprotocol.io/specification
- Roadmap: `docs/roadmap.md`
- Microsoft Learn MCP: https://learn.microsoft.com/api/mcp
