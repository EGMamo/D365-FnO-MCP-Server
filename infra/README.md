# Azure infrastructure

`main.bicep` provisions one environment of the hosted service into an existing resource group,
following the [Azure resource guide](../docs/azure-resource-guide.md) and the
[Azure artifact contract](../docs/azure-artifact-contract.md). It has not been deployed yet. Run a
what-if first and review it:

```bash
export D365_WORKER_ADMIN_PASSWORD='<from your secret store>'
az deployment group what-if -g <resource-group> -p infra/main.dev.bicepparam
```

Do not restore or deploy the old `D365_INDEX_URL`, `D365_INDEX_UPLOAD_KEYS` or
`D365_INDEX_PUBLISH_URL` topology.

## What it creates

| Module | Resources |
| --- | --- |
| `monitoring` | Log Analytics workspace, workspace-based Application Insights (local auth off), action group |
| `network` | VNet with app-integration, private-endpoint and worker subnets; NAT gateway for egress; deny-all inbound NSGs; private DNS zones for Blob, Key Vault and ACR |
| `identities` | User-assigned identities for the API, the worker and the GitHub deploy workflow (OIDC federated credential, no secret) |
| `storage` | StorageV2 account with Shared Key and public blob access disabled; `d365-artifacts`, `d365-sources` and `d365-operations` containers; versioning and soft delete; lifecycle rules that never touch bundles |
| `keyVault` (x2) | One RBAC vault for API secrets and one for worker secrets, purge protection on |
| `registry` | ACR with admin user and anonymous pull disabled (Premium when private networking is on) |
| `apiApp` | Linux App Service plan, the web app and a `staging` slot running the API container |
| `worker` | Windows Server VM (no public IP, Trusted Launch, platform patching), Azure Monitor Agent, and a Logic App that runs `acquire` on schedule |
| `alerts` | Health, availability, 5xx, CPU, memory, 401 bursts, Blob 403s, worker run failure and freshness |

`enablePrivateNetworking` (default `true`) puts Storage, both vaults and ACR behind private endpoints
with public access disabled and integrates the API with the VNet. ACR stays publicly reachable for
authenticated pushes from GitHub-hosted runners unless `registryPublicNetworkAccess` is `false`; the
API still pulls over the private endpoint.

## Least-privilege roles

| Identity | Role | Scope |
| --- | --- | --- |
| API | Storage Blob Data Reader | `d365-artifacts` container |
| API | Key Vault Secrets User | API vault |
| API | AcrPull | registry |
| Worker | Storage Blob Data Contributor | `d365-artifacts`, `d365-sources`, `d365-operations` containers |
| Worker | Key Vault Secrets User | worker vault |
| Deploy (GitHub) | AcrPush | registry |
| Deploy (GitHub) | Website Contributor | web app (and its slot) |
| Scheduler (Logic App) | Virtual Machine Contributor | worker VM |

No identity has a subscription or resource-group role. Assigning these roles requires the deploying
principal to hold Owner or User Access Administrator on the resource group.

## How the API gets its index

Each API instance runs the startup pull described in the architecture decision: it reads
`deployment-pointers.json` with the API identity, downloads the immutable active bundle to
instance-local disk, validates it and only then starts answering `/health`. The template sets:

| Setting | Value |
| --- | --- |
| `D365_ARTIFACT_ACCOUNT_URL` | the storage account's Blob endpoint |
| `D365_ARTIFACT_CONTAINER` | `d365-artifacts` |
| `D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID`, `AZURE_CLIENT_ID` | the API identity |
| `D365_ARTIFACT_STORE_PATH` | `/artifacts` (container filesystem) |
| `D365_INDEX_DB_PATH` | `/data/d365_index.db` (container filesystem) |
| `WEBSITES_ENABLE_APP_SERVICE_STORAGE` | `false`, so nothing lands on the `/home` network share |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `1800` seconds for download and validation |
| `MCP_API_KEYS` | Key Vault reference to the `mcp-api-keys` secret |
| `TRUST_PROXY_HOPS` | `1` (App Service front end) |

The `D365_ARTIFACT_*` names match the operator `artifact` CLI. If the startup materialization
change settles on different names, update `modules/apiApp.bicep` and `deploy.yml` with it.

## Deployment and rollback

`.github/workflows/deploy.yml` pushes the image, starts it in the `staging` slot, waits for the slot
to report healthy (it has then materialized and validated the bundle), smoke-tests `/mcp` and swaps.
The swap warm-up pings `/health` again and aborts if the slot is not ready. If production is not
healthy after the swap, the workflow swaps back.

Rollback paths:

- **Image:** swap the slots again; the previous image is still in `staging`.
- **Index:** run `d365-fno-mcp-server artifact rollback --expected-revision <n>` on the worker VM
  (it reaches Storage privately), then restart the web app so each instance pulls the previous
  bundle. Restarting `staging` first and swapping keeps the API available during the change.

Infrastructure-only redeploys must pass the currently deployed image as `apiImage`, or the web app
and slot are reset to that parameter's value.

## Worker schedule

The worker VM is deallocated between runs. At each `workerScheduleHoursUtc` hour the Logic App starts
it, runs this through managed Run Command with run ID `scheduled-<yyyyMMddTHHmmZ>`:

```powershell
node <workerRoot>\app\dist\src\index.js acquire --config <workerRoot>\acquisition.json --run-id <run id>
```

then deallocates the VM whatever the outcome and fails its own run if acquisition failed. The
worker's Blob acquisition lease remains the guard against overlapping runs.

## Operator steps outside the template

These are deliberately not automated and must not be done implicitly:

1. Create the `mcp-api-keys` secret in the API vault and the Power Platform credential in the
   worker vault. Never put secret values in parameter files, source control, logs or chat.
2. Initialize and format the worker data disk, install Node.js 24, the .NET Framework PAC CLI and a
   release build of this repository under `workerRoot\app`, and write `workerRoot\acquisition.json`
   with `destination.accountUrl`, `containerName` and `managedIdentityClientId` from the deployment
   outputs.
3. Configure the GitHub `production` environment with the outputs listed in `deploy.yml`.
4. Publish and promote a first bundle before the API can become healthy; until then it fails
   closed.

## Validation

CI builds and lints the templates (`infra` job). Locally:

```bash
bicep build infra/main.bicep --stdout > /dev/null
bicep lint infra/main.bicep
D365_WORKER_ADMIN_PASSWORD=placeholder bicep build-params infra/main.dev.bicepparam --stdout > /dev/null
```
