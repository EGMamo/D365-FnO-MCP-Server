---
appliesTo:
  tools: [get_data_entity_details, check_entity_odata_readiness, create_data_entity]
  objectTypes: [DataEntity]
note: "Unmapped fields are populated in postLoad() and are not computed fields. Natural keys are usually unique per company only, so wrap find() calls in changecompany(this.DataAreaId)."
---
# Data Entities

> Mapped vs. unmapped/computed fields, `postLoad` population, company scoping, and the DMF
> set-based export trap.

- **Mapped field**: `i:type="AxDataEntityViewMappedField"` with `<DataField>` + `<DataSource>`.
- **Unmapped / virtual field**: `i:type="AxDataEntityViewUnmappedField<Type>"`
  (`...UnmappedFieldString`, `...UnmappedFieldReal`, `...UnmappedFieldInt64`, `...UnmappedFieldEnum`,
  …), `IsComputedField=No`. **Not** `AxDataEntityViewComputedField` — a computed field is a different
  concept (view SQL), whereas an unmapped field is populated in code.
- Populate an unmapped field in a `postLoad()` override (via a `tableStr()` CoC extension, or directly
  in the entity's own class methods).
- Most natural keys are **unique only within a company**. Wrap `<Table>::find(...)` in
  `changecompany(this.DataAreaId) { … }` inside `postLoad()` / entity callbacks — the ambient
  company isn't guaranteed there.
- **DMF export of a `postLoad`-computed field:** set-based export **bypasses `postLoad`**, so the
  value exports blank. Set `SupportsSetBasedSqlOperations = No` on the entity to force row-by-row so
  `postLoad` runs. Trade-off: slower export.
- **Staging table must carry every exported field.** A public entity field missing from staging →
  `DataEntityPublicFieldDefinedOnStagingTableCheck`. Regenerate staging, or add the column manually
  (give unmapped-field columns a real type + `<StringSize>`/EDT).
- Don't copy a whole standard entity unless you need it — a full copy drags in hundreds of standard
  fields/relations that each throw BP warnings (obsolete refs, duplicate roles, EDT-not-migrated).
  Trim to the fields you actually export.
