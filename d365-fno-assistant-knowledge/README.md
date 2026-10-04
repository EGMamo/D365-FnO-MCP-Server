# D365 F&O Developer Assistant — Knowledge Base

Generic, project-agnostic knowledge for an MCP serving Dynamics 365 Finance & Operations (X++/AOT)
developers. Every fact here was distilled from real customization work, then stripped of company,
model, and integration-partner names — nothing in this folder should identify the source project.

This folder is self-contained on purpose: it has no dependency on the rest of this repository, so
it can be copied into its own repo/package whenever that decision is made (not yet finalized).

## Placeholders used throughout

| Placeholder | Meaning | Example |
|---|---|---|
| `<Prefix>` | Your model's object prefix | `Zel`, `Con`, `Fab` |
| `<Model>` | Your model/package name | `MyCompany-Core` |
| `<LabelFile>` | Your label file id | `MyCoreLabels` |

## Resources

Each file is meant to be one MCP resource — small enough to fetch on its own when a query only
concerns one topic.

| File | Topic |
|---|---|
| `resources/01-aot-source-layout.md` | Where real AOT source lives vs. build-output mirrors; VS designer rewrite behavior |
| `resources/02-chain-of-command.md` | `[ExtensionOf]` selector-by-target-type — the #1 CoC gotcha |
| `resources/03-data-entities.md` | Mapped/unmapped fields, `postLoad`, company scoping, DMF export quirks, staging parity |
| `resources/04-tables-and-fields.md` | Field type patterns, EDT inheritance, FK lookup pattern, mandatory BP properties |
| `resources/05-field-groups-and-forms.md` | Naming conventions, `DataGroup` gotcha, preserving `[Form]` |
| `resources/06-lookups-and-filtering.md` | `SysTableLookup`, hiding disabled values, dependent/cascading filters |
| `resources/07-label-files.md` | Label storage/reference pattern, stale-compiled-label gotcha |
| `resources/08-security.md` | Privilege/duty/role naming, entry-point grants, extensions, BP coverage and non-admin testing |
| `resources/09-sysoperation-batch-pattern.md` | Contract/Service/Controller batch pattern |
| `resources/10-transactions.md` | Correct `ttsbegin`/`ttscommit`/`ttsabort` shape |
| `resources/11-best-practice-warnings.md` | BP warning → cause → fix quick reference |
| `resources/12-build-and-tooling-notes.md` | Local build limits, verifying standard schema offline |
| `resources/13-verified-standard-schema-facts.md` | Non-obvious standard-table facts (OData names vs. real field names) |
| `resources/14-deployment-pipeline-gotchas.md` | Azure DevOps X++ build/package/deploy task gotchas |
| `resources/15-unit-testing-conventions.md` | `SysTestCase` conventions, fixture patterns, `validateWrite` testing gotcha |
| `resources/16-parent-child-field-locking-pattern.md` | Role + parent-link + field-level lock + batch-sync pattern |
| `resources/17-coc-side-effect-suppression-pattern.md` | Context-scoped flag to bypass a CoC side effect on a specific call path |
| `resources/18-outbound-batch-integration-pattern.md` | DMF export → landing zone → ETL → REST upsert → sync-log callback architecture |
| `resources/19-documentation-ways-of-working.md` | Spec docs go stale; as-built doc template shape; treat notes as point-in-time |
| `resources/20-security-model.md` | Role → Duty → Privilege → Entry point traversal, extensions, sub-roles, SoD rules, static-analysis limits |
| `resources/21-exposing-fno-to-agents.md` | OData, virtual tables, the ERP MCP server; OData readiness, natural keys, read-only agent roles, OData actions |
| `resources/22-performance-antipatterns.md` | Trace Parser workflow, N+1 and slow SQL, set-based operations, index checks, caching by table group |
| `resources/23-batch-and-telemetry.md` | SysOperation vs RunBaseBatch, pack/unpack, BatchRetryable and idempotency, batch telemetry events and KQL |
| `resources/24-form-patterns-ui-layout.md` | Web client logical/physical split, selecting form patterns and subpatterns, ArrangeMethod/ColumnsMode/sizing, pattern property ownership |
| `resources/25-arrival-journals-to-product-receipts.md` | Batch-posting arrival journals, then product receipts per PO with the journal's packing slip id; registered-quantity and idempotency gotchas (API names to verify) |

Each topic starts with a YAML header (`appliesTo`, `match`, `filter`, `rank`, `note`) that the
server's knowledge filter uses to annotate index tool results; see "Knowledge filter" in the
repository README.

## Provenance

Distilled from AGENTS.md/CLAUDE.md-style shared conventions (read by both GitHub Copilot and
Claude Code on the source project) plus as-built integration/migration docs and assistant session
memory. Git history doesn't attribute a change to a specific AI tool, so no attempt is made here to
credit individual entries to one assistant — this is a merged knowledge base by design.

## Explicitly out of scope

No object/table/class/field names carrying a company-specific prefix, no specific business rules
from the source features this was generalized from, no external API shapes/payloads, no Azure
resource names, no label ids or label file names, no environment/company codes.
