---
appliesTo:
  tools: [get_bp_findings, check_xpp_best_practices]
match:
  tools: [get_bp_findings, check_xpp_best_practices]
note: "Most BP messages are warnings that still matter; the quick reference maps each rule to its cause and fix."
---
# Best Practice (BP) Warnings — Quick Reference

> Most BP messages are **warnings** (build still shows 0 errors) but keep them at zero.

| Rule | Cause | Fix |
|---|---|---|
| `BPErrorUnknownLabel` | Stale compiled label resource | Full rebuild / re-save label file in editor |
| `BPUnusedStrFmtArgument` | Usually the above (unresolved label) | Same rebuild; else fix the format string |
| `BPErrorMethodUnbalancedTtsbeginCommit` | Manual `ttsabort` / begin outside try | See the transactions resource |
| `BPErrorClassNewNotProtected` | Controller `new()` public | Make `protected` |
| `BPErrorDeveloperDocumentationNotDefined` | Missing property | Add `<DeveloperDocumentation>` (label) |
| `BPErrorTableTitleField1NotDeclared` | Missing property | Set `TitleField1` |
| `BPErrorTableNoCaching` | Missing property | Set `CacheLookup` (e.g. `Found`) |
| `BPErrorTableFieldNotInFieldGroup` | Field in no group | Add to `AutoReport`/`Main` |
| `BPTableWithRecIdIndexMissingReplacementKey` | Alt key + RecId index | Set `ReplacementKey` |
| `BPErrorEDTNotMigrated` / `BPUpgradeMetadataEDTRelation` | Field EDT carries legacy relation | `<IgnoreEDTRelation>Yes</IgnoreEDTRelation>` (+ explicit relation if needed) |
| `BPErrorLabelIsText` | EDT/property `Label` is literal text | Use a label id |
| `BPErrorDutyNotCoveredByRole` | Duty on no role | Add to a role |
| `BPErrorPreventRedundantEntryPointUnsetGrant` | Entry-point grant `Unset` | Set `Allow`/appropriate |
| `DataEntityPublicFieldDefinedOnStagingTableCheck` | Entity field missing on staging | Regenerate staging / add column |
| `DataEntityStagingTableNotToUseRecIDAsKeyColumnCheck` | RecId in staging key | Remove RecId from staging index |
| `DataEntityFieldNamePropertyCheck` | Array field name has digit/`_` | Rename / remove |
| `BPODataRelationRelatedRoleNameAlreadyUsed` / `...PropertyNotSpecified` / `...LinesEmpty` | Copied/incomplete entity relations | Delete unneeded relations / set unique `RelatedTableRole` / add constraints |
| `BPErrorMissingOrUnsupportedImage` | Menu item form image missing | Set a valid image |
| `BPXmlDocNoDocumentationComments` / `...ParameterNotDescribed` / `...NoReturns` | Missing doc headers | Add `///` `<summary>`/`<param>`/`<returns>` |
| `BPParameterNotUsed` (`_e`) | Event-handler signature | Cosmetic — add `///` or suppress |
