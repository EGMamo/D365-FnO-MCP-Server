---
appliesTo:
  tools: [get_table_schema, get_edt_details, find_field_access]
  objectTypes: [Table, Edt]
note: "Prefer EDT inheritance for field types. A string FK to a custom lookup uses IgnoreEDTRelation=Yes plus an explicit relation, and new tables need the BP properties (TitleField1, CacheLookup, DeveloperDocumentation)."
---
# Tables & Fields

> Field-type patterns, EDT inheritance, the string-lookup FK pattern, and the BP-required
> properties on a new table.

- **NoYes / enum field**: `i:type="AxTableFieldEnum"` with `<EnumType>NoYes</EnumType>` directly —
  no EDT needed.
- **Real field**: `i:type="AxTableFieldReal"` with `<ExtendedDataType>` (e.g. `SalesPrice`, `AmountCur`).
  Prefer EDT inheritance for precision/scale over inline values; create a reusable `<Prefix>*` Real EDT
  if used in more than one place.
- **String lookup field pattern** (FK to a custom lookup table): string field with
  `<IgnoreEDTRelation>Yes</IgnoreEDTRelation>` + an explicit `AxTableRelation` mapping the field to the
  lookup table's key. Composite FKs need multiple constraint lines.
- **DMF staging fields** mirror the base field with `<IgnoreEDTRelation>Yes</IgnoreEDTRelation>`.
- Mandatory table properties (BP-required on new tables): `DeveloperDocumentation` (label ref),
  `TitleField1`, `CacheLookup`, every non-system field in a field group (incl. `AutoReport`), and a
  `ReplacementKey` when the table has an alternate key + RecId index.
- Custom lookup tables commonly get: `[Hookable(false)]` static `find()`/`exist()`, an alternate key
  on the natural key, and cascading delete cleanup where referenced.
