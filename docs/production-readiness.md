# Production readiness and implementation evidence

Updated: 2026-10-10. The goal remains an operationally reliable, feature-complete, grounded
D365 FnO code-intelligence server. **The full goal is not yet verified or complete.**
The feature and performance scope remains [Phases 8–13](plan-performance-features-intelligence.md);
the completed changes below do not replace that scope.

## Verified in this checkout

Validation ran on macOS with Node 26.8.1. These are local results, not a claim that the remote
Linux/Windows CI, Azure deployment, container, or Visual Studio extension were tested in this run.

| Gate | Current evidence |
|---|---|
| Full validation | `npm run check` on macOS, Node 26.8.1, with local port binding enabled: typecheck, lint, build, knowledge headers (26 topics) and tests passed; 680 tests passed, 4 skipped, 46 passing test files and 1 skipped file (2026-10-10, after the changes listed below); a later run with the embedding model installed: 683 passed, 1 skipped (the opt-in DynamicsXrefDB test) |
| Compiled protocol | `npm run check` includes the compiled-server tests in `tests/mcpIntegration.test.ts` (real child processes and SDK clients over HTTP, occupied-port startup failure, hosted-mode startup); they passed in this run |
| Knowledge headers | All 26 topic headers valid; embedding model absent, so runtime guidance uses topic rules |
| Startup failure | An occupied TCP port returns exit code 1 in both local and hosted modes, without logging successful listening/readiness |
| Metadata grounding | Differently cased names return table references, derived classes, method signatures, and compiler usage locations in local indexes, current read-only snapshots, and read-only snapshots lacking the new indexes |
| Security grounding | Role extensions, cycles, privileges, entry points, and segregation-of-duties rules retain their meaning across input/reference casing differences |
| Code review tools | Best-practice analysis resolves differently cased object names and returns the indexed name and actual findings |

The four skipped tests in the first run are one opt-in DynamicsXrefDB test and three tests that
require the embedding model. The model (all-MiniLM-L6-v2, archive SHA-256 matched the value pinned in
`src/cli/fetch-model-command.ts`) was then installed under the gitignored `models/` folder and
the three semantic tests ran and passed. That verifies the embedding path and cached topic vectors
work; it is not a representative relevance evaluation of guidance quality, which is still open. Earlier in this session, with port binding blocked by the sandbox, 11 tests
(appVersion, mcpIntegration, transport) failed with `listen EPERM`; they pass now that binding
is allowed, so they were environment failures, not code defects. Passing the remaining suite does not establish those capabilities against
their external dependencies.

## Changes implemented

- Startup now exposes an awaitable listener result. A bind failure closes the local index and
  propagates to the CLI's failure exit; hosted artifact activation starts only after a successful
  bind. Successful hosted startup still exposes liveness while the bundle is being prepared.
- A shared object-row lookup preserves exact-name precedence and provides a case-insensitive
  fallback without loading child collections. Best-practice analysis and privilege resolution
  reuse it.
- Structural references and compiler usage queries match names case-insensitively, retaining
  object-type, method, relationship-kind, and result-limit filters. Results retain stored names.
- Security traversal resolves known references to indexed names before comparing identities.
  Missing references remain visible. Mixed-case duty rules no longer hide SoD conflicts.
- Additive indexes support these case-insensitive lookup paths. The object-name index includes
  the original spelling as a final key so deterministic name ordering can use the selective
  lookup. Snapshot creation opens/migrates the source database before copying these indexes.
- `npm run check` is the shared local/CI gate. `npm run test:e2e` always builds first, preventing
  accidental verification of stale compiled code. CI now includes knowledge-header validation.

- "Did you mean" suggestions (`suggestObjectNames`/`notFoundMessage`, bounded to 200 scored
  candidates) on the metadata tools' not-found responses; other tools' messages are unchanged.
- Read tuning pragmas on all connections (64 MB cache, 256 MB mmap, in-memory temp store, 5 s
  busy timeout). Effect on latency has not been measured.
- `list_objects` pages in a deterministic `type, name, id` order.
- `get_element_xml` is capped by `maxChars` (default 100,000) and states when it truncates.
  `get_table_schema`, `get_form_datasources`, `get_data_entity_details`, `get_enum_values` and
  `get_query_datasources` cap each list at
  `maxItems` (default 1000, 10-10,000) and report clipped lists under `truncated`; output shape is
  unchanged when nothing is clipped. Source-read audit of the rest: label search tools take a `limit` (max 500); security tools
  return a capped list with the true total and `truncated`; traces and code-quality tools take
  limits. `telemetry`, `entities` and `knowledge` were only counted for limit-style code, not
  exercised with large inputs, so they remain unverified.

- `npm run bench` (`scripts/bench.mjs`): A1 read-path harness over a deterministic synthetic
  corpus in a disk-backed database. At 20,000 objects on this machine: build 1.1 s, FTS rebuild
  14 ms, p95 under 0.1 ms for prefix search and exact/lowercase lookups, 0.34 ms for typo
  suggestions, about 2.1 ms for a type-filtered search matching thousands of rows. The corpus
  is synthetic and the harness does not yet cover incremental indexing, concurrency, or real
  Finance and Operations sizes, so A1 stays open.
- `ax_objects(package, type, name, id)` index: package-filtered `list_objects` paging p50 fell
  from 0.54 ms to 0.047 ms at 20,000 objects (synthetic corpus).

- B1 partial: `AxTableExtension` (added fields, indexes, `extends` xref to the base table),
  `AxView` (fields, query tables) and `AxMap` (fields, mapped tables) are scanned, parsed, stored
  and exposed to tools that accept an indexed type. `create_table_extension` now rejects fields
  that another indexed extension already adds. Verified with parser tests and an index-build
  integration test on synthetic XML; not yet validated against real Finance and Operations
  metadata. Form, EDT, enum (with added values), data entity and query extensions are indexed by
  name and `extends` link only; their added controls and properties are not parsed. Menu and menu
  item extensions are linked the same way.
- Services and service groups are parsed (class, external name, operations; service-to-class and
  group-to-service links that `analyze_impact` follows), tested on synthetic XML in the shape I
  expect from the AOT, not on real metadata. Name-level indexing (name, package, searchable via
  any tool accepting an indexed type; contents not parsed) of SSRS reports, menus, workflow types/approvals/tasks/
  automated tasks/categories, aggregate measurements/dimensions and KPIs. Their capabilities are
  now `partial` rather than `absent`, with notes stating that nothing inside them is parsed. Table/
  field grants, code permissions and security policies, macros and resources remain unindexed. Existing indexes need a rebuild to gain them.

- `analyze_impact`: bounded transitive dependents of an object over declared structural
  references (extensions, subclasses, data sources, EDT use), by depth, with cycle protection and
  an explicit `truncated` flag. Covered by unit tests on a synthetic graph. It reports declared
  references, not call sites, and does not yet weight or explain results (C-track ranking remains).

- `create_event_handler` generator: table data-event handlers (Inserting/Inserted/Updating/
  Updated/Deleting/Deleted) and pre/post handlers for indexed Class or Table methods, grounded
  against the index with canonical casing and method-existence checks. Output is unit-tested as
  text only; it has not been compiled with the Finance and Operations compiler. Field-level data
  events and the other planned generators remain.
- `create_form_event_handler`: form (Initialized/PostRun/Closing/Closed), data source
  (Initialized/Activated/Written/Writing/Deleted/Deleting) and control (Clicked/Modified) handlers,
  grounded on the indexed form, data source and control names. The event lists are deliberately
  limited to ones I am confident exist; output is unit-tested as text and not compiled.

- `search_symbols` `explain` option (default off, output unchanged): each hit states whether it
  matched exactly, by name prefix, by name substring, or on another indexed token, and why that
  places it where it is. This restates the existing ordering (exact name, then full-text rank); it
  adds no type weighting, popularity or package tiering, so the C-track ranking work remains.

- Bench now includes labels. Synthetic, disk-backed, this machine: 20,000 objects / 100,000 label
  rows rebuild object FTS in 38 ms and label FTS in 97 ms; 100,000 objects / 500,000 label rows
  take 195 ms and 592 ms (about 1.2 microseconds per label row, roughly linear). A label full-text
  query is p95 0.73 ms at 100,000 rows. A full rebuild after a single label-file edit is therefore
  seconds, not minutes, at plausible sizes (extrapolated, not measured, for a multi-million-row
  install), so incremental FTS (A4) is lower priority than the plan assumed; measure on a real
  corpus before building it.

- `get_method_source`: returns one method's (or the class declaration's) X++ source from the
  stored element XML, case-insensitive, capped by `maxChars` with a truncation flag, and lists
  the available methods when the name is wrong. `traces.ts` already told callers to use this
  tool, which did not exist. It needs raw XML stored or readable source files; it does not
  index method bodies, so full-text search over source (B2) remains open.

- Query cancellation (A6) finding, Node 26.8.1: `node:sqlite` exposes no interrupt or progress
  handler (`DatabaseSync` has `function`, `aggregate`, `setAuthorizer`, `serialize`, ...; statements
  have no cancel). A running synchronous query therefore cannot be stopped in-process; the HTTP
  request timeout only replies 504. Real cancellation needs read queries moved to worker threads,
  each with its own read-only connection, that can be terminated on timeout. That is an
  architecture change to be built and load-tested with port binding available; it is not started.

- Worst-case synchronous scan cost, measured (synthetic, disk-backed, this machine, warm cache):
  a no-hit `LIKE '%q%'` over 3,000,000 label rows blocks the event loop for about 1.2 s; a no-hit
  `raw_xml LIKE` over 20,000 objects of about 25 KB each takes about 0.23 s. Given the A6 finding
  above and these bounds, moving every tool to terminable worker threads is a large rewrite of
  the tool layer (tools query the shared connection directly) for a bounded, second-scale stall,
  so it is deferred, not built. Revisit if a real corpus or concurrent load shows worse stalls;
  `search_labels` keeps its substring semantics (full-text matching is whole-token and would change
  results), so its description now states the scan cost and points to `search_labels_fts`.

- Container smoke test (CI `docker` job: build, empty-start behaviour, health, `mssql` omitted from
  the image) was not run: the Docker CLI is installed but its daemon socket
  (`~/.docker/run/docker.sock`) was not reachable from this sandbox, and `az bicep` could not
  initialise here. Both need to be run by the CI runner or by the user with Docker Desktop running.

Existing hosted snapshots remain read-only and are not migrated by the server. Rebuild and
republish a bundle to receive the new indexes. Older snapshots can answer the new queries using
their existing schema, but their case-insensitive lookups may be slower.

A targeted in-memory SQLite probe used 50,000 synthetic tables, 10 warmups, and 100 calls to
`getObjectHeader` for the last table with lowercase input. On this machine, p95 was 0.016 ms
with the new object index and 1.622 ms after dropping it. `EXPLAIN QUERY PLAN` confirmed a
name/type search with the index versus a type-only scan without it. This isolates one lookup;
it does not establish full-SDK, disk-backed, concurrent, or end-to-end tool latency.

## Remaining release evidence and work

| Requirement | What remains |
|---|---|
| Dependency security | `npm audit` ran on 2026-10-10 (approved by the user): 4 moderate, 0 high/critical, one chain: `sprintf-js` <=1.1.3 (GHSA-hp3w-g68c-fv3c, DoS via unbounded precision specifiers) via `tedious`, used by `mssql`/`@types/mssql`. npm reports no fix available, so nothing was changed. Remaining decision: whether the optional DynamicsXrefDB SQL path is acceptable with this advisory, or should pin/replace the driver. |
| Deployment | Run Linux/Windows Node 24 CI, container smoke tests, infrastructure checks, and staged hosted startup/rollback under the actual deployment identity. |
| Live integrations | Run the opt-in read-only DynamicsXrefDB contract against an authorized development database; validate generated X++ through the Finance Operations compiler. |
| Semantic guidance | Install the configured embedding model and run the three skipped semantic tests plus a representative relevance evaluation. Header validation alone is insufficient. |
| Performance | Build the A1 benchmark harness and representative corpus; measure full/incremental indexing, label updates, tool latency percentiles, concurrency, and bundle size. A targeted 50,000-object lookup probe is not the full benchmark. |
| Resource limits | Implement and verify A4/A5/A6/A7 incremental FTS, indexer throughput, query cancellation/workers, and bounded tool responses. |
| Metadata and source coverage | Complete B1/B2 extension/view/map/security-policy coverage and method-source indexing, including deployment bundle/capability evidence. |
| Features and intelligence | Complete the remaining generators, impact analysis/index diff, tool schemas/descriptions, explainable ranking, grounded hotspot fixes, privilege recommendations, and gated semantic object search in Tracks B/C. |

Next implementation priority: A1 measurement, then the remaining Phase 8 read-path,
response-budget, incremental-FTS, and tool-description work. Full-SDK performance targets and
feature coverage must be proven before declaring their roadmap phases complete.

## Reproduce the local gates

```bash
npm ci
npm run check

# Focused protocol/deployment regression run, including its build:
npm run test:e2e
```

The HTTP tests need permission to bind local sockets. The test suite's write-enabled cases use
isolated temporary fixture workspaces; the server's normal write-tools setting remains disabled.
