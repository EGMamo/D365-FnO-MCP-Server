<#
.SYNOPSIS
    Acquire step of the scheduled worker: caches the X++ SDK and the UDE assets for the
    environment's current F&O version and writes sources.json for the prepare-bundle step.

.DESCRIPTION
    Runs on the worker VM in Windows PowerShell 5.1 as SYSTEM (Run Command), without prompts.

    1. Reads the Power Platform client secret from the worker Key Vault with the worker's managed
       identity (F:\worker\bin\Get-WorkerSecret.ps1). The secret stays in memory: it is never
       written to disk, printed or put on a command line.
    2. Asks Dataverse for the linked F&O application version (msprov_getfinopsapplicationdetails,
       the query 'pac tool xpp install' makes), unless -AppVersion pins one.
    3. When that version is not cached yet, downloads the 'systemmetadata' (X++ SDK, the zip
       'pac tool xpp install' extracts), 'finopsvsix22' and 'crossreference' Dev Tools assets with
       acquire-ude-assets.ps1 and extracts the SDK to <CacheRoot>\<version>\PackagesLocalDirectory,
       so the index records the version from the path. Older versions are pruned.
    4. Writes sources.json (version, SDK path, file names, sizes and SHA-256 of the three assets).

    -Preflight proves access end to end without downloading anything: vault secret, token,
    version and the three asset URLs, plus disk space and the worker build.

    AzCopy is on the machine PATH, so acquire-ude-assets.ps1 uses it and the short-lived SAS URL
    of each asset is visible on AzCopy's command line while it downloads.

    -LogLevel sets how much it prints: Error, Warning, Info (default), Verbose or Debug; -Verbose
    and -Debug also work. Verbose adds paths, timings and cache decisions, Debug the values behind
    them. A requested level is passed on to acquire-ude-assets.ps1. The client secret and the
    access token are never printed, at any level.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$ApplicationId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/?$')]
    [string]$DataverseEnvironmentUri,

    # sources.json for the build step, normally ${WORK_DIR}\sources.json. Required unless -Preflight.
    [string]$SourcesFile,

    # Pins the F&O version instead of asking Dataverse (scheduled runs then stop following updates).
    [ValidatePattern('^(\d+\.\d+\.\d+\.\d+)?$')]
    [string]$AppVersion,

    [string]$CacheRoot = 'F:\worker\cache',

    [ValidatePattern('^[0-9A-Za-z-]{1,127}$')]
    [string]$SecretName = 'power-platform-client-secret',

    [string]$SecretHelper = 'F:\worker\bin\Get-WorkerSecret.ps1',

    [ValidateRange(1, 10)]
    [int]$KeepVersions = 2,

    [switch]$Preflight,

    # How much the script prints: Error, Warning, Info (default), Verbose or Debug. -Verbose and -Debug also work.
    [ValidateSet('Error', 'Warning', 'Info', 'Verbose', 'Debug')]
    [string]$LogLevel = 'Info'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
# -Verbose and -Debug raise the level. Debug output is 'Continue', never the 'Inquire' that 5.1
# sets for -Debug: this runs as SYSTEM with nobody to answer a prompt.
$script:LogRank = @{ Error = 0; Warning = 1; Info = 2; Verbose = 3; Debug = 4 }[$LogLevel]
if ($VerbosePreference -eq 'Continue' -and $script:LogRank -lt 3) { $script:LogRank = 3 }
if ($DebugPreference -in @('Continue', 'Inquire')) { $script:LogRank = 4 }
$script:LogLevelName = @('Error', 'Warning', 'Info', 'Verbose', 'Debug')[$script:LogRank]
# True only when the caller passed -LogLevel, -Verbose or -Debug, so a default run calls
# acquire-ude-assets.ps1 as before.
$script:LogLevelRequested = $PSBoundParameters.ContainsKey('LogLevel') -or [bool]$PSBoundParameters['Verbose'] -or
    [bool]$PSBoundParameters['Debug']
$VerbosePreference = if ($script:LogRank -ge 3) { 'Continue' } else { 'SilentlyContinue' }
$DebugPreference = if ($script:LogRank -ge 4) { 'Continue' } else { 'SilentlyContinue' }
# Only ever lowered, so at Info and above the secret helper and acquire-ude-assets.ps1 inherit the
# same preferences as before.
if ($script:LogRank -lt 1) { $WarningPreference = 'SilentlyContinue' }
if ($script:LogRank -lt 2) { $InformationPreference = 'SilentlyContinue' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$assetScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'acquire-ude-assets.ps1'
$assetNames = @('systemmetadata', 'finopsvsix22', 'crossreference')
$environmentUri = $DataverseEnvironmentUri.TrimEnd('/') + '/'
# 4 GB SDK zip + 16 GB extracted + the other assets, with room for the next version.
$requiredFreeGb = 40
Write-Verbose "Log level $script:LogLevelName. Cache $CacheRoot (keeps $KeepVersions versions); asset script $assetScript."

# Progress goes to stdout, which the worker's run log and Run Command capture. -LogLevel Warning
# or Error leaves only warnings and errors.
function Write-Info([string]$Message) {
    if ($script:LogRank -ge 2) { Write-Output $Message }
}

# Runs a block that handles the client secret or the access token with Verbose and Debug off, so
# no cmdlet or helper inside it can trace a request that carries them, whatever the level.
function Invoke-Untraced([scriptblock]$Block) {
    $VerbosePreference = 'SilentlyContinue'
    $DebugPreference = 'SilentlyContinue'
    & $Block
}

# The error text of a failed web call, including the service's own message (for example an
# AADSTS code or a Dataverse privilege error). Neither contains the secret or a token.
function Get-WebErrorText([System.Management.Automation.ErrorRecord]$ErrorRecord) {
    $text = $ErrorRecord.Exception.Message
    # Invoke-RestMethod has already read the response body into ErrorDetails, so the response
    # stream itself is empty by now.
    $body = $null
    if ($null -ne $ErrorRecord.ErrorDetails) { $body = $ErrorRecord.ErrorDetails.Message }
    if (-not [string]::IsNullOrWhiteSpace($body)) {
        $detail = $null
        try {
            $json = $body | ConvertFrom-Json
            if ($json.PSObject.Properties['error_description']) { $detail = ($json.error_description -split "`r?`n")[0] }
            elseif ($json.PSObject.Properties['error'] -and $json.error.PSObject.Properties['message']) { $detail = $json.error.message }
        }
        catch { $detail = $body }
        if ($detail) { $text = "$text $($detail.Substring(0, [Math]::Min(400, $detail.Length)))" }
    }
    return $text
}

# A version is cached when its manifest and its extracted SDK are both in place.
function Test-CachedVersion([string]$VersionDirectory) {
    return (Test-Path -LiteralPath (Join-Path $VersionDirectory 'sources.json')) -and
        (Test-Path -LiteralPath (Join-Path $VersionDirectory 'PackagesLocalDirectory\bin\xppc.exe'))
}

function Write-Utf8Json([string]$Path, $Value) {
    # UTF-8 without BOM, replaced atomically: Node's JSON.parse rejects a BOM.
    $directory = Split-Path $Path -Parent
    if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    $temp = "$Path.tmp-$PID"
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-FreeGb([string]$Path) {
    $drive = [IO.Path]::GetPathRoot((New-Object IO.DirectoryInfo $Path).FullName)
    return [Math]::Floor((New-Object IO.DriveInfo $drive).AvailableFreeSpace / 1GB)
}

function Get-ProofAssets([string]$ProofPath) {
    $proof = Get-Content -LiteralPath $ProofPath -Raw | ConvertFrom-Json
    $assets = $proof.Assets
    # Windows PowerShell 5.1 sometimes serializes an array as {"value": [...], "Count": n}.
    if ($null -ne $assets -and $assets.PSObject.Properties['value']) { $assets = $assets.value }
    $captured = $proof.CapturedAtUtc
    if ($captured -is [datetime]) { $captured = $captured.ToUniversalTime().ToString('o') }
    return @{ CapturedAt = [string]$captured; Assets = @($assets) }
}

function Find-Asset($Assets, [string]$Name) {
    $match = @($Assets | Where-Object { $_.ResourceName -eq $Name })
    if ($match.Count -ne 1) { throw "acquire-ude-assets.ps1 did not report the '$Name' asset." }
    return $match[0]
}

# Moves an extracted SDK into place. pac expects bin\xppc.exe at the zip root; a single wrapping
# folder is accepted too.
function Resolve-SdkRoot([string]$Extracted) {
    if (Test-Path -LiteralPath (Join-Path $Extracted 'bin\xppc.exe')) { return $Extracted }
    $children = @(Get-ChildItem -LiteralPath $Extracted -Force)
    if ($children.Count -eq 1 -and $children[0].PSIsContainer -and
        (Test-Path -LiteralPath (Join-Path $children[0].FullName 'bin\xppc.exe'))) {
        return $children[0].FullName
    }
    throw "The X++ SDK zip has no bin\xppc.exe; it does not look like a PackagesLocalDirectory."
}

# -- Secret and token -------------------------------------------------------------------------
$stepTimer = [Diagnostics.Stopwatch]::StartNew()
Write-Verbose "Reading '$SecretName' with $SecretHelper."
try {
    $plainSecret = Invoke-Untraced { & $SecretHelper -Name $SecretName }
}
catch {
    throw "Could not read '$SecretName' from the worker Key Vault: $($_.Exception.Message)"
}
if ([string]::IsNullOrWhiteSpace($plainSecret)) { throw "The worker Key Vault secret '$SecretName' is empty." }
$secureSecret = ConvertTo-SecureString $plainSecret -AsPlainText -Force

Write-Verbose "Requesting a token for $environmentUri from tenant $TenantId."
try {
    $tokenResponse = Invoke-Untraced {
        Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$TenantId/oauth2/token" `
            -ContentType 'application/x-www-form-urlencoded' -Body @{
                client_id     = $ApplicationId
                client_secret = $plainSecret
                grant_type    = 'client_credentials'
                resource      = $environmentUri
            }
    }
}
catch {
    throw "Microsoft Entra ID refused a token for app $ApplicationId in tenant ${TenantId}: $(Get-WebErrorText $_)"
}
finally {
    $plainSecret = $null
}
$accessToken = [string]$tokenResponse.access_token
$tokenResponse = $null
if ([string]::IsNullOrWhiteSpace($accessToken)) { throw 'Microsoft Entra ID did not return an access token.' }
Write-Info "Signed in to $environmentUri as app $ApplicationId."
Write-Verbose ('Secret and token took {0:N1} s.' -f $stepTimer.Elapsed.TotalSeconds)

# -- Version ------------------------------------------------------------------------------------
if ($AppVersion) {
    Write-Info "Using the pinned F&O version $AppVersion."
}
else {
    Write-Verbose "Asking $environmentUri for the F&O version (msprov_getfinopsapplicationdetails)."
    try {
        $details = Invoke-Untraced {
            Invoke-RestMethod -Method Get -Uri ($environmentUri + 'api/data/v9.2/msprov_getfinopsapplicationdetails()') `
                -Headers @{
                    Authorization      = "Bearer $accessToken"
                    Accept             = 'application/json'
                    'OData-MaxVersion' = '4.0'
                    'OData-Version'    = '4.0'
                }
        }
    }
    catch {
        throw "Dataverse did not report the F&O version of $environmentUri. Check that the app is an " +
            "application user with a security role there and that the environment is linked to " +
            "Finance and Operations: $(Get-WebErrorText $_)"
    }
    Write-Debug "Dataverse returned the properties: $(@($details.PSObject.Properties | ForEach-Object { $_.Name }) -join ', ')."
    $property = $details.PSObject.Properties['ApplicationVersion']
    if ($null -ne $property) { Write-Debug "ApplicationVersion: '$($property.Value)'." }
    if ($null -eq $property -or [string]$property.Value -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw "Dataverse returned no four-part ApplicationVersion for $environmentUri."
    }
    $AppVersion = [string]$property.Value
    Write-Info "Environment F&O version: $AppVersion."
}
$accessToken = $null

$versionDirectory = Join-Path $CacheRoot $AppVersion
$packagesDirectory = Join-Path $versionDirectory 'PackagesLocalDirectory'
$cachedManifest = Join-Path $versionDirectory 'sources.json'
Write-Verbose "Version directory: $versionDirectory."
$assetArguments = @{
    TenantId                = $TenantId
    ApplicationId           = $ApplicationId
    DataverseEnvironmentUri = $environmentUri
    AppVersion              = $AppVersion
    AssetNames              = $assetNames
    ClientSecret            = $secureSecret
}
# Only a requested level is passed on, so a default run calls acquire-ude-assets.ps1 as before.
if ($script:LogLevelRequested) { $assetArguments['LogLevel'] = $script:LogLevelName }

# -- Preflight ----------------------------------------------------------------------------------
if ($Preflight) {
    $preflightDirectory = Join-Path $CacheRoot 'preflight'
    Write-Verbose "Running $assetScript -MetadataOnly for $($assetNames -join ', ') into $preflightDirectory."
    $stepTimer = [Diagnostics.Stopwatch]::StartNew()
    & $assetScript @assetArguments -OutputDirectory $preflightDirectory -MetadataOnly | Out-Null
    Write-Verbose ('acquire-ude-assets.ps1 took {0:N1} s.' -f $stepTimer.Elapsed.TotalSeconds)
    $proof = Get-ProofAssets (Join-Path $preflightDirectory 'ude-assets-proof.json')
    Write-Debug "Proof captured at $($proof.CapturedAt) with $($proof.Assets.Count) assets."
    foreach ($name in $assetNames) {
        $asset = Find-Asset $proof.Assets $name
        Write-Info ("Asset {0}: {1}, {2:N1} GB" -f $name, $asset.FileName, ([double]$asset.ContentLength / 1GB))
    }
    $freeGb = Get-FreeGb $CacheRoot
    Write-Info "Free space for the cache ($CacheRoot): $freeGb GB."
    if (Test-CachedVersion $versionDirectory) { Write-Info "Version $AppVersion is already cached." }
    elseif ($freeGb -lt $requiredFreeGb) { throw "The cache needs at least $requiredFreeGb GB free; $CacheRoot has $freeGb GB." }
    else { Write-Verbose "Version $AppVersion is not cached; the next run downloads it ($requiredFreeGb GB needed)." }
    $build = 'F:\worker\app\dist\src\cli\prepare-bundle-command.js'
    if (-not (Test-Path -LiteralPath $build)) {
        throw "The worker build has no prepare-bundle command ($build). Run -Step SetupWorker again."
    }
    Write-Info 'Preflight passed.'
    return
}

if (-not $SourcesFile) { throw 'Pass -SourcesFile (normally ${WORK_DIR}\sources.json) or -Preflight.' }

# -- Cache --------------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
if (Test-CachedVersion $versionDirectory) {
    Write-Info "Reusing the cached sources for $AppVersion."
}
else {
    $freeGb = Get-FreeGb $CacheRoot
    Write-Verbose "Version $AppVersion is not cached. Free space for the cache: $freeGb GB (needs $requiredFreeGb GB)."
    if ($freeGb -lt $requiredFreeGb) { throw "The cache needs at least $requiredFreeGb GB free; $CacheRoot has $freeGb GB." }

    $downloadDirectory = Join-Path $versionDirectory 'download'
    # A run killed mid-download leaves temporaries named after its process; complete files are
    # reused when their size and MD5 match.
    if (Test-Path -LiteralPath $downloadDirectory) {
        Write-Verbose "Clearing partial downloads from $downloadDirectory."
        Get-ChildItem -LiteralPath $downloadDirectory -Recurse -Force |
            Where-Object { $_.Name -like '.azcopy-*' -or $_.Name -like '*.partial-*' } |
            Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Info "Downloading the X++ SDK and assets for $AppVersion..."
    Write-Verbose "Running $assetScript for $($assetNames -join ', ') into $downloadDirectory."
    $stepTimer = [Diagnostics.Stopwatch]::StartNew()
    & $assetScript @assetArguments -OutputDirectory $downloadDirectory | Out-Null
    Write-Verbose ('acquire-ude-assets.ps1 took {0:N1} min.' -f $stepTimer.Elapsed.TotalMinutes)
    $proof = Get-ProofAssets (Join-Path $downloadDirectory 'ude-assets-proof.json')
    Write-Debug "Proof captured at $($proof.CapturedAt) with $($proof.Assets.Count) assets."

    $sdk = Find-Asset $proof.Assets 'systemmetadata'
    $staging = "$packagesDirectory.partial"
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    Write-Info "Extracting $($sdk.FileName)..."
    $stepTimer = [Diagnostics.Stopwatch]::StartNew()
    [IO.Compression.ZipFile]::ExtractToDirectory([string]$sdk.Path, $staging)
    $sdkRoot = Resolve-SdkRoot $staging
    Write-Verbose ('Extracted {0} in {1:N1} min; SDK root {2}.' -f $sdk.Path, $stepTimer.Elapsed.TotalMinutes, $sdkRoot)
    if (Test-Path -LiteralPath $packagesDirectory) { Remove-Item -LiteralPath $packagesDirectory -Recurse -Force }
    Move-Item -LiteralPath $sdkRoot -Destination $packagesDirectory
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    # The extracted SDK replaces the 4 GB zip; its hash stays in sources.json.
    Remove-Item -LiteralPath ([string]$sdk.Path) -Force

    $sources = [ordered]@{}
    foreach ($name in $assetNames) {
        $asset = Find-Asset $proof.Assets $name
        $sources[$name] = [ordered]@{
            fileName   = [string]$asset.FileName
            sha256     = ([string]$asset.Sha256).ToLowerInvariant()
            bytes      = [long]$asset.ContentLength
            acquiredAt = $proof.CapturedAt
        }
        Write-Debug ('{0}: {1}, {2} bytes, SHA-256 {3}.' -f $name, $sources[$name].fileName, $sources[$name].bytes, $sources[$name].sha256)
    }
    Write-Utf8Json $cachedManifest ([ordered]@{
        schemaVersion           = 1
        applicationVersion      = $AppVersion
        dataverseEnvironmentUri = $environmentUri
        packagesLocalDirectory  = $packagesDirectory
        sources                 = $sources
    })
    Write-Info "Cached $AppVersion in $versionDirectory."
}
(Get-Item -LiteralPath $versionDirectory).LastWriteTimeUtc = [DateTime]::UtcNow

# Keep the newest complete versions and drop unfinished ones; a failed prune never fails the run.
$others = @(Get-ChildItem -LiteralPath $CacheRoot -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' -and $_.Name -ne $AppVersion })
$unfinished = @($others | Where-Object { -not (Test-CachedVersion $_.FullName) })
$surplus = @($others | Where-Object { Test-CachedVersion $_.FullName } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip ($KeepVersions - 1))
$stale = @($unfinished) + @($surplus)
Write-Verbose ("Other cached versions: [{0}]; unfinished or beyond -KeepVersions {1}: [{2}]." -f
    (@($others | ForEach-Object { $_.Name }) -join ', '), $KeepVersions, (@($stale | ForEach-Object { $_.Name }) -join ', '))
foreach ($old in $stale) {
    try { Remove-Item -LiteralPath $old.FullName -Recurse -Force; Write-Info "Removed the cached $($old.Name)." }
    catch { Write-Warning "Could not remove the cached $($old.Name): $($_.Exception.Message)" }
}

# The run's copy: the build step reads it from the work directory.
Copy-Item -LiteralPath $cachedManifest -Destination $SourcesFile -Force
Write-Info "Wrote $SourcesFile."
