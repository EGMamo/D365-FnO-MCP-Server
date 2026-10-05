// Separate user-assigned identities for the read-only API, the acquisition
// worker and the GitHub deployment workflow. Role assignments live next to the
// resources they grant access to so each one is scoped as narrowly as possible.
// The deploy identity trusts no repository here: scripts/azure-github-trust.ps1
// adds the GitHub federated credential on demand, so nothing in the template
// names a GitHub owner or repository.

param location string
param tags object
param namePrefix string

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-api-${namePrefix}'
  location: location
  tags: tags
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-worker-${namePrefix}'
  location: location
  tags: tags
}

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-deploy-${namePrefix}'
  location: location
  tags: tags
}

output apiIdentityId string = apiIdentity.id
output apiPrincipalId string = apiIdentity.properties.principalId
output apiClientId string = apiIdentity.properties.clientId
output workerIdentityId string = workerIdentity.id
output workerPrincipalId string = workerIdentity.properties.principalId
output workerClientId string = workerIdentity.properties.clientId
output deployPrincipalId string = deployIdentity.properties.principalId
output deployClientId string = deployIdentity.properties.clientId
