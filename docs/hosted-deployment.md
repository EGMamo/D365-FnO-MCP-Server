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
8. Signal the API. Each replica validates the selected bundle, copies it to a sibling candidate on
   local disk and atomically activates that local file. Existing sessions may finish on the prior
   read-only handle.

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

The Azure resource template must be revised together with the acquisition worker. Do not deploy the
legacy SAS/manifest topology from an older checkout.
