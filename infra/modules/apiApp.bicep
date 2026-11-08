// Read-only MCP API on App Service for Linux with a staging slot.
//
// With D365_ARTIFACT_SOURCE=azure-blob each instance listens immediately but
// unready: /live answers 200 while /health (readiness) answers 503 until the
// active Blob bundle has been materialized onto instance-local disk, validated
// and opened. App Service health checks and swap warm-up both use /health, so a
// replica gets no traffic and a slot cannot be swapped in before then.
// The live SQLite file is never on Azure Files: App Service storage is off.

param location string
param tags object
param namePrefix string

@description('App Service plan SKU. Premium v3 gives the local disk and memory a full SQLite copy needs, and slots. P0v3 (4 GB) is the smallest; the staging slot shares its memory during a deployment.')
param planSku string

@description('Instances. Stay at 1 until MCP session routing across replicas is proven.')
@minValue(1)
param instanceCount int

param apiIdentityId string
param apiClientId string
param deployPrincipalId string

param registryLoginServer string
@description('Image repository and tag, for example d365-fno-mcp-server:<sha>. Pass the currently deployed tag on infrastructure-only redeploys so they do not roll the image back.')
param image string

param apiKeyVaultName string
@description('Name of the Key Vault secret holding MCP_API_KEYS (name=key,... with keys of 32+ characters). Created by an operator, never by this template.')
param apiKeysSecretName string

param artifactBlobEndpoint string
param artifactContainerName string
@description('Container of the key registry (key-registry.json), in the same account as the artifacts.')
param keyRegistryContainerName string

@description('Client CIDR ranges allowed to reach the API. Empty allows all addresses (API keys still apply).')
param allowedIngressCidrs array

param enablePrivateNetworking bool
param appSubnetId string

param workspaceId string

var websiteContributor = 'de139f84-1756-47ae-9be6-808fbbe84772'

// Paths inside the container's own filesystem, not the /home share. /data is
// the image's only directory writable by the non-root runtime user.
var artifactStorePath = '/data/artifacts'
var indexDbPath = '/data/d365_index.db'

var appSettings = [
  { name: 'WEBSITES_PORT', value: '8080' }
  { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
  // Bundle download, hashing and SQLite validation run before the server listens.
  { name: 'WEBSITES_CONTAINER_START_TIME_LIMIT', value: '1800' }
  { name: 'WEBSITE_SWAP_WARMUP_PING_PATH', value: '/health' }
  { name: 'WEBSITE_SWAP_WARMUP_PING_STATUSES', value: '200' }
  { name: 'MCP_TRANSPORT', value: 'http' }
  { name: 'MCP_PORT', value: '8080' }
  { name: 'TRUST_PROXY_HOPS', value: '1' }
  // Fixed keys (the deploy smoke key). Developer keys live in the key registry below, managed with the admin key.
  { name: 'MCP_API_KEYS', value: '@Microsoft.KeyVault(VaultName=${apiKeyVaultName};SecretName=${apiKeysSecretName})' }
  { name: 'MCP_KEY_REGISTRY', value: 'azure-blob' }
  { name: 'MCP_KEY_REGISTRY_ACCOUNT_URL', value: artifactBlobEndpoint }
  { name: 'MCP_KEY_REGISTRY_CONTAINER', value: keyRegistryContainerName }
  { name: 'D365_ENABLE_WRITE_TOOLS', value: '0' }
  { name: 'D365_ARTIFACT_SOURCE', value: 'azure-blob' }
  { name: 'D365_ARTIFACT_STORE_PATH', value: artifactStorePath }
  { name: 'D365_INDEX_DB_PATH', value: indexDbPath }
  { name: 'D365_ARTIFACT_ACCOUNT_URL', value: artifactBlobEndpoint }
  { name: 'D365_ARTIFACT_CONTAINER', value: artifactContainerName }
  { name: 'D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID', value: apiClientId }
  { name: 'AZURE_CLIENT_ID', value: apiClientId }
]

var clientRestrictions = [for (cidr, i) in allowedIngressCidrs: {
  name: 'allow-${i}'
  ipAddress: cidr
  action: 'Allow'
  priority: 100 + i
}]

// The /health availability test must still reach a restricted site.
var ipRestrictions = empty(allowedIngressCidrs) ? [] : concat(clientRestrictions, [
  {
    name: 'allow-availability-tests'
    tag: 'ServiceTag'
    ipAddress: 'ApplicationInsightsAvailability'
    action: 'Allow'
    priority: 900
  }
])

var siteConfig = {
  linuxFxVersion: 'DOCKER|${registryLoginServer}/${image}'
  acrUseManagedIdentityCreds: true
  acrUserManagedIdentityID: apiClientId
  alwaysOn: true
  healthCheckPath: '/health'
  http20Enabled: true
  minTlsVersion: '1.2'
  scmMinTlsVersion: '1.2'
  ftpsState: 'Disabled'
  remoteDebuggingEnabled: false
  vnetRouteAllEnabled: enablePrivateNetworking
  ipSecurityRestrictions: ipRestrictions
  ipSecurityRestrictionsDefaultAction: empty(allowedIngressCidrs) ? 'Allow' : 'Deny'
  scmIpSecurityRestrictionsUseMain: true
  appSettings: appSettings
}

var siteProperties = {
  serverFarmId: plan.id
  httpsOnly: true
  clientAffinityEnabled: false
  keyVaultReferenceIdentity: apiIdentityId
  virtualNetworkSubnetId: enablePrivateNetworking ? appSubnetId : null
  vnetImagePullEnabled: enablePrivateNetworking
  siteConfig: siteConfig
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'asp-${namePrefix}'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: planSku
    capacity: instanceCount
  }
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: 'app-${namePrefix}'
  location: location
  tags: tags
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${apiIdentityId}': {} }
  }
  properties: siteProperties
}

// The deployment workflow sets the new image here, waits for the slot to
// materialize and validate its bundle, smoke-tests it and then swaps.
resource staging 'Microsoft.Web/sites/slots@2023-12-01' = {
  parent: site
  name: 'staging'
  location: location
  tags: tags
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${apiIdentityId}': {} }
  }
  properties: siteProperties
}

resource siteFtp 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: site
  name: 'ftp'
  properties: { allow: false }
}

resource siteScm 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: site
  name: 'scm'
  properties: { allow: false }
}

resource stagingFtp 'Microsoft.Web/sites/slots/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: staging
  name: 'ftp'
  properties: { allow: false }
}

resource stagingScm 'Microsoft.Web/sites/slots/basicPublishingCredentialsPolicies@2023-12-01' = {
  parent: staging
  name: 'scm'
  properties: { allow: false }
}

// Website Contributor on this site (and therefore its slot) only: enough to set
// the container image, restart and swap. No access to storage or Key Vault.
resource deployContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: site
  name: guid(site.id, deployPrincipalId, websiteContributor)
  properties: {
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', websiteContributor)
  }
}

var logCategories = [
  'AppServiceHTTPLogs'
  'AppServiceConsoleLogs'
  'AppServicePlatformLogs'
  'AppServiceAuditLogs'
  'AppServiceIPSecAuditLogs'
]

resource siteDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: site
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [for category in logCategories: { category: category, enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

resource stagingDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: staging
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [for category in logCategories: { category: category, enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output planId string = plan.id
output siteId string = site.id
output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
output stagingHostName string = staging.properties.defaultHostName
