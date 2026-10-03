# Azure infrastructure

The legacy App Service template was removed because it depended on developer-published manifests,
long-lived SAS URLs and direct index uploads. Those paths are no longer supported.

The replacement template will be added with the Azure acquisition worker. It must provision:

- a private scheduled worker with managed identity and Key Vault access;
- isolated candidate storage plus active and previous index slots;
- a read-only MCP API identity;
- atomic candidate promotion and explicit rollback;
- named API-key storage for MCP clients;
- logging, health checks and least-privilege RBAC.

Infrastructure implementation is gated by the versioned
[Azure artifact contract](../docs/azure-artifact-contract.md). Exact container and path names remain
provisional until the Blob adapter implements immutable create-only bundles and ETag/lease-protected
active/previous pointer updates.

Do not restore or deploy the old `D365_INDEX_URL`, `D365_INDEX_UPLOAD_KEYS` or
`D365_INDEX_PUBLISH_URL` topology. See
[Hosted deployment](../docs/hosted-deployment.md) for the current architecture contract.
