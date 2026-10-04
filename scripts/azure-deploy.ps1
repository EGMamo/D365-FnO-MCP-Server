<#
.SYNOPSIS
    Deploys one environment of the hosted service (infra/main.bicep) into any tenant and subscription.

.DESCRIPTION
    Run it from a clone of this repository with PowerShell 7 and the Azure CLI. Nothing about the
    tenant, subscription, resource group or resource names is fixed: the tenant and subscription
    come from -TenantId/-SubscriptionId or the Azure CLI's current context, and every resource name
    is derived by the template from -WorkloadName and -EnvironmentName.

    It runs these steps:
      1. Signs in to -TenantId if needed, selects the subscription and shows the context.
      2. Registers the resource providers the template uses (needed on a new subscription).
      3. Creates the resource group if it does not exist.
      4. Writes infra/main.<environment>.local.bicepparam (git-ignored, no secret values). On a
         redeploy it keeps the API image that is currently running.
      5. Runs what-if, asks for confirmation, then deploys.
      6. Prints the outputs and, with -PostDeploy, runs scripts/azure-post-deploy.ps1.

    The worker VM's local administrator password is read from D365_WORKER_ADMIN_PASSWORD when set,
    otherwise prompted without echo. It reaches the template only through that process environment
    variable, never a file or a command line.

    The signed-in identity needs Owner, or Contributor plus User Access Administrator, on the
    resource group (the template creates role assignments).

.EXAMPLE
    ./scripts/azure-deploy.ps1 -TenantId <tenant-id> -SubscriptionId <subscription-id> -ResourceGroup rg-d365mcp-prod -Location westeurope -EnvironmentName prod -AlertEmail ops@example.com

.EXAMPLE
    ./scripts/azure-deploy.ps1 -ResourceGroup rg-d365mcp-prod -EnvironmentName prod -WhatIfOnly

.EXAMPLE
    ./scripts/azure-deploy.ps1 -ResourceGroup rg-d365mcp-prod -EnvironmentName prod -PostDeploy
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

    # GitHub repository (owner/name) whose 'production' environment may deploy the API.
    [string]$GitHubRepository = 'EGMamo/D365-FnO-MCP-Server',

    # Use this parameter file instead of generating one. It must read the worker password with
    # readEnvironmentVariable('D365_WORKER_ADMIN_PASSWORD').
    [string]$ParameterFile,

    # Run what-if and stop.
    [switch]$WhatIfOnly,

    [switch]$SkipWhatIf,

    # Do not ask for confirmation before deploying.
    [switch]$Yes,

    # Run scripts/azure-post-deploy.ps1 after a successful deployment.
    [switch]$PostDeploy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Template = Join-Path $RepoRoot 'infra/main.bicep'
$PasswordVariable = 'D365_WORKER_ADMIN_PASSWORD'
$Providers = @(
    'Microsoft.Authorization', 'Microsoft.Compute', 'Microsoft.ContainerRegistry', 'Microsoft.Insights',
    'Microsoft.KeyVault', 'Microsoft.Logic', 'Microsoft.ManagedIdentity', 'Microsoft.Network',
    'Microsoft.OperationalInsights', 'Microsoft.Storage', 'Microsoft.Web'
)

function Write-Step([string]$Text) { Write-Host "`n== $Text ==" -ForegroundColor Cyan }

function Invoke-Az {
    $output = & az @args
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)." }
    return $output
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

# -- 1. Tools and context ------------------------------------------------------------------------
Write-Step 'Checking tools and Azure context'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Install the Azure CLI first.' }
& az bicep version *> $null
if ($LASTEXITCODE -ne 0) { Invoke-Az bicep install | Out-Null }

$account = $null
$current = & az account show -o json 2>$null
if ($LASTEXITCODE -eq 0) { $account = $current | ConvertFrom-Json }
if (-not $account -or ($TenantId -and $account.tenantId -ne $TenantId)) {
    if ($TenantId) { Invoke-Az login --tenant $TenantId --output none | Out-Null }
    else { Invoke-Az login --output none | Out-Null }
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
Write-Host "Tenant:       $($account.tenantId)"
Write-Host "Subscription: $($account.name) ($($account.id))"
Write-Host "Signed in as: $($account.user.name)"
Write-Host "Target:       $ResourceGroup, environment '$EnvironmentName', workload '$WorkloadName'"
Confirm-Continue 'Deploy to this subscription?'

# -- 2. Resource providers -----------------------------------------------------------------------
Write-Step 'Registering resource providers'
$registered = Invoke-Az provider list --query "[?registrationState=='Registered'].namespace" -o json | ConvertFrom-Json
$missing = $Providers | Where-Object { $registered -notcontains $_ }
foreach ($namespace in $missing) {
    Write-Host "Registering $namespace..."
    Invoke-Az provider register --namespace $namespace --wait --output none | Out-Null
}
if (-not $missing) { Write-Host 'All required providers are registered.' }

# -- 3. Resource group ---------------------------------------------------------------------------
Write-Step 'Resource group'
$exists = (Invoke-Az group exists -n $ResourceGroup) -eq 'true'
if ($exists) {
    $groupLocation = Invoke-Az group show -n $ResourceGroup --query location -o tsv
    if ($Location -and $Location -ne $groupLocation) {
        throw "$ResourceGroup already exists in $groupLocation, not $Location."
    }
    $Location = $groupLocation
    Write-Host "$ResourceGroup exists in $Location."
}
else {
    if (-not $Location) { $Location = Read-Host "Region for the new resource group $ResourceGroup (for example westeurope)" }
    $tagArgs = @("workload=$WorkloadName", "environment=$EnvironmentName") + ($Tags.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    Invoke-Az group create -n $ResourceGroup -l $Location --tags @tagArgs --output none | Out-Null
    Write-Host "Created $ResourceGroup in $Location."
}

$me = & az ad signed-in-user show --query id -o tsv 2>$null
if ($LASTEXITCODE -eq 0 -and $me) {
    $roles = Invoke-Az role assignment list --assignee $me --all --include-inherited --include-groups `
        --query "[?roleDefinitionName=='Owner' || roleDefinitionName=='User Access Administrator' || roleDefinitionName=='Role Based Access Control Administrator'].scope" -o json | ConvertFrom-Json
    $groupId = Invoke-Az group show -n $ResourceGroup --query id -o tsv
    if (-not ($roles | Where-Object { $groupId.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) {
        Write-Warning 'No Owner or User Access Administrator role found for you on this resource group; role assignments in the template will fail.'
    }
}

# -- 4. Parameters -------------------------------------------------------------------------------
Write-Step 'Parameters'
if ($ParameterFile) {
    $paramPath = (Resolve-Path -LiteralPath $ParameterFile).Path
    Write-Host "Using $paramPath."
}
else {
    # Infrastructure redeploys must keep the running image, or the app is reset to the default tag.
    $apiImage = $null
    $siteName = "app-$WorkloadName-$EnvironmentName"
    $fx = & az webapp config show -g $ResourceGroup -n $siteName --query linuxFxVersion -o tsv 2>$null
    if ($LASTEXITCODE -eq 0 -and $fx -match '^DOCKER\|[^/]+/(.+)$') {
        $apiImage = $Matches[1]
        Write-Host "Keeping the running API image $apiImage."
    }

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
        "param tags = {`n$tagLines`n}",
        "param allowedIngressCidrs = $(ConvertTo-BicepArray $AllowedIngressCidrs)",
        "param alertEmailReceivers = $(ConvertTo-BicepArray $AlertEmail)",
        "param githubRepository = $(ConvertTo-BicepString $GitHubRepository)"
    )
    if ($apiImage) { $lines += "param apiImage = $(ConvertTo-BicepString $apiImage)" }
    $lines += "param workerAdminPassword = readEnvironmentVariable('$PasswordVariable')"

    $paramPath = Join-Path $RepoRoot "infra/main.$EnvironmentName.local.bicepparam"
    Set-Content -LiteralPath $paramPath -Value ($lines -join "`n") -Encoding utf8NoBOM
    Write-Host "Wrote $paramPath."
}

$passwordWasSet = [bool][Environment]::GetEnvironmentVariable($PasswordVariable)
if (-not $passwordWasSet) {
    while ($true) {
        $first = [Net.NetworkCredential]::new('', (Read-Host 'Worker VM administrator password' -AsSecureString)).Password
        $second = [Net.NetworkCredential]::new('', (Read-Host 'Repeat the password' -AsSecureString)).Password
        if ($first -ne $second) { Write-Warning 'The passwords do not match.'; continue }
        if (-not (Test-VmPassword $first)) { Write-Warning 'Use 12-123 characters with three of: lowercase, uppercase, digit, symbol.'; continue }
        break
    }
    [Environment]::SetEnvironmentVariable($PasswordVariable, $first)
    $first = $null; $second = $null
}

try {
    # -- 5. What-if and deployment ---------------------------------------------------------------
    if (-not $SkipWhatIf) {
        Write-Step 'What-if'
        Invoke-Az deployment group what-if -g $ResourceGroup -p $paramPath --result-format ResourceIdOnly | Write-Host
        Write-Host 'Nested modules that depend on values from other modules show as unevaluated; role assignments show as unsupported. Both are expected.'
        if ($WhatIfOnly) { return }
        Confirm-Continue 'Deploy these changes?'
    }

    Write-Step 'Deploying'
    $deploymentName = "$WorkloadName-$EnvironmentName-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmm'))"
    Write-Host "Deployment '$deploymentName' (a first deployment takes about 20-30 minutes)..."
    $result = Invoke-Az deployment group create -g $ResourceGroup -n $deploymentName -p $paramPath -o json | ConvertFrom-Json
}
finally {
    if (-not $passwordWasSet) { [Environment]::SetEnvironmentVariable($PasswordVariable, $null) }
}

# -- 6. Outputs and hand-off ---------------------------------------------------------------------
Write-Step 'Outputs'
$outputs = $result.properties.outputs
foreach ($property in $outputs.PSObject.Properties) {
    Write-Host ("{0,-32} {1}" -f $property.Name, $property.Value.value)
}

$postDeployScript = Join-Path $PSScriptRoot 'azure-post-deploy.ps1'
if ($PostDeploy) {
    & $postDeployScript -ResourceGroup $ResourceGroup -SubscriptionId $account.id -DeploymentName $deploymentName -Repository $GitHubRepository
}
else {
    Write-Host "`nNext: $postDeployScript -ResourceGroup $ResourceGroup"
}
