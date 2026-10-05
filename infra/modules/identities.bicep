// Separate user-assigned identities for the read-only API, the acquisition
// worker and the GitHub deployment workflow. Role assignments live next to the
// resources they grant access to so each one is scoped as narrowly as possible.

param location string
param tags object
param namePrefix string

@description('GitHub repository (owner/name) whose deployment workflow may federate with the deploy identity.')
param githubRepository string

@description('GitHub environment the deployment workflow runs in.')
param githubEnvironment string

@description('Numeric GitHub owner and repository IDs. When both are set, the ID-based subject is trusted too.')
param githubOwnerId string = ''
param githubRepositoryId string = ''

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

// GitHub Actions OIDC: only jobs in the named environment of this repository
// can exchange their token for the deploy identity. No client secret exists.
resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-${githubEnvironment}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:${githubEnvironment}'
    audiences: ['api://AzureADTokenExchange']
  }
}

// Repositories created, renamed or transferred after 15 July 2026 (and ones that
// opted in) present an ID-based subject: repo:owner@ownerId/name@repoId:...
var githubNames = split(githubRepository, '/')
var trustImmutableSubject = !empty(githubOwnerId) && !empty(githubRepositoryId)

resource githubImmutableFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (trustImmutableSubject) {
  parent: deployIdentity
  name: 'github-${githubEnvironment}-immutable'
  // An identity accepts one federated credential write at a time.
  dependsOn: [githubFederation]
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubNames[0]}@${githubOwnerId}/${githubNames[1]}@${githubRepositoryId}:environment:${githubEnvironment}'
    audiences: ['api://AzureADTokenExchange']
  }
}

output apiIdentityId string = apiIdentity.id
output apiPrincipalId string = apiIdentity.properties.principalId
output apiClientId string = apiIdentity.properties.clientId
output workerIdentityId string = workerIdentity.id
output workerPrincipalId string = workerIdentity.properties.principalId
output workerClientId string = workerIdentity.properties.clientId
output deployPrincipalId string = deployIdentity.properties.principalId
output deployClientId string = deployIdentity.properties.clientId
