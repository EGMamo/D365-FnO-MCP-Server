<#
.SYNOPSIS
    Lets one GitHub repository's Deploy workflow sign in to Azure as the deploy identity, or removes
    every GitHub trust from it.

.DESCRIPTION
    Run it from a clone of this repository with PowerShell 7 and the Azure CLI signed in to the
    subscription that holds the environment. infra/main.bicep creates the deploy identity
    (id-deploy-<workload>-<env>) without any federated credential, so no deployment names a GitHub
    owner or repository; this script adds the one trust the Deploy workflow needs, on demand.

    Without -Remove it looks up the repository's owner and IDs on GitHub (with gh when it is signed
    in, otherwise the public API), then writes the federated credential github-<environment> with
    the subject GitHub sends for jobs in that environment:
      Id    repo:<owner>@<owner-id>/<name>@<repo-id>:environment:<environment> (the default; GitHub
            sends this form for repositories created, renamed or transferred after 15 July 2026)
      Name  repo:<owner>/<name>:environment:<environment> (older repositories)
    Any other GitHub credential on the identity is deleted, so only this repository is trusted.
    Run it again after moving the repository: the owner name and owner ID change, the repository ID
    does not.

    With -Remove it deletes every federated credential on the identity whose issuer is GitHub
    Actions. The Deploy workflow cannot sign in until you run the script again without -Remove.

    Both modes list the credentials and the exact az commands, then ask before changing anything.

.EXAMPLE
    ./scripts/azure-github-trust.ps1 -ResourceGroup D365fodevmcp

.EXAMPLE
    ./scripts/azure-github-trust.ps1 -ResourceGroup D365fodevmcp -Repository NewOrg/D365-FnO-MCP-Server

.EXAMPLE
    ./scripts/azure-github-trust.ps1 -ResourceGroup D365fodevmcp -Remove
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

    # GitHub repository (owner/name) to trust. Defaults to the GitHub repository of this clone's
    # 'origin' remote.
    [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$', ErrorMessage = '{0} is not an owner/name repository.')]
    [string]$Repository,

    # GitHub environment whose jobs may sign in (the Deploy workflow uses 'production').
    [ValidatePattern('^[A-Za-z0-9._-]{1,100}$')]
    [string]$Environment = 'production',

    # Subject form: Id (owner and repository IDs, the default) or Name (owner/name).
    [ValidateSet('Id', 'Name')]
    [string]$SubjectFormat = 'Id',

    # Delete every GitHub federated credential on the deploy identity instead of adding one.
    [switch]$Remove,

    # Do not ask before changing the credentials.
    [switch]$Yes,

    # How much the script prints: Error, Warning, Info (default), Verbose or Debug. -Verbose and -Debug also work.
    [ValidateSet('Error', 'Warning', 'Info', 'Verbose', 'Debug')]
    [string]$LogLevel = 'Info'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$script:LogRank = @{ Error = 0; Warning = 1; Info = 2; Verbose = 3; Debug = 4 }[$LogLevel]
if ($VerbosePreference -eq 'Continue' -and $script:LogRank -lt 3) { $script:LogRank = 3 }
if ($DebugPreference -in @('Continue', 'Inquire')) { $script:LogRank = 4 }
$VerbosePreference = if ($script:LogRank -ge 3) { 'Continue' } else { 'SilentlyContinue' }
$DebugPreference = if ($script:LogRank -ge 4) { 'Continue' } else { 'SilentlyContinue' }
if ($script:LogRank -lt 1) { $WarningPreference = 'SilentlyContinue' }
# No call here sends or returns a secret, so every az call may get --verbose/--debug.
$script:AzLogArgs = @(if ($script:LogRank -ge 4) { '--debug' } elseif ($script:LogRank -ge 3) { '--verbose' })

$Issuer = 'https://token.actions.githubusercontent.com'
$Audience = 'api://AzureADTokenExchange'

function Write-Info([string]$Text) { if ($script:LogRank -ge 2) { Write-Host $Text } }

function Invoke-Az {
    Write-Verbose "az $($args -join ' ')"
    $output = & az @args @script:AzLogArgs
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)." }
    return $output
}

function Confirm-Continue([string]$Question) {
    if ($Yes) { return }
    $answer = Read-Host "$Question [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw 'Stopped at your request; nothing was changed.' }
}

# -- Deploy identity -----------------------------------------------------------------------------
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Install the Azure CLI first.' }
if ($SubscriptionId) { Invoke-Az account set --subscription $SubscriptionId | Out-Null }
$name = $DeploymentName
if (-not $name) {
    $name = Invoke-Az deployment group list -g $ResourceGroup `
        --query "[?properties.provisioningState=='Succeeded' && properties.outputs.deployClientId != null] | sort_by(@, &properties.timestamp) | [-1].name" -o tsv
    if (-not $name) { throw "No successful infra/main.bicep deployment found in $ResourceGroup. Pass -DeploymentName." }
}
$clientId = Invoke-Az deployment group show -g $ResourceGroup -n $name --query properties.outputs.deployClientId.value -o tsv
$identity = Invoke-Az identity list -g $ResourceGroup --query "[?clientId=='$clientId'].name | [0]" -o tsv
if (-not $identity) { throw "No identity with client ID $clientId (the deployClientId output of '$name') in $ResourceGroup." }

$existing = @(Invoke-Az identity federated-credential list -g $ResourceGroup --identity-name $identity -o json | ConvertFrom-Json |
    Where-Object { $_.issuer -eq $Issuer })
Write-Host "Deploy identity: $identity in $ResourceGroup"
if ($existing.Count -eq 0) { Write-Host 'GitHub credentials on it: none' }
else {
    Write-Host 'GitHub credentials on it:'
    $existing | ForEach-Object { Write-Host "  $($_.name): $($_.subject)" }
}

function Remove-Credentials([object[]]$Credentials) {
    foreach ($credential in $Credentials) {
        Write-Info "Deleting $($credential.name)..."
        # Writes to one identity's credentials must not overlap, so these run one at a time.
        Invoke-Az identity federated-credential delete -g $ResourceGroup --identity-name $identity -n $credential.name --yes --output none | Out-Null
    }
}

if ($Remove) {
    if ($existing.Count -eq 0) { Write-Info 'Nothing to remove.'; return }
    Write-Host "`nThese commands will run:"
    $existing | ForEach-Object { Write-Host "  az identity federated-credential delete -g $ResourceGroup --identity-name $identity -n $($_.name) --yes" }
    Write-Warning 'The Deploy workflow cannot sign in to Azure until you run this script again without -Remove.'
    Confirm-Continue 'Remove all GitHub trust from the deploy identity?'
    Remove-Credentials $existing
    Write-Info "Removed $($existing.Count) GitHub credential(s); $identity trusts no GitHub repository."
    return
}

# -- Subject -------------------------------------------------------------------------------------
if (-not $Repository) {
    $Repository = & (Join-Path $PSScriptRoot 'Get-GitHubRepository.ps1')
    Write-Verbose "GitHub repository from the origin remote: $Repository."
}
$repo = $null
if (Get-Command gh -ErrorAction SilentlyContinue) {
    Write-Verbose "gh api repos/$Repository"
    $json = & gh api "repos/$Repository" 2>$null
    if ($LASTEXITCODE -eq 0 -and $json) { $repo = $json | ConvertFrom-Json }
}
if (-not $repo) {
    # Works for public repositories; a private one needs gh signed in with access to it.
    Write-Verbose "GET https://api.github.com/repos/$Repository"
    try { $repo = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository" -Headers @{ 'User-Agent' = 'd365-fno-mcp-server' } }
    catch { throw "Could not read $Repository from GitHub ($($_.Exception.Message)). For a private repository, install the GitHub CLI and run gh auth login." }
}
# After a transfer GitHub redirects the old name, so take the owner and name it returns.
$owner = $repo.owner.login
$repoName = $repo.name
if ("$owner/$repoName" -ne $Repository) { Write-Warning "$Repository is now $owner/$repoName on GitHub; trusting $owner/$repoName." }
$subject = if ($SubjectFormat -eq 'Id') {
    "repo:$owner@$($repo.owner.id)/$repoName@$($repo.id):environment:$Environment"
}
else {
    "repo:$owner/${repoName}:environment:$Environment"
}
$credentialName = "github-$Environment"

# Other credentials go; one with the same name is overwritten in place.
$toDelete = @($existing | Where-Object { $_.name -ne $credentialName })
$current = $existing | Where-Object { $_.name -eq $credentialName -and $_.subject -eq $subject }
if ($current -and $toDelete.Count -eq 0) { Write-Info "`n$credentialName already trusts $subject; nothing to change."; return }

Write-Host "`nThese commands will run:"
$toDelete | ForEach-Object { Write-Host "  az identity federated-credential delete -g $ResourceGroup --identity-name $identity -n $($_.name) --yes" }
$create = -not $current
if ($create) {
    Write-Host "  az identity federated-credential create -g $ResourceGroup --identity-name $identity -n $credentialName --issuer $Issuer --subject '$subject' --audiences $Audience"
}
Confirm-Continue "Trust $owner/$repoName ($Environment) and nothing else?"
Remove-Credentials $toDelete
if ($create) {
    Invoke-Az identity federated-credential create -g $ResourceGroup --identity-name $identity -n $credentialName `
        --issuer $Issuer --subject $subject --audiences $Audience --output none | Out-Null
    Write-Info "$credentialName now trusts $subject."
}
Write-Info 'Azure can take a minute to accept a new credential; rerun a failed Deploy after that.'
