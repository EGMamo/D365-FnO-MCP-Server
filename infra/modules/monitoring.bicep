// Shared Log Analytics workspace, workspace-based Application Insights and the
// alert action group used by every other module.

param location string
param tags object
param namePrefix string

@minValue(30)
@maxValue(730)
param logRetentionDays int

@description('Email receivers for operational alerts. May be empty while the action group is wired to another destination.')
param alertEmailReceivers array

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePrefix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: logRetentionDays
    features: { disableLocalAuth: true }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${namePrefix}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    // Only availability tests and Entra-authenticated senders may ingest; no instrumentation key is issued to apps.
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take(replace('d365${namePrefix}', '-', ''), 12)
    enabled: true
    emailReceivers: [for (address, i) in alertEmailReceivers: {
      name: 'email-${i}'
      emailAddress: address
      useCommonAlertSchema: true
    }]
  }
}

output workspaceId string = workspace.id
output appInsightsId string = appInsights.id
output appInsightsName string = appInsights.name
output actionGroupId string = actionGroup.id
