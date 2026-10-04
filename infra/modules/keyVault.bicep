// RBAC-authorized Key Vault with purge protection. One vault per trust zone,
// so each identity can read only the secrets its own component needs.
// Secret values are never set here; operators add them out of band.

param location string
param tags object
@maxLength(24)
param name string

@description('Principals granted Key Vault Secrets User on this vault.')
param secretReaderPrincipalIds array

param enablePrivateNetworking bool

@description('Subnets (with the Microsoft.KeyVault service endpoint) allowed in the vault firewall, alongside the private endpoint.')
param allowedSubnetIds array
param privateEndpointSubnetId string
param vaultDnsZoneId string
param workspaceId string

var secretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      defaultAction: enablePrivateNetworking ? 'Deny' : 'Allow'
      bypass: 'AzureServices'
      virtualNetworkRules: [for subnetId in allowedSubnetIds: { id: subnetId, ignoreMissingVnetServiceEndpoint: false }]
      ipRules: []
    }
  }
}

resource readers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for principalId in secretReaderPrincipalIds: {
  scope: vault
  name: guid(vault.id, principalId, secretsUser)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsUser)
  }
}]

module endpoint 'privateEndpoint.bicep' = if (enablePrivateNetworking) {
  name: 'pe-${name}'
  params: {
    location: location
    tags: tags
    name: 'pe-${vault.name}'
    subnetId: privateEndpointSubnetId
    targetResourceId: vault.id
    groupId: 'vault'
    dnsZoneId: vaultDnsZoneId
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: vault
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'audit', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output id string = vault.id
output name string = vault.name
output uri string = vault.properties.vaultUri
