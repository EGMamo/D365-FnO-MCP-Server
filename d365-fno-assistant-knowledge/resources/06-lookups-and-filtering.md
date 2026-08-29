# Lookups & Filtering

> Building filtered dropdowns, hiding disabled values, and the reliable way to make one lookup
> depend on another.

- Build a filtered dropdown with `SysTableLookup::newParameters(tableNum(T), _control)` +
  a `Query` with ranges, then `addLookupField(...)` and `performFormLookup()`.
- Reusable "hide disabled values" helper: a static method that adds a
  `<flagField> == NoYes::No` range to a `SysTableLookup` for any lookup table.
- Two ways to intercept a lookup:
  - **Field-level (form-agnostic):** `[FormDataFieldEventHandler(tableStr(T), fieldStr(T, F),
    FormDataFieldEventType::Lookup)]` — fires on every form showing that field.
  - **Control-level (one form):** `[FormControlEventHandler(formControlStr(MyForm, ControlName),
    FormControlEventType::Lookup)]`.
  Set `_e.result(true)` to suppress the default lookup.
- **Dependent filter (e.g. filter B by selected A):** a composite table relation *can* auto-filter,
  but on complex standard forms it is **unreliable** — implement an explicit `OnLookup` handler that
  reads A's current value and ranges B's query. Pair it with an `OnModified` handler on A that clears
  B when A changes.
