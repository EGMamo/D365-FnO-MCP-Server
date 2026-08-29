# Field Groups & Form Extensions

> Naming conventions, the `DataGroup` auto-generation trap, and the one property you must never
> strip from a form.

- Field groups organize fields for UI and for query/report generation. A group `Label` can be a
  custom label or a system label (`@SYS###`, `@ApplicationFoundation:...`).
- Form control naming convention: `<GroupName>_<FieldName>`.
- String/enum fields → `AxFormStringControl`; Real fields → `AxFormRealControl`; always set
  `<DataSource>`.
- **DataGroup gotcha:** a form group whose `<DataGroup>` points at a table field group auto-generates
  its child controls from that field group. **Unbound** controls placed inside get stripped on
  re-serialization. To add a filter/helper control, either make it a bound field or put it in a plain
  (non-DataGroup) group.
- **Always preserve the `[Form]` attribute** in a form's `classDeclaration`. Never remove it.
