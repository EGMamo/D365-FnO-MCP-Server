// Hosted D365 FnO MCP server: App Service (Linux container) that downloads a
// published index from Blob Storage at start-up, plus an Azure SQL copy of
// DynamicsXrefDB that the publish job reads. See infra/README.md for the
// deployment order and the manual steps (SAS, BACPAC import, SQL login).
targetScope = 'resourceGroup'

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('Short prefix for resource names (letters and digits only), for example d365mcp.')
@minLength(3)
@maxLength(12)
param namePrefix string

@description('Image tag in the container registry to run, for example a git SHA or "latest".')
param imageTag string = 'latest'

@description('App Service plan SKU. P0v3 suits indexes up to a couple of GB; P1v3 gives the SQLite page cache more memory.')
@allowed(['B1', 'B2', 'B3', 'P0v3', 'P1v3', 'P2v3'])
param appServiceSku string = 'P0v3'

@description('Administrator login for the Azure SQL logical server.')
param sqlAdminLogin string

@secure()
@description('Administrator password for the Azure SQL logical server.')
param sqlAdminPassword string

@description('Maximum size in GB of the DynamicsXrefDB copy.')
param sqlMaxSizeGb int = 32

@description('Public IPv4 address of the machine that runs index-xref and the publish script. Added to the SQL firewall; leave empty to skip.')
param devMachineIp string = ''

@secure()
@description('Value for MCP_API_KEYS (name=key,name=key; keys of 32+ characters). Stored in Key Vault.')
param mcpApiKeys string

@secure()
@description('Manifest URL carrying a read SAS for the indexes container. Leave empty on the first deployment; the app then starts with an empty index until the secret is set and the app restarted.')
param indexSasUrl string = ''

@description('Names from MCP_API_KEYS (comma-separated) allowed to upload a new index over HTTPS, for example from the Visual Studio extension. Leave empty to disable uploads.')
param indexUploadKeys string = ''

@secure()
@description('Container URL of the indexes container with a create+write SAS. Uploaded indexes are published there so a restart serves them again. Leave empty to keep uploads only until the next restart.')
param indexPublishSasUrl string = ''

@description('Object ID of the user or service principal that runs scripts/publish-index.ps1. Gets Storage Blob Data Contributor and Website Contributor. Leave empty to skip.')
param publisherPrincipalId string = ''

@description('Object ID of the GitHub Actions service principal that pushes images and updates the web app. Gets AcrPush and Website Contributor. Leave empty to skip.')
param deployerPrincipalId string = ''

@description('Send container and HTTP logs to a Log Analytics workspace.')
param enableLogAnalytics bool = true

var suffix = uniqueString(resourceGroup().id)
var storageName = take(toLower('${namePrefix}st${suffix}'), 24)
var acrName = take(toLower('${namePrefix}acr${suffix}'), 50)
var keyVaultName = take('${namePrefix}-kv-${suffix}', 24)
var sqlServerName = toLower('${namePrefix}-sql-${suffix}')
var webAppName = toLower('${namePrefix}-mcp-${take(suffix, 6)}')
var imageName = 'd365-fno-mcp-server'

var roleIds = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  websiteContributor: 'de139f84-1756-47ae-9be6-808fbbe84772'
}

// ── Storage: published indexes and BACPAC uploads ────────────────────────────
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    // Needed to issue the long-lived service SAS the web app reads the index with.
    allowSharedKeyAccess: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource indexesContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'indexes'
  properties: { publicAccess: 'None' }
}

resource bacpacContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'bacpac'
  properties: { publicAccess: 'None' }
}

// ── Container registry ───────────────────────────────────────────────────────
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

// ── Key Vault: API keys and the index SAS URL ────────────────────────────────
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
  }
}

resource apiKeysSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'MCP-API-KEYS'
  properties: { value: mcpApiKeys }
}

resource indexUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(indexSasUrl)) {
  parent: keyVault
  name: 'INDEX-SAS-URL'
  properties: { value: indexSasUrl }
}

resource indexPublishUrlSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (!empty(indexPublishSasUrl)) {
  parent: keyVault
  name: 'INDEX-PUBLISH-SAS-URL'
  properties: { value: indexPublishSasUrl }
}

// ── Logging (optional) ───────────────────────────────────────────────────────
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (enableLogAnalytics) {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── App Service ──────────────────────────────────────────────────────────────
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${namePrefix}-plan'
  location: location
  kind: 'linux'
  sku: { name: appServiceSku, capacity: 1 }
  properties: { reserved: true }
}

var baseAppSettings = {
  // App Service container plumbing
  WEBSITES_PORT: '8080'
  // Keep /home unmounted: it is an SMB share where SQLite cannot lock. The
  // index lives on container-local disk and is re-downloaded on every start.
  WEBSITES_ENABLE_APP_SERVICE_STORAGE: 'false'
  // The server downloads the index before it starts listening.
  WEBSITES_CONTAINER_START_TIME_LIMIT: '1800'
  WEBSITES_CONTAINER_STOP_TIME_LIMIT: '30'
  WEBSITE_WARMUP_PATH: '/health'
  DOCKER_REGISTRY_SERVER_URL: 'https://${acr.properties.loginServer}'
  DOCKER_ENABLE_CI: 'false'
  // Server configuration
  MCP_TRANSPORT: 'http'
  MCP_PORT: '8080'
  TRUST_PROXY_HOPS: '1'
  D365_INDEX_DB_PATH: '/data/d365_index.db'
  D365_ENABLE_WRITE_TOOLS: '0'
  D365_INDEX_ON_START: '0'
  MAX_CONCURRENT_SESSIONS: '100'
  SESSION_IDLE_TIMEOUT_MS: '1800000'
  MCP_API_KEYS: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=MCP-API-KEYS)'
}

var appSettings = union(
  baseAppSettings,
  empty(indexSasUrl) ? {} : { D365_INDEX_URL: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=INDEX-SAS-URL)' },
  empty(indexUploadKeys) ? {} : { D365_INDEX_UPLOAD_KEYS: indexUploadKeys },
  empty(indexUploadKeys) || empty(indexPublishSasUrl) ? {} : { D365_INDEX_PUBLISH_URL: '@Microsoft.KeyVault(VaultName=${keyVault.name};SecretName=INDEX-PUBLISH-SAS-URL)' }
)

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/${imageName}:${imageTag}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      healthCheckPath: '/health'
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      // MCP sessions live in process memory, so never scale out.
      numberOfWorkers: 1
      appSettings: [for setting in items(appSettings): { name: setting.key, value: setting.value }]
    }
  }
}

resource webAppAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, webApp.id, roleIds.acrPull)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.acrPull)
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource webAppSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, webApp.id, roleIds.keyVaultSecretsUser)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.keyVaultSecretsUser)
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource webAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableLogAnalytics) {
  name: 'logs'
  scope: webApp
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
  }
}

// ── Publisher and deployer permissions ───────────────────────────────────────
resource publisherBlobContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(publisherPrincipalId)) {
  name: guid(storage.id, publisherPrincipalId, roleIds.storageBlobDataContributor)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.storageBlobDataContributor)
    principalId: publisherPrincipalId
  }
}

resource publisherWebsiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(publisherPrincipalId)) {
  name: guid(webApp.id, publisherPrincipalId, roleIds.websiteContributor)
  scope: webApp
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.websiteContributor)
    principalId: publisherPrincipalId
  }
}

resource deployerAcrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerPrincipalId)) {
  name: guid(acr.id, deployerPrincipalId, roleIds.acrPush)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.acrPush)
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource deployerWebsiteContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(deployerPrincipalId)) {
  name: guid(webApp.id, deployerPrincipalId, roleIds.websiteContributor)
  scope: webApp
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleIds.websiteContributor)
    principalId: deployerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ── Azure SQL: DynamicsXrefDB copy read by index-xref ────────────────────────
resource sqlServer 'Microsoft.Sql/servers@2023-08-01-preview' = {
  name: sqlServerName
  location: location
  properties: {
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
  }
}

// Serverless with auto-pause: only the scheduled import reads this database.
resource xrefDb 'Microsoft.Sql/servers/databases@2023-08-01-preview' = {
  parent: sqlServer
  name: 'DynamicsXrefDB'
  location: location
  sku: { name: 'GP_S_Gen5', tier: 'GeneralPurpose', family: 'Gen5', capacity: 1 }
  properties: {
    autoPauseDelay: 60
    minCapacity: json('0.5')
    maxSizeBytes: sqlMaxSizeGb * 1073741824
    collation: 'SQL_Latin1_General_CP1_CI_AS'
    zoneRedundant: false
  }
}

// Lets the Azure SQL import/export service reach the server for the BACPAC import.
resource sqlAllowAzure 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = {
  parent: sqlServer
  name: 'AllowAllWindowsAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource sqlAllowDevMachine 'Microsoft.Sql/servers/firewallRules@2023-08-01-preview' = if (!empty(devMachineIp)) {
  parent: sqlServer
  name: 'DevMachine'
  properties: { startIpAddress: devMachineIp, endIpAddress: devMachineIp }
}

// ── Outputs ──────────────────────────────────────────────────────────────────
output webAppName string = webApp.name
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output mcpEndpoint string = 'https://${webApp.properties.defaultHostName}/mcp'
output webAppPrincipalId string = webApp.identity.principalId
output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output storageAccountName string = storage.name
output indexesContainer string = indexesContainer.name
output keyVaultName string = keyVault.name
output sqlServerFqdn string = sqlServer.properties.fullyQualifiedDomainName
output sqlDatabaseName string = xrefDb.name
