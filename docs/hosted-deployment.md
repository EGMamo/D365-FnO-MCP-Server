# Hosted deployment

The production service has two trust zones: a private index-acquisition worker and a public
read-only MCP API. Developer workstations do not build or upload production indexes.

## Target architecture

```text
Scheduled Azure worker
  Entra workload identity / service principal
       |
       | Dev Tools service: download the X++ SDK and assets for the environment's version
       v
per-version source cache -> new run work directory
  parse -> build SQLite -> import approved data -> validate
       |
       | emit immutable, content-addressed bundle
       v
artifact store + atomic active/previous pointer
       |
       | validate -> copy to local sibling -> atomic local activation
       v
read-only MCP API -> HTTPS/API key -> Visual Studio gateway -> Copilot
```

The worker and API use separate identities. The API identity has read-only access to promoted
artifacts and cannot acquire SDK packages or promote candidates. The worker has no public MCP
endpoint.

## Index lifecycle

1. Authenticate noninteractively. Prefer managed identity where the acquisition endpoint supports
   it; otherwise store the Entra application secret in Key Vault and grant only the worker access.
2. Download SDK assets once per version into the worker's private cache and record non-secret
   source provenance. Each run builds its candidate in a new work directory.
3. Build a new SQLite database. Never update the active database in place.
4. Validate SQLite integrity, schema version, required metadata, object counts, source-path
   sanitization, four-part D365 application version, capability completeness and source hashes.
5. Stop promotion on any failed check and retain the current active index.
6. Finalize an immutable bundle containing the database, manifest and validation report.
7. Atomically update the active/previous pointer document with optimistic concurrency. Keep every
   referenced bundle for rollback.
8. Restart or slot-swap the API. With `D365_ARTIFACT_SOURCE=azure-blob`, each replica listens
   unready, reads the active pointer with managed identity and pins its ETag, downloads the
   immutable bundle to local disk, validates it, atomically activates the local copy and reports
   ready on `/health` only after a representative query. See the README section "Hosted startup
   from Azure Blob".

## Scheduled acquisition worker

Run one private worker cycle with:

```powershell
node F:\worker\app\dist\src\index.js acquire --config F:\worker\acquisition.json --run-id scheduled-2026-10-04
```

The scheduler supplies a stable, unique run ID. Reusing an ID after success is a no-op; reusing one
after failure removes the incomplete work directory and starts a numbered retry. Each run writes
`<runsRoot>/<runId>/status.json` with acquire, build, bundle, validate, publish and cleanup phase
states. The status document is the validation evidence: it includes the immutable bundle ID,
individual validation checks and the promoted pointer revision. The run's `work` directory is
removed after success, failure, cancellation or timeout unless `retainWorkDirectory` is explicitly
enabled for a secured diagnostic environment.

`scripts/azure-post-deploy.ps1 -Step PrepareWorker` writes the configuration for the Azure worker.
It has this shape:

```json
{
  "runsRoot": "F:\\worker\\runs",
  "sourceDatabase": "d365_index.db",
  "bundleOptionsFile": "bundle-options.json",
  "timeoutMs": 19800000,
  "acquire": [
    {
      "name": "acquire-ude-sources",
      "executable": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "args": ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", "F:\\worker\\app\\scripts\\worker\\acquire-ude-sources.ps1",
        "-TenantId", "<tenant>", "-ApplicationId", "<app>",
        "-DataverseEnvironmentUri", "https://contoso.crm.dynamics.com",
        "-SecretName", "power-platform-client-secret", "-CacheRoot", "F:\\worker\\cache",
        "-SourcesFile", "${WORK_DIR}\\sources.json"]
    }
  ],
  "build": [
    {
      "name": "prepare-bundle",
      "executable": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["F:\\worker\\app\\dist\\src\\index.js", "prepare-bundle",
        "--sources", "${WORK_DIR}\\sources.json", "--db-path", "${SOURCE_DB}",
        "--bundle-options", "${BUNDLE_OPTIONS_FILE}"]
    }
  ],
  "destination": {
    "type": "azure-blob",
    "accountUrl": "https://example.blob.core.windows.net",
    "containerName": "d365-artifacts",
    "managedIdentityClientId": "<worker identity client id>"
  }
}
```

`acquire-ude-sources.ps1` reads the Power Platform client secret from the worker Key Vault with the
worker's managed identity, asks Dataverse for the environment's Finance and Operations version, and
downloads the X++ SDK (`systemmetadata`, the package `pac tool xpp install` uses), the Visual Studio
tools VSIX and the cross-reference backup for that version from the Dev Tools service. It keeps the
extracted SDK per version under `F:\worker\cache\<version>\PackagesLocalDirectory`, so a run for an
unchanged version downloads nothing, and writes `sources.json` with each file's size and SHA-256.
`prepare-bundle` indexes that SDK and writes the bundle options with that provenance. Nothing needs
PAC, RDP or a signed-in user. The cross-reference backup is recorded but not imported: restoring it
needs a SQL Server the worker does not have, so hosted bundles carry no XRef usages. This is an
intentional deployment boundary: the worker does not provision a SQL Server or restore the backup.
The hosted `get_usage_snapshot_status` tool therefore reports `not-imported`; an empty
`find_usages` result does not prove that an object is unused. Local operators can still restore the
backup to a SQL Server and run `index-xref` against it when they build their own index.

`PrepareWorker -LogLevel <level>` (or `-Verbose`, `-Debug`) adds `-LogLevel <level>` to the acquire
step's `args` and an `env` with the matching `MCP_LOG_LEVEL` (`ERROR`, `WARN`, `INFO`, or `DEBUG` for
`Verbose` and `Debug`) to the build step, so scheduled runs log at that level. No level prints the
client secret, a token or a SAS query string.

Without `policy`, the worker applies the API's startup checks: this server's version, its index
schema version, and the capabilities the indexer covers completely (none yet, see
`src/indexer/capabilityCoverage.ts`).

Command placeholders are limited to `${RUN_DIR}`, `${WORK_DIR}`, `${SOURCE_DB}` and
`${BUNDLE_OPTIONS_FILE}`. A custom pipeline (`-Step UploadConfig -AcquisitionConfig <file>`) must
write the source database and a `CreateArtifactBundleOptions` JSON document at the configured
relative paths. Commands run without a shell, so name an `.exe` (`powershell.exe`, `node.exe`)
rather than a `.cmd` wrapper. Read credentials at run time from the worker Key Vault (for example
with `F:\worker\bin\Get-WorkerSecret.ps1`); never put secrets, connection strings, SAS URLs or
tokens in arguments, `env` values (stored literally in the file) or the bundle-options document. Each step's output is kept in `<runsRoot>\<runId>\logs`; `SetupWorker`
limits the worker folder to SYSTEM and Administrators, and steps must still not print credentials.

`destination.type` may be `local` with `storeRoot`, or `azure-blob` with `accountUrl`,
`containerName`, and optional `managedIdentityClientId`. Azure publication obtains the existing
acquisition lease, uploads and verifies the immutable bundle, then conditionally promotes the
pointer. Local publication performs the same validate-before-pointer-update sequence. Cancellation
(`SIGINT`/`SIGTERM`) and the run timeout stop the current child process, skip publication, preserve
the active pointer and still execute cleanup.

The repository retains reusable `indexSnapshot` and `indexActivation` primitives for candidate
validation and same-volume atomic replacement. It also implements the local versioned
[Azure artifact contract](azure-artifact-contract.md), producer/consumer and pointer semantics. The
retired manifest download, `publish-index`, `pull-index`, direct upload routes and Visual Studio index
builder are removed.

## API configuration

The hosted API needs:

- `MCP_TRANSPORT=http`
- `MCP_API_KEYS=name=<32+ character key>,...`
- `D365_INDEX_DB_PATH=<path to the promoted active database>`
- `D365_ARTIFACT_STORE_PATH=<mounted or synchronized immutable artifact-store root>`
- `D365_ENABLE_WRITE_TOOLS=0`
- `TRUST_PROXY_HOPS=<actual trusted proxy hop count>`

It does not accept `D365_INDEX_URL`, upload keys, publish SAS URLs or index packages from clients.
Health becomes ready only after a valid active database is available.
When `D365_ARTIFACT_STORE_PATH` is configured, startup requires an active pointer, validates the
entire referenced bundle, stages its database at `D365_INDEX_DB_PATH`, and opens that local file
read-only. Any contract, compatibility, capability, checksum or SQLite failure aborts startup and
leaves the previous local snapshot untouched.

## Client connection

The Visual Studio extension is the preferred client. It stores the hosted key in Windows Credential
Manager, starts a loopback gateway, writes that gateway to `.mcp.json`, forwards the installed SDK
version and merges local workspace tools into the hosted tool list. See
[Visual Studio extension](visual-studio-extension.md).

Other clients may connect directly to `https://<api>/mcp` with `X-API-Key`, but they do not receive
Visual Studio workspace tools.

To see what a server is serving, ask it. Any valid key works. Probes belong on `/live` (liveness) and
`/health` (readiness), which are not rate limited: `/status` spends the same rate-limit budget as the MCP
routes.

```bash
curl -H "X-API-Key: $D365_MCP_API_KEY" https://<api>/status
```

The answer names the application version and build time of the index, the bundle id, pointer
revision and creation time of the bundle this replica activated at startup, and the server version.
It answers while a replica is still starting. See [Transport](../README.md#transport) for the fields.

## Operations

| Task | Action |
| --- | --- |
| Refresh | Run the scheduled worker; promotion occurs only after validation |
| Roll back | Swap the active/previous pointer to the retained validated bundle and signal the API |
| Rotate client access | Rotate the named API-key secret and recycle the API |
| Rotate acquisition credentials | Add a new Key Vault secret version, update the worker, verify, then retire the old credential |
| Check what is live | `GET /status` with a key: bundle id, pointer revision, application version and build time of what this replica activated at startup |
| Diagnose mismatch | Read `index.applicationVersion` from `GET /status` (or `get_index_stats`) and compare it with the client's `X-D365-Client-Sdk-Version` |
| Diagnose candidate failure | Inspect worker logs and validation report; do not alter the active database |

The operator CLI can publish and control the same immutable Blob artifact store without
upload keys or SAS URLs:

```bash
d365-fno-mcp-server artifact publish --bundle-dir ./artifact-store/bundles/<bundle-hash>
d365-fno-mcp-server artifact status --verify --json
d365-fno-mcp-server artifact promote --bundle-id sha256:<bundle-hash> --expected-revision <revision>
d365-fno-mcp-server artifact rollback --expected-revision <revision>
```

`promote` and `rollback` require the pointer revision read by the operator. A stale revision
fails closed through both the revision check and Azure Blob conditional ETag write. The CLI uses
`DefaultAzureCredential`; set `D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID` only when a user-assigned
managed identity is required.

`infra/main.bicep` provisions the API (with a staging slot), the scheduled Windows worker, the
artifact store, registry, vaults, identities, monitoring and private networking; see
[infra/README.md](../infra/README.md). Do not deploy the legacy SAS/manifest topology from an older
checkout.
