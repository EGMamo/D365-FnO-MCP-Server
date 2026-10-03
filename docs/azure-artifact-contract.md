# Azure artifact contract

The private acquisition worker and the read-only MCP API exchange one immutable, machine-validated
D365 index bundle. This contract is the deployment gate for the replacement Azure infrastructure:
storage paths, worker packaging and infrastructure templates must carry this contract rather than
inventing a second publication format.

The implementation is in:

- `src/indexer/artifactContract.ts` — strict schemas, canonical JSON, bundle identity, hashes and
  compatibility checks;
- `src/indexer/artifactBundle.ts` — bundle producer, validator and local API snapshot activation;
- `src/indexer/artifactPointers.ts` — concurrency-safe active/previous promotion and rollback;
- `src/indexer/indexSnapshot.ts` and `src/indexer/indexActivation.ts` — compact SQLite snapshots and
  same-volume local activation.

## Durable store layout

```text
artifact store
├── bundles/
│   └── <64-character bundle hash>/
│       ├── manifest.json
│       ├── d365_index.db
│       └── validation-report.json
└── deployment-pointers.json
```

A finalized bundle directory is immutable. Its ID is
`sha256:<canonical-manifest-identity-hash>`. The identity includes the database and validation-report
hashes, provenance, capabilities and compatibility declarations. `manifest.json` is written last in
the staging directory, and the complete directory is renamed into `bundles/` in one operation.

`deployment-pointers.json` is the only mutable publication document. It contains a monotonically
increasing revision plus `active` and `previous` bundle references. Promotion validates the complete
target bundle before atomically replacing this document. The caller must supply the revision it
read; a stale revision fails instead of overwriting a competing promotion. The filesystem
implementation uses an exclusive lock as the local reference implementation. The Azure Blob adapter
uses an acquisition lock lease plus conditional ETag writes for the same behavior.

Rollback swaps `active` and `previous`. It never rebuilds or changes either bundle.

## Manifest requirements

Contract name: `d365-fno-index-bundle`  
Contract version: `1`

Every manifest records:

- an immutable bundle ID and `validated` lifecycle state;
- created, built and published timestamps;
- authoritative four-part D365 application and SDK versions plus release identity;
- generator name/version and SQLite index schema version;
- database path, byte count, SHA-256 and object/label/usage counts;
- validation-report path, byte count and SHA-256;
- source provenance for PackagesLocalDirectory, exactly two VSIX assets, dbrefx/XRef and optional
  inputs; each entry has a non-secret source ID, version, acquisition time, byte count and SHA-256;
- completeness for code metadata, data-model metadata, UI/form patterns, workflow/service metadata,
  reporting/analytics, labels/resources, extensions, reports and security graphs;
- minimum/maximum compatible server versions, required index schema and required capabilities.

The producer does not silently infer missing provenance or call a partial capability complete. These
inputs are explicit worker outputs and are validated against the contract. A required capability must
be marked complete.

## Validation and consumption

Before a bundle can be promoted or consumed:

1. Parse all documents with strict schemas; unknown properties are rejected.
2. Recompute the content-addressed bundle ID.
3. Enforce contract, server-version, index-schema and required-capability compatibility.
4. Require a passing validation report whose individual checks all pass.
5. Verify database and report sizes and SHA-256 values.
6. Run SQLite `quick_check`, compare the object count, and verify schema and D365 application
   versions against the manifest.

The hosted API must not open SQLite directly from Blob Storage or a shared network filesystem. Each
replica validates the selected immutable bundle, copies `d365_index.db` to a sibling candidate on
local ephemeral/persistent disk, verifies the copied hash, closes its old handle, and atomically
renames the candidate into the configured active path. It then reopens that local file read-only.
Existing requests may finish against the prior read-only handle.

Missing, rejected, partial, corrupt, incompatible or capability-deficient bundles fail closed and
leave the current local database untouched.

## Read/write boundary

The acquisition worker writes only its private scratch space, immutable artifact bundles and the
deployment pointer. The hosted API reads the pointer and bundles and writes only its own local runtime
snapshot. It cannot acquire SDK packages, publish bundles or modify developer workspaces.

The Visual Studio loopback gateway forwards client context and hosted MCP requests. Local workspace
writes, when later supported through a provider-verified bridge, remain local and never enter the
Azure artifact flow. Developer-built indexes and direct upload routes are not part of this contract.

## Azure adapter

`src/indexer/azureBlobArtifactStore.ts` implements the Azure storage boundary, and
`src/indexer/azureBlobArtifactStoreSdk.ts` binds it to the Azure SDK with
`DefaultAzureCredential`; no credentials or account keys are stored in the repository. It preserves
these invariants:

- upload a bundle under a never-reused bundle ID;
- use create-only writes for bundle members;
- publish only after the same validation passes in the durable store;
- update the pointer with ETag/lease concurrency control;
- retain every referenced active/previous bundle;
- grant the API read access only and the worker create/promote access;
- log bundle ID, pointer revision and validation outcome without logging credentials or signed URLs.

The adapter uses bounded, hash-verified downloads and revalidates the complete durable bundle before
promotion. Its lease-scoped writer prevents retention from deleting active or previous bundles.
Infrastructure deployment remains blocked until Windows acquisition proof and worker integration are
complete and the deployed API startup/reload path invokes the fail-closed consumer.
