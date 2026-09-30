<#
.SYNOPSIS
  Builds the D365 F&O metadata index, imports compiler usage data, packages the
  index, uploads it to Azure Blob Storage and restarts the hosted MCP server.

.DESCRIPTION
  Runs on a machine that has PackagesLocalDirectory: a developer VM or a unified
  development experience workstation. Meant to be scheduled (see the docs for a
  schtasks example) but safe to run by hand.

  Requirements on this machine:
    - Node.js 24 and the d365-fno-mcp-server CLI (npm link / npm install -g .)
    - Azure CLI, signed in (az login) with
        Storage Blob Data Contributor on the storage account and
        Website Contributor on the web app
    - Optional: D365_XREF_CONNECTION_STRING in the environment (read-only login
      to the DynamicsXrefDB copy in Azure SQL). Set it from a secret store or a
      protected file; never pass it on the command line.

  Upload order matters: the versioned folder goes first and latest/manifest.json
  last, so the server never sees a pointer to a half-uploaded version.

.EXAMPLE
  pwsh scripts/publish-index.ps1 -StorageAccount stacmed365 -ResourceGroup rg-d365-mcp -WebApp app-d365-mcp
#>
[CmdletBinding()]
param(
  # PackagesLocalDirectory. Defaults to D365_PACKAGES_DIR, then the newest
  # unified development experience install under %LOCALAPPDATA%.
  [string]$PackagesDir = $env:D365_PACKAGES_DIR,
  [string]$DbPath = $(if ($env:D365_INDEX_DB_PATH) { $env:D365_INDEX_DB_PATH } else { Join-Path $env:LOCALAPPDATA 'd365-fno-mcp/d365_index.db' }),
  [string]$OutDir = $(Join-Path $env:LOCALAPPDATA 'd365-fno-mcp/publish'),
  [Parameter(Mandatory)][string]$StorageAccount,
  [string]$Container = 'indexes',
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$WebApp,
  # Skip index-xref even when D365_XREF_CONNECTION_STRING is set.
  [switch]$SkipXref,
  # Re-parse every file (index --force).
  [switch]$Force,
  # Strip the packages directory prefix from indexed paths in the published copy.
  [switch]$RelativePaths,
  # Published versions to keep in the container; older ones are deleted. 0 keeps all.
  [int]$Keep = 3,
  [string]$Cli = 'd365-fno-mcp-server'
)

$ErrorActionPreference = 'Stop'

function Step([string]$Message) {
  Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

function Invoke-Cli([string[]]$Arguments) {
  & $Cli @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Cli $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Invoke-Az([string[]]$Arguments) {
  & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "az $($Arguments[0]) $($Arguments[1]) failed with exit code $LASTEXITCODE" }
}

if (-not $PackagesDir) {
  $installs = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft/Dynamics365') -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'PackagesLocalDirectory' } |
    Where-Object { Test-Path $_ }
  if (-not $installs) { throw 'PackagesLocalDirectory not found. Pass -PackagesDir or set D365_PACKAGES_DIR.' }
  $PackagesDir = $installs | Select-Object -First 1
}

$env:D365_PACKAGES_DIR = $PackagesDir
$env:D365_INDEX_DB_PATH = $DbPath
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $DbPath) | Out-Null

Step "Indexing $PackagesDir -> $DbPath"
$indexArgs = @('index')
if ($Force) { $indexArgs += '--force' }
Invoke-Cli $indexArgs

if ($SkipXref) {
  Step 'Skipping compiler usage import (-SkipXref)'
} elseif ($env:D365_XREF_CONNECTION_STRING) {
  Step 'Importing compiler cross-reference usage data'
  try {
    Invoke-Cli @('index-xref', '--db-path', $DbPath)
  } catch {
    # Azure SQL serverless resumes from auto-pause on the first connection,
    # which can take about a minute and fail that first attempt.
    Step "index-xref failed ($($_.Exception.Message)); retrying in 90 s"
    Start-Sleep -Seconds 90
    Invoke-Cli @('index-xref', '--db-path', $DbPath)
  }
} else {
  Step 'D365_XREF_CONNECTION_STRING not set; skipping compiler usage import'
}

Step "Packaging the index into $OutDir"
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
$publishArgs = @('publish-index', '--db-path', $DbPath, '--out', $OutDir)
if ($RelativePaths) { $publishArgs += '--relative-paths' }
Invoke-Cli $publishArgs

$latestManifestPath = Join-Path (Join-Path $OutDir 'latest') 'manifest.json'
$manifest = Get-Content $latestManifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
Step ("Version {0}: {1} objects, {2:N1} MB gzip" -f $version, $manifest.stats.objects, ($manifest.db.bytes / 1MB))

Step "Uploading $version to $StorageAccount/$Container"
Invoke-Az @(
  'storage', 'blob', 'upload-batch', '--auth-mode', 'login', '--only-show-errors',
  '--account-name', $StorageAccount, '--destination', $Container, '--destination-path', $version,
  '--source', (Join-Path $OutDir $version), '--overwrite', 'true'
) | Out-Null

Step 'Switching latest/manifest.json'
Invoke-Az @(
  'storage', 'blob', 'upload', '--auth-mode', 'login', '--only-show-errors',
  '--account-name', $StorageAccount, '--container-name', $Container,
  '--name', 'latest/manifest.json', '--file', $latestManifestPath, '--overwrite', 'true'
) | Out-Null

Step "Restarting $WebApp so it downloads $version"
Invoke-Az @('webapp', 'restart', '--resource-group', $ResourceGroup, '--name', $WebApp, '--only-show-errors') | Out-Null

if ($Keep -gt 0) {
  Step "Pruning published versions beyond the newest $Keep"
  $names = az storage blob list --auth-mode login --only-show-errors --account-name $StorageAccount `
    --container-name $Container --query '[].name' -o tsv
  if ($LASTEXITCODE -ne 0) { throw 'az storage blob list failed' }
  # The version latest/manifest.json points at now; a server-side upload may have replaced ours.
  $liveManifest = Join-Path $OutDir 'live-manifest.json'
  az storage blob download --auth-mode login --only-show-errors --account-name $StorageAccount `
    --container-name $Container --name 'latest/manifest.json' --file $liveManifest --overwrite true | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'az storage blob download of latest/manifest.json failed' }
  $liveVersion = (Get-Content $liveManifest -Raw | ConvertFrom-Json).version
  # Version folders sort chronologically by name (YYYYMMDDTHHMMSSZ-<sha8>); other folders are not ours.
  $versions = $names | ForEach-Object { ($_ -split '/')[0] } |
    Where-Object { $_ -cmatch '^\d{8}T\d{6}Z-[0-9a-f]{8}$' } | Sort-Object -Unique -Descending
  foreach ($old in ($versions | Select-Object -Skip $Keep | Where-Object { $_ -ne $liveVersion })) {
    Step "Deleting $old"
    Invoke-Az @(
      'storage', 'blob', 'delete-batch', '--auth-mode', 'login', '--only-show-errors',
      '--account-name', $StorageAccount, '--source', $Container, '--pattern', "$old/*"
    ) | Out-Null
  }
}

Step "Done: $version is live"
