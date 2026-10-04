---
appliesTo:
  tools: [get_index_staleness, get_index_stats, list_packages, list_models]
note: "Local dotnet msbuild cannot run F&O targets. Verify standard table and field names against the AxTable XML in PackagesLocalDirectory, not OData names or recalled APIs."
---
# Build & Tooling Notes

> Local build limitations and how to verify facts offline instead of relying on recalled API
> names.

- **Local `dotnet msbuild` can't run F&O targets** without the F&O dev box's targeting pack +
  Dynamics BuildTasks. Rely on the editor's XML diagnostics + a real dev-box/pipeline build.
- **Verify standard table/field names offline** from the local package metadata:
  `C:\Users\<user>\AppData\Local\Microsoft\Dynamics365\<version>\PackagesLocalDirectory\<Package>\AxTable\<Table>.xml`
  (skip the `XppMetadata` mirror). **OData entity metadata often renames the underlying table fields**,
  so don't trust OData field names for X++ `fieldNum()`/relations — check the actual `AxTable` XML.
  The same directory holds the full standard AOT for every module — use it to verify any standard
  class/method signature instead of relying on recalled API names, which can be wrong or
  version-specific (a plausible-sounding helper class that doesn't exist in a given version is a
  recurring failure mode).
- OData query tooling is great for *data* verification (does a value exist, what companies) but **can't
  fetch raw X++ class source**; verify class members via IntelliSense / AOT browse.
- Metadata-only edits don't change live OData/UI behavior until compiled + DB-synced.
