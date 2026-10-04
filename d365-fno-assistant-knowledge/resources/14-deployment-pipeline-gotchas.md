---
appliesTo:
  tools: [get_index_staleness]
match:
  names: ['*BuildXpp*', '*CreatePackage*']
note: "Keep PlatformVersion and ApplicationVersion in sync with packages.config, and use a modern NuGetToolInstaller for the unified package path."
---
# Deployment Pipeline Gotchas (Azure DevOps X++ Build Tasks)

> Version-sync requirements, NuGet tooling, and the cloud-package zip/license steps that are easy
> to miss.

- Keep `PlatformVersion`/`ApplicationVersion` build variables in sync with the versions pinned in
  `packages.config` (`Platform.DevALM.BuildXpp`, `Application*/ApplicationSuite.DevALM.BuildXpp`).
  Mismatch → `XppCreatePackage` version-mismatch failures.
- For the **Power Platform unified package** path (`CreateCloudPackage`), use a **modern**
  `NuGetToolInstaller` (7.6.x). Pinning NuGet to `3.3.0` (the legacy LCS-only guidance) causes
  `System.Text.Json` / `Microsoft.IdentityModel.Clients.ActiveDirectory` assembly-load failures.
  If those persist with modern NuGet, the pinned `CompilerPackage` may predate MS bundling those DLLs
  for the cloud path — get the full task log and check for the DLLs beside
  `Microsoft.Dynamics.AXCreateDeployablePackageBase.dll`; fix by using a newer `CompilerPackage`.
- `XppCreatePackage`'s `CloudPackageOutputLocation` is an **unzipped folder** — zip it
  (`ArchiveFiles@2`, `includeRootFolder: false`) before publishing the unified-package artifact.
  There's no `AXDeployableRuntime_*.zip` unless `CreateRegularPackage: true`.
- `XppAddLicenseToPackage@1` (needs a `ModelName`) is required for unified-package licensing.
