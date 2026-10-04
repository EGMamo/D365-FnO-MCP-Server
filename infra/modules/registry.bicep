// Container registry for the API image. Anonymous pull and the admin user are
// disabled; the API pulls with its managed identity and the deployment workflow
// pushes with its federated identity.

param location string
param tags object
@minLength(5)
@maxLength(50)
param name string

@description('Premium is required for a private endpoint.')
@allowed(['Basic', 'Standard', 'Premium'])
param sku string

@description('Keep enabled while images are pushed from GitHub-hosted runners; pulls still use the private endpoint when one exists.')
param publicNetworkAccess bool

param apiPrincipalId string
param deployPrincipalId string

param enablePrivateEndpoint bool
param privateEndpointSubnetId string
param registryDnsZoneId string
param workspaceId string

var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPush = '8311e382-0749-4cb8-b61a-304f252e45ec'

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: name
  location: location
  tags: tags
  sku: { name: sku }
  // Network rules (and so the trusted-services bypass) are Premium-only.
  properties: union({
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: publicNetworkAccess ? 'Enabled' : 'Disabled'
  }, sku == 'Premium' ? { networkRuleBypassOptions: 'AzureServices' } : {})
}

resource apiPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, apiPrincipalId, acrPull)
  properties: {
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

resource deployPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, deployPrincipalId, acrPush)
  properties: {
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPush)
  }
}

module endpoint 'privateEndpoint.bicep' = if (enablePrivateEndpoint) {
  name: 'pe-registry'
  params: {
    location: location
    tags: tags
    name: 'pe-${registry.name}'
    subnetId: privateEndpointSubnetId
    targetResourceId: registry.id
    groupId: 'registry'
    dnsZoneId: registryDnsZoneId
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: registry
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [{ categoryGroup: 'allLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output name string = registry.name
output loginServer string = registry.properties.loginServer
