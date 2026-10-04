# Azure resource guide for the hosted D365 FnO MCP service

This guide defines a practical starting plan for hosting and operating the
D365 FnO MCP service under the acquisition-worker architecture. It is a
planning guide, not a deployment script.

The target architecture has two responsibilities:

- A public, read-only MCP API serves one validated SQLite index at a time.
- A private, scheduled Azure worker acquires the current D365 F&O SDK and
  related assets, builds and validates a candidate index, and promotes an
  immutable bundle.

The Visual Studio extension remains a loopback MCP gateway. It stores the
hosted API key in Windows Credential Manager, forwards SDK and client context,
and proxies the hosted service. It does not build or upload indexes.

> [!IMPORTANT]
> Azure-hosted components are read-only with respect to developers' local
> Visual Studio workspaces and metadata files. The worker writes only to its
> private scratch space and the Azure artifact store. The hosted API reads a
> validated local SQLite snapshot. Neither component applies changes to a
> developer workspace.

## Recommended starting topology

Use the following minimal resource set after completing the remaining Windows
acquisition and worker-integration gates described in Phase 0:

| Resource | Initial choice | Purpose |
| --- | --- | --- |
| Resource group | One per environment | Lifecycle and RBAC boundary |
| Azure App Service plan | Linux, one always-on instance | Hosts the read-only MCP API |
| Azure App Service web app | Custom container | Downloads, verifies, and locally activates one index bundle before becoming ready |
| Azure Windows VM | Worker host | Runs `pac tool xpp install`, SDK acquisition, indexing, validation, and promotion |
| Azure Container Registry | Basic initially | Stores versioned API and worker images; disable anonymous/admin access |
| Azure Storage account | Standard general-purpose v2, LRS initially | Stores immutable bundles, source artifacts, run reports, and the promotion pointer |
| Azure Key Vault | RBAC authorization, purge protection | Holds Power Platform credentials and hosted API keys |
| Managed identities | Separate identities for API and worker | Passwordless access to Storage, Key Vault, and ACR |
| Log Analytics workspace | Shared by API and worker | Central diagnostic and job execution logs |
| Application Insights | Connected to the API | Request, dependency, exception, and availability telemetry |
| Azure Monitor alerts | Action group plus alert rules | Alerts on failures, stale indexes, and service health |

### Why App Service for the API

App Service is the initial choice because the API is a conventional,
always-on HTTPS service, needs only one active replica at first, and must hold
a local read-only SQLite copy. App Service also provides managed identity,
Key Vault references, health checks, deployment slots, access restrictions,
and straightforward custom-container operation.

Alternatives:

- **Azure Container Apps for the API** can be revisited when the MCP transport
  and session behavior have been proven with replica changes. It does not
  solve the worker requirement because Container Apps Jobs use Linux
  containers. Keep a minimum of one API replica; scale to zero is not
  appropriate for predictable MCP availability.
- **Azure Functions** is not preferred for the API or worker because SDK
  acquisition and index builds can be long-running and disk-intensive.
- **A dedicated Windows VM** increases patching and operational work, but is
  required for the current X++ SDK acquisition path.
- **AKS** is unnecessary for the initial scale and would add avoidable
  operational cost.

### Worker platform decision

The verified and documented requirement is a Windows worker:

- On this macOS host, `pac` 2.12.2 is installed and starts successfully.
- `pac tool xpp list` reports no installed SDK and instructs the user to run
  `pac tool xpp install`.
- The same installation rejects `pac tool xpp install` and exposes only
  `list` and `uninstall` under `pac tool xpp`.
- On a Windows ARM64 VM, the .NET global-tool installation of `pac` exposes
  `install`, `list`, and `uninstall` under `pac tool xpp`. It downloaded and
  registered SDK `10.0.2645.124` (about 4 GB compressed and 16 GB extracted)
  and installed it under
  `%LOCALAPPDATA%\Microsoft\Dynamics365\10.0.2645.124\PackagesLocalDirectory`.
  The acquired X++ compiler `7.0.7996.111` started successfully under ARM64
  emulation, returned its complete help output within 30 seconds, and wrote
  nothing to stderr.
- Separate screenshots from an authorized work laptop provide a known-good
  reference for Visual Studio XPP configuration, versioned
  `PackagesLocalDirectory`, LocalDB XRef, runtime package symlinks, and
  generated XPPConfig JSON. They are not evidence about the ARM64 VM and no
  work-laptop assets should be transferred without employer authorization.
- Microsoft's `pac tool` reference says those commands are available only for
  the .NET Full Framework PAC CLI.
- Microsoft's X++ skill states that `pac tool xpp install` is Windows-only and
  explicitly says not to invent a Linux/macOS fallback.

The general PAC CLI is available on Windows, Linux, and macOS, but that does
not make every command cross-platform. The observed Windows command surface
is sufficient to continue the proof without replacing the current PAC
installation, but Microsoft still documents the tool group as Full Framework
and the X++ workflow as Windows-only. A Linux Container Apps Job therefore
cannot be assumed to run the required acquisition path.

Therefore:

1. Use a Windows worker for the X++ SDK and
   `PackagesLocalDirectory` acquisition path.
2. Use an Azure Windows VM (or an approved Windows build runner) with a
   scheduled trigger.
3. Do not include Container Apps Jobs in the initial worker topology.
4. Reconsider Linux only if Microsoft later ships and documents a supported
   non-Windows X++ installer, followed by an end-to-end proof.

Do not split one promotion workflow across developer machines. Whichever host
is selected must perform acquisition, build, validation, and promotion under
the same run and identity.

## Phase 0: align the artifact contract (implemented locally)

The local `align-artifact-contract` prerequisite and Azure Blob adapter are
implemented and validated. The remaining deployment gate is to prove Windows
SDK acquisition and connect the worker to these surfaces without weakening
their validation, revision, or rollback rules.

### Step 0.1: define the immutable bundle

The implemented strict contract defines a versioned, machine-validated bundle
containing:

- An immutable, content-addressed `bundleId` and explicit contract version.
- D365 SDK/application version and source environment/release identity.
- Bundle-contract version, SQLite schema version, and generator/API version.
- Creation, build-completion, validation, and publication timestamps.
- Byte counts and SHA-256 hashes for every required artifact.
- Build and validation status. Only a validated bundle can be promoted.
- The required SQLite index file.
- A durable, machine-readable validation report.
- Source provenance for:
  - `PackagesLocalDirectory`;
  - one or two version-applicable VSIX assets;
  - dbrefx and XRef inputs;
  - optional feeds or imports included in the build.
- A capability inventory that declares the presence and completeness of:
  - code metadata;
  - data-model metadata;
  - UI and form patterns;
  - workflow and service metadata;
  - reporting and analytics;
  - labels and resources;
  - extensions;
  - reports;
  - security graphs.
- Compatibility rules, including supported API/generator versions, supported
  schema versions, required capabilities, and fail-closed behavior.

The implemented local artifact-store layout is:

```text
artifact-store/
  deployment-pointers.json
  bundles/
    <bundle-id>/
      manifest.json
      d365_index.db
      validation-report.json
```

`manifest.json` contains the identity, compatibility, capability, checksum,
and provenance contract. `deployment-pointers.json` is the revisioned
active/previous selection. The Azure Blob adapter preserves these names and
semantics while allowing the container name to remain deployment-configurable.

### Step 0.2: define promotion as one conditional pointer update

The local implementation uses one revisioned
`deployment-pointers.json` document rather than independently updating two
pointer files. It records the active and previous bundle selections and
supports promotion and rollback.

The implemented Azure Blob adapter maps revision checks to Blob ETags and
`If-Match` conditions. A concurrent promoter receives `412 Precondition
Failed` instead of silently overwriting another promotion. A renewable Blob
lease on `locks/acquisition` prevents overlapping scheduled builds; revision
and ETag checks remain the final concurrency guards.

Promotion rules:

1. Bundle objects are immutable and uploaded with create-only semantics.
2. The worker uploads all artifacts and re-reads them for validation.
3. Only a bundle whose manifest lifecycle is `validated` and whose final
   validation report says `passed` may be named by the channel document.
4. Promotion changes active, previous, and revision together in the single
   conditional `deployment-pointers.json` write.
5. Rollback is another conditional channel update that makes the retained
   previous bundle active. It never rebuilds or edits the bundle.
6. Rejected or incomplete candidates can never be referenced by the channel.

### Step 0.3: define API compatibility checks

The API must fail readiness, not merely warn, when:

- the bundle-contract version is unsupported;
- the SQLite schema is outside the supported range;
- the generator/API compatibility rule fails;
- a required capability is absent or incomplete;
- an artifact or manifest hash does not match;
- the validation report is absent or does not say `validated`;
- the active pointer refers to a missing bundle.

### Step 0.4: use the implemented producer and consumer seams

The target architecture branch now includes:

- `src/indexer/artifactContract.ts` for strict contract types and validation;
- `src/indexer/artifactBundle.ts` for bundle production, validation, and local
  staging;
- `src/indexer/artifactPointers.ts` for revisioned active/previous promotion
  and rollback;
- `src/server/artifactStartup.ts` for the hosted startup seam;
- `src/indexer/azureBlobArtifactStore.ts` for create-only immutable uploads,
  ETag promotion, acquisition leases, rollback-safe retention, and fail-closed
  local materialization;
- `src/indexer/azureBlobArtifactStoreSdk.ts` for the managed-identity Azure SDK
  binding;
- `D365_ARTIFACT_STORE_PATH`, which selects the local artifact store, activates
  its selected bundle into `D365_INDEX_DB_PATH`, and opens the database
  read-only;
- `docs/azure-artifact-contract.md` as the contract reference.

Ten focused tests cover the implementation. The full suite passed with 545
tests and one skipped test at the Phase 0 handoff.

The acquisition worker must call these contract and Blob-adapter surfaces
rather than create a parallel manifest or promotion format.

Legacy manifest, remote-download, upload-route, upload-client, and
publish/pull/upload CLI designs are retired. Git history may be used only for
lessons such as hashing, validation before activation, and immutable
publication. Do not restore the old `latest/manifest.json` or developer upload
contract as the new baseline.

### Step 0.5: complete the remaining Azure deployment gates

The local contract gate has passed. Do not deploy production infrastructure
until the remaining integration checks pass:

- The Windows acquisition proof succeeds for the selected PAC and SDK version.
- The Windows worker produces bundles through `artifactBundle.ts`.
- The Windows worker persists and promotes them through
  `azureBlobArtifactStore.ts`.
- Hosted startup materializes the selected Blob bundle into a local artifact
  store before `artifactStartup.ts` activates it (implemented by
  `D365_ARTIFACT_SOURCE=azure-blob`; needs an end-to-end run against Azure).
- End-to-end tests cover Blob conflicts, interrupted downloads, worker
  acquisition failure, startup recovery, and rollback.
- Tests prove Azure components cannot write to a local developer workspace.

## Phase 1: collect prerequisites and make decisions

### Step 1.1: choose environment boundaries

Record:

- Azure tenant, subscription, region, and environment name.
- Resource naming and tagging rules.
- Data classification and retention requirements.
- Recovery point and recovery time expectations.
- Required API ingress: public with restrictions, private, or through an
  existing gateway.
- Required worker schedule and maximum acceptable index age.

Use separate resource groups and Key Vaults for nonproduction and production.

### Step 1.2: measure the workload

On a trusted build host, measure:

- uncompressed and compact SQLite size;
- peak disk required for source assets, candidate DB, validation, and bundle;
- peak memory and CPU during index generation;
- normal build duration;
- expected daily source-download volume;
- API request rate and concurrent MCP sessions.

Size the App Service plan so the local DB and useful SQLite page cache fit
comfortably. Size worker ephemeral storage for the source set, active
candidate, compact snapshot, validation work, and safety margin.

### Step 1.3: prove the Windows worker image

The platform decision is Windows. Perform the remaining toolchain proof on a
disposable Windows worker host.

On a disposable Windows worker host, verify:

1. The Windows PAC installation exposes `pac tool xpp install`. Verified on the
   candidate Windows ARM64 VM.
2. `pac tool xpp install` downloads and registers the requested X++ SDK and
   `PackagesLocalDirectory`. Verified for `10.0.2645.124`.
3. The installed X++ compiler starts successfully under ARM64 emulation.
   Verified with X++ compiler `7.0.7996.111`.
4. Noninteractive authentication succeeds.
5. The required SDK/package download command succeeds.
6. The version-applicable VS2022 tools VSIX and XRef backup can be acquired.
   Acquisition and hashing are verified; XRef restore/import remains open.
7. Node.js and SQLite index generation complete.
8. Peak disk, memory, and runtime fit the selected Windows VM.

After `pac tool xpp install` completes, `scripts/verify-windows-xpp.ps1`
captures the registered SDKs, any generated `XPPConfig` files, referenced
`PackagesLocalDirectory` paths, package counts, and compiler locations without
reading authentication profiles or tokens. CLI-only acquisition might not
create `XPPConfig`; the verifier also discovers compilers directly from
versioned SDK directories. Run it first without arguments, then use
`-ExecuteCompiler` to start each discovered compiler with `/?` and
record whether it executes and exits under the host architecture. The verifier
saves the `pac tool xpp list` output and exits 1 if that command fails:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-windows-xpp.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify-windows-xpp.ps1 -ExecuteCompiler
```

The Dev Tools client-metadata endpoint used by the UDE tooling is not a
documented public API. For the proof only, `scripts/acquire-ude-assets.ps1`
resolves the current `finopsvsix22` and `crossreference` assets with a
dedicated Dataverse application identity. The legacy `finopsvsix` resource can
be requested explicitly for older builds but is unavailable for the verified
VS2022 environment. The script validates that every returned URL is an HTTPS
Azure Blob URL and records no bearer token or SAS URL. Resolve metadata before
downloading the multi-gigabyte assets:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\acquire-ude-assets.ps1 `
  -TenantId "<tenant-id>" `
  -ApplicationId "<application-id>" `
  -DataverseEnvironmentUri "https://<org>.crm<N>.dynamics.com/" `
  -AppVersion "<four-part-version>" `
  -MetadataOnly
```

Do not treat this reverse-engineered endpoint as a production dependency until
Microsoft confirms it is supported for unattended acquisition. Keep the
client-metadata response and its short-lived SAS URL out of logs and reports.
When AzCopy is present on `PATH`, the script uses its parallel Blob transfer
engine and keeps its logs and job plans in a temporary directory that is
removed after each asset. AzCopy only accepts the pre-signed SAS inside the
source URL, so the SAS is visible on AzCopy's command line while a transfer
runs; error output is redacted. Keep AzCopy off `PATH` (and omit `-AzCopyPath`)
to use the built-in single-stream downloader, which keeps the SAS inside the
script's own process. Existing files are reused, and new downloads accepted,
only when their exact length and, when the blob reports one, Content-MD5 match
the current service metadata; the script then hashes them into the combined
proof.

Do not attempt to substitute a Linux container merely because `pac auth`
works there. Only reconsider Linux if Microsoft documents a supported X++
installer and the complete acquisition/build flow passes on that platform.

## Phase 2: complete one-time identity setup

Separate Power Platform identity from Azure resource identity.

### Step 2.1: create the Power Platform automation identity

An authorized Entra administrator must:

1. Create or select an Entra app registration for the acquisition worker.
2. Create a client secret initially if required, or preferably configure a
   certificate/federated approach supported by the final worker.
3. Add the service principal as an application user in the target Power
   Platform environment.
4. Assign only the environment roles required for the selected `pac`
   acquisition commands.
5. Confirm the application user can access the target D365 F&O environment
   and required package assets.
6. Record an owner and rotation date.

Power Platform CLI supports a named service-principal profile using tenant ID,
application ID, and client secret. It also supports `--managedIdentity` where
Azure Identity is accepted. Test managed identity first in the selected Azure
host; use the app registration and Key Vault secret only where the target
Power Platform operation requires it. Managed identity support for `pac auth`
does not make the X++ SDK installer available on Linux.

Do not pass secrets on a command line that will be logged. Inject them into
the job at runtime from Key Vault and suppress command tracing.

### Step 2.2: create Azure managed identities

Use separate identities:

- **API identity**
  - Storage Blob Data Reader on the bundle container.
  - Key Vault Secrets User only for API secrets.
  - ACR pull permission if App Service pulls a private image using identity.
- **Worker identity**
  - Storage Blob Data Contributor on bundle/source/run containers.
  - Key Vault Secrets User only for acquisition credentials.

Do not grant either identity subscription-level Contributor. Use data-plane
RBAC and the narrowest practical resource scope.

## Phase 3: define infrastructure as code

Use Bicep under `infra/` unless the project chooses another standard. Keep
environment-specific values in parameter files, not templates.

Provision in this dependency order:

1. Resource group, tags, Log Analytics, and Application Insights.
2. Storage account and private containers.
3. Key Vault with RBAC authorization, soft delete, and purge protection.
4. User-assigned identities if they are needed during resource creation.
5. ACR with anonymous and admin access disabled for the API image.
6. Windows VM, managed disk, worker identity, patching, and scheduling
   mechanism.
7. App Service plan and web app with managed identity.
8. Storage, Key Vault, and ACR role assignments.
9. App settings and Key Vault references.
10. Health checks, diagnostic settings, dashboards, action group, and alerts.
11. Optional VNet integration, private endpoints, and private DNS.

Before any deployment, run a Bicep what-if operation and review Azure Policy,
regional availability, quotas, and naming conflicts.

## Phase 4: configure durable storage

Use private Blob containers with public access disabled. Prefer Entra ID and
managed identity over account keys. Disable Shared Key authorization after all
clients have been verified with identity-based access.

Recommended logical data classes:

```text
artifact container
  deployment-pointers.json
  bundles/<bundle-id>/manifest.json
  bundles/<bundle-id>/d365_index.db
  bundles/<bundle-id>/validation-report.json
  locks/acquisition

source container
  sdk/<source-version>/...
  vsix/<asset-version>/...
  xref/<source-version>/...

operations container
  runs/<run-id>/run-report.json
  rejected/<run-id>/...
```

Apply lifecycle policies separately:

- Keep active and previous bundles until explicitly superseded and outside the
  rollback window.
- Retain several additional validated bundles for investigation.
- Expire rejected candidates and scratch artifacts sooner.
- Retain source artifacts according to audit and rebuild requirements.
- Never let an automatic lifecycle rule delete a bundle named by the channel.

Enable blob versioning or soft delete for `deployment-pointers.json` as an
additional recovery aid. It does not replace explicit active/previous
semantics.

## Phase 5: deploy and configure the private worker

The worker has no public ingress. Configure one execution at a time and set a
deadline longer than the measured build duration. Implement this phase on a
Windows VM or approved Windows build runner. A VM can use Windows Task
Scheduler, an Azure Automation trigger, or an external scheduler that starts
the worker command; the artifact contract and promotion protocol remain the
same.

### End-to-end worker flow

1. **Start run**
   - Generate a run ID.
   - Acquire the acquisition lock lease.
   - Read `deployment-pointers.json`, its revision, and its ETag.
   - Emit a `started` run event.
2. **Authenticate**
   - Obtain Azure tokens through managed identity.
   - Resolve a Power Platform credential from Key Vault only if managed
     identity cannot perform the required `pac` operation.
   - Create an isolated, run-scoped `pac` authentication profile.
3. **Acquire sources**
   - Download the current D365 F&O SDK/package local directory.
   - Parse the generated
     `%LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\*.json` selected for the
     run. Treat its application version, `FrameworkDirectory`,
     `ReferencePackagesPaths`, model-store path, runtime-packages path, and
     XRef server/database settings as authoritative discovery data; do not
     reconstruct these paths from naming conventions.
   - Require every discovered path and application version to agree with the
     requested acquisition version. Fail closed on stale or conflicting
     side-by-side configuration entries.
   - Download every VSIX asset applicable to the selected Visual Studio generation.
   - Download dbrefx/XRef data and any approved optional source.
   - Record version, source, acquisition time, and hash for every asset.
4. **Build candidate**
   - Build in a run-scoped sibling candidate directory.
   - Never write to the API's active database path.
   - Produce a compact SQLite snapshot with the local snapshot primitive.
5. **Validate**
   - Run full SQLite integrity validation for production publication.
   - Verify schema and generator versions.
   - Verify expected tables, metadata, nonzero counts, and source versions.
   - Verify every required capability and regression threshold.
   - Compare important counts with the active bundle and require an explicit
     override for unexpected large losses.
   - Produce the signed or hashed validation report.
6. **Upload immutable bundle**
   - Produce `manifest.json`, `d365_index.db`, and
     `validation-report.json` through the implemented artifact bundle API.
   - Compute the bundle identity from the implemented contract.
   - Upload with create-only conditions.
   - Re-read manifest and artifact metadata and verify hashes.
7. **Promote**
   - Re-read `deployment-pointers.json` and verify its revision and ETag still
     match the run's base.
   - Atomically write active and previous bundle IDs in one conditional update.
   - Treat an ETag conflict as a failed promotion requiring reconciliation.
8. **Finish**
   - Emit success metrics and the promoted bundle ID.
   - Release the lease.
   - Delete ephemeral credentials and scratch files.

### Failure behavior

On any failure:

- Do not modify `deployment-pointers.json`.
- Leave the active API bundle unchanged.
- Mark the run failed and emit the failing stage and correlation ID.
- Retain the validation report and selected rejected artifacts for diagnosis.
- Clean up authentication profiles, secrets in memory where practical, and
  scratch data.
- Release or allow expiry of the lock lease.
- Alert only after recording enough context to diagnose the failure without
  exposing secrets.

## Phase 6: deploy and configure the read-only API

### Safe SQLite startup

The durable source is Blob Storage; the live SQLite file is local. Setting
`D365_ARTIFACT_SOURCE=azure-blob` (with `D365_ARTIFACT_ACCOUNT_URL`,
`D365_ARTIFACT_CONTAINER` and an instance-local `D365_ARTIFACT_STORE_PATH`)
makes `serve` implement the sequence below through
`materializeAzureArtifactIndex` in `src/server/artifactStartup.ts`. The HTTP
listener starts first with `/health` answering 503, so App Service health
checks and slot warm-up route no traffic until activation completes.

At startup:

1. Read `deployment-pointers.json` with managed identity.
2. Fetch the selected immutable bundle.
3. Materialize `manifest.json`, `d365_index.db`, and
   `validation-report.json` into a sibling local artifact-store candidate.
4. Bound every download by its declared size.
5. Verify bundle, file, and validation-report hashes.
6. Enforce contract, schema, generator, and capability compatibility.
7. Atomically make the complete local artifact store available at
   `D365_ARTIFACT_STORE_PATH`.
8. Let `artifactStartup.ts` validate the selected bundle and activate its DB
   into `D365_INDEX_DB_PATH`.
9. Open the activated DB read-only.
10. Mark the health endpoint ready only after a representative query passes.

Do not open SQLite directly from Blob Storage, Azure Files, SMB, or NFS.
Network filesystems do not provide the local filesystem and locking semantics
this design relies on.

For the POC, update the index through a controlled API restart after a
promotion. A later hot-reload design must open and test the new DB first,
atomically swap the application's DB reference, and drain old readers before
deleting the prior local copy.

### Restart and scale-out semantics

- Local instance storage is a cache, not the source of truth.
- Every cold start can reconstruct the active local DB from the channel and
  immutable bundle.
- Each replica must use its own local DB copy.
- Readiness prevents traffic from reaching a replica before its copy is open.
- A single replica is the initial supported topology because MCP sessions are
  process-local.

Do not add a second replica until session routing/reconnect behavior and
bundle rollout consistency are tested. If scale-out is enabled, pin each
rollout to one bundle ID and keep that bundle retained until all replicas have
converged.

## Phase 7: networking and secrets

### Initial low-cost boundary

- Expose only the API over HTTPS.
- Require a separate API key per client or operator.
- Store API keys in Key Vault and in Windows Credential Manager on the Visual
  Studio client.
- Disable worker ingress.
- Disable anonymous Blob and ACR access.
- Add App Service access restrictions where client IP ranges are stable.
- Keep Storage and Key Vault public endpoints enabled only if network rules
  and identity controls meet the POC risk assessment.

### Production hardening

Add, in order of need:

1. VNet integration for App Service and the Windows VM subnet.
2. Private endpoints and private DNS for Storage, Key Vault, and ACR.
3. Controlled outbound egress/NAT if source endpoints require allowlisting.
4. Azure Front Door/WAF if the API remains internet-facing.
5. Entra authentication in front of or instead of shared API keys when MCP
   client support is proven.
6. Deployment slots and a controlled rollout process for API image updates.

Managed identities do not work across Entra tenants. If Azure resources and
the Power Platform environment are in different tenants, retain a dedicated
cross-tenant app registration for the Power Platform boundary.

## Phase 8: monitoring, alerts, and operations

Emit structured logs with `runId`, `bundleId`, stage, duration, and result.
Never log API keys, client secrets, access tokens, SAS values, or URLs
containing credentials.

Track:

- API availability, latency, HTTP failures, auth failures, and active bundle.
- API startup download time and readiness failures.
- Worker execution state and duration per stage.
- Last successful acquisition and promotion timestamps.
- Active bundle age and D365 SDK version.
- Validation failures and capability regressions.
- Storage, Key Vault, and ACR authorization failures.
- Local disk and memory pressure.

Create alerts for:

- API health or availability failure.
- No successful promotion within the freshness objective.
- Worker execution failure, timeout, or overlap.
- Validation rejection.
- `deployment-pointers.json` referencing a missing or incompatible bundle.
- Repeated API authentication failures.
- Key Vault secret nearing expiry.
- App Service CPU, memory, disk, or restart anomalies.

Document runbooks for retry, rollback, secret rotation, failed authentication,
stale source data, and storage recovery.

## Phase 9: POC verification

The POC is complete only when all checks pass:

- [x] The local Phase 0 contract, producer, validator, promotion, rollback, and
      hosted startup seam are implemented and tested.
- [x] The Azure Blob adapter preserves the implemented contract and passes
      create-only, ETag, lease, corruption, rollback, and retention tests.
- [ ] `pac tool xpp install` runs noninteractively on the Windows worker with
      the chosen identity.
- [ ] The worker acquires all required sources and records provenance.
- [ ] A candidate build produces the required capability inventory.
- [ ] Integrity and compatibility validation pass.
- [ ] A failed candidate cannot change `deployment-pointers.json`.
- [ ] Concurrent promotions cause one conditional write to fail safely.
- [ ] The API downloads to local storage and never opens remote SQLite.
- [ ] The API remains unready until validation and a representative query pass.
- [ ] The API serves only the active bundle ID selected by
      `deployment-pointers.json`.
- [ ] Worker execution does not interrupt API reads.
- [ ] Restart reconstructs the same active local DB.
- [ ] Rollback selects the previous immutable bundle without rebuilding it.
- [ ] Retention preserves active and previous bundles.
- [ ] Managed identities have only required RBAC roles.
- [ ] Secrets are absent from source, image layers, command lines, and logs.
- [ ] API, worker, freshness, and validation alerts are tested.
- [ ] Azure-hosted components cannot write to a developer workspace.

## Scaling and migration path

The initial topology is deliberately one API replica and one current D365
version. Expected limitations:

- API availability is interrupted during plan maintenance or a controlled
  single-replica restart.
- Process-local MCP sessions constrain transparent scale-out.
- Every replica needs enough disk and memory for a full local SQLite copy.
- Promotion throughput is serialized.
- SQLite remains suitable only while the workload is read-heavy and the
  database fits comfortably on each instance.

Add a second API replica when availability requirements exceed the
single-instance model and session behavior is solved. Continue using one
immutable local SQLite copy per replica; do not introduce a shared network DB
file.

Move beyond SQLite when any of these becomes true:

- the index no longer fits comfortably on instance disk or memory;
- startup copy time violates recovery objectives;
- query concurrency exceeds vertical scaling;
- online writes or incremental multi-writer ingestion are required;
- cross-version routing or many independently promoted datasets are required.

At that point, evaluate a managed search/data platform using measured query
patterns rather than copying the SQLite schema directly.

## User-provided inputs needed later

Collect names and identifiers first. Enter secret values only through an
approved secret-management process.

### Azure

- Tenant ID, subscription ID, region, and environment names.
- Resource naming, tags, and budget owner.
- Allowed API ingress ranges or gateway requirements.
- Alert recipients and action-group destinations.
- Log and artifact retention requirements.

### D365 F&O and Power Platform

- Target environment ID and URL.
- Expected D365 application/SDK version or update policy.
- Confirmed `pac` commands and source locations for the package local
  directory, version-applicable VSIX assets, and dbrefx/XRef data.
- Power Platform application-user roles and an approving administrator.

### Identity and secrets

- Entra application/client ID for Power Platform automation.
- Tenant ID for that application.
- Client secret or certificate only if managed identity/federation cannot be
  used for the required operation.
- Hosted API key names and rotation owner.
- Existing private DNS, VNet, firewall, or certificate requirements.

### Capacity

- Measured DB and source sizes.
- Peak worker CPU, memory, disk, and duration.
- API request volume, concurrent sessions, and availability objective.
- Maximum acceptable index age and rollback retention window.

## Cost drivers

Obtain current regional estimates before deployment; do not treat this list as
pricing.

Primary cost drivers are:

- App Service plan size and always-on instance count.
- Windows VM size, disk, uptime/schedule, patching, and execution duration.
- ACR storage and image transfer.
- Blob capacity, version retention, transactions, and source downloads.
- Log Analytics ingestion and retention.
- Application Insights telemetry volume and sampling.
- Private endpoints, Front Door/WAF, and managed outbound networking.
- Cross-region or internet data transfer.
- A Windows VM is required for the current X++ SDK acquisition path.

Keep the POC low cost with one API instance, one right-sized scheduled Windows
worker, Basic ACR, Standard LRS storage, bounded log retention, VM shutdown
outside acquisition windows where operationally safe, and no premium
networking until requirements justify it.

## Assumptions and unresolved decisions

- The tenant permits a noninteractive Power Platform application user.
- The required acquisition operations are authorized and automatable through
  the selected `pac` version.
- The current PAC/macOS verification does not expose `pac tool xpp install`.
  The candidate Windows ARM64 VM successfully acquired and registered SDK
  `10.0.2645.124`, and X++ compiler `7.0.7996.111` executed under emulation.
  The CLI-only acquisition did not generate an `XPPConfig` directory.
  Noninteractive authentication, the remaining package inputs, and a complete
  worker run remain to be proven. A separate work-laptop configuration for
  application `10.0.2645.124` is a layout reference only. Microsoft identifies
  the X++ workflow as
  Windows-only.
- The worker is therefore Windows. A future platform change requires new
  Microsoft support documentation and a complete toolchain proof.
- The bundle schema, Blob prefixes, local file names, pointer concurrency, and
  acquisition lease are implemented. The Azure container name remains
  deployment-configurable.
- The initial API uses one instance and one current D365 version.
- Client routing to previous versions, two-version serving, and two-replica
  topology are deferred.
- API-key authentication is the initial client mechanism; Entra-based API
  authentication remains a hardening option.
- Region pairing, zone redundancy, and geo-redundant storage depend on the
  production recovery objectives.

## Microsoft guidance

- [Jobs in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/jobs)
- [`pac auth` reference](https://learn.microsoft.com/power-platform/developer/cli/reference/auth)
- [`pac tool` reference](https://learn.microsoft.com/power-platform/developer/cli/reference/tool)
- [Power Platform CLI installation and OS support](https://learn.microsoft.com/power-platform/developer/cli/introduction)
- [Microsoft Dataverse X++ skill: Windows-only prerequisite](https://github.com/microsoft/Dataverse-skills/blob/main/.github/plugins/dataverse/skills/erp-xpp/SKILL.md)
- [Power Platform authentication](https://learn.microsoft.com/power-platform/admin/programmability-authentication)
- [Managed identities for App Service](https://learn.microsoft.com/azure/app-service/overview-managed-identity)
- [Key Vault references for App Service](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references)
- [Manage concurrency in Blob Storage](https://learn.microsoft.com/azure/storage/blobs/concurrency-manage)
- [Create and manage Blob leases with JavaScript or TypeScript](https://learn.microsoft.com/azure/storage/blobs/storage-blob-lease-javascript)
- [Authenticate JavaScript apps to Azure with `DefaultAzureCredential`](https://learn.microsoft.com/azure/developer/javascript/sdk/authentication/overview)
- [Blob Storage architecture best practices](https://learn.microsoft.com/azure/well-architected/service-guides/azure-blob-storage)
- [Prevent Shared Key authorization](https://learn.microsoft.com/azure/storage/common/shared-key-authorization-prevent)
- [Container Apps image pull with managed identity](https://learn.microsoft.com/azure/container-apps/managed-identity-image-pull)
- [App Service VNet integration](https://learn.microsoft.com/azure/app-service/overview-vnet-integration)
- [Observability in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/observability)
- [Secure App Service deployments](https://learn.microsoft.com/azure/app-service/overview-security)
