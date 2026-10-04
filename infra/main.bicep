// Hosted D365 FnO MCP service: read-only API on App Service with a staging
// slot, private Windows acquisition worker, Blob artifact store, ACR, Key
// Vault, managed identities, monitoring and private networking.
//
// Deploy into an existing resource group, one per environment. Always run
// `az deployment group what-if` first. This template never creates secret
// values; see infra/README.md for the operator steps around it.

targetScope = 'resourceGroup'

@description('Short environment name, for example dev or prod.')
@maxLength(8)
param environmentName string

@description('Short workload name used in resource names.')
@maxLength(10)
param workloadName string = 'd365mcp'

param location string = resourceGroup().location

param tags object = {}

// ── API ────────────────────────────────────────────────────────────────────
@description('App Service plan SKU. Must support slots and hold a full local SQLite copy.')
param apiPlanSku string = 'P1v3'

@minValue(1)
param apiInstanceCount int = 1

@description('Image repository:tag in the registry. Pass the currently deployed tag on infrastructure-only redeploys.')
param apiImage string = 'd365-fno-mcp-server:latest'

@description('Client CIDR ranges allowed to reach the API. Empty allows all addresses (API keys still apply).')
param allowedIngressCidrs array = []

@description('Name of the API Key Vault secret holding MCP_API_KEYS. Operators create the secret.')
param apiKeysSecretName string = 'mcp-api-keys'

// ── Storage ────────────────────────────────────────────────────────────────
param artifactContainerName string = 'd365-artifacts'
param sourceContainerName string = 'd365-sources'
param operationsContainerName string = 'd365-operations'

@description('Public IP addresses or CIDR ranges allowed in the storage firewall. Only takes effect when enablePrivateNetworking is false.')
param storageAllowedIpRanges array = []

@minValue(7)
param versionRetentionDays int = 30
@minValue(1)
param rejectedRetentionDays int = 14
@minValue(1)
param runReportRetentionDays int = 90
@description('0 keeps source assets until deleted explicitly.')
@minValue(0)
param sourceRetentionDays int = 0

// ── Worker ─────────────────────────────────────────────────────────────────
param workerVmSize string = 'Standard_D8s_v5'
@minValue(128)
param workerDataDiskSizeGb int = 512
param workerAdminUsername string = 'workeradmin'
@secure()
@description('Local administrator password for the worker VM. Supply it at deployment time from a secure source; never commit it.')
param workerAdminPassword string
param workerRoot string = 'F:\\worker'
@description('UTC hours at which acquisition runs start.')
param workerScheduleHoursUtc array = [2]
@minValue(1)
@maxValue(23)
param workerRunTimeoutHours int = 6

// ── Networking ─────────────────────────────────────────────────────────────
@description('Private endpoints for Storage, Key Vault and ACR with public access disabled, and VNet integration for the API. The VNet, worker subnet and NAT gateway are always created.')
param enablePrivateNetworking bool = true
param vnetAddressPrefix string = '10.40.0.0/22'
param appSubnetPrefix string = '10.40.0.0/26'
param privateEndpointSubnetPrefix string = '10.40.0.64/26'
param workerSubnetPrefix string = '10.40.1.0/26'

@description('Keep ACR reachable publicly (authenticated only) so GitHub-hosted runners can push. The API pulls over the private endpoint when private networking is on.')
param registryPublicNetworkAccess bool = true

// ── Deployment identity ────────────────────────────────────────────────────
@description('GitHub repository (owner/name) allowed to federate with the deploy identity.')
param githubRepository string = 'EGMamo/D365-FnO-MCP-Server'
param githubEnvironment string = 'production'

// ── Monitoring ─────────────────────────────────────────────────────────────
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30
param alertEmailReceivers array = []
@description('Freshness objective: alert when no acquisition run succeeded within this window. P2D tolerates one missed daily run.')
@allowed(['PT6H', 'P1D', 'P2D'])
param freshnessWindow string = 'P2D'
param authFailureThreshold int = 50

var namePrefix = '${workloadName}-${environmentName}'
// Storage account and registry names allow only lowercase letters and digits.
var compactName = toLower(replace(replace('${workloadName}${environmentName}', '-', ''), '_', ''))
var suffix = take(uniqueString(resourceGroup().id, namePrefix), 6)
var allTags = union({ workload: workloadName, environment: environmentName }, tags)

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    tags: allTags
    namePrefix: namePrefix
    logRetentionDays: logRetentionDays
    alertEmailReceivers: alertEmailReceivers
  }
}

// Always deployed: the worker needs its private subnet and NAT egress either way.
module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    location: location
    tags: allTags
    namePrefix: namePrefix
    addressPrefix: vnetAddressPrefix
    appSubnetPrefix: appSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    workerSubnetPrefix: workerSubnetPrefix
  }
}

module identities 'modules/identities.bicep' = {
  name: 'identities'
  params: {
    location: location
    tags: allTags
    namePrefix: namePrefix
    githubRepository: githubRepository
    githubEnvironment: githubEnvironment
  }
}

var privateEndpointSubnetId = enablePrivateNetworking ? network.outputs.privateEndpointSubnetId : ''

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    tags: allTags
    accountName: take('st${compactName}${suffix}', 24)
    artifactContainerName: artifactContainerName
    sourceContainerName: sourceContainerName
    operationsContainerName: operationsContainerName
    apiPrincipalId: identities.outputs.apiPrincipalId
    workerPrincipalId: identities.outputs.workerPrincipalId
    versionRetentionDays: versionRetentionDays
    rejectedRetentionDays: rejectedRetentionDays
    runReportRetentionDays: runReportRetentionDays
    sourceRetentionDays: sourceRetentionDays
    enablePrivateNetworking: enablePrivateNetworking
    allowedSubnetIds: [network.outputs.workerSubnetId, network.outputs.appSubnetId]
    allowedIpRanges: storageAllowedIpRanges
    privateEndpointSubnetId: privateEndpointSubnetId
    blobDnsZoneId: enablePrivateNetworking ? network.outputs.blobDnsZoneId : ''
    workspaceId: monitoring.outputs.workspaceId
  }
}

// One vault per trust zone: the API reads MCP_API_KEYS, the worker reads its
// Power Platform credential. Neither identity can read the other's secrets.
module apiVault 'modules/keyVault.bicep' = {
  name: 'kv-api'
  params: {
    location: location
    tags: allTags
    name: take('kv-api-${environmentName}-${suffix}', 24)
    secretReaderPrincipalIds: [identities.outputs.apiPrincipalId]
    enablePrivateNetworking: enablePrivateNetworking
    allowedSubnetIds: [network.outputs.appSubnetId]
    privateEndpointSubnetId: privateEndpointSubnetId
    vaultDnsZoneId: enablePrivateNetworking ? network.outputs.vaultDnsZoneId : ''
    workspaceId: monitoring.outputs.workspaceId
  }
}

// Created after the API vault: Key Vault can fail one of two vaults created at the same moment
// with an internal 409 BlobAlreadyExists conflict.
module workerVault 'modules/keyVault.bicep' = {
  name: 'kv-worker'
  dependsOn: [apiVault]
  params: {
    location: location
    tags: allTags
    name: take('kv-wrk-${environmentName}-${suffix}', 24)
    secretReaderPrincipalIds: [identities.outputs.workerPrincipalId]
    enablePrivateNetworking: enablePrivateNetworking
    allowedSubnetIds: [network.outputs.workerSubnetId]
    privateEndpointSubnetId: privateEndpointSubnetId
    vaultDnsZoneId: enablePrivateNetworking ? network.outputs.vaultDnsZoneId : ''
    workspaceId: monitoring.outputs.workspaceId
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    tags: allTags
    name: take('cr${compactName}${suffix}', 50)
    sku: enablePrivateNetworking ? 'Premium' : 'Basic'
    publicNetworkAccess: enablePrivateNetworking ? registryPublicNetworkAccess : true
    apiPrincipalId: identities.outputs.apiPrincipalId
    deployPrincipalId: identities.outputs.deployPrincipalId
    enablePrivateEndpoint: enablePrivateNetworking
    privateEndpointSubnetId: privateEndpointSubnetId
    registryDnsZoneId: enablePrivateNetworking ? network.outputs.registryDnsZoneId : ''
    workspaceId: monitoring.outputs.workspaceId
  }
}

module api 'modules/apiApp.bicep' = {
  name: 'api'
  params: {
    location: location
    tags: allTags
    namePrefix: namePrefix
    planSku: apiPlanSku
    instanceCount: apiInstanceCount
    apiIdentityId: identities.outputs.apiIdentityId
    apiClientId: identities.outputs.apiClientId
    deployPrincipalId: identities.outputs.deployPrincipalId
    registryLoginServer: registry.outputs.loginServer
    image: apiImage
    apiKeyVaultName: apiVault.outputs.name
    apiKeysSecretName: apiKeysSecretName
    artifactBlobEndpoint: storage.outputs.blobEndpoint
    artifactContainerName: storage.outputs.artifactContainerName
    allowedIngressCidrs: allowedIngressCidrs
    enablePrivateNetworking: enablePrivateNetworking
    appSubnetId: enablePrivateNetworking ? network.outputs.appSubnetId : ''
    workspaceId: monitoring.outputs.workspaceId
  }
}

module worker 'modules/worker.bicep' = {
  name: 'worker'
  params: {
    location: location
    tags: allTags
    namePrefix: namePrefix
    subnetId: network.outputs.workerSubnetId
    workerIdentityId: identities.outputs.workerIdentityId
    vmSize: workerVmSize
    dataDiskSizeGb: workerDataDiskSizeGb
    adminUsername: workerAdminUsername
    adminPassword: workerAdminPassword
    workerRoot: workerRoot
    scheduleHoursUtc: workerScheduleHoursUtc
    runTimeoutHours: workerRunTimeoutHours
    workspaceId: monitoring.outputs.workspaceId
  }
}

module alerts 'modules/alerts.bicep' = {
  name: 'alerts'
  params: {
    location: location
    tags: allTags
    namePrefix: namePrefix
    actionGroupId: monitoring.outputs.actionGroupId
    workspaceId: monitoring.outputs.workspaceId
    appInsightsId: monitoring.outputs.appInsightsId
    siteId: api.outputs.siteId
    siteHostName: api.outputs.defaultHostName
    planId: api.outputs.planId
    schedulerId: worker.outputs.schedulerId
    freshnessWindow: freshnessWindow
    authFailureThreshold: authFailureThreshold
  }
}

// Non-secret values for the GitHub environment (vars) and the worker's
// acquisition.json destination block.
output resourceGroupName string = resourceGroup().name
output webAppName string = api.outputs.siteName
output webAppHostName string = api.outputs.defaultHostName
output stagingHostName string = api.outputs.stagingHostName
output registryName string = registry.outputs.name
output deployClientId string = identities.outputs.deployClientId
output artifactAccountUrl string = storage.outputs.blobEndpoint
output artifactContainerName string = storage.outputs.artifactContainerName
output workerManagedIdentityClientId string = identities.outputs.workerClientId
output apiKeyVaultName string = apiVault.outputs.name
output workerKeyVaultName string = workerVault.outputs.name
output workerVmName string = worker.outputs.vmName
output schedulerName string = worker.outputs.schedulerName
