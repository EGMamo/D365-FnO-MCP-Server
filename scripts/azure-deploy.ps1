<#
.SYNOPSIS
    Deploys one environment of the hosted service (infra/main.bicep) into any tenant and subscription.

.DESCRIPTION
    Run it from a clone of this repository with PowerShell 7 and the Azure CLI. Nothing about the
    tenant, subscription, resource group or resource names is fixed: the tenant and subscription
    come from -TenantId/-SubscriptionId or the Azure CLI's current context, and every resource name
    is derived by the template from -WorkloadName and -EnvironmentName.

    It runs these steps:
      1. Signs in to -TenantId if needed (in a browser, or with -UseDeviceCode a device code),
         selects the subscription and shows the context.
      2. Registers the resource providers the template uses (needed on a new subscription).
      3. Creates the resource group if it does not exist. With -RemoveExistingResources it first
         deletes every resource in the group except the Key Vaults, after showing them and asking
         you to type the resource group name.
      4. Writes infra/main.<environment>.local.bicepparam (git-ignored, no secret values). On a
         redeploy it keeps the API image that is currently running and, once scheduled
         acquisition runs are on, keeps them on. A new environment starts with them off.
      5. Checks for existing resources that an in-place deployment cannot move to the chosen cost
         profile (worker disk type, registry private endpoint). With -ReplaceIncompatible it
         converts them after confirmation; without it, it stops and says what to do.
      6. Runs what-if, asks for confirmation, then deploys.
      7. Prints the outputs and, with -PostDeploy, runs scripts/azure-post-deploy.ps1.

    -CostProfile picks the sizing: 'cheapest' (the default for environment names starting with
    'dev') or 'standard' (the default otherwise). See costProfile in infra/main.bicep.

    The worker VM's local administrator password is read from D365_WORKER_ADMIN_PASSWORD when set,
    otherwise prompted without echo. It reaches the template only through that process environment
    variable, never a file or a command line.

    The signed-in identity needs Owner, or Contributor plus User Access Administrator, on the
    resource group (the template creates role assignments).

    -LogLevel sets how much it prints: Error, Warning, Info (the default), Verbose or Debug;
    -Verbose and -Debug also work. Verbose adds each az command, the error text of az calls whose
    failure the script handles, the values behind each decision and step timings, and passes
    --verbose to az; Debug adds internal values and passes --debug. The calls that send the worker
    password (what-if and the deployment) never get those flags, because az --debug logs request
    bodies. Errors, questions and what they ask about (the what-if result too with -WhatIfOnly)
    show at every level. -PostDeploy passes a level you set on to azure-post-deploy.ps1.

.EXAMPLE
    ./scripts/azure-deploy.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> -ResourceGroup rg-d365mcp-prod -Location westeurope -EnvironmentName prod -AlertEmail ops@example.com

.EXAMPLE
    ./scripts/azure-deploy.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> -ResourceGroup rg-d365mcp-prod -EnvironmentName prod -UseDeviceCode

.EXAMPLE
    ./scripts/azure-deploy.ps1 -ResourceGroup rg-d365mcp-prod -EnvironmentName prod -WhatIfOnly

.EXAMPLE
    ./scripts/azure-deploy.ps1 -ResourceGroup rg-d365mcp-prod -EnvironmentName prod -PostDeploy

.EXAMPLE
    # Move an existing dev environment to the cheapest profile, converting the worker disks and
    # removing the registry's private endpoint.
    ./scripts/azure-deploy.ps1 -ResourceGroup rg-d365mcp-dev -EnvironmentName dev -CostProfile cheapest -ReplaceIncompatible

.EXAMPLE
    # Start over: delete everything in the group except the Key Vaults, then deploy fresh.
    ./scripts/azure-deploy.ps1 -ResourceGroup rg-d365mcp-dev -EnvironmentName dev -RemoveExistingResources

.EXAMPLE
    # Show each az command, the values behind each decision and step timings.
    ./scripts/azure-deploy.ps1 -ResourceGroup rg-d365mcp-dev -EnvironmentName dev -LogLevel Verbose
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[-\w._()]{1,90}$')]
    [string]$ResourceGroup,

    # Short environment name used in resource names (template limit: 8 characters).
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9-]{1,8}$')]
    [string]$EnvironmentName,

    # Region for a new resource group. Defaults to the existing group's region.
    [string]$Location,

    # Tenant to sign in to. Defaults to the Azure CLI's current tenant.
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', ErrorMessage = '{0} is not a valid tenant ID (expected a GUID like 00000000-0000-0000-0000-000000000000). Run az account list -o table to see yours.')]
    [string]$TenantId,

    # Subscription to deploy into. Defaults to the Azure CLI's current subscription.
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', ErrorMessage = '{0} is not a valid subscription ID (expected a GUID like 00000000-0000-0000-0000-000000000000). Run az account list -o table to see yours.')]
    [string]$SubscriptionId,

    [ValidatePattern('^[a-z0-9]{1,10}$')]
    [string]$WorkloadName = 'd365mcp',

    # Client CIDR ranges allowed to reach the API. Empty allows all addresses (API keys still apply).
    [string[]]$AllowedIngressCidrs = @(),

    # Addresses that receive alert emails.
    [string[]]$AlertEmail = @(),

    [hashtable]$Tags = @{},

    # GitHub repository (owner/name) that -PostDeploy configures and trusts to deploy the API.
    # Defaults to the GitHub repository of this clone's 'origin' remote. The template itself trusts
    # no repository; see scripts/azure-github-trust.ps1.
    [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$', ErrorMessage = '{0} is not an owner/name repository.')]
    [string]$GitHubRepository,

    # Use this parameter file instead of generating one. It must read the worker password with
    # readEnvironmentVariable('D365_WORKER_ADMIN_PASSWORD').
    [string]$ParameterFile,

    # Sizing profile. Defaults to 'cheapest' for environment names starting with 'dev' and to
    # 'standard' otherwise. Ignored with -ParameterFile, which sets costProfile itself.
    [ValidateSet('standard', 'cheapest')]
    [string]$CostProfile,

    # Convert existing resources whose new settings cannot be applied in place: worker disks whose
    # type changes (the VM must be deallocated; disk contents are kept) and the registry private
    # endpoint that blocks a Premium to Basic downgrade (images are kept). Asks first.
    [switch]$ReplaceIncompatible,

    # Delete every resource in the resource group except the Key Vaults before deploying. Shows the
    # list and requires typing the resource group name; -Yes does not skip that. Bundles, images and
    # worker disks are lost; the vaults and their secrets are kept because purge protection
    # reserves vault names for 90 days after deletion.
    [switch]$RemoveExistingResources,

    # Sign in with a device code (az login --use-device-code) instead of opening a browser.
    [switch]$UseDeviceCode,

    # Run what-if and stop.
    [switch]$WhatIfOnly,

    [switch]$SkipWhatIf,

    # Do not ask for confirmation before deploying.
    [switch]$Yes,

    # Run scripts/azure-post-deploy.ps1 after a successful deployment.
    [switch]$PostDeploy,

    # How much the script prints: Error, Warning, Info (default), Verbose or Debug. -Verbose and -Debug also work.
    [ValidateSet('Error', 'Warning', 'Info', 'Verbose', 'Debug')]
    [string]$LogLevel = 'Info'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

# -Verbose and -Debug raise the level; the preference variables then follow the resolved level.
$script:LogRank = @{ Error = 0; Warning = 1; Info = 2; Verbose = 3; Debug = 4 }[$LogLevel]
if ($VerbosePreference -eq 'Continue' -and $script:LogRank -lt 3) { $script:LogRank = 3 }
if ($DebugPreference -in @('Continue', 'Inquire')) { $script:LogRank = 4 }
$script:LogLevelName = @('Error', 'Warning', 'Info', 'Verbose', 'Debug')[$script:LogRank]
# True only when you passed -LogLevel, -Verbose or -Debug, so a default run calls
# azure-post-deploy.ps1 as before, even when your session's preferences raise the level here.
$script:LogLevelRequested = $PSBoundParameters.ContainsKey('LogLevel') -or [bool]$PSBoundParameters['Verbose'] -or
    [bool]$PSBoundParameters['Debug']
$VerbosePreference = if ($script:LogRank -ge 3) { 'Continue' } else { 'SilentlyContinue' }
# Never 'Inquire': a debug run must not stop at every Write-Debug.
$DebugPreference = if ($script:LogRank -ge 4) { 'Continue' } else { 'SilentlyContinue' }
# Only a requested level changes these, and an explicit -WarningAction or -InformationAction still
# wins, so a default run honours the caller's settings as before.
if ($script:LogLevelRequested -and -not $PSBoundParameters.ContainsKey('WarningAction')) {
    $WarningPreference = if ($script:LogRank -ge 1) { 'Continue' } else { 'SilentlyContinue' }
}
if ($script:LogLevelRequested -and -not $PSBoundParameters.ContainsKey('InformationAction')) {
    $InformationPreference = if ($script:LogRank -ge 2) { 'Continue' } else { 'SilentlyContinue' }
}
# Splatted into warnings that explain a question or the list before it: -LogLevel Error does not
# hide them, but -WarningAction does.
$script:WarnAtAllLevels = @{}
if ($script:LogRank -lt 1 -and -not $PSBoundParameters.ContainsKey('WarningAction')) { $script:WarnAtAllLevels.WarningAction = 'Continue' }
# Added by Invoke-Az only. az --debug logs request and response bodies, so calls that carry a secret
# go through Invoke-AzSensitive and never get these.
$script:AzLogArgs = @(if ($script:LogRank -ge 4) { '--debug' } elseif ($script:LogRank -ge 3) { '--verbose' })
Write-Verbose "Log level $($script:LogLevelName); PowerShell $($PSVersionTable.PSVersion)."

if ($RemoveExistingResources -and $WhatIfOnly) { throw '-RemoveExistingResources deletes resources, so it cannot be combined with -WhatIfOnly.' }

$RepoRoot = Split-Path -Parent $PSScriptRoot
if ($PostDeploy -and -not $GitHubRepository) {
    $GitHubRepository = & (Join-Path $PSScriptRoot 'Get-GitHubRepository.ps1')
    Write-Verbose "GitHub repository from the origin remote: $GitHubRepository."
}
$Template = Join-Path $RepoRoot 'infra/main.bicep'
$PasswordVariable = 'D365_WORKER_ADMIN_PASSWORD'
# Resource group tags written by azure-pause.ps1 and removed after a successful deployment.
$PausedTags = @('d365mcp-paused-at', 'd365mcp-paused-api-image', 'd365mcp-paused-scheduler')
$PausedImageTag = 'd365mcp-paused-api-image'
$Providers = @(
    'Microsoft.Authorization', 'Microsoft.Compute', 'Microsoft.ContainerRegistry', 'Microsoft.Insights',
    'Microsoft.KeyVault', 'Microsoft.Logic', 'Microsoft.ManagedIdentity', 'Microsoft.Network',
    'Microsoft.OperationalInsights', 'Microsoft.Storage', 'Microsoft.Web'
)

# Write-Host ignores the preference variables, so Info-level progress goes through here.
function Write-Info([string]$Text, [ConsoleColor]$ForegroundColor) {
    if ($script:LogRank -lt 2) { return }
    $colour = @{}
    if ($PSBoundParameters.ContainsKey('ForegroundColor')) { $colour.ForegroundColor = $ForegroundColor }
    Write-Host $Text @colour
}

$script:CurrentStep = $null
function Complete-Step {
    if ($script:CurrentStep) { Write-Verbose "'$($script:CurrentStep.Name)' took $($script:CurrentStep.Timer.Elapsed.ToString('hh\:mm\:ss'))." }
    $script:CurrentStep = $null
}

function Write-Step([string]$Text) {
    Complete-Step
    $script:CurrentStep = @{ Name = $Text; Timer = [Diagnostics.Stopwatch]::StartNew() }
    Write-Info "`n== $Text ==" -ForegroundColor Cyan
}

# For calls that send and return no secret values: shows the command and adds az --verbose/--debug.
function Invoke-Az {
    Write-Verbose "az $($args -join ' ')"
    $output = & az @args @script:AzLogArgs
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)." }
    return $output
}

# For calls that send or return a secret, such as the deployment commands, whose compiled parameters
# include the worker password: no --verbose/--debug at any level and only the subcommand is shown.
function Invoke-AzSensitive {
    $command = foreach ($word in $args) { if ("$word".StartsWith('-')) { break }; $word }
    Write-Verbose "az $($command -join ' ') (carries a secret: arguments not shown, no --verbose/--debug)"
    $output = & az @args
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)." }
    return $output
}

# For calls whose failure the caller handles through $LASTEXITCODE: az's error text stays hidden as
# before and shows at Verbose. No --verbose/--debug, whose text would bury it.
function Invoke-AzQuiet {
    Write-Verbose "az $($args -join ' ')"
    # The merged error text is data here, not a failure.
    $ErrorActionPreference = 'Continue'
    foreach ($line in (& az @args 2>&1)) {
        if ($line -is [Management.Automation.ErrorRecord]) { Write-Verbose "az: $line" } else { $line }
    }
}

function Confirm-Continue([string]$Question) {
    if ($Yes) { return }
    $answer = Read-Host "$Question [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw 'Stopped at your request.' }
}

function ConvertTo-BicepString([string]$Value) {
    return "'" + $Value.Replace('\', '\\').Replace("'", "\'") + "'"
}

function ConvertTo-BicepArray([string[]]$Values) {
    if (-not $Values -or $Values.Count -eq 0) { return '[]' }
    return "[`n" + (($Values | ForEach-Object { '  ' + (ConvertTo-BicepString $_) }) -join "`n") + "`n]"
}

# Azure requires 12-123 characters with three of: lowercase, uppercase, digit, symbol.
function Test-VmPassword([string]$Value) {
    if ($Value.Length -lt 12 -or $Value.Length -gt 123) { return $false }
    $classes = @('[a-z]', '[A-Z]', '\d', '[^a-zA-Z\d]') | Where-Object { $Value -cmatch $_ }
    return @($classes).Count -ge 3
}

# Prints the innermost errors of a failed deployment, including preflight policy denials, and the
# failed operations of it and its nested module deployments.
function Write-DeploymentFailure([string]$Name) {
    Write-Host "`nDeployment '$Name' failed:" -ForegroundColor Red
    $seenText = [Text.StringBuilder]::new()
    $errorJson = Invoke-AzQuiet deployment group show -g $ResourceGroup -n $Name --query properties.error -o json
    if ($LASTEXITCODE -ne 0 -or -not $errorJson -or $errorJson -eq 'null') {
        Write-Host "No error details recorded; run: az deployment group show -g $ResourceGroup -n $Name"
    }
    else {
        $leaves = [Collections.Generic.List[object]]::new()
        $walk = {
            param($node)
            $children = @(@($node.PSObject.Properties['details']?.Value) | Where-Object { $_ })
            if ($children.Count -eq 0) { $leaves.Add($node) } else { foreach ($child in $children) { & $walk $child } }
        }
        & $walk ($errorJson | ConvertFrom-Json)
        foreach ($leaf in $leaves) {
            $target = $leaf.PSObject.Properties['target']?.Value
            Write-Host "- $($leaf.code)$(if ($target) { " on $target" }): $($leaf.message)"
            [void]$seenText.AppendLine("$($leaf.code) $target $($leaf.message)")
        }
    }

    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($Name)
    $seen = @{}
    while ($pending.Count -gt 0) {
        $current = $pending.Dequeue()
        if ($seen.ContainsKey($current)) { continue }
        $seen[$current] = $true
        $opsJson = Invoke-AzQuiet deployment operation group list -g $ResourceGroup -n $current `
            --query "[?properties.provisioningState=='Failed'].{type:properties.targetResource.resourceType, name:properties.targetResource.resourceName, code:properties.statusMessage.error.code, message:properties.statusMessage.error.message}" -o json
        if ($LASTEXITCODE -ne 0 -or -not $opsJson) { continue }
        foreach ($op in @($opsJson | ConvertFrom-Json)) {
            if ($op.type -eq 'Microsoft.Resources/deployments') { $pending.Enqueue($op.name); continue }
            Write-Host "- $($op.type) '$($op.name)': $($op.code): $($op.message)"
            [void]$seenText.AppendLine("$($op.type) $($op.name) $($op.code) $($op.message)")
        }
    }

    # Known failure classes and what to do about them.
    $text = $seenText.ToString()
    $hints = @()
    if ($text -match 'BlobAlreadyExists') {
        $hints += 'Key Vault returned an internal 409 conflict (BlobAlreadyExists). This is transient on the Key Vault side, typically when vaults are created at the same moment; rerun the script. Do not delete the vault: purge protection would block its name for 90 days.'
    }
    if ($text -match '(?i)soft.?delete|deleted state|VaultAlreadyExists|already in use') {
        $hints += "A vault with this name exists or is soft-deleted. List soft-deleted vaults with: az keyvault list-deleted --query `"[].name`" -o tsv. Recover one with: az keyvault recover -n <name>. Purge protection prevents purging it, so recover it or use another -EnvironmentName."
    }
    if ($text -match 'RequestDisallowedByPolicy') {
        $hints += "An Azure Policy assignment denied a resource. The message above names the policy; see 'Organization policies' in infra/README.md for the parameter that changes the setting, or ask for an exemption."
    }
    if ($text -match 'AuthorizationFailed' -and $text -match 'roleAssignments') {
        $hints += 'You may not create role assignments here. You need Owner, or User Access Administrator, on the resource group.'
    }
    foreach ($hint in $hints) { Write-Host "`nWhat to do: $hint" -ForegroundColor Yellow }
}

# Deletes the given resources, cheapest dependents first, retrying what still has dependents.
function Remove-GroupResources([object[]]$Resources) {
    $rank = @{
        'microsoft.insights/metricalerts' = 0; 'microsoft.insights/scheduledqueryrules' = 0
        'microsoft.insights/webtests' = 0; 'microsoft.insights/actiongroups' = 1
        'microsoft.logic/workflows' = 1; 'microsoft.compute/virtualmachines' = 2; 'microsoft.web/sites' = 2
        'microsoft.network/privateendpoints' = 3; 'microsoft.network/networkinterfaces' = 4
        'microsoft.compute/disks' = 4; 'microsoft.web/serverfarms' = 4
        'microsoft.network/privatednszones/virtualnetworklinks' = 5; 'microsoft.insights/datacollectionrules' = 5
        'microsoft.insights/components' = 6; 'microsoft.network/virtualnetworks' = 7
        'microsoft.network/privatednszones' = 8; 'microsoft.network/natgateways' = 8
        'microsoft.network/networksecuritygroups' = 8; 'microsoft.network/publicipaddresses' = 9
        'microsoft.operationalinsights/workspaces' = 9
    }
    $remaining = @($Resources | Sort-Object { $r = $rank[$_.type.ToLowerInvariant()]; if ($null -eq $r) { 5 } else { $r } })
    for ($pass = 1; $pass -le 5 -and $remaining.Count -gt 0; $pass++) {
        # A deleted app's subnet link or a deleted VM's NIC can take a minute to release.
        if ($pass -gt 1) { Write-Info "Retrying $($remaining.Count) resource(s) that still had dependents..."; Start-Sleep -Seconds 60 }
        $failed = @()
        foreach ($resource in $remaining) {
            # Children (slots, VM extensions) go with their parent.
            Invoke-AzQuiet resource show --ids $resource.id --output none
            if ($LASTEXITCODE -ne 0) { Write-Verbose "'$($resource.name)' is already gone."; continue }
            Write-Info "Deleting $($resource.type) '$($resource.name)'..."
            Invoke-AzQuiet resource delete --ids $resource.id --output none
            if ($LASTEXITCODE -ne 0) { Write-Verbose "Deleting '$($resource.name)' failed (exit $LASTEXITCODE) in pass $pass."; $failed += $resource }
        }
        $remaining = $failed
    }
    if ($remaining.Count -gt 0) {
        throw "Could not delete: $(($remaining | ForEach-Object { "$($_.type) '$($_.name)'" }) -join ', '). Delete them in the portal and run the script again."
    }
}

# -- 1. Tools and context ------------------------------------------------------------------------
Write-Step 'Checking tools and Azure context'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Install the Azure CLI first.' }
Write-Verbose "Azure CLI: $((Get-Command az).Source)"
Invoke-AzQuiet bicep version | Out-Null
if ($LASTEXITCODE -ne 0) { Invoke-Az bicep install | Out-Null }

$account = $null
$current = Invoke-AzQuiet account show -o json
if ($LASTEXITCODE -eq 0) { $account = $current | ConvertFrom-Json }
if ($account) { Write-Verbose "Azure CLI context: tenant $($account.tenantId), subscription $($account.id)." }
if (-not $account -or ($TenantId -and $account.tenantId -ne $TenantId)) {
    $loginArgs = @('login', '--output', 'none')
    if ($TenantId) { $loginArgs += @('--tenant', $TenantId) }
    if ($UseDeviceCode) { $loginArgs += '--use-device-code' }
    # Not piped, so the device code and sign-in URL reach the console. No --verbose/--debug: it
    # acquires tokens.
    Write-Verbose "az $($loginArgs -join ' ')"
    & az @loginArgs
    if ($LASTEXITCODE -ne 0) { throw "az login failed (exit $LASTEXITCODE)." }
}
if ($SubscriptionId) {
    $visible = Invoke-Az account list --query "[?id=='$SubscriptionId'] | length(@)" -o tsv
    if ($visible -ne '1') {
        throw "Subscription $SubscriptionId is not visible to $((Invoke-Az account show --query user.name -o tsv)). Check the ID with az account list -o table, or sign in to its tenant with -TenantId."
    }
    Invoke-Az account set --subscription $SubscriptionId | Out-Null
}
$account = Invoke-Az account show -o json | ConvertFrom-Json
if ($TenantId -and $account.tenantId -ne $TenantId) {
    throw "Subscription '$($account.name)' is in tenant $($account.tenantId), not $TenantId."
}
# What the question below confirms, so shown at every level unless -Yes skips the question.
$show = if ($Yes) { 'Write-Info' } else { 'Write-Host' }
& $show "Tenant:       $($account.tenantId)"
& $show "Subscription: $($account.name) ($($account.id))"
& $show "Signed in as: $($account.user.name)"
& $show "Target:       $ResourceGroup, environment '$EnvironmentName', workload '$WorkloadName'"
Confirm-Continue 'Deploy to this subscription?'

# -- 2. Resource providers -----------------------------------------------------------------------
Write-Step 'Registering resource providers'
$registered = Invoke-Az provider list --query "[?registrationState=='Registered'].namespace" -o json | ConvertFrom-Json
$missing = $Providers | Where-Object { $registered -notcontains $_ }
foreach ($namespace in $missing) {
    Write-Info "Registering $namespace..."
    Invoke-Az provider register --namespace $namespace --wait --output none | Out-Null
}
if (-not $missing) { Write-Info 'All required providers are registered.' }

# -- 3. Resource group ---------------------------------------------------------------------------
Write-Step 'Resource group'
$exists = (Invoke-Az group exists -n $ResourceGroup) -eq 'true'
if ($exists) {
    $groupLocation = Invoke-Az group show -n $ResourceGroup --query location -o tsv
    if ($Location -and $Location -ne $groupLocation) {
        throw "$ResourceGroup already exists in $groupLocation, not $Location."
    }
    $Location = $groupLocation
    Write-Info "$ResourceGroup exists in $Location."
}
else {
    if (-not $Location) { $Location = Read-Host "Region for the new resource group $ResourceGroup (for example westeurope)" }
    $tagArgs = @("workload=$WorkloadName", "environment=$EnvironmentName") + ($Tags.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    Invoke-Az group create -n $ResourceGroup -l $Location --tags @tagArgs --output none | Out-Null
    Write-Info "Created $ResourceGroup in $Location."
}

if ($RemoveExistingResources -and $exists) {
    Write-Step 'Removing existing resources'
    $all = @(Invoke-Az resource list -g $ResourceGroup --query '[].{id:id, name:name, type:type}' -o json | ConvertFrom-Json)
    $kept = @($all | Where-Object { $_.type -eq 'Microsoft.KeyVault/vaults' })
    $doomed = @($all | Where-Object { $_.type -ne 'Microsoft.KeyVault/vaults' })
    if ($doomed.Count -eq 0) {
        Write-Info 'Nothing to delete.'
    }
    else {
        # What the name prompt below confirms, so shown at every level.
        Write-Host "These $($doomed.Count) resources in $ResourceGroup will be deleted:"
        $doomed | Sort-Object type, name | ForEach-Object { Write-Host ("  {0,-55} {1}" -f $_.type, $_.name) }
        foreach ($vault in $kept) { Write-Host "Kept: Key Vault '$($vault.name)' and its secrets (purge protection reserves the name for 90 days)." }
        Write-Warning 'This loses the artifact bundles and source assets in storage, the images in the registry and the worker disks. After the deployment, run azure-post-deploy.ps1 again (the identities, and so the GitHub variables, change), deploy the API image and run a first acquisition.' @script:WarnAtAllLevels
        $typed = Read-Host "Type the resource group name ($ResourceGroup) to delete them"
        if ($typed -cne $ResourceGroup) { throw 'Stopped: the name did not match, nothing was deleted.' }
        Remove-GroupResources $doomed
        Write-Info "Deleted $($doomed.Count) resources."
    }
}
elseif ($RemoveExistingResources) {
    Write-Info 'The resource group is new; nothing to remove.'
}

$me = Invoke-AzQuiet ad signed-in-user show --query id -o tsv
if ($LASTEXITCODE -eq 0 -and $me) {
    $roles = Invoke-Az role assignment list --assignee $me --all --include-inherited --include-groups `
        --query "[?roleDefinitionName=='Owner' || roleDefinitionName=='User Access Administrator' || roleDefinitionName=='Role Based Access Control Administrator'].scope" -o json | ConvertFrom-Json
    $groupId = Invoke-Az group show -n $ResourceGroup --query id -o tsv
    Write-Debug "Scopes where you can assign roles: $(@($roles) -join ', ')"
    if (-not ($roles | Where-Object { $groupId.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) {
        Write-Warning 'No Owner or User Access Administrator role found for you on this resource group; role assignments in the template will fail.'
    }
}
else {
    Write-Verbose "Skipped the role check: az ad signed-in-user show returned no user (exit $LASTEXITCODE), as for a service principal."
}

# -- 4. Parameters -------------------------------------------------------------------------------
Write-Step 'Parameters'
if ($ParameterFile) {
    $paramPath = (Resolve-Path -LiteralPath $ParameterFile).Path
    Write-Info "Using $paramPath."
}
else {
    if (-not $CostProfile) { $CostProfile = if ($EnvironmentName -like 'dev*') { 'cheapest' } else { 'standard' } }
    Write-Info "Cost profile: $CostProfile."

    # Infrastructure redeploys must keep the running image, or the app is reset to the default tag.
    $apiImage = $null
    $siteName = "app-$WorkloadName-$EnvironmentName"
    $fx = Invoke-AzQuiet webapp config show -g $ResourceGroup -n $siteName --query linuxFxVersion -o tsv
    if ($LASTEXITCODE -eq 0 -and $fx -match '^DOCKER\|[^/]+/(.+)$') {
        $apiImage = $Matches[1]
        Write-Info "Keeping the running API image $apiImage."
    }
    else {
        # azure-pause.ps1 deleted the app and recorded its image on the resource group.
        $groupTags = Invoke-Az group show -n $ResourceGroup --query tags -o json | ConvertFrom-Json
        $pausedImage = if ($groupTags -and $groupTags.PSObject.Properties[$PausedImageTag]) { $groupTags.$PausedImageTag }
        if ($pausedImage) {
            $apiImage = $pausedImage
            Write-Info "Resuming a paused environment with its API image $apiImage."
        }
        else {
            Write-Verbose "No running API image found on $siteName (exit $LASTEXITCODE, linuxFxVersion '$fx'); the template default is used."
        }
    }

    # The scheduler is created off; keep it on when azure-post-deploy.ps1 has already turned it on.
    $schedulerState = Invoke-AzQuiet resource show -g $ResourceGroup -n "logic-worker-$WorkloadName-$EnvironmentName" `
        --resource-type Microsoft.Logic/workflows --query properties.state -o tsv
    $schedulerEnabled = $LASTEXITCODE -eq 0 -and $schedulerState -eq 'Enabled'
    Write-Verbose "Scheduler state: '$schedulerState' (exit $LASTEXITCODE)."
    if ($schedulerEnabled) { Write-Info 'Keeping scheduled acquisition runs on.' }

    $allTags = [ordered]@{}
    foreach ($entry in $Tags.GetEnumerator()) { $allTags[$entry.Key] = [string]$entry.Value }
    $tagLines = ($allTags.GetEnumerator() | ForEach-Object {
        $key = if ($_.Key -match '^[A-Za-z_][A-Za-z0-9_]*$') { $_.Key } else { ConvertTo-BicepString $_.Key }
        "  ${key}: $(ConvertTo-BicepString $_.Value)"
    }) -join "`n"

    $lines = @(
        "// Generated by scripts/azure-deploy.ps1 on $((Get-Date).ToUniversalTime().ToString('u')). No secret values.",
        "using 'main.bicep'",
        '',
        "param environmentName = $(ConvertTo-BicepString $EnvironmentName)",
        "param workloadName = $(ConvertTo-BicepString $WorkloadName)",
        "param location = $(ConvertTo-BicepString $Location)",
        "param costProfile = $(ConvertTo-BicepString $CostProfile)",
        "param tags = {`n$tagLines`n}",
        "param allowedIngressCidrs = $(ConvertTo-BicepArray $AllowedIngressCidrs)",
        "param alertEmailReceivers = $(ConvertTo-BicepArray $AlertEmail)"
    )
    if ($apiImage) { $lines += "param apiImage = $(ConvertTo-BicepString $apiImage)" }
    if ($schedulerEnabled) { $lines += 'param workerSchedulerEnabled = true' }
    $lines += "param workerAdminPassword = readEnvironmentVariable('$PasswordVariable')"

    $paramPath = Join-Path $RepoRoot "infra/main.$EnvironmentName.local.bicepparam"
    Set-Content -LiteralPath $paramPath -Value ($lines -join "`n") -Encoding utf8NoBOM
    Write-Info "Wrote $paramPath."
    Write-Debug "Generated parameters (no secret values):`n$($lines -join "`n")"
}

$passwordWasSet = [bool][Environment]::GetEnvironmentVariable($PasswordVariable)
Write-Verbose "Worker password: $(if ($passwordWasSet) { "from $PasswordVariable" } else { 'prompted' }); the value is never shown."
if (-not $passwordWasSet) {
    while ($true) {
        $first = [Net.NetworkCredential]::new('', (Read-Host 'Worker VM administrator password' -AsSecureString)).Password
        $second = [Net.NetworkCredential]::new('', (Read-Host 'Repeat the password' -AsSecureString)).Password
        # These explain why the prompt repeats, so they show at every level.
        if ($first -ne $second) { Write-Warning 'The passwords do not match.' @script:WarnAtAllLevels; continue }
        if (-not (Test-VmPassword $first)) { Write-Warning 'Use 12-123 characters with three of: lowercase, uppercase, digit, symbol.' @script:WarnAtAllLevels; continue }
        break
    }
    [Environment]::SetEnvironmentVariable($PasswordVariable, $first)
    $first = $null; $second = $null
}

try {
    # -- 5. Existing resources the new settings cannot update in place ----------------------------
    Write-Step 'Checking existing resources against the new settings'
    # Literal values from the parameter file; anything else falls back to the template default.
    $paramText = Get-Content -LiteralPath $paramPath -Raw
    $paramValue = {
        param($name, $default)
        if ($paramText -match "(?m)^\s*param\s+$name\s*=\s*'?([\w.-]*)'?\s*(//.*)?$" -and $Matches[1]) { $Matches[1] } else { $default }
    }
    $targetCheapest = (& $paramValue 'costProfile' 'standard') -eq 'cheapest'
    $targetDiskType = & $paramValue 'workerDiskType' $(if ($targetCheapest) { 'StandardSSD_LRS' } else { 'Premium_LRS' })
    $targetPremiumRegistry = (& $paramValue 'enablePrivateNetworking' 'true') -ne 'false' -and -not $targetCheapest
    Write-Verbose "Target settings: cheapest profile $targetCheapest, worker disk type $targetDiskType, Premium registry $targetPremiumRegistry."

    function Assert-WorkerDeallocated {
        $power = Invoke-Az vm get-instance-view -g $ResourceGroup -n $vmName --query "instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]" -o tsv
        Write-Verbose "$vmName power state: $power"
        if ($power -ne 'PowerState/deallocated') {
            throw "$vmName is $($power -replace 'PowerState/', ''), and its disks can only change type while it is deallocated. An acquisition run may be in progress: wait for the scheduler to deallocate it (or run az vm deallocate -g $ResourceGroup -n $vmName when no run is active), then run the script again."
        }
    }

    $conversions = @()
    $prefix = "$WorkloadName-$EnvironmentName"
    $vmName = "vm-worker-$prefix"
    $disks = @(Invoke-Az disk list -g $ResourceGroup --query "[?name=='osdisk-worker-$prefix' || name=='datadisk-worker-$prefix'].{id:id, name:name, sku:sku.name}" -o json | ConvertFrom-Json)
    $disksToConvert = @($disks | Where-Object { $_.sku -ne $targetDiskType })
    Write-Debug "Worker disks: $(@($disks | ForEach-Object { "$($_.name) $($_.sku)" }) -join ', ')"
    foreach ($disk in $disksToConvert) { $conversions += "Change disk '$($disk.name)' from $($disk.sku) to $targetDiskType (contents kept; the VM must be deallocated)" }

    $registryEndpoints = @()
    if (-not $targetPremiumRegistry) {
        $registry = @(Invoke-Az acr list -g $ResourceGroup --query '[].{name:name, sku:sku.name, endpoints:privateEndpointConnections[].privateEndpoint.id}' -o json | ConvertFrom-Json) | Select-Object -First 1
        if ($registry) { Write-Debug "Registry $($registry.name): $($registry.sku), $(@($registry.endpoints | Where-Object { $_ }).Count) private endpoint(s)." }
        if ($registry -and $registry.sku -eq 'Premium' -and $registry.endpoints) {
            $registryEndpoints = @($registry.endpoints)
            $conversions += "Delete the private endpoint(s) of registry '$($registry.name)' so it can move from Premium to Basic (images kept; the API then pulls over the registry's public endpoint)"
        }
    }

    if ($conversions.Count -eq 0) {
        Write-Info 'Everything can be updated in place.'
    }
    else {
        # The error, warning or question below is about this list, and with -WhatIfOnly it is part of
        # the result, so it shows at every level unless -Yes -ReplaceIncompatible leaves nothing to ask.
        $show = if ($Yes -and $ReplaceIncompatible -and -not $WhatIfOnly) { 'Write-Info' } else { 'Write-Host' }
        $conversions | ForEach-Object { & $show "- $_" }
        if ($ReplaceIncompatible -and $disksToConvert.Count -gt 0) { Assert-WorkerDeallocated }
        if (-not $ReplaceIncompatible) {
            $message = 'These existing resources cannot move to the new settings in place. Run the script again with -ReplaceIncompatible to convert them, or with -RemoveExistingResources to start over.'
            if ($WhatIfOnly) { Write-Warning $message @script:WarnAtAllLevels } else { throw $message }
        }
    }

    # -- 6. What-if and deployment ---------------------------------------------------------------
    if (-not $SkipWhatIf) {
        Write-Step 'What-if'
        # What the question below confirms, or with -WhatIfOnly the result, so shown at every level
        # unless -Yes skips the question.
        $show = if ($Yes -and -not $WhatIfOnly) { 'Write-Info' } else { 'Write-Host' }
        Invoke-AzSensitive deployment group what-if -g $ResourceGroup -p $paramPath --result-format ResourceIdOnly | ForEach-Object { & $show $_ }
        Write-Info 'Nested modules that depend on values from other modules show as unevaluated; role assignments show as unsupported. Both are expected.'
        if ($WhatIfOnly) { return }
        Confirm-Continue 'Deploy these changes?'
    }

    if ($conversions.Count -gt 0) {
        Write-Step 'Converting existing resources'
        Confirm-Continue 'Apply the conversions listed above?'
        if ($disksToConvert.Count -gt 0) {
            Assert-WorkerDeallocated
            foreach ($disk in $disksToConvert) {
                Write-Info "Converting $($disk.name) to $targetDiskType..."
                Invoke-Az disk update --ids $disk.id --sku $targetDiskType --output none | Out-Null
            }
        }
        foreach ($endpoint in $registryEndpoints) {
            Write-Info "Deleting private endpoint $(Split-Path -Leaf $endpoint)..."
            Invoke-Az network private-endpoint delete --ids $endpoint --output none | Out-Null
        }
    }

    Write-Step 'Deploying'
    $deploymentName = "$WorkloadName-$EnvironmentName-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmm'))"
    Write-Info "Deployment '$deploymentName' (a first deployment takes about 20-30 minutes)..."
    try {
        $json = Invoke-AzSensitive deployment group create -g $ResourceGroup -n $deploymentName -p $paramPath -o json --only-show-errors 2>$null
    }
    catch {
        Write-Verbose $_.Exception.Message
        Write-DeploymentFailure $deploymentName
        throw "Deployment '$deploymentName' failed. Fix the errors above and run the script again; it redeploys incrementally over the resources that were created."
    }
    $result = $json | ConvertFrom-Json
}
finally {
    if (-not $passwordWasSet) { [Environment]::SetEnvironmentVariable($PasswordVariable, $null) }
    # Times the step that ended here, also after -WhatIfOnly or a failure.
    Complete-Step
}

# -- 7. Outputs and hand-off ---------------------------------------------------------------------
$groupTags = Invoke-Az group show -n $ResourceGroup --query tags -o json | ConvertFrom-Json
$pausedAt = if ($groupTags -and $groupTags.PSObject.Properties['d365mcp-paused-at']) { $groupTags.'d365mcp-paused-at' }
$present = @($PausedTags | Where-Object { $groupTags -and $groupTags.PSObject.Properties[$_] })
if ($present) {
    foreach ($tag in $present) { Invoke-Az group update -n $ResourceGroup --remove "tags.$tag" --output none | Out-Null }
    Write-Verbose "Removed the pause tags $($present -join ', ') from $ResourceGroup."
}

Write-Step 'Outputs'
$outputs = $result.properties.outputs
foreach ($property in $outputs.PSObject.Properties) {
    Write-Info ("{0,-32} {1}" -f $property.Name, $property.Value.value)
}
Complete-Step

$postDeployScript = Join-Path $PSScriptRoot 'azure-post-deploy.ps1'
if ($PostDeploy) {
    # Only a level the caller asked for is passed on, so a default run calls it as before.
    $postDeployLogging = @{}
    if ($script:LogLevelRequested) { $postDeployLogging.LogLevel = $script:LogLevelName }
    Write-Verbose "Running $postDeployScript with -LogLevel $($script:LogLevelName)."
    & $postDeployScript -ResourceGroup $ResourceGroup -SubscriptionId $account.id -DeploymentName $deploymentName -Repository $GitHubRepository @postDeployLogging
}
elseif ($pausedAt) {
    Write-Info "`nResumed the environment paused at $pausedAt. The API loads the kept bundle from storage on start."
    Write-Info "The worker VM is new: before the next acquisition run, run $postDeployScript -ResourceGroup $ResourceGroup -Step SetupWorker,PrepareWorker -DataverseUrl <url> -WorkerApplicationId <app id> (and ResumeScheduler if scheduled runs were on)."
    Write-Info "The Deploy workflow needs GitHub trust again: $(Join-Path $PSScriptRoot 'azure-github-trust.ps1') -ResourceGroup $ResourceGroup"
}
else {
    Write-Info "`nNext: $postDeployScript -ResourceGroup $ResourceGroup"
}
