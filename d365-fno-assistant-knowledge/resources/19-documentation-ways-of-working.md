---
appliesTo:
  tools: [get_index_staleness]
note: "Spec status columns go stale. Verify what is built against the metadata, and treat earlier notes as point-in-time."
---
# Documentation & Ways-of-Working Practices

> Process habits worth surfacing to a developer, not just X++ facts.

- **Spec docs go stale, fast.** A functional/design doc's own embedded status column ("To do" /
  "TBD" / "Done") is not reliable evidence of what's actually built, especially past the first
  sprint. Always verify "what's still pending" against the real metadata/code, and prefer a
  maintained as-built doc over the original spec when both exist for the same feature.
- **As-built integration docs have a consistent, reusable shape** worth templating: architecture
  diagram → entity/field mapping tables → data-model section for any new supporting tables →
  deployment runbook (per deployable component) → testing checklist structured as happy path /
  update path / failure path → a numbered "known limitations and decisions" list. This shape reads
  well and is worth suggesting whenever a developer is about to document a new integration.
- **Treat prior notes as point-in-time, not live state.** Any recalled fact about "what's
  implemented" or "what's missing" needs a re-check against current code/metadata before being
  restated as current fact — this applies to an AI assistant's own memory just as much as to a
  stale spec doc.
