<#
.SYNOPSIS
    Pauses an environment of the hosted service to cut its cost to a few dollars a month, keeping
    the data a resume needs.

.DESCRIPTION
    Run it from a clone of this repository with PowerShell 7 and the Azure CLI signed in to the
    subscription that holds the environment. Every name comes from the newest successful
    infra/main.bicep deployment in -ResourceGroup and from the workload and environment tags the
    template puts on each resource, so it works for any tenant, subscription and environment.

    Deleted (these are what cost money while nothing runs):
      App Service app, staging slot and plan; worker VM with its NIC, OS disk and data disk;
      NAT gateway and its public IP; private endpoints; availability test and alert rules.
      Every GitHub federated credential on the deploy identity, so no GitHub repository can sign
      in to the subscription while it is paused (scripts/azure-github-trust.ps1 adds one back).
    Kept (free or a few dollars a month):
      Storage account: artifact bundles (the index the API loads), sources, operations.
      Key Vaults and their secrets (purge protection would reserve deleted names for 90 days).
      Managed identities with their role assignments, so the GitHub 'production' environment's
      client ID stays valid.
      Container registry and its images; Log Analytics and Application Insights; VNet, subnets,
      NSGs and private DNS zones (the storage and vault firewalls name the subnets); the Logic App
      scheduler, disabled; the action group and the worker's data collection rule.

    Before deleting it records the running API image and the scheduler state as resource group
    tags. scripts/azure-deploy.ps1 reads them when the app does not exist, so a resume brings the
    same image back, then removes the tags. The scheduler stays disabled after a resume, because
    the new worker VM has to be set up first.

    Resume:
      ./scripts/azure-deploy.ps1 -ResourceGroup <group> -EnvironmentName <env>
    recreates everything deleted here. The API pulls the active bundle from storage on start, so
    no acquisition is needed. The new worker VM has an empty data disk, so before the next
    acquisition run azure-post-deploy.ps1 -Step SetupWorker,PrepareWorker (with -DataverseUrl and
    -WorkerApplicationId), then -Step ResumeScheduler if the scheduler was on.

    It lists what it would delete and keep, then asks you to type the resource group name.
    -WhatIfOnly lists and stops without changing anything. It stops when the worker VM is running,
    because an acquisition run may be in progress.

.EXAMPLE
    ./scripts/azure-pause.ps1 -ResourceGroup D365fodevmcp -WhatIfOnly

.EXAMPLE
    ./scripts/azure-pause.ps1 -ResourceGroup D365fodevmcp

.EXAMPLE
    ./scripts/azure-pause.ps1 -ResourceGroup D365fodevmcp -LogLevel Verbose
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
    # Resource group the infra/main.bicep deployment went into.
    [Parameter(Mandatory)]
    [ValidatePattern('^[-\w._()]{1,90}$')]
    [string]$ResourceGroup,

    # Subscription holding the resource group. Defaults to the Azure CLI's current subscription.
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', ErrorMessage = '{0} is not a valid subscription ID (expected a GUID like 00000000-0000-0000-0000-000000000000). Run az account list -o table to see yours.')]
    [string]$SubscriptionId,

    # Name of the infra/main.bicep deployment. Defaults to the newest successful one in the group.
    [string]$DeploymentName,

    # List what would be deleted and kept, then stop.
    [switch]$WhatIfOnly,

    # How much the script prints: Error, Warning, Info (default), Verbose or Debug. -Verbose and -Debug also work.
    [ValidateSet('Error', 'Warning', 'Info', 'Verbose', 'Debug')]
    [string]$LogLevel = 'Info'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

# -LogLevel, raised to at least Verbose or Debug by -Verbose or -Debug.
$script:LogRank = @{ Error = 0; Warning = 1; Info = 2; Verbose = 3; Debug = 4 }[$LogLevel]
if ($VerbosePreference -eq 'Continue' -and $script:LogRank -lt 3) { $script:LogRank = 3 }
if ($DebugPreference -in @('Continue', 'Inquire')) { $script:LogRank = 4 }
$VerbosePreference = if ($script:LogRank -ge 3) { 'Continue' } else { 'SilentlyContinue' }
# Never 'Inquire': a debug run must not stop at every Write-Debug.
$DebugPreference = if ($script:LogRank -ge 4) { 'Continue' } else { 'SilentlyContinue' }
if ($script:LogRank -lt 1) { $WarningPreference = 'SilentlyContinue' }
# No call here sends or returns a secret, so every az call may get --verbose/--debug.
$script:AzLogArgs = @(if ($script:LogRank -ge 4) { '--debug' } elseif ($script:LogRank -ge 3) { '--verbose' })

# Resource group tags that azure-deploy.ps1 reads on resume.
$PausedAtTag = 'd365mcp-paused-at'
$PausedImageTag = 'd365mcp-paused-api-image'
$PausedSchedulerTag = 'd365mcp-paused-scheduler'

# Deleted, in this order; a resource whose dependents are not gone yet is retried.
$DeleteOrder = [ordered]@{
    'microsoft.insights/metricalerts' = 0; 'microsoft.insights/scheduledqueryrules' = 0
    'microsoft.insights/webtests' = 0; 'microsoft.web/sites' = 1; 'microsoft.compute/virtualmachines' = 1
    'microsoft.web/serverfarms' = 2; 'microsoft.network/privateendpoints' = 2
    'microsoft.network/networkinterfaces' = 3; 'microsoft.compute/disks' = 3
    'microsoft.network/natgateways' = 4; 'microsoft.network/publicipaddresses' = 5
}

function Write-Info([string]$Text, [ConsoleColor]$ForegroundColor) {
    if ($script:LogRank -lt 2) { return }
    $colour = @{}
    if ($PSBoundParameters.ContainsKey('ForegroundColor')) { $colour.ForegroundColor = $ForegroundColor }
    Write-Host $Text @colour
}

function Write-Step([string]$Text) { Write-Info "`n== $Text ==" -ForegroundColor Cyan }

function Invoke-Az {
    Write-Verbose "az $($args -join ' ')"
    $output = & az @args @script:AzLogArgs
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)." }
    return $output
}

# For calls whose failure the caller handles through $LASTEXITCODE; az's error text shows at Verbose.
function Invoke-AzQuiet {
    Write-Verbose "az $($args -join ' ')"
    $ErrorActionPreference = 'Continue'
    foreach ($line in (& az @args 2>&1)) {
        if ($line -is [Management.Automation.ErrorRecord]) { Write-Verbose "az: $line" } else { $line }
    }
}

# -- 1. Context and environment ------------------------------------------------------------------
Write-Step 'Reading the environment'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Install the Azure CLI first.' }
if ($SubscriptionId) {
    $visible = Invoke-Az account list --query "[?id=='$SubscriptionId'] | length(@)" -o tsv
    if ($visible -ne '1') { throw "Subscription $SubscriptionId is not visible to the signed-in account. Check the ID with az account list -o table." }
    Invoke-Az account set --subscription $SubscriptionId | Out-Null
}
$account = Invoke-Az account show -o json | ConvertFrom-Json

$name = $DeploymentName
if (-not $name) {
    $name = Invoke-Az deployment group list -g $ResourceGroup `
        --query "[?properties.provisioningState=='Succeeded' && properties.outputs.webAppName != null] | sort_by(@, &properties.timestamp) | [-1].name" -o tsv
    if (-not $name) { throw "No successful infra/main.bicep deployment found in $ResourceGroup. Pass -DeploymentName." }
}
$deployment = Invoke-Az deployment group show -g $ResourceGroup -n $name --query properties -o json | ConvertFrom-Json
$value = {
    param($section, $key)
    $entry = $deployment.$section.PSObject.Properties[$key]
    if (-not $entry -or $null -eq $entry.Value.value) { throw "Deployment '$name' has no '$key' $section value. Pass -DeploymentName of an infra/main.bicep deployment." }
    return [string]$entry.Value.value
}
$environmentName = & $value parameters environmentName
# Older parameter files left workloadName at the template default.
$workloadEntry = $deployment.parameters.PSObject.Properties['workloadName']
$workloadName = if ($workloadEntry -and $workloadEntry.Value.value) { [string]$workloadEntry.Value.value } else { 'd365mcp' }
$webApp = & $value outputs webAppName
$workerVm = & $value outputs workerVmName
$scheduler = & $value outputs schedulerName
$registry = & $value outputs registryName
$deployClientId = & $value outputs deployClientId

Write-Host "Subscription: $($account.name) ($($account.id)), tenant $($account.tenantId)"
Write-Host "Target:       $ResourceGroup, environment '$environmentName', workload '$workloadName' (deployment '$name')"

# -- 2. Current state ----------------------------------------------------------------------------
Write-Step 'Checking current state'
$groupTags = Invoke-Az group show -n $ResourceGroup --query tags -o json | ConvertFrom-Json
$alreadyPaused = $groupTags -and $groupTags.PSObject.Properties[$PausedAtTag]

$apiImage = $null
$fx = Invoke-AzQuiet webapp config show -g $ResourceGroup -n $webApp --query linuxFxVersion -o tsv
if ($LASTEXITCODE -eq 0 -and $fx -match '^DOCKER\|[^/]+/(.+)$') {
    $apiImage = $Matches[1]
    Write-Info "Running API image: $apiImage."
}
elseif ($alreadyPaused) {
    Write-Info "$webApp does not exist; the group was already paused at $($groupTags.$PausedAtTag)."
}
else {
    Write-Verbose "No running API image on $webApp (exit $LASTEXITCODE, linuxFxVersion '$fx'); a resume uses the template default."
}

$schedulerState = Invoke-AzQuiet resource show -g $ResourceGroup -n $scheduler --resource-type Microsoft.Logic/workflows --query properties.state -o tsv
if ($LASTEXITCODE -ne 0) { $schedulerState = $null }
Write-Verbose "Scheduler '$scheduler' state: '$schedulerState'."

$power = Invoke-AzQuiet vm get-instance-view -g $ResourceGroup -n $workerVm --query "instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]" -o tsv
if ($LASTEXITCODE -eq 0 -and $power -and $power -ne 'PowerState/deallocated') {
    $message = "$workerVm is $($power -replace 'PowerState/', ''), so an acquisition run may be in progress. Wait for it to finish and deallocate (or run az vm deallocate -g $ResourceGroup -n $workerVm when no run is active), then run this again."
    if ($WhatIfOnly) { Write-Warning $message } else { throw $message }
}

# -- 3. What is deleted and kept -----------------------------------------------------------------
$all = @(Invoke-Az resource list -g $ResourceGroup --query '[].{id:id, name:name, type:type, tags:tags}' -o json | ConvertFrom-Json)
$ours = {
    param($resource)
    $tags = $resource.tags
    return $tags -and $tags.PSObject.Properties['environment'] -and $tags.environment -eq $environmentName -and
        $tags.PSObject.Properties['workload'] -and $tags.workload -eq $workloadName
}
$doomed = @($all | Where-Object { $DeleteOrder.Contains($_.type.ToLowerInvariant()) -and (& $ours $_) } |
    Sort-Object { $DeleteOrder[$_.type.ToLowerInvariant()] }, name)
$doomedIds = @($doomed | ForEach-Object { $_.id })
$kept = @($all | Where-Object { $doomedIds -notcontains $_.id } | Sort-Object type, name)
# Federated credentials are child resources, so resource list does not show them.
$deployIdentity = $all | Where-Object { $_.type -eq 'Microsoft.ManagedIdentity/userAssignedIdentities' } |
    Where-Object { (Invoke-Az identity show --ids $_.id --query clientId -o tsv) -eq $deployClientId } | Select-Object -First 1
$githubTrust = @()
if ($deployIdentity) {
    $githubTrust = @(Invoke-Az identity federated-credential list -g $ResourceGroup --identity-name $deployIdentity.name -o json | ConvertFrom-Json |
        Where-Object { $_.issuer -eq 'https://token.actions.githubusercontent.com' })
}
$untagged = @($all | Where-Object { $DeleteOrder.Contains($_.type.ToLowerInvariant()) -and -not (& $ours $_) })

Write-Host "`nDeleted ($($doomed.Count + $githubTrust.Count)):" -ForegroundColor Yellow
$doomed | ForEach-Object { Write-Host ("  {0,-50} {1}" -f $_.type, $_.name) }
foreach ($credential in $githubTrust) {
    Write-Host ("  {0,-50} {1}" -f 'GitHub federated credential', "$($deployIdentity.name)/$($credential.name) ($($credential.subject))")
}
Write-Host "`nKept ($($kept.Count)):" -ForegroundColor Green
$kept | ForEach-Object { Write-Host ("  {0,-50} {1}" -f $_.type, $_.name) }
foreach ($resource in $untagged) {
    Write-Warning "Left alone: $($resource.type) '$($resource.name)' has no workload=$workloadName / environment=$environmentName tags, so it may not belong to this environment."
}

$registrySku = Invoke-AzQuiet acr show -g $ResourceGroup -n $registry --query sku.name -o tsv
Write-Host "`nWhat stays billed: storage (by GB stored), container registry $registrySku, 3 private DNS zones (about `$1.50), Key Vaults and Log Analytics (by use, close to nothing while paused)."
if ($registrySku -eq 'Premium') {
    Write-Warning "The registry is Premium (about `$50 a month). Run azure-deploy.ps1 -CostProfile cheapest -ReplaceIncompatible before pausing to move it to Basic (about `$5)."
}
if ($schedulerState -eq 'Enabled') { Write-Info "The scheduler '$scheduler' is turned off; turn it on again with azure-post-deploy.ps1 -Step ResumeScheduler after the worker is set up." }

if ($WhatIfOnly) { Write-Info "`n-WhatIfOnly: nothing was changed."; return }
if ($doomed.Count -eq 0 -and $githubTrust.Count -eq 0) { Write-Info "`nNothing to delete: $ResourceGroup is already paused."; return }

Write-Warning 'Deleting these cannot be undone. The bundles, secrets, identities and images are kept; the worker VM disks are not, so the next acquisition run starts with a fresh worker, and the Deploy workflow cannot sign in until azure-github-trust.ps1 runs again.'
$typed = Read-Host "Type the resource group name ($ResourceGroup) to pause it"
if ($typed -cne $ResourceGroup) { throw 'Stopped: the name did not match, nothing was changed.' }

# -- 4. Record state for the resume, then stop the scheduler -------------------------------------
Write-Step 'Recording state for the resume'
$tagArgs = @("tags.$PausedAtTag=$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ'))")
# A second pause keeps what the first one recorded.
if ($apiImage) { $tagArgs += "tags.$PausedImageTag=$apiImage" }
if ($schedulerState -and -not ($alreadyPaused -and $groupTags.PSObject.Properties[$PausedSchedulerTag])) { $tagArgs += "tags.$PausedSchedulerTag=$schedulerState" }
Invoke-Az group update -n $ResourceGroup --set @tagArgs --output none | Out-Null
Write-Info "Tagged $ResourceGroup with $(($tagArgs | ForEach-Object { $_ -replace '^tags\.', '' }) -join ', ')."

if ($schedulerState -eq 'Enabled') {
    Invoke-Az resource update -g $ResourceGroup -n $scheduler --resource-type Microsoft.Logic/workflows `
        --set properties.state=Disabled --output none | Out-Null
    Write-Info "Disabled $scheduler."
}

# -- 5. Delete -----------------------------------------------------------------------------------
Write-Step 'Deleting'
foreach ($credential in $githubTrust) {
    Write-Info "Deleting GitHub federated credential '$($credential.name)' ($($credential.subject))..."
    Invoke-Az identity federated-credential delete -g $ResourceGroup --identity-name $deployIdentity.name -n $credential.name --yes --output none | Out-Null
}
# The NAT gateway cannot be deleted while a subnet uses it; the resume attaches it again.
$nat = @($doomed | Where-Object { $_.type -eq 'Microsoft.Network/natGateways' })
$remaining = @($doomed)
for ($pass = 1; $pass -le 5 -and $remaining.Count -gt 0; $pass++) {
    if ($pass -gt 1) { Write-Info "Retrying $($remaining.Count) resource(s) that still had dependents..."; Start-Sleep -Seconds 60 }
    $failed = @()
    foreach ($resource in $remaining) {
        Invoke-AzQuiet resource show --ids $resource.id --output none
        if ($LASTEXITCODE -ne 0) { Write-Verbose "'$($resource.name)' is already gone."; continue }
        if ($resource.type -eq 'Microsoft.Network/natGateways') {
            $subnets = @(Invoke-Az network nat gateway show --ids $resource.id --query 'subnets[].id' -o json | ConvertFrom-Json)
            foreach ($subnet in $subnets) {
                Write-Info "Detaching $($resource.name) from subnet $(Split-Path -Leaf $subnet)..."
                Invoke-AzQuiet network vnet subnet update --ids $subnet --remove natGateway --output none | Out-Null
            }
        }
        Write-Info "Deleting $($resource.type) '$($resource.name)'..."
        Invoke-AzQuiet resource delete --ids $resource.id --output none
        if ($LASTEXITCODE -ne 0) { Write-Verbose "Deleting '$($resource.name)' failed (exit $LASTEXITCODE) in pass $pass."; $failed += $resource }
    }
    $remaining = $failed
}
if ($remaining.Count -gt 0) {
    throw "Could not delete: $(($remaining | ForEach-Object { "$($_.type) '$($_.name)'" }) -join ', '). Delete them in the portal or run this again; the state for the resume is already recorded."
}
Write-Info "Deleted $($doomed.Count) resources and $($githubTrust.Count) GitHub credential(s). $ResourceGroup is paused."
if ($nat) { Write-Verbose 'The subnets have no NAT gateway until the resume.' }

Write-Host "`nTo resume:" -ForegroundColor Cyan
Write-Host "  ./scripts/azure-deploy.ps1 -ResourceGroup $ResourceGroup -EnvironmentName $environmentName -SubscriptionId $($account.id)"
Write-Host '  The API comes back with the same image and loads the kept bundle from storage.'
Write-Host '  Before the next Deploy run, let the repository sign in again (after a move, from a clone of the new location):'
Write-Host "  ./scripts/azure-github-trust.ps1 -ResourceGroup $ResourceGroup"
Write-Host '  Before the next acquisition run:'
$workerSteps = if ($schedulerState -eq 'Enabled') { 'SetupWorker,PrepareWorker,ResumeScheduler' } else { 'SetupWorker,PrepareWorker' }
Write-Host "  ./scripts/azure-post-deploy.ps1 -ResourceGroup $ResourceGroup -Step $workerSteps -DataverseUrl <url> -WorkerApplicationId <app id>"
