// Private Windows acquisition worker and its scheduler.
//
// The VM has no public IP and no inbound rules. It is deallocated outside
// acquisition windows. A Logic App starts it on schedule, runs one
// `d365-fno-mcp-server acquire` cycle through managed Run Command with a unique
// run ID, records the outcome and always deallocates it again. The worker's
// own Blob lease remains the guard against overlapping runs; the scheduler also
// allows only one workflow run at a time.
//
// Installing Node.js, AzCopy, the worker build and acquisition.json on the VM is
// a separate operator step (azure-post-deploy.ps1 SetupWorker and PrepareWorker,
// see infra/README.md); this template only provides the host, identity,
// schedule and telemetry.

param location string
param tags object
param namePrefix string

param subnetId string
param workerIdentityId string

@description('VM size. Size for the SDK set (~16 GB extracted), XRef restore, the candidate DB and validation.')
param vmSize string

@description('Data disk for worker scratch (SDK, XRef restore, candidate DB), in GB.')
@minValue(128)
param dataDiskSizeGb int

@description('Storage type of the OS and data disks: Premium_LRS or StandardSSD_LRS.')
param diskType string

param adminUsername string
@secure()
param adminPassword string

@description('Directory on the VM holding the worker build (app\\dist\\src\\index.js) and acquisition.json.')
param workerRoot string

@description('UTC hours at which the scheduler starts an acquisition run, for example [2].')
param scheduleHoursUtc array

@description('Whether scheduled runs are on. A new environment starts with them off until a first acquisition succeeds.')
param schedulerEnabled bool

@description('Upper bound for one acquisition run, in hours. Set it above the measured build duration.')
@minValue(1)
@maxValue(23)
param runTimeoutHours int

param workspaceId string

var vmContributor = '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: 'nic-worker-${namePrefix}'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: subnetId }
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: 'vm-worker-${namePrefix}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${workerIdentityId}': {} }
  }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
    }
    osProfile: {
      computerName: take('wrk${replace(namePrefix, '-', '')}', 15)
      adminUsername: adminUsername
      adminPassword: adminPassword
      windowsConfiguration: {
        enableAutomaticUpdates: true
        provisionVMAgent: true
        patchSettings: {
          patchMode: 'AutomaticByPlatform'
          assessmentMode: 'AutomaticByPlatform'
          automaticByPlatformSettings: { bypassPlatformSafetyChecksOnUserSchedule: false }
        }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'MicrosoftWindowsServer'
        offer: 'WindowsServer'
        sku: '2022-datacenter-azure-edition'
        version: 'latest'
      }
      osDisk: {
        name: 'osdisk-worker-${namePrefix}'
        createOption: 'FromImage'
        managedDisk: { storageAccountType: diskType }
        deleteOption: 'Delete'
      }
      dataDisks: [
        {
          name: 'datadisk-worker-${namePrefix}'
          lun: 0
          createOption: 'Empty'
          diskSizeGB: dataDiskSizeGb
          managedDisk: { storageAccountType: diskType }
          deleteOption: 'Detach'
        }
      ]
    }
    networkProfile: {
      networkInterfaces: [{ id: nic.id, properties: { deleteOption: 'Delete' } }]
    }
    diagnosticsProfile: {
      bootDiagnostics: { enabled: true }
    }
  }
}

// ── Telemetry: Azure Monitor Agent with the worker identity ────────────────
resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = {
  name: 'dcr-worker-${namePrefix}'
  location: location
  tags: tags
  kind: 'Windows'
  properties: {
    dataSources: {
      windowsEventLogs: [
        {
          name: 'worker-events'
          streams: ['Microsoft-Event']
          xPathQueries: [
            'Application!*[System[(Level=1 or Level=2 or Level=3)]]'
            'System!*[System[(Level=1 or Level=2 or Level=3)]]'
          ]
        }
      ]
      performanceCounters: [
        {
          name: 'worker-capacity'
          streams: ['Microsoft-Perf']
          samplingFrequencyInSeconds: 60
          counterSpecifiers: [
            '\\Processor(_Total)\\% Processor Time'
            '\\Memory\\Available MBytes'
            '\\LogicalDisk(*)\\% Free Space'
            '\\LogicalDisk(*)\\Free Megabytes'
          ]
        }
      ]
    }
    destinations: {
      logAnalytics: [{ name: 'workspace', workspaceResourceId: workspaceId }]
    }
    dataFlows: [
      { streams: ['Microsoft-Event', 'Microsoft-Perf'], destinations: ['workspace'] }
    ]
  }
}

resource monitorAgent 'Microsoft.Compute/virtualMachines/extensions@2024-07-01' = {
  parent: vm
  name: 'AzureMonitorWindowsAgent'
  location: location
  tags: tags
  properties: {
    publisher: 'Microsoft.Azure.Monitor'
    type: 'AzureMonitorWindowsAgent'
    typeHandlerVersion: '1.0'
    autoUpgradeMinorVersion: true
    enableAutomaticUpgrade: true
    settings: {
      authentication: {
        managedIdentity: {
          'identifier-name': 'mi_res_id'
          'identifier-value': workerIdentityId
        }
      }
    }
  }
}

resource dcrAssociation 'Microsoft.Insights/dataCollectionRuleAssociations@2023-03-11' = {
  scope: vm
  name: 'worker-telemetry'
  properties: {
    dataCollectionRuleId: dcr.id
  }
  dependsOn: [monitorAgent]
}

// ── Scheduler ──────────────────────────────────────────────────────────────
var armBase = '${environment().resourceManager}${substring(vm.id, 1)}'
var computeApiVersion = '2024-07-01'
var armAuth = {
  type: 'ManagedServiceIdentity'
  audience: environment().resourceManager
}

// Run Command passes RunId as a named PowerShell argument. Step output goes to
// the run's logs folder on the VM; only the exit status matters here.
var runScript = join([
  'param([Parameter(Mandatory = $true)][string]$RunId)'
  '$ErrorActionPreference = \'Stop\''
  '$root = \'${workerRoot}\''
  '& node (Join-Path $root \'app\\dist\\src\\index.js\') acquire --config (Join-Path $root \'acquisition.json\') --run-id $RunId'
  'if ($LASTEXITCODE -ne 0) { throw "acquire exited with code $LASTEXITCODE" }'
], '\r\n')

resource scheduler 'Microsoft.Logic/workflows@2019-05-01' = {
  name: 'logic-worker-${namePrefix}'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    state: schedulerEnabled ? 'Enabled' : 'Disabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      triggers: {
        Schedule: {
          type: 'Recurrence'
          recurrence: {
            frequency: 'Day'
            interval: 1
            timeZone: 'UTC'
            // A recurrence without a start time also runs once whenever the workflow is saved or
            // enabled. A start time in the past only anchors the schedule.
            startTime: '2026-01-01T00:00:00'
            schedule: { hours: scheduleHoursUtc, minutes: [0] }
          }
          runtimeConfiguration: {
            concurrency: { runs: 1, maximumWaitingRuns: 1 }
          }
        }
      }
      actions: {
        Start_worker: {
          type: 'Http'
          inputs: {
            method: 'POST'
            uri: '${armBase}/start?api-version=${computeApiVersion}'
            authentication: armAuth
          }
        }
        Run_acquisition: {
          type: 'Http'
          runAfter: { Start_worker: ['Succeeded'] }
          limit: { timeout: 'PT${runTimeoutHours}H' }
          inputs: {
            method: 'PUT'
            uri: '${armBase}/runCommands/acquire?api-version=${computeApiVersion}'
            authentication: armAuth
            body: {
              location: location
              properties: {
                source: { script: runScript }
                parameters: [
                  { name: 'RunId', value: 'scheduled-@{formatDateTime(trigger().scheduledTime, \'yyyyMMddTHHmmZ\')}' }
                ]
                asyncExecution: false
                treatFailureAsDeploymentFailure: true
                timeoutInSeconds: runTimeoutHours * 3600
              }
            }
          }
        }
        Deallocate_worker: {
          type: 'Http'
          runAfter: { Run_acquisition: ['Succeeded', 'Failed', 'TimedOut', 'Skipped'] }
          inputs: {
            method: 'POST'
            uri: '${armBase}/deallocate?api-version=${computeApiVersion}'
            authentication: armAuth
          }
        }
        Report_outcome: {
          type: 'If'
          runAfter: { Deallocate_worker: ['Succeeded', 'Failed'] }
          // A failed deallocation fails the run too, so a VM left running raises the alert.
          expression: {
            and: [
              { equals: ['@actions(\'Run_acquisition\').status', 'Succeeded'] }
              { equals: ['@actions(\'Deallocate_worker\').status', 'Succeeded'] }
            ]
          }
          actions: {}
          else: {
            actions: {
              Fail_run: {
                type: 'Terminate'
                inputs: {
                  runStatus: 'Failed'
                  runError: { code: 'AcquisitionFailed', message: 'The acquisition run or the worker deallocation did not succeed; see the run history and the worker run report.' }
                }
              }
            }
          }
        }
      }
      outputs: {}
    }
  }
}

// Virtual Machine Contributor on this VM only: start, run command, deallocate.
resource schedulerVmAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vm
  name: guid(vm.id, scheduler.id, vmContributor)
  properties: {
    principalId: scheduler.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', vmContributor)
  }
}

resource schedulerDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: scheduler
  name: 'to-log-analytics'
  properties: {
    workspaceId: workspaceId
    logs: [{ category: 'WorkflowRuntime', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output vmId string = vm.id
output vmName string = vm.name
output schedulerId string = scheduler.id
output schedulerName string = scheduler.name
