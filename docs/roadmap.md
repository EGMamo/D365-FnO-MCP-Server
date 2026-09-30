# D365-FnO-MCP-Server — Expansion Plan (sourced from Microsoft FastTrack Implementation Assets)

Source: https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets (MIT, sample code).
Status: Phases 1–7 shipped. The awesome-msdyn365fo submission is a manual step for the maintainer.

## Baseline before Phase 1 (historical)
- Indexed 7 AOT types: Table, Class, Enum, Form, Query, DataEntity, EDT (+ label files).
- 32 tools: metadata/navigation, labels, XRef usages, grounded generators (CoC, table/class ext, RunBase, SysOperation), guarded table-extension writer, knowledge digest.
- Missing then: security objects (Role/Duty/Privilege), menu items, extensions (`Ax*Extension`), runtime/perf data, release/deprecation awareness, OData/Copilot-facing generators.

Today the server indexes 15 AOT folders plus label files (`src/indexer/scanner.ts`) and registers 54 tools; see the README's tool list.

## Design guardrails (keep)
- Local, grounded, read-only by default; writes only via preview + apply.
- External data imported into the SQLite snapshot with provenance (follow the `index-xref` pattern in `src/indexer/xrefSql.ts`) — no live D365/OData calls from the core server.
- Response sizing: ≤100 rows show all, otherwise top 20 + totals (convention from the Compliance Advisor agent).

---

## Phase 1 — Security model intelligence (highest value, fully offline) — ✅ done (generators moved to Phase 2)
Inspired by: ERP Compliance Advisor Agent, User Onboarding Agent (`D365FORoleMap.csv`, 6.4k role→duty rows).
1. Index `AxSecurityRole`, `AxSecurityDuty`, `AxSecurityPrivilege`, `AxMenuItemDisplay/Action/Output` (+ their `*Extension` folders).
2. Tools:
   - `get_security_object` → role/duty/privilege: duties, privileges, sub-roles (optionally flattened).
   - `find_security_path` → which roles/duties/privileges grant access to a menu item/form/table/entity (Role → Duty → Privilege → EntryPoint).
   - `analyze_sod_conflicts` → given a rule set (JSON pairs of duties) report roles that combine conflicting duties.
   - `diff_roles` → compare two roles' effective privileges.
3. Generator: `create_security_privilege` / `create_security_duty` for a new menu item or data entity (grounded against the index).
4. Knowledge topic: security model + SoD basics.

## Phase 2 — Data entity / OData generators for Copilot & AI agents — ✅ done
Implemented: `check_entity_odata_readiness`, `create_data_entity`, `create_security_privilege`, `create_readonly_role_for_entities`, `create_odata_action`; knowledge topic 21. Staging table generation is left to the Visual Studio wizard (entities are emitted with `DataManagementEnabled = No`). `create_security_duty` was folded into `create_readonly_role_for_entities`.

Inspired by: Compliance Advisor's 10 custom `AuditAgent*` entities, Payment Recon `PRARetailPaymentReconEntity`, Inventory Fulfillment / Sales Order agents using OData + virtual tables + official F&O MCP server.
1. `create_data_entity` generator (grounded: table fields, keys, `PublicEntityName`/`PublicCollectionName`, `IsPublic`, staging table optional, read-only flag).
2. `create_readonly_role_for_entities` → emits `AuditAgentReader`-style role + privilege XML granting Read on a list of entities.
3. `check_entity_odata_readiness` → validates `IsPublic`, public names, keys, unsupported field types, virtual-entity eligibility.
4. `create_odata_action` / custom service generator for agent-callable actions (SysOperation already exists — extend).
5. Knowledge topic: "exposing F&O to Copilot Studio agents" (OData connector, virtual tables, official F&O MCP server + Allowed MCP Clients).

## Phase 3 — Performance trace analysis (Trace Parser) — ✅ done
Inspired by: Trace Parser Agent (TraceParserMCP views `vw_NPlusOnePatterns` [>100 calls, <5 ms avg], `vw_SlowSqlStatements` [>5 s], `vw_TopMethodsBySession`, keyword search SPs).
1. `index-trace` CLI: import an `AxTrace` SQL DB (or a Trace Parser export) into the snapshot, same staging/provenance flow as `index-xref`.
2. Tools: `list_trace_sessions`, `find_n_plus_one`, `find_slow_sql`, `get_top_methods`, `search_trace`.
3. Differentiator vs FastTrack: join trace methods/tables back to AOT metadata → return the X++ method source location, table indexes (`get_table_schema`), and suggest fixes (set-based ops, `exists join`, caching, missing index) grounded in the actual code.
4. Knowledge topic: performance anti-patterns (N+1, row-by-row, missing index, cache lookup).

## Phase 4 — Release / deprecation awareness — ✅ done
Inspired by: Release Planner Helper MCP (TS + Zod, 1h cache, `search_release_plans`, `get_release_wave_summary`, `list_products`).
1. Optional `release-plans` module (off by default; only network feature) or offline snapshot import of `releaseplans.microsoft.com` data.
2. Tools: `search_release_plans` scoped to Finance/SCM/Commerce; `check_feature_impact` → map a release feature/deprecation keyword to indexed objects/usages in the customer's models.

Shipped: `index-release-plans` (CLI import, the only network feature, with full paging; the FastTrack sample reads only the first 100 of ~1,250 features), `search_release_plans` and `check_feature_impact`. The tools read the local copy, so there is no cache or live call. `get_release_wave_summary` and `list_products` are covered by the product/wave filters. The Learn "removed or deprecated features" list is not imported. Release plans stop after September 2026 (moving to the Microsoft AI at Work roadmap).

## Phase 5 — Operational telemetry helpers (generators, not live queries) — ✅ done
Inspired by: Batch Framework Telemetry Agent (App Insights, 10.0.45+), Store Monitoring Agent (KQL library over Log Analytics), FastTrack MonitoringAndTelemetry / BatchTracing folders.
1. `generate_kql_query` for batch telemetry scenarios (failures, throttling, thread usage, long-running jobs) and Commerce POS/RetailServer health — template library, grounded with batch class names from the index.
2. `analyze_batch_class` → for a class: RunBase vs SysOperation, `canRunInNewSession`, retry (`BatchRetryable`), idempotency hints.
3. Knowledge topics: batch framework best practices, telemetry setup, SQL maintenance (from FastTrack Administration).

Shipped: `generate_kql_query` (15 scenarios across Application Insights and Log Analytics), `analyze_batch_class` and knowledge topic `23-batch-and-telemetry`. SQL maintenance guidance is deferred, and form-run telemetry is left out because its event names are not verified.

## Phase 6 — Packaging & integration — ✅ done
- Local agents (GitHub Copilot custom agents and Claude Code subagents) that use this server over stdio — mirrors Trace Parser's "dual MCP" (domain MCP + Microsoft Learn MCP).
- Add a Responsible-AI / security FAQ section (pattern from Compliance Advisor).
- Ship agent instructions ("X++ dev assistant" and reviewers) that combine this server + Microsoft Learn MCP.

Shipped as local agents instead of Copilot Studio: four agents (`xpp-developer`, `performance-reviewer`, `security-reviewer`, `release-planner`) in [`agents/`](../agents) as GitHub Copilot custom agents and Claude Code subagents, generated from one source by `npm run build:agents`, each pairing this server (`d365-fno`) with Microsoft Learn MCP; setup in [local-agents.md](local-agents.md). Plus [responsible-ai-faq.md](responsible-ai-faq.md). `.gemini/rules.md` was brought up to date with the current tools.

## Phase 7 — Code quality & community tooling (sourced from GitHub community projects) — ✅ done
Sources: [microsoft/Dynamics365FO-AppChecker](https://github.com/microsoft/Dynamics365FO-AppChecker) (MIT), [d365collaborative/d365fo.tools](https://github.com/d365collaborative/d365fo.tools) (MIT), [TrudAX/TRUDUtilsD365](https://github.com/TrudAX/TRUDUtilsD365) (MIT), [ameyer505/D365FOSecurityConverter](https://github.com/ameyer505/D365FOSecurityConverter) (MIT), [microsoft/mcp](https://github.com/microsoft/mcp) (MIT), [mafzaal/d365fo-client](https://github.com/mafzaal/d365fo-client) (MIT, comparison only).
1. `check_xpp_best_practices` — static X++ checks on indexed objects or pasted source, modelled on AppChecker's official `rules/X++` catalog: unbalanced tts, breakpoints, direct SQL, insert/update/delete in loops, nested `while select`, `select forUpdate` without a write, `delete()` in a loop instead of `delete_from`, CoC methods without `next`, empty `catch`, boolean literal comparisons, TODO comments, missing documentation. Uses a small comment/string-aware X++ scanner (no X++ tree-sitter/LSP exists to reuse).
2. `find_field_access` — read vs write classification of a table field across indexed code, using TRUDUtils' "Show cross-reference" heuristic (`buffer.Field = …`, `+=`, `setField(fieldNum(…))`, `update_recordset … setting`), narrowed by the XRef snapshot when imported.
3. `index-bp` + `get_bp_findings` — import `xppbp.exe -xmlLog` output (as produced by d365fo.tools `Invoke-D365BestPractice` / `New-D365CAReport`) into the index with provenance, then query findings by object, rule or severity.
4. `convert_security_customizations` — split a Security configuration UI export (`SecurityDatabaseCustomizations.xml`) into AOT `AxSecurityRole/Duty/Privilege` files with optional prefix/rename, dependency closure, and validation against the indexed security model (D365FOSecurityConverter logic, read-only: returns files, writes nothing).
5. Discoverability: `llms-install.md` and `glama.json` (microsoft/mcp conventions); submit to [awesome-msdyn365fo](https://github.com/anderson-joyle/awesome-msdyn365fo) (manual step for the maintainer).
6. Wire the new tools into the local agents (`xpp-developer`, `performance-reviewer`, `security-reviewer`) and docs.

Deferred / not planned:
- Live OData/DMF tools like d365fo-client — conflicts with the "no live D365 calls from the core server" guardrail; pair this server with d365fo-client instead if live data is needed.
- A full X++ grammar / language server (tree-sitter) — large effort; revisit if the scanner's heuristics are not enough.
- CAR `.xlsx` import — `index-bp` reads the same diagnostics from the xppbp XML log without an Excel dependency.

Shipped as `src/xpp/` (scanner, rules, field access), `src/indexer/bpFindings.ts`, `src/security/converter.ts` and `src/tools/codeQuality.ts`, plus the `index-bp` command, `llms-install.md` and `glama.json`. The three agents were updated. Still manual: submitting the server to awesome-msdyn365fo.

---

## FastTrack AI ERP agents — asset catalog

| Agent | What it does | Tech / artifacts | Reuse value for you |
|---|---|---|---|
| **ERP Compliance Advisor** (v1.0.1.0) | NL audit Q&A: user access reviews, SoD, SOX, license vs role, login logs; 19 read-only tools | Copilot Studio; `SA_ERPComplianceAdvisorAgent.axpp` (10 `AuditAgent*` entities + `AuditAgentReader` role) + 9 std entities via OData | ★★★ Template for Phase 1–2; entity XML is a reference for generators; response-sizing rules; RAI FAQ |
| **User Onboarding** | Email → Azure OpenAI extraction → Teams approval → Entra user + F&O roles via OData | Power Automate, Azure OpenAI, `RolesDuties/D365FORoleMap.csv` | ★★ Role/duty CSV as test fixture & knowledge; pattern for role recommendation |
| **Sales Order Processor** | PDF/image order emails → AI Builder extraction → validate customer/product → create SO; manual-review states | Dataverse staging tables, agent flows, virtual tables (Released products V2, Customers V3), PCF PDF viewer | ★★ Reference for "exposing entities to agents" docs; staging/status-machine pattern |
| **Inventory Fulfillment** | Product search, on-hand, ATP, reserve/unreserve; creates transfer/sales orders | Inventory Visibility Service + child agents using **official F&O MCP server** | ★★ Shows how official F&O MCP coexists; position your server as the dev/metadata MCP next to it |
| **Payment Recon** (Commerce) | Reconciles Adyen payments vs D365 Commerce transactions | `PaymentRecon_TransexportRecon.axpp` (`PRARetailPaymentReconEntity`), Azure SQL, ADF, Key Vault, PP solution | ★ X++ export entity sample; test-corpus for indexing custom models |
| **Batch Framework Telemetry** | Batch failures, throttling, threads, priority distribution via KQL | App Insights (F&O 10.0.45+), Copilot Studio, Teams/Outlook | ★★ KQL templates for Phase 5 |
| **Store Monitoring (Commerce)** | POS device availability, errors, perf, offline DB health, alert investigation | Azure Arc + AMA, DCR, Log Analytics KQL library, Bicep alerts, Windows services | ★ KQL library + "no auto-mitigation / AI disclosure" design rules |

### Implementation agents (closest to your server)
| Agent | What it does | Reuse value |
|---|---|---|
| **Trace Parser Agent** | N+1, slow SQL, blocking, exceptions from F&O traces; 6–8 h → 5–10 min | ★★★ Views/SP logic to port into Phase 3; you can beat it by linking to AOT source |
| **Release Planner Helper** | TS MCP over public release plans; creates ADO/Jira items | ★★ Same stack as yours (TS, Zod, stdio+HTTP); Phase 4 |

### Caveats
- All are sample/reference code, not supported products; Copilot Studio agents need credits.
- MIT license allows reuse with attribution; keep notices when copying SQL/KQL/CSV.
