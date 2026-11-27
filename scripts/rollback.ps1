<#
.SYNOPSIS
    Rolls the hosted index back to the previous bundle, or lifts a rollback hold.

.DESCRIPTION
    Run it from a built clone of this repository (npm run build) with PowerShell 7, Node.js and the
    Azure CLI signed in to an account with Storage Blob Data Contributor on the artifact container.

    Rollback makes the previous bundle active and holds it there: the scheduled acquisition run still
    uploads its new bundle but does not promote it, so a rollback is not undone overnight. The hold
    ends when you promote a bundle (d365-fno-mcp-server artifact promote) or run this script with
    -Action ClearRollback. A server replica switches only when it restarts.

    Rollback and ClearRollback need -ExpectedRevision, the pointer revision you looked at in Status.
    The change is refused ("expected N, current M") when the pointers moved since, so a stale
    decision, such as a rollback after a newer promotion, never applies.

.EXAMPLE
    ./scripts/rollback.ps1 -AccountUrl https://stmcp.blob.core.windows.net -Container artifacts

.EXAMPLE
    ./scripts/rollback.ps1 -AccountUrl https://stmcp.blob.core.windows.net -Container artifacts -Action Rollback -ExpectedRevision 4
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
    # Storage account origin, for example https://stmcp.blob.core.windows.net. Defaults to D365_ARTIFACT_ACCOUNT_URL.
    [ValidatePattern('^https://[A-Za-z0-9.-]+/?$', ErrorMessage = '{0} is not an https storage account origin.')]
    [string]$AccountUrl = $env:D365_ARTIFACT_ACCOUNT_URL,

    # Artifact container name. Defaults to D365_ARTIFACT_CONTAINER.
    [string]$Container = $env:D365_ARTIFACT_CONTAINER,

    [ValidateSet('Status', 'Rollback', 'ClearRollback')]
    [string]$Action = 'Status',

    # The pointer revision shown by Status. Required for Rollback and ClearRollback.
    [ValidateRange(0, [int]::MaxValue)]
    [int]$ExpectedRevision = -1,

    # Client ID of a user-assigned managed identity, when running where one is attached.
    [string]$ManagedIdentityClientId = $env:D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID,

    # Skip the confirmation prompt.
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'

if (-not $AccountUrl) { throw 'Pass -AccountUrl or set D365_ARTIFACT_ACCOUNT_URL.' }
if (-not $Container) { throw 'Pass -Container or set D365_ARTIFACT_CONTAINER.' }
if ($Action -ne 'Status' -and $ExpectedRevision -lt 0) {
    throw "-Action $Action needs -ExpectedRevision. Run with -Action Status first and pass the revision it shows."
}

$cli = Join-Path $PSScriptRoot '..' 'dist' 'src' 'index.js'
if (-not (Test-Path $cli)) { throw "Build first (npm run build): $cli does not exist." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js first.' }

$env:D365_ARTIFACT_ACCOUNT_URL = $AccountUrl
$env:D365_ARTIFACT_CONTAINER = $Container
if ($ManagedIdentityClientId) { $env:D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID = $ManagedIdentityClientId }

function Invoke-Artifact([string[]]$Arguments) {
    $output = & node $cli artifact @Arguments --json 2>&1
    $code = $LASTEXITCODE
    $text = ($output | ForEach-Object { "$_" }) -join "`n"
    try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null }
    if ($code -ne 0) {
        $message = if ($parsed -and $parsed.error) { $parsed.error } else { $text }
        throw "artifact $($Arguments[0]) failed: $message"
    }
    return $parsed
}

function Write-Pointers($Pointers) {
    Write-Host "Revision : $($Pointers.revision)"
    Write-Host "Active   : $(if ($Pointers.active) { "$($Pointers.active.bundleId) (promoted $($Pointers.active.promotedAt))" } else { 'none' })"
    Write-Host "Previous : $(if ($Pointers.previous) { "$($Pointers.previous.bundleId) (promoted $($Pointers.previous.promotedAt))" } else { 'none' })"
    $hold = $Pointers.PSObject.Properties['rollbackHold']
    if ($hold -and $hold.Value) {
        Write-Host "Rollback hold: scheduled runs will not promote (rolled back from $($hold.Value.supersededBundleId) at $($hold.Value.heldAt))."
    } else {
        Write-Host 'Rollback hold: none.'
    }
}

$status = Invoke-Artifact @('status')
Write-Pointers $status.pointers

if ($Action -eq 'Status') { return }

# The CLI repeats this check under the write lease; failing here just saves the prompt.
if ($status.pointers.revision -ne $ExpectedRevision) {
    throw "Artifact pointer revision changed: expected $ExpectedRevision, current $($status.pointers.revision). Review the status above and run again."
}

if ($Action -eq 'Rollback') {
    if (-not $status.pointers.previous) { throw 'There is no previous bundle to roll back to.' }
    $question = "Make $($status.pointers.previous.bundleId) active and hold it there?"
    $cliAction = 'rollback'
} else {
    $question = 'Lift the rollback hold so scheduled runs promote new bundles again?'
    $cliAction = 'clear-rollback'
}
if (-not $Yes) {
    $answer = Read-Host "$question [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw 'Stopped at your request.' }
}

$result = Invoke-Artifact @($cliAction, '--expected-revision', "$ExpectedRevision")
Write-Host ''
Write-Host "Done. New pointers:"
Write-Pointers $result.pointers
if ($Action -eq 'Rollback') { Write-Host 'Restart the web app replicas to serve the rolled-back bundle.' }
