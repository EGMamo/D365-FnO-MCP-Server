// Durable artifact store. Bundles are immutable and published by the worker;
// the API identity can only read the artifact container. Shared Key access is
// disabled so every client authenticates with Entra ID.

param location string
param tags object
@maxLength(24)
param accountName string

param artifactContainerName string
param sourceContainerName string
param operationsContainerName string

param apiPrincipalId string
param workerPrincipalId string

@description('Days to keep noncurrent blob versions and soft-deleted blobs, including old deployment-pointers.json versions.')
@minValue(7)
param versionRetentionDays int

@description('Days to keep rejected candidates under the operations container.')
@minValue(1)
param rejectedRetentionDays int

@description('Days to keep run reports under the operations container.')
@minValue(1)
param runReportRetentionDays int

@description('Days to keep acquired source assets. 0 keeps them until deleted explicitly.')
@minValue(0)
param sourceRetentionDays int

param enablePrivateNetworking bool
param privateEndpointSubnetId string
param blobDnsZoneId string
param workspaceId string

var blobDataReader = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    allowCrossTenantReplication: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: enablePrivateNetworking ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    // Versioning and soft delete are recovery aids for deployment-pointers.json;
    // the explicit active/previous pointer remains the rollback mechanism.
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: versionRetentionDays }
    containerDeleteRetentionPolicy: { enabled: true, days: versionRetentionDays }
  }
}

resource artifactContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: artifactContainerName
  properties: { publicAccess: 'None' }
}

resource sourceContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: sourceContainerName
  properties: { publicAccess: 'None' }
}

resource operationsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: operationsContainerName
  properties: { publicAccess: 'None' }
}

// No rule ever matches bundles/ or deployment-pointers.json base blobs: only the
// worker's retention logic, which knows the active and previous bundles, deletes them.
var baseRules = [
  {
    name: 'expire-rejected-candidates'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['${operationsContainerName}/rejected/'] }
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: rejectedRetentionDays } } }
    }
  }
  {
    name: 'expire-run-reports'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['${operationsContainerName}/runs/'] }
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: runReportRetentionDays } } }
    }
  }
  {
    name: 'expire-noncurrent-versions'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'] }
      actions: { version: { delete: { daysAfterCreationGreaterThan: versionRetentionDays } } }
    }
  }
]

var sourceRule = [
  {
    name: 'expire-source-assets'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['${sourceContainerName}/'] }
      actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: sourceRetentionDays } } }
    }
  }
]

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: concat(baseRules, sourceRetentionDays > 0 ? sourceRule : [])
    }
  }
  dependsOn: [artifactContainer, sourceContainer, operationsContainer]
}

// API: read-only, artifact container only.
resource apiArtifactReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: artifactContainer
  name: guid(artifactContainer.id, apiPrincipalId, blobDataReader)
  properties: {
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataReader)
  }
}

// Worker: create bundles, take the acquisition lease and promote, plus its own
// source and operations containers. No account-level data role.
resource workerArtifactContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: artifactContainer
  name: guid(artifactContainer.id, workerPrincipalId, blobDataContributor)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}

resource workerSourceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sourceContainer
  name: guid(sourceContainer.id, workerPrincipalId, blobDataContributor)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}

resource workerOperationsContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: operationsContainer
  name: guid(operationsContainer.id, workerPrincipalId, blobDataContributor)
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributor)
  }
}

module blobEndpoint 'privateEndpoint.bicep' = if (enablePrivateNetworking) {
  name: 'pe-blob'
  params: {
    location: location
    tags: tags
    name: 'pe-${account.name}-blob'
    subnetId: privateEndpointSubnetId
    targetResourceId: account.id
    groupId: 'blob'
    dnsZoneId: blobDnsZoneId
  }
}

resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: blobService
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [
      { category: 'StorageRead', enabled: true }
      { category: 'StorageWrite', enabled: true }
      { category: 'StorageDelete', enabled: true }
    ]
    metrics: [{ category: 'Transaction', enabled: true }]
  }
}

output accountName string = account.name
output blobEndpoint string = account.properties.primaryEndpoints.blob
output artifactContainerName string = artifactContainer.name
output sourceContainerName string = sourceContainer.name
output operationsContainerName string = operationsContainer.name
