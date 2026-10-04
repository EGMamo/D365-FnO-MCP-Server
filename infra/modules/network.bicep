// Private network: App Service VNet integration, private endpoints and the
// worker subnet, with a NAT gateway for controlled outbound egress and private
// DNS zones for Blob Storage, Key Vault and Container Registry.

param location string
param tags object
param namePrefix string

@description('VNet address space, for example 10.40.0.0/22.')
param addressPrefix string
param appSubnetPrefix string
param privateEndpointSubnetPrefix string
param workerSubnetPrefix string

resource natIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: 'pip-nat-${namePrefix}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: 'ng-${namePrefix}'
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [{ id: natIp.id }]
  }
}

// The worker has no inbound path at all; it is operated through Run Command.
resource workerNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-worker-${namePrefix}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'deny-all-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource privateEndpointNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-pe-${namePrefix}'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-vnet-https-inbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '443'
        }
      }
      {
        name: 'deny-all-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-${namePrefix}'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [addressPrefix] }
    subnets: [
      {
        name: 'snet-app'
        properties: {
          addressPrefix: appSubnetPrefix
          natGateway: { id: nat.id }
          defaultOutboundAccess: false
          // Lets Storage and Key Vault firewalls name this subnet in their VNet rules,
          // which some organizations' policies require alongside private endpoints.
          serviceEndpoints: [{ service: 'Microsoft.Storage' }, { service: 'Microsoft.KeyVault' }]
          delegations: [
            {
              name: 'app-service'
              properties: { serviceName: 'Microsoft.Web/serverFarms' }
            }
          ]
        }
      }
      {
        name: 'snet-pe'
        properties: {
          addressPrefix: privateEndpointSubnetPrefix
          defaultOutboundAccess: false
          networkSecurityGroup: { id: privateEndpointNsg.id }
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
      {
        name: 'snet-worker'
        properties: {
          addressPrefix: workerSubnetPrefix
          natGateway: { id: nat.id }
          defaultOutboundAccess: false
          // Lets Storage and Key Vault firewalls name this subnet in their VNet rules,
          // which some organizations' policies require alongside private endpoints.
          serviceEndpoints: [{ service: 'Microsoft.Storage' }, { service: 'Microsoft.KeyVault' }]
          networkSecurityGroup: { id: workerNsg.id }
        }
      }
    ]
  }
}

// Order matters: the outputs below index into this array.
var zoneNames = [
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.vaultcore.azure.net'
  'privatelink${environment().suffixes.acrLoginServer}'
]

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in zoneNames: {
  name: zone
  location: 'global'
  tags: tags
}]

resource zoneLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in zoneNames: {
  parent: zones[i]
  name: 'link-${vnet.name}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}]

output appSubnetId string = vnet.properties.subnets[0].id
output privateEndpointSubnetId string = vnet.properties.subnets[1].id
output workerSubnetId string = vnet.properties.subnets[2].id
output blobDnsZoneId string = zones[0].id
output vaultDnsZoneId string = zones[1].id
output registryDnsZoneId string = zones[2].id
