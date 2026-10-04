# Hosted deployment

The production service has two trust zones: a private index-acquisition worker and a public
read-only MCP API. Developer workstations do not build or upload production indexes.

## Target architecture

```text
Scheduled Azure worker
  Entra workload identity / service principal
       |
       | pac CLI: download approved D365 SDK assets
       v
isolated candidate directory
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
2. Download SDK assets into a new private candidate directory and record non-secret source
   provenance.
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
d365-fno-mcp-server acquire --config C:\worker\acquisition.json --run-id scheduled-2026-10-04
```

The scheduler supplies a stable, unique run ID. Reusing an ID after success is a no-op; reusing one
after failure removes the incomplete work directory and starts a numbered retry. Each run writes
`<runsRoot>/<runId>/status.json` with acquire, build, bundle, validate, publish and cleanup phase
states. The status document is the validation evidence: it includes the immutable bundle ID,
individual validation checks and the promoted pointer revision. The run's `work` directory is
removed after success, failure, cancellation or timeout unless `retainWorkDirectory` is explicitly
enabled for a secured diagnostic environment.

The JSON configuration has this shape:

```json
{
  "runsRoot": "C:\\worker\\runs",
  "sourceDatabase": "candidate\\d365_index.db",
  "bundleOptionsFile": "bundle-options.json",
  "timeoutMs": 7200000,
  "acquire": [
    {
      "name": "acquire-ude-assets",
      "executable": "pwsh.exe",
      "args": ["-NoProfile", "-File", "C:\\worker\\scripts\\acquire-ude-assets.ps1", "-OutputDirectory", "${WORK_DIR}\\assets"]
    }
  ],
  "build": [
    {
      "name": "build-index",
      "executable": "d365-fno-mcp-server.cmd",
      "args": ["index", "--force", "--packages-dir", "${WORK_DIR}\\assets\\PackagesLocalDirectory", "--db-path", "${SOURCE_DB}"]
    },
    {
      "name": "import-xref",
      "executable": "d365-fno-mcp-server.cmd",
      "args": ["index-xref", "--db-path", "${SOURCE_DB}"]
    }
  ],
  "policy": {
    "serverVersion": "0.1.0",
    "minimumIndexSchemaVersion": 3,
    "maximumIndexSchemaVersion": 3,
    "requiredCapabilities": ["codeMetadata", "dataModelMetadata", "securityGraphs"]
  },
  "destination": {
    "type": "azure-blob",
    "accountUrl": "https://example.blob.core.windows.net",
    "containerName": "d365-artifacts"
  }
}
```

Command placeholders are limited to `${RUN_DIR}`, `${WORK_DIR}`, `${SOURCE_DB}` and
`${BUNDLE_OPTIONS_FILE}`. The acquisition/build process must write the source database and a
`CreateArtifactBundleOptions` JSON document at the configured relative paths. Use command
environment variables for credentials; never put secrets, connection strings, SAS URLs or tokens
in arguments or the bundle-options document. The worker discards child output and reports only
step names and exit status, so command output cannot leak credentials into worker logs.

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

## Operations

| Task | Action |
| --- | --- |
| Refresh | Run the scheduled worker; promotion occurs only after validation |
| Roll back | Swap the active/previous pointer to the retained validated bundle and signal the API |
| Rotate client access | Rotate the named API-key secret and recycle the API |
| Rotate acquisition credentials | Add a new Key Vault secret version, update the worker, verify, then retire the old credential |
| Diagnose mismatch | Compare the worker-recorded application version with `X-D365-Client-Sdk-Version` |
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
