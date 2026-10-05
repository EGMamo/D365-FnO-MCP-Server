# Azure infrastructure

`main.bicep` provisions one environment of the hosted service into an existing resource group,
following the [Azure resource guide](../docs/azure-resource-guide.md) and the
[Azure artifact contract](../docs/azure-artifact-contract.md).

## Deploy with the scripts

Two PowerShell 7 scripts deploy an environment into any tenant and subscription. Neither contains
a tenant, subscription or resource name: they take them from parameters or the Azure CLI context.

```powershell
# Infrastructure: sign-in, providers, resource group, generated parameters, what-if, deploy.
./scripts/azure-deploy.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> `
  -ResourceGroup <resource-group> -Location <region> -EnvironmentName <env> -AlertEmail <address>

# Operator steps after the first deployment (see below). Reads every name from the deployment outputs.
# Without -DataverseUrl and -WorkerApplicationId it stops after setting up the worker VM.
./scripts/azure-post-deploy.ps1 -ResourceGroup <resource-group> -DataverseUrl https://<org>.crm.dynamics.com `
  -WorkerApplicationId <app id>
```

`azure-deploy.ps1` writes `infra/main.<env>.local.bicepparam` (git-ignored, no secret values), keeps
the running API image on redeploys, prompts for the worker VM password without echo unless
`D365_WORKER_ADMIN_PASSWORD` is set, and asks before deploying. `-WhatIfOnly` stops after the
what-if; `-PostDeploy` continues straight into `azure-post-deploy.ps1`. Add `-UseDeviceCode` to sign
in with a device code (`az login --use-device-code`) instead of a browser, for example over SSH or
when the browser sign-in is blocked. Both scripts document their
parameters in `Get-Help`.

Both scripts take `-LogLevel Error|Warning|Info|Verbose|Debug` (default `Info`); `-Verbose` and
`-Debug` also work. `Verbose` adds each az command, the values behind each decision and step
timings, and passes `--verbose` to az; `Debug` adds internal values and passes `--debug`. Calls that
send or return a secret (the deployment that carries the worker password, Key Vault tokens, your
`-AcquisitionConfig`) never get those az flags, because `az --debug` logs whole requests and
responses. `Error` prints only errors and what the questions ask about. On `azure-post-deploy.ps1`
a level you pass also applies to the Run Command scripts on the worker, and `PrepareWorker` records
it in `acquisition.json`, so `acquire-ude-sources.ps1`, AzCopy and the Node worker use it in the
first and the scheduled acquisitions. Run `PrepareWorker` again without a level to go back to the
default; a worker set up before this option needs `SetupWorker` first.

To deploy by hand instead, run a what-if first and review it:

```bash
export D365_WORKER_ADMIN_PASSWORD='<from your secret store>'
az deployment group what-if -g <resource-group> -p infra/main.dev.bicepparam
```

Do not restore or deploy the old `D365_INDEX_URL`, `D365_INDEX_UPLOAD_KEYS` or
`D365_INDEX_PUBLISH_URL` topology.

## Cost profiles

`costProfile` picks the sizing without changing the architecture. `azure-deploy.ps1 -CostProfile`
sets it, defaulting to `cheapest` for environment names starting with `dev` and `standard`
otherwise; `main.dev.bicepparam` uses `cheapest`.

| Setting | `standard` | `cheapest` |
| --- | --- | --- |
| App Service plan (`apiPlanSku` overrides) | P1v3, 8 GB | P0v3, 4 GB |
| Worker OS and data disks (`workerDiskType` overrides) | Premium SSD | Standard SSD |
| Container registry | Premium with a private endpoint | Basic, no private endpoint; the API pulls with its identity over the public endpoint |
| `/health` availability test | 3 locations every 5 minutes | 2 locations every 15 minutes |

The rough monthly difference in West Europe is about $470 for `standard` and $290 for `cheapest`,
with the worker VM running about 3 hours a night. P0v3 is the smallest plan with slots; the
staging slot shares its 4 GB during a deployment, so if the memory alert fires or the slot fails
to become ready, set `apiPlanSku=P1v3`. Storage and Key Vault keep their private endpoints in both
profiles because organization policies commonly require them.

Moving an existing environment between profiles: the plan, registry SKU and availability test
update in place, but a disk's type only changes while the VM is deallocated, and a Premium registry
cannot drop to Basic while it has a private endpoint. `azure-deploy.ps1` detects both and stops;
rerun it with `-ReplaceIncompatible` to convert them (disk contents and images are kept).
`-RemoveExistingResources` instead deletes every resource in the group except the Key Vaults (purge
protection reserves vault names for 90 days) before deploying. It lists them and requires typing the
resource group name, even with `-Yes`; storage bundles, registry images and the worker disks are
lost, so run `azure-post-deploy.ps1`, the Deploy workflow and a first acquisition again afterwards.

## Pausing an environment

`scripts/azure-pause.ps1 -ResourceGroup <group>` cuts an idle environment to a few dollars a month
while keeping what a resume needs. It deletes the App Service app and plan, the worker VM with its
NIC and disks, the NAT gateway and its public IP, the private endpoints, the availability test, the
alert rules and every GitHub federated credential on the deploy identity. It keeps the storage
account (the artifact bundles the API loads), the Key Vaults, the managed identities with their
role assignments, the registry
and its images, Log Analytics and Application Insights, the VNet, NSGs and private DNS zones, and
the scheduler Logic App (disabled). Only resources tagged with the deployment's `workload` and
`environment` are deleted; names come from the newest successful deployment.

Run it with `-WhatIfOnly` first to see the list. It stops while the worker VM is running, records
the API image and scheduler state as `d365mcp-paused-*` tags on the resource group, then asks you
to type the group name. What stays billed is mostly storage by GB and the registry (Basic about $5
a month, Premium about $50, so move to `cheapest` first if it is still Premium).

To resume, run `azure-deploy.ps1` with the same resource group and environment name. It recreates
the deleted resources, deploys the image recorded at pause time and removes the tags; the API pulls
the active bundle from storage when it starts, so no acquisition run is needed. The GitHub
`production` environment's values stay valid because the identities were kept, but the Deploy
workflow can sign in only after `azure-github-trust.ps1` (below) runs again. The new worker VM
starts empty, so run `azure-post-deploy.ps1 -Step SetupWorker,PrepareWorker` before the next
acquisition and `-Step ResumeScheduler` if scheduled runs were on.

## GitHub trust

The template names no GitHub owner or repository. `scripts/azure-github-trust.ps1 -ResourceGroup
<group>` adds the one federated credential the Deploy workflow needs, `github-production` on the
deploy identity, for the repository of the clone's `origin` remote (or `-Repository owner/name`).
It looks up the owner and repository IDs on GitHub and uses the ID-based subject
`repo:<owner>@<owner-id>/<name>@<repo-id>:environment:production`, which GitHub sends for
repositories created, renamed or transferred after 15 July 2026; `-SubjectFormat Name` uses
`repo:<owner>/<name>:environment:production` for older ones. It deletes any other GitHub credential
on the identity, so one repository is trusted at a time. `-Remove` deletes them all.
`azure-post-deploy.ps1 -Step GitHub` runs it before it configures the environment. After moving
the repository, run it again from a clone of the new location: the owner ID changes.

## What it creates

| Module | Resources |
| --- | --- |
| `monitoring` | Log Analytics workspace, workspace-based Application Insights (local auth off), action group |
| `network` | VNet with app-integration, private-endpoint and worker subnets; NAT gateway for egress; deny-all inbound NSGs; private DNS zones for Blob, Key Vault and ACR |
| `identities` | User-assigned identities for the API, the worker and the GitHub deploy workflow. The deploy identity has no federated credential until `scripts/azure-github-trust.ps1` adds one |
| `storage` | StorageV2 account with Shared Key and public blob access disabled; `d365-artifacts`, `d365-sources` and `d365-operations` containers; versioning and soft delete; lifecycle rules that never touch bundles |
| `keyVault` (x2) | One RBAC vault for API secrets and one for worker secrets, purge protection on. Separate vaults keep the internet-facing API's identity away from the worker's Power Platform credential; vaults have no fixed cost |
| `registry` | ACR with admin user and anonymous pull disabled (Premium with a private endpoint when private networking is on, except in the `cheapest` profile) |
| `apiApp` | Linux App Service plan, the web app and a `staging` slot running the API container |
| `worker` | Windows Server VM (no public IP, Trusted Launch, platform patching), Azure Monitor Agent, and a Logic App that runs `acquire` on schedule |
| `alerts` | Health, availability, 5xx, CPU, memory, 401 bursts, Blob 403s, worker run failure and freshness |

`enablePrivateNetworking` (default `true`) puts Storage, both vaults and ACR behind private endpoints
with public access disabled and integrates the API with the VNet. ACR stays publicly reachable for
authenticated pushes from GitHub-hosted runners unless `registryPublicNetworkAccess` is `false`; the
API still pulls over the private endpoint.

The app and worker subnets also carry `Microsoft.Storage` and `Microsoft.KeyVault` service
endpoints, and the storage account and both vaults list those subnets in their firewall VNet rules.
The private endpoints remain the access path; the VNet rules exist because some organizations deny
storage accounts and vaults that have none (for example a "storage accounts require VNet ACLs"
policy). `storageAllowedIpRanges` adds IP rules to the storage firewall when private networking is
off.

### Organization policies

Deployments into a governed subscription can be denied by policy at preflight. The template already
meets the common baselines (TLS 1.2, HTTPS only, no Shared Key or public blob access, RBAC vaults
with purge protection, no VM public IP, Trusted Launch, local auth off for monitoring). Settings that
stricter policies may still reject, and the parameter that changes them:

| Resource | Setting a policy may deny | Option |
| --- | --- | --- |
| Container registry | Public network access for GitHub-hosted pushes | `registryPublicNetworkAccess=false` with a self-hosted runner in the VNet |
| Web app | Public network access (the API is internet-facing) | `allowedIngressCidrs` to restrict callers; a policy exemption otherwise |
| Worker VM | No encryption at host or customer-managed disk keys | Needs the `EncryptionAtHost` feature registered; not set by default |
| Any resource | Required tags | `-Tags @{ key = 'value' }` on `azure-deploy.ps1` |
| Any resource | Allowed regions or VM sizes | `-Location`, `workerVmSize` |

`azure-deploy.ps1` prints each denied resource and the policy's message when a deployment fails.
A failed deployment can leave some resources behind; rerunning the script redeploys incrementally
over them.

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
instance-local disk, validates it and opens it. Until then `/health` (readiness) answers 503 while
`/live` (liveness) answers 200; App Service health checks and slot swap warm-up both use `/health`.
The template sets:

| Setting | Value |
| --- | --- |
| `D365_ARTIFACT_ACCOUNT_URL` | the storage account's Blob endpoint |
| `D365_ARTIFACT_CONTAINER` | `d365-artifacts` |
| `D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID`, `AZURE_CLIENT_ID` | the API identity |
| `D365_ARTIFACT_SOURCE` | `azure-blob` |
| `D365_ARTIFACT_STORE_PATH` | `/data/artifacts` (container filesystem, writable by the runtime user) |
| `D365_INDEX_DB_PATH` | `/data/d365_index.db` (container filesystem) |
| `WEBSITES_ENABLE_APP_SERVICE_STORAGE` | `false`, so nothing lands on the `/home` network share |
| `WEBSITES_CONTAINER_START_TIME_LIMIT` | `1800` seconds for download and validation |
| `MCP_API_KEYS` | Key Vault reference to the `mcp-api-keys` secret |
| `TRUST_PROXY_HOPS` | `1` (App Service front end) |

These names match the startup materialization in the server configuration (`src/configLoader.ts`).

## Deployment and rollback

`.github/workflows/deploy.yml` pushes the image, starts it in the `staging` slot, waits for the slot
to report healthy (it has then materialized and validated the bundle), smoke-tests `/mcp` and swaps.
The swap warm-up pings `/health` again and aborts if the slot is not ready. If production is not
healthy after the swap, the workflow swaps back. It then stops `staging` while production is
healthy (otherwise it leaves `staging` running and warns), and the next deployment starts it again.

Disk: each App Service instance has a 15 GB host disk for images and container data that is not
expandable and is shared by every container in the plan, both slots included
([App Service on Linux FAQ](https://learn.microsoft.com/troubleshoot/azure/app-service/faqs-app-service-linux-new#custom-containers)).
A running slot keeps one copy of the index in its container (the downloaded bundle and the active
database are hard links to the same file), so a deployment briefly needs room for two copies and
production alone holds one between deployments.

Rollback paths:

- **Image:** after a successful deployment the stopped `staging` slot holds the previous image;
  after a failed one it holds the candidate that failed. Check with `az webapp config show --slot
  staging --query linuxFxVersion`, and if needed point it at a known-good tag (deployments tag
  images with the commit SHA) with `az webapp config container set --slot staging
  --container-image-name <registry>/d365-fno-mcp-server:<tag>`. Then start it (`az webapp start
  --slot staging`), wait until its `/health` answers 200, swap, and stop `staging` again.
- **Index:** run `node F:\worker\app\dist\src\index.js artifact rollback --expected-revision <n>`
  on the worker VM through Run Command (`az vm start`, then `az vm run-command invoke
  --command-id RunPowerShellScript --scripts @rollback.ps1`), with `D365_ARTIFACT_ACCOUNT_URL`,
  `D365_ARTIFACT_CONTAINER` and `D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID` set in the script from
  the deployment outputs; it reaches Storage privately. Then restart the web app so each instance
  pulls the previous bundle; `/health` answers 503 until it has. To keep the API available instead,
  set `staging` to production's image first (a swap also exchanges images), then start it, wait for
  its `/health`, swap and stop it again.

Infrastructure-only redeploys must pass the currently deployed image as `apiImage`, or the web app
and slot are reset to that parameter's value.

## Worker schedule

The worker VM is deallocated between runs. At each `workerScheduleHoursUtc` hour the Logic App starts
it, runs this through managed Run Command with run ID `scheduled-<yyyyMMddTHHmmZ>`:

```powershell
node <workerRoot>\app\dist\src\index.js acquire --config <workerRoot>\acquisition.json --run-id <run id>
```

then deallocates the VM whatever the outcome, and fails its own run (raising the worker-run alert)
if acquisition or the deallocation failed. The worker's Blob acquisition lease remains the guard
against overlapping runs.

A new environment is created with the schedule off (`workerSchedulerEnabled = false`), so nothing
runs before the worker is prepared. `azure-post-deploy.ps1` turns it on after the first acquisition
succeeds, and `azure-deploy.ps1` keeps it on for later redeploys. A hand-run redeploy must pass
`workerSchedulerEnabled = true` once the schedule is on, or it is turned off again. The trigger has
a fixed past start time, so saving or enabling the workflow does not start a run.

To see recent runs and why one failed:

```powershell
az rest --method get --url "/subscriptions/{subscriptionId}/resourceGroups/<group>/providers/Microsoft.Logic/workflows/<scheduler>/runs?api-version=2019-05-01&`$top=5" `
  --query "value[].{run:name, status:properties.status, start:properties.startTime, error:properties.error.message}" -o table
az rest --method get --url "/subscriptions/{subscriptionId}/resourceGroups/<group>/providers/Microsoft.Logic/workflows/<scheduler>/runs/<run>/actions?api-version=2019-05-01" `
  --query "value[].{action:name, status:properties.status, code:properties.code}" -o table
```

`<scheduler>` is the deployment's `schedulerName` output. The worker's own report for a run is
`<workerRoot>\runs\scheduled-<time>\status.json`, with step output in the `logs` folder next to it.

## Operator steps outside the template

These are deliberately not done by the template. `scripts/azure-post-deploy.ps1` runs them from an
operator machine, reading every name from this deployment's outputs (`Get-Help` lists its steps).
Every VM step goes through Run Command, so the worker needs no RDP, Bastion or inbound rule.

```powershell
./scripts/azure-post-deploy.ps1 -ResourceGroup <group> -DataverseUrl https://<org>.crm.dynamics.com `
  -WorkerApplicationId <app id>
```

1. Create the `mcp-api-keys` secret in the API vault and the Power Platform client secret in the
   worker vault. Never put secret values in parameter files, source control, logs or chat.
2. Initialize and format the worker data disk and install Node.js 24, AzCopy and a build of the
   current `master` commit of `-Repository` (default this repository) under `F:\worker\app`
   (`SetupWorker`). Rerun it to pick up worker changes. The scripts assume the default
   `workerRoot` of `F:\worker`.
3. Check that the worker can read the secret, sign in to Dataverse, read the Finance and
   Operations version and resolve the X++ SDK downloads, then write `F:\worker\acquisition.json`
   with the destination from the deployment outputs (`PrepareWorker`).
4. Publish, promote and verify a first bundle (`FirstAcquisition`); until then the API fails
   closed. Then re-enable the scheduler.
5. Let the repository's `production` jobs sign in as the deploy identity, configure that
   environment with the outputs listed in `deploy.yml` (`GitHub`) and run the Deploy workflow.

Two things only you can do, before `PrepareWorker`:

- Create a dedicated app registration for the worker, store its client secret with
  `SeedWorkerSecret`, and add it as an application user with a security role in the Power Platform
  environment (Power Platform admin center, the environment, Settings > Users + permissions >
  Application users). Give it Basic User; if `PrepareWorker` reports a missing privilege, add it
  through a custom role. Avoid System Administrator, because code on the worker can read this
  secret.
- Decide how to import the cross-reference (XRef) data. The worker downloads and hashes the
  backup for provenance, but restoring it needs a SQL Server, so bundles have no XRef usages yet.

## Validation

CI builds and lints the templates (`infra` job). Locally:

```bash
bicep build infra/main.bicep --stdout > /dev/null
bicep lint infra/main.bicep
D365_WORKER_ADMIN_PASSWORD=placeholder bicep build-params infra/main.dev.bicepparam --stdout > /dev/null
```
