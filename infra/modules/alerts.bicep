// Availability, capacity, worker failure, freshness and authorization alerts.

param location string
param tags object
param namePrefix string

param actionGroupId string
param workspaceId string
param appInsightsId string

param siteId string
param siteHostName string
param planId string
param schedulerId string

@description('Raise an alert when no acquisition run has succeeded within this window. Log alert windows only accept fixed sizes.')
@allowed(['PT6H', 'P1D', 'P2D'])
param freshnessWindow string

@description('401 responses per 15 minutes that count as repeated authentication failures.')
param authFailureThreshold int

var actions = [{ actionGroupId: actionGroupId }]

// ── API ────────────────────────────────────────────────────────────────────
resource healthCheck 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-api-health-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    description: 'App Service health checks on /health are failing: the active bundle did not materialize or the server is down.'
    severity: 1
    enabled: true
    scopes: [siteId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'health'
          metricName: 'HealthCheckStatus'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'LessThan'
          threshold: 100
          timeAggregation: 'Average'
        }
      ]
    }
    actions: actions
  }
}

resource serverErrors 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-api-5xx-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    description: 'The API is returning server errors.'
    severity: 2
    enabled: true
    scopes: [siteId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'http5xx'
          metricName: 'Http5xx'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: 10
          timeAggregation: 'Total'
        }
      ]
    }
    actions: actions
  }
}

var webTestName = 'webtest-api-health-${namePrefix}'

resource availabilityTest 'Microsoft.Insights/webtests@2022-06-15' = {
  name: webTestName
  location: location
  tags: union(tags, { 'hidden-link:${appInsightsId}': 'Resource' })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: webTestName
    Name: 'API /health'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [
      { Id: 'us-va-ash-azr' }
      { Id: 'emea-nl-ams-azr' }
      { Id: 'apac-sg-sin-azr' }
    ]
    Request: {
      RequestUrl: 'https://${siteHostName}/health'
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 14
    }
  }
}

resource availability 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-api-availability-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    description: 'The public /health endpoint is unavailable from at least two test locations.'
    severity: 1
    enabled: true
    scopes: [availabilityTest.id, appInsightsId]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: availabilityTest.id
      componentId: appInsightsId
      failedLocationCount: 2
    }
    actions: actions
  }
}

resource planCpu 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-api-cpu-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    description: 'The App Service plan is under sustained CPU pressure.'
    severity: 2
    enabled: true
    scopes: [planId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'cpu'
          metricName: 'CpuPercentage'
          metricNamespace: 'Microsoft.Web/serverfarms'
          operator: 'GreaterThan'
          threshold: 85
          timeAggregation: 'Average'
        }
      ]
    }
    actions: actions
  }
}

resource planMemory 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-api-memory-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    description: 'The App Service plan is under sustained memory pressure.'
    severity: 2
    enabled: true
    scopes: [planId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'memory'
          metricName: 'MemoryPercentage'
          metricNamespace: 'Microsoft.Web/serverfarms'
          operator: 'GreaterThan'
          threshold: 85
          timeAggregation: 'Average'
        }
      ]
    }
    actions: actions
  }
}

resource authFailures 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-api-auth-failures-${namePrefix}'
  location: location
  tags: tags
  properties: {
    description: 'Repeated 401 responses: a client is using a revoked key or someone is guessing keys.'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'AppServiceHTTPLogs | where _ResourceId =~ "${toLower(siteId)}" and ScStatus == 401'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: authFailureThreshold
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroupId] }
  }
}

// ── Storage ────────────────────────────────────────────────────────────────
resource storageDenied 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-storage-authz-${namePrefix}'
  location: location
  tags: tags
  properties: {
    description: 'Blob requests were denied: an identity lost its role, or a component tried to write where it may not.'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'StorageBlobLogs | where StatusCode == 403'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroupId] }
  }
}

// ── Worker ─────────────────────────────────────────────────────────────────
resource workerFailed 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-worker-run-failed-${namePrefix}'
  location: 'global'
  tags: tags
  properties: {
    description: 'A scheduled acquisition run failed, timed out or was rejected by validation. The active bundle is unchanged.'
    severity: 2
    enabled: true
    scopes: [schedulerId]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'failed'
          metricName: 'RunsFailed'
          metricNamespace: 'Microsoft.Logic/workflows'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
        }
      ]
    }
    actions: actions
  }
}

resource stale 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'alert-worker-freshness-${namePrefix}'
  location: location
  tags: tags
  properties: {
    description: 'No acquisition run has succeeded within the freshness objective; the served index is getting stale.'
    severity: 2
    enabled: true
    scopes: [workspaceId]
    evaluationFrequency: 'PT1H'
    windowSize: freshnessWindow
    criteria: {
      allOf: [
        {
          query: 'AzureDiagnostics | where ResourceProvider == "MICROSOFT.LOGIC" and _ResourceId =~ "${toLower(schedulerId)}" and OperationName == "Microsoft.Logic/workflows/workflowRunCompleted" and status_s == "Succeeded"'
          timeAggregation: 'Count'
          operator: 'LessThan'
          threshold: 1
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [actionGroupId] }
  }
}
