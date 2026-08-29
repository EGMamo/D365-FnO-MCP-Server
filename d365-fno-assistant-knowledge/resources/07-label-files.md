# Label Files

> Label storage/reference pattern, and the #1 cause of a "label clearly exists but BP says
> unknown" report.

- Labels live in `AxLabelFile/LabelResources/<locale>/<LabelFile>.<locale>.label.txt` as
  `Id=Text` lines, referenced in code/metadata as `@<LabelFile>:Id`.
- The `AxLabelFile/<LabelFile>_<locale>.xml` descriptor must have `LabelFileId=<LabelFile>` and point
  at the txt.
- Use the **same id across locales** for the same concept.
- **`BPErrorUnknownLabel` for a label that clearly exists = stale compiled label resource.** Editing
  the `.label.txt` **outside the VS label editor** (direct file writes / tools) doesn't trigger the
  incremental build's label compiler, so code references fail. **Fix: full/clean Rebuild** (or open the
  label file in VS's label editor and re-save). The paired `BPUnusedStrFmtArgument (%n not used)`
  warnings share this cause (unresolved label = empty format string) and clear together.
- Team preference examples worth adopting: keep label text free of a trailing period; use a plain
  incrementing numeric id scheme.
