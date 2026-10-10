# Plan: performance, features and intelligence (Phases 8–13)

Status: implementation started, October 2026. Continues [roadmap.md](roadmap.md), whose Phases 1–7 are shipped.
Every finding below was checked against the code at the referenced line; line numbers are as of
commit `33ff457`.

Execution evidence and remaining production gates: [production-readiness.md](production-readiness.md).
The C1.1 casing fixes, shared object-row lookup, and corresponding case-insensitive query indexes
are implemented, including security traversal and read-only snapshot regressions. A2 remains
partial; the benchmark, other optimizations, and subsequent feature phases remain open. The
baseline below records the original assessment and is not a claim that all findings still apply.

## 0. Baseline (what the code does today)

Performance

- One `node:sqlite` connection is shared by every session and every query is synchronous, so each
  query blocks the event loop (`src/server/start.ts:57-69`, `:89-90`). The request timeout only
  sends a 504; it cannot cancel a running query (`src/server/httpTransport.ts:226-245`).
- Pragmas are `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON` only
  (`src/indexer/db.ts:49-54`). `mmap_size`, `cache_size`, `temp_store` and `busy_timeout` are never
  set.
- The indexer is single-threaded: one `for await` loop, one full-file read, one full-tree
  `fast-xml-parser` parse and one `BEGIN/COMMIT` per file (`src/indexer/buildIndex.ts:140-215`).
  `glob()` materialises the whole file list before yielding (`src/indexer/scanner.ts:15-18`).
- Both FTS5 tables are external-content with no sync triggers and are rebuilt in full whenever
  anything changed (`db.ts:865-875`, `buildIndex.ts:452-458`). One edited label file therefore
  rebuilds the label FTS for every language.
- Read-path statements are re-prepared on every call; `getObjectByName` runs 7–8 statements and
  loads fields, methods and controls even when the caller only needs existence
  (`db.ts:1141-1178`).
- Full scans: `search_labels` is `LIKE '%q%'` over `ax_labels` (`src/tools/labels.ts:27-35`);
  `search_symbols` and `search_labels_fts` fall back to `LIKE` on zero FTS hits (`db.ts:1054-1095`,
  `:953-995`); `find_field_access` runs `raw_xml LIKE` over every code-bearing object
  (`src/tools/codeQuality.ts:144-146`); `COLLATE NOCASE` comparisons bypass the binary indexes
  (`codeQuality.ts:151`, `traces.ts:70,101`, `db.ts:1144`); `publicNameOwners` uses
  `lower(value)=lower(?)` (`src/tools/entities.ts:74-85`). Missing indexes: `ax_objects(package)`,
  `(model)`, `(file_path)`, `ax_properties(key,value)`.
- N+1 walks in the security model: `expandRole` calls `getObjectByName` per role and per duty;
  `findSecurityPaths` walks `parentRoles` one query per node (`src/security/model.ts:102-122`,
  `:158-171`, `:210-237`).
- Results are capped by row count only; `get_element_xml`, `get_table_schema`,
  `get_form_datasources` and `get_data_entity_details` are unbounded and everything is
  pretty-printed. `list_objects` paginates with `OFFSET` and no `ORDER BY` (`db.ts:1239-1256`).
- The knowledge filter wraps every tool result with `JSON.parse` and a pretty `JSON.stringify`
  (`src/knowledge/filter.ts:206,295`). Despite the comment at `src/knowledge/toolWrapper.ts:10`,
  generators are inside the wrapper (`start.ts:111-121`).
- No benchmarks, no timing harness, no large test corpus (fixtures total about 60 KB).

Features and intelligence

- 54 tools, one resource template (`d365kb://{slug}`), one prompt. No tool annotations
  (`readOnlyHint` etc.), no `outputSchema`, no sampling, no elicitation.
- Name resolution is exact, then `COLLATE NOCASE`; there is no fuzzy or "did you mean" path
  (`db.ts:1141-1145`). Casing is inconsistent: `get_table_schema`/`get_class_hierarchy` pass the
  caller's casing to the case-sensitive `getXrefsTo` (`src/tools/metadata.ts:75,87`);
  `get_method_signature` matches the method case-sensitively (`:99`); `find_usages` and
  `getSecurityGrants` are exact-only (`src/indexer/xrefUsage.ts:267`, `db.ts:1202`).
- Ranking: exact name first, then FTS rank. No type weighting, no popularity, no package tiering.
- Method bodies are not indexed. `ax_methods` holds name, modifiers, return type and params
  (`db.ts:82-91`). Source-level tools read `raw_xml` on demand.
- Not indexed (`src/indexer/capabilityCoverage.ts:30-104`): views, maps, all `*Extension` types
  except roles/duties, workflows, services, aggregate measures/KPIs, SSRS reports, menus, tiles,
  resources, table/field grants, code permissions, security policies, macros. Form and entity
  methods are not stored as methods. Because table extensions are not indexed,
  `create_table_extension` cannot see fields added by other extensions
  (`src/tools/generators.ts:112-122`).
- No generators for event handlers, form extensions, entity extensions, EDT/enum extensions, menu
  items or duties. `traces.ts:185` tells the model to call `get_method_source`, which does not
  exist.
- Most metadata tool descriptions are one or two words ("Full table details"). Only 1 of 26
  knowledge topics uses `filter`/`rank` headers.
- Eight tools have no test that names them: `get_class_hierarchy`, `get_method_signature`,
  `get_enum_values`, `get_edt_details`, `get_form_datasources`, `get_query_datasources`,
  `get_data_entity_details`, `get_usage_snapshot_status`.

---

## Track A — Performance

### A1. Measure first: benchmark harness (prerequisite for everything else)

- `scripts/bench/` with a synthetic corpus generator that scales the existing fixtures to N objects
  and M labels (targets: 50k objects / 2M labels locally, full SDK in CI nightly on the Azure
  acquisition runner).
- `npm run bench` reports: full index build, incremental no-op run, one-label-file change, and
  p50/p95 of the 12 most-called tools (`search_symbols`, `get_table_schema`, `search_labels`,
  `find_security_path`, `get_security_object flatten`, `check_entity_odata_readiness`,
  `find_field_access`, `find_usages`, `search_release_plans`, `get_task_guidance`,
  `list_objects`, `get_index_stats`).
- Emit JSON; store per-commit results as a CI artifact and fail the job on >25% regression against
  `master`.

### A2. Cheap wins on the read path

1. Pragmas on open (both `openDb` and `openDbReadOnly`): `mmap_size=1GiB` (or file size), 
   `cache_size=-262144` (256 MiB), `temp_store=MEMORY`, `busy_timeout=5000`. Make them env-tunable
   via `D365_SQLITE_MMAP_MB` and `D365_SQLITE_CACHE_MB`.
2. Prepared-statement cache: a `Map<string, StatementSync>` per connection inside `db.ts`, used by
   every read helper. Removes the per-call `prepare` cost everywhere at once.
3. New indexes (additive migration, also applied in `indexSnapshot.ts`):
   `ax_objects(package)`, `ax_objects(model)`, `ax_objects(file_path)`,
   `ax_objects(name COLLATE NOCASE, type)`, `ax_properties(key, value COLLATE NOCASE)`,
   `ax_usage_refs(target_name COLLATE NOCASE)`, `ax_security_grants(target_name COLLATE NOCASE,
   target_type)`, trace frame and SQL text columns used by `traces.ts:70,101`.
   Then rewrite the `lower()`/`COLLATE NOCASE` predicates so they hit those indexes.
4. `getObjectHeader(db, name, type)` returning only the `ax_objects` row, and `objectExists`.
   Use them in `security/model.ts`, `entities.ts:40-56` (`tableFields` extends chain),
   `validation/grounding.ts`, and `tools/security.ts` filter loops. Keep `getObjectByName` for
   callers that need children.
5. Batch the security walk: `expandRole` and `findSecurityPaths` should load all sub-role, duty
   and privilege edges for a set of names in one `IN (...)` query per level instead of one per
   node. Precompute `ax_security_closure(role, duty, privilege, via)` at index time as an option
   (A5).
6. `get_index_stats`: write counts to `ax_meta` at the end of each index run; the tool reads them
   instead of running `COUNT(*)` over labels on every call.
7. `list_objects`: add `ORDER BY type, name` and keyset pagination (`after` cursor) alongside the
   existing `offset` for compatibility.

Target: p95 of every metadata and security tool under 50 ms on the full SDK; `find_security_path`
on a form with 30+ privileges from >2 s to <200 ms.

### A3. Substring search without full scans (trigram FTS)

- Add `ax_labels_tri` and `ax_names_tri` FTS5 tables with `tokenize='trigram'` over
  `ax_labels.value` and `ax_objects.name` (external content, same rowids). SQLite ≥3.34 is required;
  Node 24's bundled SQLite satisfies it, and `doctor` should assert the version.
- Route `search_labels`, the `LIKE` fallbacks in `search_symbols`/`search_labels_fts`, and the
  `name LIKE` loops in `releasePlans.ts:216,249` through the trigram tables. Keep `LIKE` only for
  queries shorter than three characters.
- Bundle size will grow (trigram over tens of millions of labels is large). Mitigate by indexing
  labels for `en-US` plus the languages listed in a new `D365_INDEX_SEARCH_LANGUAGES`, defaulting to
  `en-US`; other languages keep exact-id resolution only.

Target: `search_labels` from seconds to <100 ms; zero-hit `search_symbols` no longer pays a full
scan.

### A4. Incremental FTS maintenance

- Replace the full `'rebuild'` with per-row maintenance. Since upserts are per file, the writer
  knows the affected rowids: issue the FTS5 external-content `'delete'` command for replaced rows
  and insert the new ones inside the same transaction. Keep `'rebuild'` for `--force` and for the
  schema-upgrade path. Keep `fts_pending` for crash recovery.
- Apply the same to the trigram tables in A3.

Target: a one-label-file change reindexes in seconds, not a full-FTS-rebuild time.

### A5. Indexer throughput

1. Stream the scan: use `glob`'s async iterator so parsing starts before the walk ends; build the
   folder-to-type map once (`scanner.ts:36-53`).
2. Group commits: one transaction per batch of ~500 files or ~64 MB of XML, with a `SAVEPOINT` per
   file so a failed parse still does not poison that file's mtime (keeps the guarantee documented
   at `buildIndex.ts:205-207`).
3. Parse in a `worker_threads` pool (size `os.availableParallelism() - 1`, env-tunable). Workers
   read + parse and post back the structured rows; the main thread stays the single SQLite writer.
   Pass `raw_xml` as a transferable `Uint8Array` to avoid copying.
4. Change detection stays mtime-based but also records `size`; a size change with an unchanged
   mtime (rare, but seen on some sync tools) triggers a re-parse.
5. Optional precompute of `ax_security_closure` (A2.5) and object rank (C2) as a final pass.

Target: full-SDK build 3–5× faster on an 8-core runner; incremental no-op run bounded by the stat
walk alone.

### A6. Keep the event loop responsive

- Move query execution to a small worker pool (default 2 workers, each with its own read-only
  connection; hosted mode is read-only already, local mode opens a second read-only handle on the
  WAL file). Tool handlers `await` a message-passed result. Benefits: concurrent sessions no longer
  stall each other, and the request timeout can actually terminate a runaway worker and recreate
  it, fixing the limitation noted at `httpTransport.ts:227-230`.
- Gate behind `D365_QUERY_WORKERS` (0 keeps today's in-thread behaviour) so hosted operators can
  adopt it gradually.

### A7. Response budget and wrapper cost

- A per-tool byte budget (`D365_MAX_RESULT_BYTES`, default 256 KiB) applied centrally in the tool
  wrapper: truncate arrays with a `truncated: {shown, total, next}` marker rather than a hard
  failure. `get_element_xml` gets `maxBytes` and `offset` inputs; `get_table_schema` and friends get
  `include` projections (`fields`, `indexes`, `methods`, `relations`).
- Tools return objects; the wrapper serialises once (compact JSON by default, pretty only when
  `D365_PRETTY_JSON=1`). Removes the parse/stringify round-trip in `filter.ts`.
- Fix the `toolWrapper.ts:10` comment, or move generators out of the filter if that was the
  intent; decide explicitly.

---

## Track B — Feature additions

### B1. Index coverage (unblocks several items below)

Priority order, each with a `capabilityCoverage.ts` entry flipped to `complete`:

1. `AxTableExtension`, `AxFormExtension`, `AxDataEntityViewExtension`, `AxEdtExtension`,
   `AxEnumExtension`, `AxQueryExtension`, `AxMenuItem*Extension`, with an `extends_object` column
   so "what extends X" is one query. Fixes the `create_table_extension` collision gap.
2. `AxView`, `AxMap` (fields, datasources, mappings) so schema tools and entities see them.
3. `AxSecurityPolicy` (XDS) and table/field grants inside privileges, completing the security model.
4. Form and entity methods stored as `ax_methods` rows (today only tables/classes).
5. `AxService`/`AxServiceGroup`, `AxWorkflow*`, `AxReport`, `AxMenu`, `AxTile`,
   `AxAggregateMeasurement`, `AxKpi`, `AxMacroDictionary`, `AxResource`.

### B2. Method source index (schema change, enables B3 and C4)

- New table `ax_method_source(method_id, source TEXT, line_offset INTEGER)` written only when
  `D365_INDEX_STORE_RAW_XML=1` is off or on request (`D365_INDEX_STORE_METHOD_SOURCE=1`,
  default on; it is far smaller than `raw_xml`). Covers tables, classes, forms, entities, queries.
- Trigram FTS `ax_source_tri` over it.
- `get_method_source(object, method)` tool, which fixes the dangling reference at `traces.ts:185`.
- `search_code(pattern, types?, packages?, limit)` tool: literal or regex over the source index,
  grounded results `{object, method, line, excerpt}`.
- Rewrite `find_field_access` and `check_xpp_best_practices` to read method source rows instead of
  scanning `raw_xml`.

### B3. Generators

1. `create_event_handler`: `[DataEventHandler]`, `[FormEventHandler]`, `[FormDataSourceEventHandler]`,
   `[FormControlEventHandler]`, `[SubscribesTo]` and `[PreHandlerFor]/[PostHandlerFor]`, grounded
   against indexed forms, datasources, controls and delegates; emits the correct `XppPrePostArgs`
   / `FormRun` / `FormDataSource` signatures.
2. `create_form_extension`: add control, datasource field, or event handler stub to an indexed form;
   grounded against `ax_form_controls` and datasources.
3. `create_entity_extension`, `create_edt_extension`, `create_enum_extension`.
4. `create_menu_item` (display/action/output) plus optional privilege and duty, reusing
   `create_security_privilege`.
5. `create_runbase_batch` and `create_sys_operation` become grounded: accept a `table` or
   `query` to drive the contract fields and validate EDTs.

### B4. Analysis tools

1. `analyze_change_impact(object, type)`: one call combining structural references, XRef usages,
   extensions of the object (B1), security paths, entities exposing it, release-plan hits, and BP
   findings, with the response-sizing rule from the roadmap guardrails.
2. `diff_index(baselineBundle)`: compare the active snapshot with a previous artifact bundle
   (hosted) or a second DB path (local): objects added/removed, fields/methods/properties changed.
   Pairs with the SDK version warning and `check_feature_impact` for upgrade work.
3. `get_model_dependencies(model)` from `Descriptor/*.xml` `ModuleReferences`, and
   `check_generated_dependencies(xml)` that tells a user which model references a generated
   artifact needs.
4. `get_security_closure(role)` returning the flattened graph as edges, for clients that want to
   render it.

### B5. MCP protocol surface

1. Tool annotations on all tools: `readOnlyHint: true` everywhere except the two writers, which get
   `destructiveHint: false, idempotentHint: true` (preview/apply). Clients use these for
   auto-approval, so this is a UX win at no cost.
2. `outputSchema` (zod) for the 20 most-used tools; structured content alongside text.
3. Resources: `d365aot://{type}/{name}` serving element XML, and `d365aot://{type}/{name}/source`
   for method source (B2), with completion over the index.
4. Prompts for the four agent workflows (performance review, security review, release planning,
   extension design) so clients without custom-agent support get them.
5. Elicitation (capability-gated): when the client supports it, `apply_table_extension_change`
   asks for confirmation instead of requiring `acknowledgeOfflineProject`; otherwise unchanged.

### B6. Tests

- Add tests for the eight untested tools and a golden-file test per generator.
- Add a medium fixture corpus (a few thousand objects) generated by the bench tool so query tests
  exercise indexes and not just correctness.

---

## Track C — Intelligence

### C1. Resolution and grounding hygiene

1. Fix the casing bugs: pass `obj.name` to `getXrefsTo` (`metadata.ts:75,87`), match method names
   `NOCASE` in `get_method_signature`, and make `find_usages`, `getSecurityGrants` and
   `findCodeObject` case-insensitive via the new indexes.
2. "Did you mean": on a miss, query the trigram name index and rank by Damerau-Levenshtein within
   the same type, return up to five `suggestions`. Generators still fail closed; suggestions are
   advisory only and never substituted.
3. `validateCoCTarget`: check interfaces as `Interface` once B1 adds them; treat `final` as a hard
   error for CoC on classes (it is today a note at `grounding.ts:215`).
4. Collision checks for `create_table_extension` include fields from indexed extensions (B1).

### C2. Ranking v1 (deterministic, explainable)

Add a `score` and `why` to `search_symbols` rows:

- exact name > prefix > FTS rank > trigram substring;
- type weight for untyped queries: Table, Class, DataEntity, Form, Enum, EDT above MenuItem,
  Privilege, Duty, Role, extensions;
- package tier: customer packages (those not in a Microsoft allowlist derived from the index)
  first, then ApplicationSuite, then Foundation/Platform;
- popularity: inbound `ax_xref` + `ax_usage_refs` counts precomputed into `ax_object_rank` at the
  end of the index/import runs (A5.5).

Expose the weights in one place so the knowledge filter's `rank.prefer` remains the override.

### C3. Tool descriptions and knowledge headers

- Rewrite every tool description to the pattern "what it returns / when to use / when not to /
  what to call first". Models pick tools from these strings; two-word descriptions are the biggest
  single intelligence loss in the server today.
- Add `rank`/`filter` headers to the topics that imply ordering (security, entities, batch, forms,
  AOT layout). Run `knowledge-check` in CI.
- Server instructions: list the three entry-point tools (`get_task_guidance`, `search_symbols`,
  `analyze_change_impact`) and the response-sizing convention.

### C4. Grounded fix suggestions for trace hotspots

Roadmap Phase 3 item 3 ("suggest fixes grounded in the actual code") was never implemented.
With B2 in place:

- `suggest_hotspot_fix(sessionId, method)`: joins the hotspot to its source and table metadata and
  applies deterministic rules: `while select` inside a loop → set-based or `exists join`;
  statement `WHERE` columns not covered by any index → list candidate indexes from
  `get_table_schema`; repeated point reads on a `Main`/`Group` table with cache lookup `None` →
  recommend `Found`; `insert` in loop → `RecordInsertList`; missing `firstonly`.
- Each suggestion cites the source line and the index or property it inspected; nothing is
  generated that the code does not support.

### C5. Security intelligence

- `recommend_privileges(entryPoints[])`: greedy set cover over existing privileges and duties that
  grant the requested entry points, preferring Microsoft-shipped ones, returning the minimal set and
  what each adds beyond the request.
- `find_overprivileged_roles(role, requiredEntryPoints[])`: entry points a role grants beyond the
  list.
- SoD rule library as a knowledge topic plus a `rulesets` input preset for
  `analyze_sod_conflicts` (standard finance pairs).

### C6. Semantic object search (experimental, gated)

- `search_by_meaning(query, types?, packages?)`: embed object name + resolved `en-US` label +
  `Description`/`DeveloperDocumentation` properties with the existing MiniLM model at index time
  into `ax_object_embeddings` (int8-quantised 384-dim blobs). Scope to Table, Class, DataEntity,
  Form, Enum, EDT, Menu items, and only packages the operator lists (default: customer packages +
  ApplicationSuite), to keep the brute-force scan under ~200k vectors.
- Pre-filter by type/package in SQL, then cosine in JS over the candidate blobs; no native vector
  extension.
- Gated behind the model being present (same as the knowledge filter) and
  `D365_INDEX_EMBEDDINGS=1`. Results are grounded: every row is an indexed object, and the tool
  reports `score`.

---

## Sequencing

| Phase | Scope | Depends on | Exit criteria |
|---|---|---|---|
| 8 | A1, A2, A4, A7, C1.1, C3 | — | Bench harness in CI; p95 targets met; descriptions rewritten; casing bugs fixed |
| 9 | A3, C1.2, C2, B5.1–B5.2, B6 | 8 | Trigram search live; `score`/`why` on search; annotations + output schemas; untested tools covered |
| 10 | B1.1–B1.4, B2, B3.1–B3.2, C1.3–C1.4 | 8 | Extensions, views, maps, policies indexed; method source + `search_code` + `get_method_source`; event-handler and form-extension generators |
| 11 | A5, A6 | 8 | Parallel indexer; query workers; cancellable timeouts |
| 12 | B4, C4, C5, B3.3–B3.5, B5.3–B5.5 | 10 | Impact analysis, index diff, hotspot fixes, least-privilege; remaining generators; resources, prompts, elicitation |
| 13 | C6, B1.5 | 10, 11 | Semantic search behind a flag; remaining AOT types |

Phases 8 and 9 are small and should ship first; they change no schema beyond additive indexes and
make everything after them measurable.

## Guardrails that stay

- Read-only by default, no live D365 calls, writes only via preview + apply.
- Every name in every result comes from the index; suggestions are labelled as suggestions.
- Schema changes are additive migrations; `index` without `--force` keeps working on an old DB and
  `index-status` reports what capabilities the file lacks.
- Response sizing: ≤100 rows show all, otherwise top 20 + totals, now enforced centrally (A7).
- Hosted bundles: any new table must be covered by `indexSnapshot.ts` and the capability manifest.

## Risks

- Trigram and method-source tables grow the bundle; the language and package scoping above are the
  mitigation, and A1 must report bundle size.
- `worker_threads` + `node:sqlite` on Node 24/26 needs a soak test on the App Service image before
  A6 defaults on.
- Ranking changes alter result order for existing users; ship `score`/`why` first with the old
  order, then flip the default one release later.
- Semantic search quality on PascalCase names is unproven; keep it experimental until the bench
  includes a relevance set.
