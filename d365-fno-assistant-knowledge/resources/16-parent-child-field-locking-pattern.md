# Parent/Child Attribute-Inheritance & Field-Locking Pattern

> A recurring ERP customization shape: a role field, a parent link, a setup table naming which
> fields roll down, and a batch job that does the rolling.

- A role enum on the header record (e.g. `Master` / `Child` / `Standalone`) plus a self-referencing
  "parent record" link field.
- A separate setup table lists *which* fields are "parent-managed" by name (not by field id) —
  dependent code resolves the field id at runtime by name against the table. This makes the setup
  table portable across schema changes and avoids hard field-id coupling.
- Parent-managed fields are read-only on child records: a `validateWrite` override rejects direct
  edits to any field named in the setup table, *except* when running inside the sync operation
  itself (a context flag distinguishes "user edit" from "sync batch write" — see the
  context-scoped side-effect suppression pattern for the mechanism).
- A batch job walks parents → children and copies parent-managed field values down, plus any
  computed/derived assignment that depends on the parent.
- A small set of fields are hard-blocked from ever being parent-managed (the natural key, the role
  field itself, the parent-link field) — validated centrally so no setup row can target them.
- Seed/setup data for this kind of table is a *reviewed baseline*, not a blind deploy script: the
  safe rollout is export-existing-rows → diff against the seed → import only new/approved rows,
  because the setup table's natural key means a naive re-import silently overwrites rows an
  environment may have already customized.
