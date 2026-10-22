# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- `tedious` (the optional `mssql` driver's dependency) moved to 20.3.7, which drops `sprintf-js`
  (GHSA-hp3w-g68c-fv3c); `npm audit` now reports no vulnerabilities.
- The HTTP transport (server and gateway) now rate-limits before it parses the body. A malformed
  or oversized JSON body used to fail in the parser and skip the limiter, so such requests were
  never counted.

### Changed

- The build no longer emits `.d.ts` and declaration maps: the package is a CLI with no library API,
  and the maps pointed at `src/`, which is not published. The packed tarball drops from 416 to 230 files.
- `package.json` names the repository, homepage and issue tracker.

- Indexing is faster: the scan reads only `<Package>/<Model>/Ax<Type>/` instead of the whole tree
  (it no longer walks `bin/` or `XppMetadata/`), files are read ahead and written 500 per transaction,
  the change check reads from a covering index instead of the XML row, and triggers keep the FTS
  indexes current so an incremental run no longer rebuilds them. On a 29k-object synthetic tree a
  cold build went from about 25s to 14s.

### Added

- `index-docs` command and `search_docs` / `get_doc_page` tools: crawl a documentation site (same
  host, under a scope, robots.txt respected, optional sitemap) or import a folder of markdown/HTML
  files into the local index, split into heading sections with an FTS5 index (porter stemming). Each
  `--source` label is replaced on re-import. Imported docs are kept apart from the curated knowledge
  base.
- `gateway` command: a hybrid gateway for developers who use a hosted server. It indexes only the
  custom models in `D365_CUSTOM_METADATA_DIR` into a separate local SQLite file, listens on
  `127.0.0.1` behind a bearer token, forwards tool calls to the hosted server and merges both sides
  where custom code matters (search, labels, table schema, references, impact, field access). Custom
  code is never sent upstream; `D365_GATEWAY_PRIVATE_PREFIXES` also keeps custom names at home. New
  settings: `D365_HOSTED_MCP_URL`, `D365_HOSTED_API_KEY` / `_FILE`, `D365_LOCAL_INDEX_DB_PATH`,
  `D365_GATEWAY_PORT`, `D365_GATEWAY_TOKEN`, `D365_GATEWAY_PRIVATE_PREFIXES`,
  `D365_GATEWAY_UPSTREAM_TIMEOUT_MS` and `D365_GATEWAY_REINDEX_TTL_MS`. `doctor` checks the gateway
  settings, folders and hosted key, and the HTTP transport takes an `allowedHosts` Host allow-list.
  See docs/hybrid-gateway.md.
- Tools: `analyze_impact` (bounded transitive dependents over declared references), `get_method_source`
  (one method's X++ from stored XML), `create_event_handler` (table data events and pre/post method
  handlers) and `create_form_event_handler` (form, data source and control events), all grounded
  against the index. `search_symbols` takes `explain` to say why each hit matched.
- Indexing: table, form, EDT, enum, data entity, query, menu and menu item extensions (linked to the
  extended object; enum extensions keep added values), views, maps, services and service groups
  (with class and service links), and by name only SSRS reports, menus, workflow types/approvals/
  tasks/categories, aggregate measurements/dimensions and KPIs. Rebuild an existing index to get them.
- `get_table_schema`, `get_form_datasources`, `get_data_entity_details`, `get_enum_values` and
  `get_query_datasources` take `maxItems` (default 1000) and report clipped lists under `truncated`;
  `get_element_xml` takes `maxChars` (default 100000).
- `npm run bench` measures read-path latency and FTS rebuild cost on a synthetic corpus.
- Not-found responses on the metadata tools suggest close indexed names.

- `scripts/azure-pause.ps1` pauses an idle environment: it deletes the App Service app and plan,
  the worker VM and disks, the NAT gateway, private endpoints and alerts, and keeps storage (the
  artifact bundles), Key Vaults, identities, the registry and the network. `azure-deploy.ps1`
  resumes it with the API image recorded at pause time. See "Pausing an environment" in
  infra/README.md.
- `scripts/azure-github-trust.ps1` adds the GitHub federated credential the Deploy workflow signs in
  with, on demand, using the repository's ID-based OIDC subject looked up on GitHub; `-Remove`
  deletes every GitHub credential on the deploy identity. `azure-post-deploy.ps1 -Step GitHub` runs
  it, and `azure-pause.ps1` removes the trust.
- `azure-deploy.ps1 -GitHubRepository` and `azure-post-deploy.ps1 -Repository` default to the
  GitHub repository of the clone's `origin` remote instead of a fixed owner, and
  docs/moving-the-repository.md lists what to update when the repository moves.
- Visual Studio extension: **Extensions > D365 F&O MCP > Set API Key...** enters or replaces the
  hosted API key on its own (tested, stored in Windows Credential Manager, gateway restarted).
  The key prompt in Configure Connection now has its own title and says which key to paste, and
  Test Connection points to Set API Key when no key is saved.
- Visual Studio extension: choose which tools Copilot may use. After the connection test passes,
  Configure Connection shows a checkbox list of the server's tools; **Select Tools...** edits it
  later. The local gateway hides unchecked tools from `tools/list` and refuses calls to them.
- `-LogLevel Error|Warning|Info|Verbose|Debug` on `azure-deploy.ps1`, `azure-post-deploy.ps1`,
  `scripts/worker/acquire-ude-sources.ps1`, `acquire-ude-assets.ps1` and `verify-windows-xpp.ps1`
  (default `Info`, output unchanged); `-Verbose` and `-Debug` also work and never stop for input.
  `Verbose` adds each az command, decisions and step timings and passes `--verbose` to az; `Debug`
  adds internal values and `--debug`. Calls that send or return a secret never get az logging flags,
  and no level prints a secret, token or SAS query string. `azure-post-deploy.ps1` passes a level you
  set to the Run Command scripts, and `PrepareWorker` records it in `acquisition.json` for
  `acquire-ude-sources.ps1`, AzCopy (`--log-level`) and the Node worker (`MCP_LOG_LEVEL`).
- `costProfile` parameter in `infra/main.bicep` (`standard` or `cheapest`). `cheapest` keeps the
  same architecture at the lowest cost: P0v3 App Service plan, Standard SSD worker disks, Basic
  ACR without a private endpoint, and the `/health` availability test from 2 locations every 15
  minutes. `main.dev.bicepparam` and `azure-deploy.ps1` (`-CostProfile`, defaulting to `cheapest`
  for environment names starting with `dev`) use it; `apiPlanSku` and `workerDiskType` still
  override it.
- `azure-deploy.ps1 -ReplaceIncompatible` converts existing resources a profile change cannot
  update in place (worker disk type while the VM is deallocated, the registry private endpoint that
  blocks a Premium to Basic downgrade); without it the script stops before deploying and says so.
  `-RemoveExistingResources` deletes every resource in the group except the Key Vaults after listing
  them and asking for the resource group name to be typed.
- Automated worker preparation: `azure-post-deploy.ps1 -Step PrepareWorker -DataverseUrl <url>
  -WorkerApplicationId <app id>` checks through Run Command that the worker can read its secret,
  sign in to Dataverse, read the Finance and Operations version and resolve the downloads, then
  writes an `acquisition.json` that needs no RDP, PAC or manual SDK install. Its acquire step,
  `scripts/worker/acquire-ude-sources.ps1`, downloads the X++ SDK (`systemmetadata`), the VS tools
  VSIX and the cross-reference backup for the environment's current version into a per-version
  cache and writes `sources.json`; the new `prepare-bundle` command indexes that SDK and writes the
  bundle options with source provenance. The cross-reference backup is hashed but not imported.
- Acquisition steps write their output to `<runsRoot>/<runId>/logs`, and a failed step's error
  names its log file. `FirstAcquisition` prints the log tails when a run fails.
- New environments create the acquisition scheduler disabled (`workerSchedulerEnabled`), and its
  recurrence has a fixed start time, so deploying or enabling it no longer starts a run on an
  unprepared worker. `azure-deploy.ps1` keeps an enabled scheduler enabled on redeploys, and
  `ResumeScheduler` enables it after the first acquisition. A run whose VM deallocation fails now
  fails, so the worker-run alert reports a VM left running.
- `Release VS extension` workflow: an `extension-v<version>` tag, or a manual run on `master`,
  builds the Visual Studio extension with that version and publishes a GitHub release with the
  VSIX and its SHA-256 checksum. `docs/visual-studio-extension.md` now covers installing it.
- Knowledge filter: index tool results pass through the knowledge base, which drops rows topics
  mark as noise (build-output mirrors), moves preferred rows first and attaches matching topic
  notes as a second content item. Topics gain an optional YAML header (`appliesTo`, `match`,
  `filter`, `rank`, `note`); all 24 shipped topics have one. Matching by meaning uses a local
  all-MiniLM-L6-v2 embedding model run through ONNX Runtime WebAssembly (`fetch-model`, included in
  the Docker image); without it the filter runs on header rules. `D365_KNOWLEDGE_FILTER=0` turns it off.
- `get_task_guidance` tool: matches a whole request against the knowledge base clause by clause,
  rates coverage, lists the parts no topic covers, and keeps the task for the session so later
  index and generator results carry the task's topics once. Generator tools now pass through the
  filter too.
- Knowledge topic 25: posting arrival journals and product receipts in batch (API names marked for
  verification against an index).
- Knowledge topic 26: creating sales orders from an Excel file, standard import first, then the
  custom X++ pattern (API names marked for verification against an index).
- `digest` blocks drafts that repeat an existing topic in different words (meaning-based check with
  the same model) and validates topic headers. New `knowledge-check` command validates headers and
  caches topic vectors.
- Storage and Key Vault firewalls list the app and worker subnets (with service endpoints) next
  to their private endpoints, so deployments pass "require VNet ACLs" policies.
  `azure-deploy.ps1` prints denied resources and failed operations when a deployment fails.
- PowerShell deployment scripts that work in any tenant and subscription:
  `scripts/azure-deploy.ps1` (sign-in, provider registration, resource group, generated parameter
  file without secrets, what-if, deploy) and `scripts/azure-post-deploy.ps1` (API keys, worker
  secret and setup, first acquisition, GitHub environment and API deploy), which reads every
  resource name from the deployment outputs.
- Azure infrastructure as code (`infra/main.bicep`, not yet deployed): App Service API with a
  staging slot and startup Blob materialization settings, a deallocated-by-default Windows
  acquisition VM run on schedule by a Logic App through Run Command, a Shared-Key-free artifact
  store with lifecycle rules that never delete bundles, ACR, separate API and worker Key Vaults,
  user-assigned identities with container- and resource-scoped roles, a GitHub OIDC deploy
  identity, private endpoints, NAT egress, Log Analytics, Application Insights availability
  testing and alerts for health, capacity, auth failures, Blob denials, worker failures and index
  freshness. CI builds and lints the templates. `deploy.yml` now deploys to the staging slot,
  waits for bundle activation, smoke-tests, swaps and swaps back if production is unhealthy.
- Per-replica startup materialization from Azure Blob (`D365_ARTIFACT_SOURCE=azure-blob`): the
  replica listens unready, reads the active pointer with managed identity and pins its ETag,
  checks local disk, downloads the immutable bundle into a staging directory, validates it,
  atomically publishes and activates it on instance-local disk, and reports ready only after a
  representative query on the opened index. `/health` is now readiness (`503` while starting) and
  the new `/live` route reports liveness. Startup failures exit with code 1.

- A fail-closed Azure artifact contract for immutable content-addressed index bundles, including
  source provenance, capability inventory, compatibility bounds, durable validation reports,
  concurrency-safe active/previous promotion, pointer-only rollback and validated local API
  activation, plus an Azure Blob adapter with managed identity, create-only bundle writes, ETag
  pointer promotion, acquisition leases, rollback-safe retention, and fail-closed materialization.
- A guided Azure resource plan. The default SDK acquisition worker is Windows because Microsoft
  documents `pac tool xpp install` as a .NET Full Framework command; Linux Container Apps Jobs remain
  conditional on a documented and complete X++ SDK acquisition proof. A candidate Windows ARM64 VM
  acquired and registered SDK `10.0.2645.124`; X++ compiler `7.0.7996.111` starts successfully under
  ARM64 emulation. A separate work-laptop configuration supplies layout evidence only. The new
  `scripts/verify-windows-xpp.ps1` captures non-secret PAC registrations, optional generated XPP
  configurations, package-directory presence, compiler discovery from both configuration and
  versioned SDK paths, and optional bounded compiler startup evidence.
- Knowledge topic `24-form-patterns-ui-layout`: how the web client splits a form into logical and
  physical halves, how to select a form pattern from `Form.Design.Style` and form shape, the
  available top-level, support, and subpattern families, and the layout properties
  (`ArrangeMethod`, `ColumnsMode`, `HeightMode`/`WidthMode`) that drive responsive sizing.
- Visual Studio single-gateway foundation: a loopback-only MCP gateway proxies hosted tools,
  forwards the installed D365 SDK version, keeps the hosted API key in Windows Credential Manager,
  and adds a privacy-safe `workspace_get_context` tool.
- Session-start SDK version warnings. The index records the four-part D365 application version it was built from (read from Unified Developer Experience paths, or from the new `D365_APP_VERSION` for layouts that do not name it), and every session is told which version it is querying through the MCP `instructions`. A client declaring an older *build* over the `X-D365-Client-SDK-Version` header is warned that returned elements may not exist locally; an older *revision* of the same build is only a notice. Nothing is blocked. See [SDK version warnings](README.md#sdk-version-warnings).
- `acquire` command and scheduled acquisition worker: acquire source assets, build and validate an immutable artifact bundle, publish it, and promote it with retry-safe run IDs.
- `artifact` command for Azure Blob bundle status, publication, promotion, and rollback.
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
- `index-status` command: compares the local packages folder with the local index and reports
  added, changed and removed files per model. `--json` for tools.
- `index --packages-dir/--db-path`.
- `index-xref` signs in with Windows authentication (`Trusted_Connection=yes`) through the optional
  `msnodesqlv8` driver, which also reaches LocalDB.

- Hosted mode: `D365_ARTIFACT_STORE_PATH` makes `serve` validate the active local artifact bundle
  before listening, so the server runs read-only without a `PackagesLocalDirectory`.
- `MCP_API_KEYS`: named API keys (`name=key,...`) alongside the legacy `MCP_API_KEY`; requests log
  the key name only and a session is bound to the key that opened it.
- `ax_meta` build metadata (`built_at`, server version, raw-XML setting); `get_index_stats` reports
  it and `get_index_staleness` reports `mode: "snapshot"` on a server without source files.
- `MCP_HOST` to bind a single interface; graceful shutdown that closes sessions before exit.
- `Dockerfile`, `.dockerignore`, a `deploy.yml` workflow (OIDC → ACR → App Service), a CI job that
  builds and smoke-tests the image, and `docs/hosted-deployment.md` with Visual Studio / Claude Code /
  VS Code client configuration.

### Changed

- `MCP_LOG_LEVEL` defaults to `INFO` instead of `DEBUG`, and log metadata can no longer overwrite a
  line's `ts`, `level`, `scope` or `message`.
- `serve` logs and exits with code 1 on an unhandled exception or rejection, and on a shutdown that
  times out (it used to exit 0). Both paths close the database first.
- CI tests on Node 26 (the image's runtime) as well as Node 24, runs `npm audit` on runtime
  dependencies and scans the built image, failing on fixable high or critical findings.
- The runtime image no longer ships npm or corepack; nothing in it runs them, and their bundled
  dependencies carried fixable high-severity advisories.
- `list_objects` pages in a deterministic `type, name, id` order.
- Connections use a larger page cache, memory-mapped reads, in-memory temp tables and a busy timeout,
  and the index has an `ax_objects(package, type, name, id)` index.
- `create_table_extension` rejects fields that another indexed table extension already adds.
- `infra/main.bicep` no longer creates the deploy identity's GitHub federated credential and drops
  the `githubRepository` and `githubEnvironment` parameters, so no deployment names a GitHub owner or
  repository. Run `scripts/azure-github-trust.ps1` (or `azure-post-deploy.ps1 -Step GitHub`) to let
  the Deploy workflow sign in. A redeploy does not delete an existing credential; the trust script
  replaces it. A `-ParameterFile` that still sets those parameters must drop them.
- Bundles declare capability coverage from what the indexer actually reads
  (`src/indexer/capabilityCoverage.ts`): code, data model, forms, labels, extensions and security
  graphs are partial, and workflows, services, reporting and reports are partial (name-level for most
  of them; see docs/production-readiness.md). A capability whose source
  files failed to index is at most partial. The API, the `artifact` commands and the acquisition
  worker used to require all nine to be complete, which no real bundle could honestly claim; by
  default they now require the complete ones, which is none yet. Set
  `D365_ARTIFACT_REQUIRED_CAPABILITIES` to require more. `prepare-bundle` still refuses an index with
  no code, data model, label or security items. The worker's `policy` block is optional and
  defaults to the same checks the API applies.
- `azure-post-deploy.ps1`: `SetupWorker` no longer installs the PAC CLI and builds from
  `-Repository`; `FirstAcquisition` passes its script as a file (multi-line inline scripts break
  in `az.cmd`), waits for a terminal state and requires the verification to finish;
  `ResumeScheduler` deallocates the VM before enabling the schedule so an immediate run is not cut
  off; `Deploy` waits for the run it started.
- Upgraded glob to 13, fast-xml-parser to 5, ESLint to 10 and Vitest to 5, and moved the CI and deploy workflows to action versions that run on Node 24. `npm ci` no longer reports deprecated packages or audit findings.
- `D365_PACKAGES_DIR` is required only for indexing; HTTP transport and API keys are mandatory for
  `serve`.
- `getIndexStats().lastIndexed` now reports the recorded build time instead of the call time.
- `mssql` moved to `optionalDependencies`; the container image and `--omit=optional` installs leave
  it out and `index-xref` explains how to install it.
- Configuration parsing is a pure `loadConfig()` (`src/configLoader.ts`) with tests.
- Artifact bundle validation reports record checks that actually ran (SQLite integrity, index
  metadata, source provenance, capability inventory) with their details; a failed check stops the
  bundle from being built.
- `scripts/acquire-ude-assets.ps1` also verifies Content-MD5 when the blob reports one, redacts SAS
  values from AzCopy errors, and checks native exit codes explicitly under Windows PowerShell 5.1;
  `scripts/verify-windows-xpp.ps1` exits 1 when `pac tool xpp list` fails.
- Visual Studio extension: `.mcp.json` is rewritten only when our entry changes, under a
  cross-process lock and through an atomic replace, and `.bak` keeps the pre-extension file; an
  instance no longer overwrites another running instance's gateway entry; cancelling Configure
  Connection leaves the saved key and settings untouched; remote server URLs must use HTTPS; SDK
  folders sort by version and `AosService` is no longer sent as an SDK version.

### Removed

- The `digest_knowledge` MCP tool. Only the server owner adds knowledge, with `digest` in the
  repository, so no MCP client can change what other clients read.
- stdio transport and keyless local sessions. The server now exposes only authenticated Streamable
  HTTP, and `MCP_API_KEYS` (or `MCP_API_KEY`) is mandatory.
- Retired developer-built index distribution: `publish-index`, `pull-index`, `upload-index`,
  manifest download at server startup, direct upload routes, SAS/publish configuration, and the
  Visual Studio Index and Upload/freshness/update workflows. Production candidates are now expected
  to be built, validated and atomically promoted by private Azure automation.

- `docs/vs-addin-plan.md`: the extension that applies generated code was not pursued; the Visual
  Studio extension now handles connection setup and the loopback MCP gateway instead.

### Added (initial scaffold)

- Initial project scaffold: strict TypeScript configuration, ESLint flat config, and build pipeline.
- AOT metadata parsers and indexer covering tables, classes, enums, EDTs, forms, and labels, with all object types wired into the indexer.
- SQLite index with incremental passes (path + mtime based), `--force` full rebuild, stale-entry pruning, rename detection, and duplicate-name collision reporting.
- MCP metadata tools: `search_symbols`, `get_table_schema`, `get_class_hierarchy`, `get_method_signature`, `find_references`, `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_element_xml`, `list_objects`, `get_index_stats`.
- MCP label tools: `resolve_label`, `search_labels`.
- X++ generators grounded against the index with validation gates: `create_coc_extension`, `create_table_extension`, `create_class_extension`, `generate_xpp_class`, `create_runbase_batch`, `create_sys_operation`.
- Streamable HTTP transport for MCP clients.
- CLI with `serve`, `index`, `doctor`, and `setup` commands, including non-interactive setup flags.
- Packaging and documentation polish: comprehensive README, `files`/`keywords` metadata, CHANGELOG, and a GitHub Actions CI workflow running typecheck, lint, build, and tests (now on Node 24).

### Fixed

- The Deploy workflow tagged the image with an empty registry address (`/d365-fno-mcp-server:<sha>`)
  and failed to build it, because the deploy identity can push images but cannot read the registry
  resource that `az acr show` asks for. It now takes the login server from `az acr login
  --expose-token` and stops if it is still empty.
- The Deploy workflow would have restarted production while setting the new image on the staging
  slot: `az webapp config container set --slot staging` also rewrites production's app settings, so
  production would download its bundle again and answer 503 during the deployment. The workflow now
  patches the staging slot's site config directly, and the image rollback steps in
  `infra/README.md` do the same.
- The hosted API could not fit a full-size index on App Service: each running slot kept the
  downloaded bundle and a copy of its database (about 12 GB for the 5.9 GB index), and the
  production and staging slots share each instance's 15 GB host disk. Startup from Azure Blob now
  hard-links the database into `D365_INDEX_DB_PATH` and its free-space check asks for one copy; when
  a test link between the two paths fails (separate mounts) it copies as before, and a copy now
  checks its own room even when a local bundle is reused. The Deploy workflow starts `staging` if
  it is stopped and stops it at the end while production is healthy, so only production holds a
  copy between deployments. `infra/README.md` has the new manual rollback steps.
- `prepare-bundle` crashed with exit code 134 (JavaScript heap out of memory) on a full X++ SDK:
  the index pass's cleanup loaded every label row in every language into memory to find stale
  ones. SQLite now finds and deletes stale objects and labels itself, so memory no longer grows
  with the number of labels. The worker also gives `prepare-bundle` an 8 GB heap.
- The acquisition run spent hours on avoidable disk work at full SDK size:
  - Index databases use `synchronous = NORMAL`, so an index run no longer flushes the disk once per
    file (about 600,000 times on a full SDK).
  - Bundles leave out each label row's file path and its index, which only index runs use. Creating
    a bundle compacts a scratch copy once with `VACUUM INTO` instead of vacuuming twice in place. On a
    test index this was 2.4 times faster and the bundle 30% smaller.
  - `FirstAcquisition` no longer runs `artifact status --verify`, which downloaded the bundle again
    right after promote had downloaded and validated it.
- The acquisition worker's publish step revalidated the whole active bundle against the current
  policy (downloading it first for Azure), so every promotion after a server upgrade failed. Local
  and Azure promotion now read only the active bundle's manifest to check the candidate is newer.
- `get_task_guidance` matched a one-line request to an unrelated topic because a trailing period
  shifted the embedding score; clauses are now matched without trailing punctuation, and a request
  that does not split into clauses is reported as uncovered when no topic reaches the threshold.
- `get_task_guidance` rated a long spec "strong" when one short fragment matched a topic; strong
  coverage now also needs at least half of the request's parts covered.
- `azure-post-deploy.ps1 -Step SetupWorker` no longer fails with a 404 on the Node.js download:
  the VM script (Windows PowerShell 5.1) picks the Node 24 x64 installer from the release's
  `SHASUMS256.txt` and verifies its checksum, and npm warnings on stderr no longer stop the build.
- Concurrent knowledge-digest writes now reserve the shared numeric prefix atomically, preventing
  different article slugs from receiving the same sequence number.
- Label files are found where Visual Studio keeps them
  (`AxLabelFile/LabelResources/<language>/<LabelFile>.<language>.label.txt`); before, a real
  `PackagesLocalDirectory` indexed no labels. The language comes from the file name, and labels are
  stored under the id code references (`MyLabels:Greeting` for `@MyLabels:Greeting`, `SYS1` for a
  legacy `@SYS1`). The index schema version is now `3`; the next `index` run re-reads every label
  file once, and `index-status` reports an index built by an older schema as out of date.
- `resolve_label` prefers the `en-US` text when a label exists in several languages, and language
  filters match case-insensitively.
- An `index` run that stops before its search rebuild (a file deleted mid-scan, Ctrl-C) no longer
  leaves new objects out of `search_symbols` for good: the next run rebuilds the FTS tables. A file
  deleted during the scan is skipped instead of stopping the run.
- Files restored with an older modification time are re-indexed; `index` and `index-status` treat
  any different time as a change.
- A label two files declare no longer disappears when the file that owned the row stops declaring
  it.
- `index-status` reports an XRef import that was not uploaded, and an index built by an older schema.
- The server refuses an uploaded index built by an older schema (new `schema` check), and a hosted
  server warns when it downloads one.
- `upload-index --stop-on-stdin-close`: the Visual Studio extension's **Cancel** now aborts the
  server upload and deletes the staging copy instead of killing the CLI, which left the server
  refusing uploads for two hours.
- Visual Studio extension: CLI INFO logs are no longer shown as errors (and DEBUG lines are off);
  Check Index Freshness does not run while an index run holds the index; the CLI runs in a neutral
  folder so a project `.env` cannot fill in settings; moving the API key out of `.mcp.json` no
  longer leaves it in `.mcp.json.bak`; Test Connection handles an invalid saved URL and a timeout
  while closing its test session.
- `scripts/publish-index.ps1` never prunes the version `latest/manifest.json` points at, and only
  treats version-named folders as versions.
- `get_bp_findings` treats `%` and `_` in the moniker filter as literal text.
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
