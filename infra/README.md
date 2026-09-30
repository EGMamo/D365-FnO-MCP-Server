# Azure deployment runbook

Provisions the hosted (read-only) MCP server and the Azure SQL copy of
`DynamicsXrefDB`. The server itself never talks to SQL; only the scheduled
publish job on a developer or build machine does. For how the pieces fit
together and how users connect, see [`docs/hosted-deployment.md`](../docs/hosted-deployment.md).

What `main.bicep` creates:

| Resource | Purpose |
| --- | --- |
| Storage account with private `indexes` and `bacpac` containers | Published index versions; BACPAC upload for the SQL import |
| Azure Container Registry (Basic) | Server image |
| Key Vault (RBAC) with `MCP-API-KEYS`, `INDEX-SAS-URL` and optionally `INDEX-PUBLISH-SAS-URL` | Secrets the web app reads through Key Vault references |
| App Service plan (Linux) + Web App for Containers | The MCP server, one instance, system-assigned identity with `AcrPull` and `Key Vault Secrets User` |
| Azure SQL logical server + `DynamicsXrefDB` (serverless, auto-pause 60 min) | Source for `index-xref` |
| Log Analytics (optional) | Container, HTTP and platform logs |

The deploying identity needs `Contributor` plus `User Access Administrator`
(or `Owner`) on the resource group, because the template assigns roles.

## 1. Provision

```bash
az group create --name rg-d365-mcp --location westeurope

export SQL_ADMIN_PASSWORD='<strong password>'
export MCP_API_KEYS="alice=$(openssl rand -hex 32),ci=$(openssl rand -hex 32)"
export DEV_MACHINE_IP='203.0.113.10'                       # machine that runs the publish script
export PUBLISHER_PRINCIPAL_ID=$(az ad signed-in-user show --query id -o tsv)

az deployment group create --resource-group rg-d365-mcp \
  --template-file infra/main.bicep --parameters infra/main.bicepparam
az deployment group show --resource-group rg-d365-mcp --name main --query properties.outputs
```

Keep the generated `MCP_API_KEYS` value somewhere safe; hand each person their
own key. The first deployment references an image tag that does not exist yet,
so the web app stays unhealthy until step 3.

## 2. Index read access (SAS)

The web app downloads the index with a read-only, container-scoped service
SAS carried in `D365_INDEX_URL`. A service SAS signed with the account key can
be long-lived (a user-delegation SAS is capped at seven days).

```bash
SA=$(az deployment group show -g rg-d365-mcp -n main --query properties.outputs.storageAccountName.value -o tsv)
KV=$(az deployment group show -g rg-d365-mcp -n main --query properties.outputs.keyVaultName.value -o tsv)
KEY=$(az storage account keys list --account-name "$SA" --query '[0].value' -o tsv)
SAS=$(az storage container generate-sas --account-name "$SA" --account-key "$KEY" \
  --name indexes --permissions rl --expiry "$(date -u -d '+1 year' +%Y-%m-%dT%H:%MZ)" -o tsv)

az keyvault secret set --vault-name "$KV" --name INDEX-SAS-URL \
  --value "https://$SA.blob.core.windows.net/indexes/latest/manifest.json?$SAS"
```

Then redeploy with `INDEX_SAS_URL` set (so the `D365_INDEX_URL` app setting is
added), or add the app setting by hand:

```bash
az webapp config appsettings set -g rg-d365-mcp -n <webAppName> \
  --settings "D365_INDEX_URL=@Microsoft.KeyVault(VaultName=$KV;SecretName=INDEX-SAS-URL)"
```

Rotation: generate a new SAS, set a new secret version, restart the web app.
Put the expiry date in a calendar; an expired SAS makes every restart fail.

### Optional: uploads from Visual Studio

To let developers upload a new index (`upload-index` or the Visual Studio extension), name the
allowed keys and give the web app a write SAS so it can publish verified uploads:

```bash
WSAS=$(az storage container generate-sas --account-name "$SA" --account-key "$KEY" \
  --name indexes --permissions rcwl --expiry "$(date -u -d '+1 year' +%Y-%m-%dT%H:%MZ)" -o tsv)
export INDEX_UPLOAD_KEYS=alice
export INDEX_PUBLISH_SAS_URL="https://$SA.blob.core.windows.net/indexes?$WSAS"
az deployment group create -g rg-d365-mcp -f infra/main.bicep -p infra/main.bicepparam
```

This stores the URL as the `INDEX-PUBLISH-SAS-URL` secret and sets `D365_INDEX_UPLOAD_KEYS` and
`D365_INDEX_PUBLISH_URL`. Rotate it like the read SAS.

## 3. Build and deploy the image

GitHub Actions (`.github/workflows/deploy.yml`) builds the image on a `v*` tag
or on demand, pushes it to ACR, points the web app at it and waits for
`/health`. It signs in with OpenID Connect, so no secret is stored:

```bash
APP_ID=$(az ad app create --display-name d365-mcp-deployer --query appId -o tsv)
az ad sp create --id "$APP_ID"
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-production",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:environment:production",
  "audiences": ["api://AzureADTokenExchange"]
}'
# The deploy job runs in the `production` environment, so GitHub issues this
# subject for tag pushes and manual runs alike; no per-tag credential is needed.
az ad sp show --id "$APP_ID" --query id -o tsv        # -> DEPLOYER_PRINCIPAL_ID, then redeploy the Bicep
```

Repository settings:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `AZURE_CLIENT_ID` | the app registration's application (client) ID |
| Secret | `AZURE_TENANT_ID` | tenant ID |
| Secret | `AZURE_SUBSCRIPTION_ID` | subscription ID |
| Secret | `MCP_SMOKE_API_KEY` | the `ci` key from `MCP_API_KEYS` |
| Variable | `ACR_NAME` | `acrName` output |
| Variable | `WEBAPP_NAME` | `webAppName` output |
| Variable | `RESOURCE_GROUP` | `rg-d365-mcp` |

Push a tag (`git tag v0.1.0 && git push origin v0.1.0`) or run the workflow by
hand. To deploy without GitHub, build locally and push:

```bash
ACR=$(az deployment group show -g rg-d365-mcp -n main --query properties.outputs.acrName.value -o tsv)
az acr login --name "$ACR"
docker build -t "$ACR.azurecr.io/d365-fno-mcp-server:0.1.0" .
docker push "$ACR.azurecr.io/d365-fno-mcp-server:0.1.0"
az webapp config container set -g rg-d365-mcp -n <webAppName> \
  --container-image-name "$ACR.azurecr.io/d365-fno-mcp-server:0.1.0"
```

## 4. DynamicsXrefDB in Azure SQL

Export only the two tables `index-xref` reads, from the machine where the
compiler database lives (SQL Server on a dev VM, or LocalDB on a unified
development experience workstation; `SqlLocalDB info` lists instances):

```powershell
SqlPackage /Action:Export /SourceServerName:"(localdb)\MSSQLLocalDB" /SourceDatabaseName:DynamicsXrefDB `
  /TargetFile:DynamicsXrefDB.bacpac /p:TableData=dbo.References /p:TableData=dbo.Names
az storage blob upload --auth-mode login --account-name <storageAccount> --container-name bacpac `
  --file DynamicsXrefDB.bacpac --name DynamicsXrefDB.bacpac
```

Import into the (empty) database the template created:

```bash
SAS=$(az storage container generate-sas --account-name "$SA" --account-key "$KEY" --name bacpac \
  --permissions rl --expiry "$(date -u -d '+1 day' +%Y-%m-%dT%H:%MZ)" -o tsv)
az sql db import -g rg-d365-mcp -s <sqlServerName> -n DynamicsXrefDB \
  -u xrefadmin -p "$SQL_ADMIN_PASSWORD" \
  --storage-key-type SharedAccessKey --storage-key "?$SAS" \
  --storage-uri "https://$SA.blob.core.windows.net/bacpac/DynamicsXrefDB.bacpac"
```

For a refresh, drop and recreate the database first (the import needs an empty
target). BACPACs over 150 GB import faster with `SqlPackage /Action:Import`
from a VM in the same region.

Create the read-only login the import job uses (run in `master`, then in
`DynamicsXrefDB`):

```sql
-- master
CREATE LOGIN xref_reader WITH PASSWORD = '<strong password>';
-- DynamicsXrefDB
CREATE USER xref_reader FOR LOGIN xref_reader;
ALTER ROLE db_datareader ADD MEMBER xref_reader;
```

Connection string for the publish machine (store it in the user's environment
or a secret manager, never on a command line):

```text
Server=tcp:<sqlServerFqdn>,1433;Database=DynamicsXrefDB;User Id=xref_reader;Password=<password>;Encrypt=true;TrustServerCertificate=false;Connection Timeout=30;Request Timeout=120000
```

`Request Timeout` (milliseconds) matters: the driver's default of 15 seconds is
too short for `COUNT_BIG` and deep `OFFSET` pages on a large `References`
table. Azure SQL enables snapshot isolation by default, so `index-xref` runs
in `SNAPSHOT` mode without `--allow-source-locks`. The serverless database
resumes from auto-pause on the first connection (about a minute); the publish
script retries once.

## 5. First publish and verification

On the publish machine (Node 24, the CLI on `PATH`, `az login` done):

```powershell
$env:D365_XREF_CONNECTION_STRING = '<connection string>'
pwsh scripts/publish-index.ps1 -StorageAccount <storageAccount> -ResourceGroup rg-d365-mcp -WebApp <webAppName>
```

Then:

```bash
curl -fsS https://<webAppName>.azurewebsites.net/health
az webapp log tail -g rg-d365-mcp -n <webAppName>      # look for "Published index ready"
```

Schedule the script (nightly at 02:00):

```powershell
schtasks /Create /SC DAILY /ST 02:00 /TN "D365 MCP index publish" /RU "$env:USERNAME" /IT `
  /TR "pwsh -NoProfile -File C:\tools\publish-index.ps1 -StorageAccount <sa> -ResourceGroup rg-d365-mcp -WebApp <app>"
```

## Operations

- **Add or revoke a user key**: update the `MCP-API-KEYS` secret (new version)
  and restart the web app. Keys are read once at start-up.
- **Check what is being served**: ask the assistant for `get_index_stats`
  (`builtAt`, counts) and `get_index_staleness` (`mode: published`, version).
- **Logs**: `az webapp log tail`, or the Log Analytics workspace
  (`AppServiceConsoleLogs`). Each request logs the key *name*, never the key.
- **Restart loop after a restart**: the index download failed and no local copy
  existed. Run `d365-fno-mcp-server doctor --hosted` with the same
  `D365_INDEX_URL` to see whether the SAS expired or the manifest is missing.
- **Scaling**: keep one instance. Sessions live in process memory.
