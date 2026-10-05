<#
.SYNOPSIS
    Runs the operator steps after a first deployment of infra/main.bicep, in order.

.DESCRIPTION
    Run it from your own machine with PowerShell 7 and the Azure CLI signed in (az login --tenant
    <tenant>) to the subscription that holds the environment. The GitHub steps also need the GitHub
    CLI (gh auth login). Every resource name, the deploy identity and the worker identity are read
    from the outputs of the infra/main.bicep deployment in -ResourceGroup, so the script works for
    any tenant, subscription and environment name.

    Steps, in the order -Step All runs them:
      PauseScheduler    Disable the Logic App so no scheduled run fires on an unprepared worker
                        (new environments are created with it disabled).
      SeedApiKeys       Generate two API keys and store MCP_API_KEYS in the API vault.
      SeedWorkerSecret  Store the Power Platform client secret in the worker vault (prompted).
      SetupWorker       Start the VM; data disk, Node.js 24, AzCopy, worker build, helpers.
      PrepareWorker     Prove the worker can reach Dataverse and the X++ SDK downloads, then write
                        the generated acquisition.json (download SDK and assets, build the bundle).
      UploadConfig      Replace acquisition.json with your own pipeline (only when you pass
                        -AcquisitionConfig).
      FirstAcquisition  Run one acquisition, then verify the promoted bundle.
      ResumeScheduler   Enable the Logic App once a first bundle is promoted.
      GitHub            Create the 'production' environment with its secrets and variables.
      Deploy            Start the Deploy workflow on master and watch it.

    PrepareWorker needs -DataverseUrl and -WorkerApplicationId: the Power Platform environment
    linked to Finance and Operations, and the app registration whose secret SeedWorkerSecret
    stored. That app must be an application user in the environment with a security role. Without
    those values (or -AcquisitionConfig), -Step All stops after SetupWorker.

    Every VM step runs through Run Command as SYSTEM, so nothing needs RDP. The worker reads the
    client secret from its own Key Vault at run time; no secret is written to the VM or a file.

    Not automated: the cross-reference (XRef) import. The worker downloads and hashes the
    crossreference asset for provenance, but restoring it needs a SQL Server the worker does not
    have, so the bundle has no usage data yet.

    Secret handling: keys and client secrets are generated or prompted in memory, never written
    to disk or printed. Generated API keys go to your clipboard one at a time so you can save
    them in your password manager. The script never rotates the exposed app-registration secret
    and never touches the XRef proof VM.

.EXAMPLE
    ./scripts/azure-post-deploy.ps1 -ResourceGroup rg-d365mcp-prod -DataverseUrl https://contoso.crm.dynamics.com -WorkerApplicationId 00000000-0000-0000-0000-000000000000

.EXAMPLE
    ./scripts/azure-post-deploy.ps1 -ResourceGroup rg-d365mcp-prod -Step PrepareWorker,FirstAcquisition -DataverseUrl https://contoso.crm.dynamics.com -WorkerApplicationId 00000000-0000-0000-0000-000000000000

.EXAMPLE
    ./scripts/azure-post-deploy.ps1 -ResourceGroup rg-d365mcp-prod -Step ResumeScheduler,GitHub,Deploy
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
    # Resource group the infra/main.bicep deployment went into.
    [Parameter(Mandatory)]
    [string]$ResourceGroup,

    # Subscription holding the resource group. Defaults to the Azure CLI's current subscription.
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', ErrorMessage = '{0} is not a valid subscription ID (expected a GUID like 00000000-0000-0000-0000-000000000000). Run az account list -o table to see yours.')]
    [string]$SubscriptionId,

    # Name of the infra/main.bicep deployment. Defaults to the newest successful one in the group.
    [string]$DeploymentName,

    [ValidateSet('All', 'PauseScheduler', 'SeedApiKeys', 'SeedWorkerSecret', 'SetupWorker', 'PrepareWorker',
        'UploadConfig', 'FirstAcquisition', 'ResumeScheduler', 'GitHub', 'Deploy')]
    [string[]]$Step = @('All'),

    # Dataverse URL of the Power Platform environment linked to Finance and Operations, for
    # example https://contoso.crm.dynamics.com (PrepareWorker).
    [ValidatePattern('^https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/?$', ErrorMessage = '{0} is not a Dataverse URL like https://contoso.crm.dynamics.com.')]
    [string]$DataverseUrl,

    # Application (client) ID of the worker's app registration, whose secret SeedWorkerSecret stored.
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', ErrorMessage = '{0} is not an application ID (a GUID).')]
    [string]$WorkerApplicationId,

    # Tenant of that app registration and environment. Defaults to the Azure CLI's tenant.
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', ErrorMessage = '{0} is not a tenant ID (a GUID).')]
    [string]$PowerPlatformTenantId,

    # Pins the Finance and Operations version instead of following the environment's version.
    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$', ErrorMessage = '{0} is not a four-part version like 10.0.2095.13.')]
    [string]$AppVersion,

    # Your own acquisition.json, for UploadConfig. PrepareWorker generates one otherwise.
    [string]$AcquisitionConfig,

    [ValidatePattern('^[0-9A-Za-z-]{1,127}$', ErrorMessage = '{0} is not a Key Vault secret name.')]
    [string]$WorkerSecretName = 'power-platform-client-secret',

    # Name of the client entry in MCP_API_KEYS (the deploy smoke test gets 'ci-smoke').
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$ClientKeyName = 'vs-client',

    # GitHub repository the worker build comes from and the Deploy workflow runs in.
    [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$', ErrorMessage = '{0} is not an owner/name repository.')]
    [string]$Repository = 'EGMamo/D365-FnO-MCP-Server',

    # Keep your temporary 'Key Vault Secrets Officer' role on the vaults (for later rotation).
    [switch]$KeepVaultAccess,

    # Leave the worker VM running when the script ends (it is deallocated by default).
    [switch]$LeaveVmRunning
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

# -- Environment (filled from the deployment outputs by Resolve-Environment) ------------------
$ApiKeysSecretName = 'mcp-api-keys'
$WorkerRoot = 'F:\worker'

$script:SmokeKey = $null
$script:RunTimeoutHours = 6
$script:BundlePromoted = $false
$script:VmStarted = $false

# -- Helpers ------------------------------------------------------------------------------------
function Write-Step([string]$Text) { Write-Host "`n== $Text ==" -ForegroundColor Cyan }

# Runs az and throws on failure. Never pass secret values through this helper's error text.
function Invoke-Az {
    $output = & az @args
    if ($LASTEXITCODE -ne 0) { throw "az $($args[0..1] -join ' ') failed (exit $LASTEXITCODE)." }
    return $output
}

function Confirm-Continue([string]$Question) {
    $answer = Read-Host "$Question [y/N]"
    if ($answer -notmatch '^(y|yes)$') { throw 'Stopped at your request.' }
}

function New-ApiKey {
    # 32 random bytes as 64 lowercase hex characters (the API requires at least 32).
    return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
}

function ConvertTo-PlainText([Security.SecureString]$Value) {
    return [Net.NetworkCredential]::new('', $Value).Password
}

function Start-WorkerVm {
    $state = Invoke-Az vm get-instance-view -g $ResourceGroup -n $WorkerVm `
        --query "instanceView.statuses[?starts_with(code, 'PowerState/')].code | [0]" -o tsv
    if ($state -ne 'PowerState/running') {
        Write-Host "Starting $WorkerVm..."
        Invoke-Az vm start -g $ResourceGroup -n $WorkerVm --output none | Out-Null
    }
    $script:VmStarted = $true
}

function Stop-WorkerVm([switch]$NoWait) {
    if ($script:VmStarted -and -not $LeaveVmRunning) {
        Write-Host "Deallocating $WorkerVm..."
        if ($NoWait) { & az vm deallocate -g $ResourceGroup -n $WorkerVm --no-wait --output none }
        else { & az vm deallocate -g $ResourceGroup -n $WorkerVm --output none }
        $script:VmStarted = $false
    }
}

# Writes a VM script to a temp file for az's '@file' syntax. Passing a multi-line script inline
# breaks on Windows, where az is a batch file that cuts arguments at line breaks.
function New-ScriptFile([string]$Name, [string]$Script) {
    $file = Join-Path ([IO.Path]::GetTempPath()) "d365mcp-$Name-$PID.ps1"
    Set-Content -LiteralPath $file -Value $Script -Encoding utf8NoBOM
    return $file
}

# Runs a PowerShell script on the worker VM as SYSTEM (action Run Command, up to ~90 minutes).
# The script must print 'STEP-OK' on its last line when it succeeds.
function Invoke-WorkerScript([string]$Name, [string]$Script) {
    Start-WorkerVm
    $file = New-ScriptFile $Name $Script
    try {
        Write-Host "Running '$Name' on $WorkerVm (this can take a while)..."
        $result = Invoke-Az vm run-command invoke -g $ResourceGroup -n $WorkerVm `
            --command-id RunPowerShellScript --scripts "@$file" -o json | ConvertFrom-Json
    }
    finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    $stdout = ($result.value | Where-Object code -like '*StdOut*').message
    $stderr = ($result.value | Where-Object code -like '*StdErr*').message
    if ($stdout) { Write-Host $stdout }
    if ($stderr) { Write-Warning $stderr }
    if ($stdout -notmatch 'STEP-OK\s*$') { throw "'$Name' did not finish on the VM; see the output above." }
}

# PowerShell lines that write $Json to $Path on the VM (UTF-8 without BOM, which Node requires).
function Get-WriteFileScript([string]$Path, [string]$Json) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json))
    return @"
[IO.File]::WriteAllText('$Path', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')), (New-Object Text.UTF8Encoding `$false))
Write-Output 'Wrote $Path'
"@
}

# acquisition.json is stored in plain text on the VM, and command env values are literal.
function Assert-NoSecretInConfig([string]$Raw) {
    if ($Raw -match '(?i)(client_?secret|password|sig=|sv=20|AccountKey=|Password=)') {
        throw "$AcquisitionConfig looks like it contains a secret, SAS or connection string. Read credentials at run time with F:\worker\bin\Get-WorkerSecret.ps1 instead."
    }
}

# Destination of every acquisition: the artifact container, written with the worker identity.
function Get-ArtifactDestination {
    return [ordered]@{
        type                    = 'azure-blob'
        accountUrl              = $ArtifactAccountUrl
        containerName           = $ArtifactContainer
        managedIdentityClientId = $WorkerClientId
    }
}

# Opens the vault to your current public IP with a temporary Secrets Officer role, runs the
# action, then closes it again whatever happens.
function Invoke-WithVaultAccess([string]$Vault, [scriptblock]$Action) {
    $me = Invoke-Az ad signed-in-user show --query id -o tsv
    $vaultId = Invoke-Az keyvault show -n $Vault --query id -o tsv
    $myIp = (Invoke-RestMethod -Uri 'https://api.ipify.org').Trim()
    Invoke-Az role assignment create --assignee-object-id $me --assignee-principal-type User `
        --role 'Key Vault Secrets Officer' --scope $vaultId --output none | Out-Null
    try {
        Invoke-Az keyvault update -n $Vault --public-network-access Enabled --default-action Deny --output none | Out-Null
        Invoke-Az keyvault network-rule add -n $Vault --ip-address "$myIp/32" --output none | Out-Null
        & $Action
    }
    finally {
        Write-Host "Closing $Vault to public traffic again..."
        & az keyvault network-rule remove -n $Vault --ip-address "$myIp/32" --output none
        & az keyvault update -n $Vault --public-network-access Disabled --output none
        if (-not $KeepVaultAccess) {
            & az role assignment delete --assignee $me --role 'Key Vault Secrets Officer' --scope $vaultId --output none
        }
    }
}

# Role assignments and network rules take a minute or two to apply, so retry the write. The value
# goes to the vault's REST API in the request body, never on a command line.
function Set-VaultSecret([string]$Vault, [string]$Name, [string]$Value) {
    $vaultUri = ([string](Invoke-Az keyvault show -n $Vault --query properties.vaultUri -o tsv)).TrimEnd('/')
    # https://<vault>.vault.azure.net -> https://vault.azure.net (and the same in other clouds).
    $resource = 'https://' + ([Uri]$vaultUri).Host.Split('.', 2)[1]
    $body = @{ value = $Value } | ConvertTo-Json
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        try {
            $token = Invoke-Az account get-access-token --resource $resource --query accessToken -o tsv
            Invoke-RestMethod -Method Put -Uri "$vaultUri/secrets/$($Name)?api-version=7.4" `
                -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' -Body $body | Out-Null
            Write-Host "Stored secret '$Name' in $Vault."
            return
        }
        catch {
            Write-Host "Waiting for vault access to apply (attempt $attempt of 12): $($_.Exception.Message)"
            Start-Sleep -Seconds 15
        }
        finally { $token = $null }
    }
    throw "Could not write secret '$Name' to $Vault. Check that your IP and role were applied."
}

function Set-ClipboardForSaving([string]$Label, [string]$Value) {
    Set-Clipboard -Value $Value
    Read-Host "The '$Label' key is on your clipboard. Save it in your password manager, then press Enter" | Out-Null
    Set-Clipboard -Value ' '
}

function Resolve-Environment {
    if ($SubscriptionId) {
        $visible = Invoke-Az account list --query "[?id=='$SubscriptionId'] | length(@)" -o tsv
        if ($visible -ne '1') { throw "Subscription $SubscriptionId is not visible to the signed-in account. Check the ID with az account list -o table." }
        Invoke-Az account set --subscription $SubscriptionId | Out-Null
    }
    $account = Invoke-Az account show -o json | ConvertFrom-Json
    $script:SubscriptionId = $account.id
    $script:TenantId = $account.tenantId

    $name = $DeploymentName
    if (-not $name) {
        $name = Invoke-Az deployment group list -g $ResourceGroup `
            --query "[?properties.provisioningState=='Succeeded' && properties.outputs.webAppName != null] | sort_by(@, &properties.timestamp) | [-1].name" -o tsv
        if (-not $name) { throw "No successful infra/main.bicep deployment found in $ResourceGroup. Pass -DeploymentName." }
    }
    $outputs = Invoke-Az deployment group show -g $ResourceGroup -n $name --query properties.outputs -o json | ConvertFrom-Json
    $value = {
        param($key)
        $entry = $outputs.PSObject.Properties[$key]
        if (-not $entry -or -not $entry.Value.value) { throw "Deployment '$name' has no '$key' output. Redeploy infra/main.bicep from master." }
        return [string]$entry.Value.value
    }
    $script:WebApp = & $value webAppName
    $script:WebAppHost = & $value webAppHostName
    $script:Registry = & $value registryName
    $script:DeployClientId = & $value deployClientId
    $script:ArtifactAccountUrl = & $value artifactAccountUrl
    $script:ArtifactContainer = & $value artifactContainerName
    $script:WorkerClientId = & $value workerManagedIdentityClientId
    $script:ApiVault = & $value apiKeyVaultName
    $script:WorkerVault = & $value workerKeyVaultName
    $script:WorkerVm = & $value workerVmName
    $script:Scheduler = & $value schedulerName
    # Deployments from before this output used the template default.
    $timeout = $outputs.PSObject.Properties['workerRunTimeoutHours']
    $script:RunTimeoutHours = if ($timeout -and $timeout.Value.value) { [int]$timeout.Value.value } else { 6 }

    Write-Host "Subscription $($account.name) ($SubscriptionId), tenant $TenantId"
    Write-Host "Resource group $ResourceGroup, deployment '$name': web app $WebApp, worker $WorkerVm"
}

# -- Steps --------------------------------------------------------------------------------------
function Step-PauseScheduler {
    Write-Step 'Pausing the acquisition scheduler'
    Invoke-Az resource update -g $ResourceGroup -n $Scheduler --resource-type Microsoft.Logic/workflows `
        --set properties.state=Disabled --output none | Out-Null
    Write-Host "$Scheduler is disabled."
}

function Step-SeedApiKeys {
    Write-Step 'Seeding MCP_API_KEYS in the API vault'
    $exists = & az keyvault secret list --vault-name $ApiVault --query "[?name=='$ApiKeysSecretName'] | length(@)" -o tsv 2>$null
    if ($exists -eq '1') { Confirm-Continue "'$ApiKeysSecretName' already exists. Replace it with new keys?" }

    $clientKey = New-ApiKey
    $script:SmokeKey = New-ApiKey
    Set-ClipboardForSaving "$ClientKeyName (client)" $clientKey
    Set-ClipboardForSaving 'ci-smoke (deploy smoke test)' $script:SmokeKey

    Invoke-WithVaultAccess $ApiVault {
        Set-VaultSecret $ApiVault $ApiKeysSecretName "$ClientKeyName=$clientKey,ci-smoke=$($script:SmokeKey)"
    }
    $clientKey = $null
}

function Step-SeedWorkerSecret {
    Write-Step 'Storing the Power Platform client secret in the worker vault'
    Write-Host 'Use a credential for a dedicated worker app registration, not the exposed one from the handoff.'
    $secure = Read-Host "Client secret for '$WorkerSecretName'" -AsSecureString
    $plain = ConvertTo-PlainText $secure
    if ([string]::IsNullOrWhiteSpace($plain)) { throw 'No secret entered.' }
    try {
        Invoke-WithVaultAccess $WorkerVault { Set-VaultSecret $WorkerVault $WorkerSecretName $plain }
    }
    finally { $plain = $null }
}

function Step-SetupWorker {
    Write-Step 'Setting up the worker VM'
    # Pin the build to one commit, so the VM runs exactly the master you see here.
    $commit = ([string](Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/commits/master" `
                -Headers @{ Accept = 'application/vnd.github.sha' })).Trim()
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw "Could not resolve the master commit of $Repository." }
    Write-Host "Worker build: $Repository master at $commit."
    # Helper installed on the VM: reads a worker-vault secret with the worker identity at run time,
    # so acquisition.json and command lines never carry secret values.
    $secretHelper = @'
param([Parameter(Mandatory)][string]$Name)
$ErrorActionPreference = 'Stop'
$token = (Invoke-RestMethod -Headers @{ Metadata = 'true' } -Uri ('http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net&client_id=' + '__CLIENT_ID__')).access_token
(Invoke-RestMethod -Headers @{ Authorization = "Bearer $token" } -Uri "https://__VAULT__.vault.azure.net/secrets/$($Name)?api-version=7.4").value
'@.Replace('__CLIENT_ID__', $WorkerClientId).Replace('__VAULT__', $WorkerVault)

    # Wrapper for scripts/acquire-ude-assets.ps1 that supplies -ClientSecret from the worker vault.
    $acquireWrapper = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$ApplicationId,
    [Parameter(Mandatory)][string]$DataverseEnvironmentUri,
    [Parameter(Mandatory)][string]$AppVersion,
    [string[]]$AssetNames,
    [string]$OutputDirectory,
    [string]$AzCopyPath,
    [switch]$MetadataOnly,
    [string]$SecretName = '__SECRET__'
)
$ErrorActionPreference = 'Stop'
$forward = @{} + $PSBoundParameters
$forward.Remove('SecretName') | Out-Null
$forward['ClientSecret'] = ConvertTo-SecureString (& 'F:\worker\bin\Get-WorkerSecret.ps1' -Name $SecretName) -AsPlainText -Force
& 'F:\worker\app\scripts\acquire-ude-assets.ps1' @forward
'@.Replace('__SECRET__', $WorkerSecretName)

    $encode = { param($text) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }

    $vmScript = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Data disk -> F: (only a disk that has never been initialized)
if (-not (Test-Path 'F:\')) {
    Get-Disk | Where-Object PartitionStyle -eq 'RAW' | Select-Object -First 1 |
        Initialize-Disk -PartitionStyle GPT -PassThru |
        New-Partition -DriveLetter F -UseMaximumSize |
        Format-Volume -FileSystem NTFS -NewFileSystemLabel worker -Confirm:$false | Out-Null
}
New-Item -ItemType Directory -Force F:\worker, F:\worker\runs, F:\worker\bin, F:\worker\tools, F:\worker\cache | Out-Null
# Only SYSTEM (the worker) and Administrators can read the worker folder: run logs, the cache and
# acquisition.json. Well-known SIDs, so this works on localized Windows.
& icacls.exe 'F:\worker' /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict access to F:\worker.' }

# Node.js 24 (latest 24.x). Run Command uses Windows PowerShell 5.1, which does not enumerate a
# JSON array from Invoke-RestMethod, so pick the installer from the release's checksum list.
if (-not (Test-Path 'C:\Program Files\nodejs\node.exe') -or -not ((& 'C:\Program Files\nodejs\node.exe' --version) -like 'v24.*')) {
    $nodeDist = 'https://nodejs.org/dist/latest-v24.x'
    Invoke-WebRequest "$nodeDist/SHASUMS256.txt" -OutFile "$env:TEMP\node-sums.txt" -UseBasicParsing
    $entry = [regex]::Match((Get-Content "$env:TEMP\node-sums.txt" -Raw), '(?m)^([0-9a-f]{64})\s+(node-v24\.\d+\.\d+-x64\.msi)\s*$')
    if (-not $entry.Success) { throw "No Node.js 24 x64 installer is listed in $nodeDist/SHASUMS256.txt." }
    $msi = $entry.Groups[2].Value
    Write-Output "Downloading $msi"
    Invoke-WebRequest "$nodeDist/$msi" -OutFile "$env:TEMP\node.msi" -UseBasicParsing
    if ((Get-FileHash "$env:TEMP\node.msi" -Algorithm SHA256).Hash -ne $entry.Groups[1].Value) { throw "Checksum mismatch for $msi." }
    $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$env:TEMP\node.msi`" /qn /norestart"
    if ($p.ExitCode -notin 0, 3010) { throw "Node.js install failed ($($p.ExitCode))." }
}
$env:Path = "C:\Program Files\nodejs;$env:Path"
Write-Output "node $(node --version)"

# AzCopy, used by acquire-ude-assets.ps1 for the large asset downloads
if (-not (Test-Path F:\worker\tools\azcopy.exe)) {
    Invoke-WebRequest https://aka.ms/downloadazcopy-v10-windows -OutFile "$env:TEMP\azcopy.zip" -UseBasicParsing
    Expand-Archive "$env:TEMP\azcopy.zip" "$env:TEMP\azcopy" -Force
    Copy-Item (Get-ChildItem "$env:TEMP\azcopy" -Recurse -Filter azcopy.exe | Select-Object -First 1).FullName F:\worker\tools\azcopy.exe
}
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($machinePath -notlike '*F:\worker\tools*') {
    [Environment]::SetEnvironmentVariable('Path', "$machinePath;F:\worker\tools", 'Machine')
}

# Worker build of the master commit resolved by the operator (public repository). The X++ SDK is
# not installed here: each acquisition downloads the version the environment runs into
# F:\worker\cache.
Write-Output 'Building __REPOSITORY__ at __COMMIT__'
Invoke-WebRequest https://github.com/__REPOSITORY__/archive/__COMMIT__.zip -OutFile "$env:TEMP\src.zip" -UseBasicParsing
Remove-Item F:\worker\src, F:\worker\app -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive "$env:TEMP\src.zip" F:\worker\src -Force
Move-Item (Get-ChildItem F:\worker\src -Directory | Select-Object -First 1).FullName F:\worker\app
Remove-Item F:\worker\src -Recurse -Force
Set-Location F:\worker\app
# cmd merges npm's stderr: in Windows PowerShell 5.1 a redirected stderr line (an npm warning)
# is a terminating error under ErrorActionPreference Stop.
& cmd.exe /c 'npm ci --no-audit --no-fund 2>&1' | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
& cmd.exe /c 'npm run build 2>&1' | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
& node dist\src\index.js --version
if ($LASTEXITCODE -ne 0) { throw 'The worker build does not start.' }

# Secret helpers
[IO.File]::WriteAllText('F:\worker\bin\Get-WorkerSecret.ps1', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__HELPER__')))
[IO.File]::WriteAllText('F:\worker\bin\acquire-ude-assets.ps1', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__WRAPPER__')))
Write-Output 'Installed F:\worker\bin\Get-WorkerSecret.ps1 and F:\worker\bin\acquire-ude-assets.ps1'
Write-Output 'STEP-OK'
'@.Replace('__HELPER__', (& $encode $secretHelper)).Replace('__WRAPPER__', (& $encode $acquireWrapper)).
        Replace('__REPOSITORY__', $Repository).Replace('__COMMIT__', $commit)

    Invoke-WorkerScript 'setup-worker' $vmScript
    Write-Host 'The worker is installed. Next: -Step PrepareWorker -DataverseUrl <url> -WorkerApplicationId <app id>.'
}

# The acquisition the scheduler runs: download the X++ SDK and assets for the environment's
# version (cached per version on F:), then index the SDK and write the bundle options.
function New-AcquisitionConfig {
    $sourcesArgs = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', "$WorkerRoot\app\scripts\worker\acquire-ude-sources.ps1",
        '-TenantId', $PowerPlatformTenantId, '-ApplicationId', $WorkerApplicationId,
        '-DataverseEnvironmentUri', $DataverseUrl, '-SecretName', $WorkerSecretName,
        '-CacheRoot', "$WorkerRoot\cache", '-SourcesFile', '${WORK_DIR}\sources.json')
    if ($AppVersion) { $sourcesArgs += @('-AppVersion', $AppVersion) }
    return [ordered]@{
        runsRoot          = "$WorkerRoot\runs"
        sourceDatabase    = 'd365_index.db'
        bundleOptionsFile = 'bundle-options.json'
        # Half an hour inside the scheduler's Run Command limit, so the worker stops and cleans up first.
        timeoutMs         = [long]($RunTimeoutHours * 3600000 - 1800000)
        acquire           = @([ordered]@{
                name       = 'acquire-ude-sources'
                executable = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
                args       = $sourcesArgs
            })
        build             = @([ordered]@{
                name       = 'prepare-bundle'
                executable = 'C:\Program Files\nodejs\node.exe'
                # Headroom above Node's default heap of about 4 GB; the default worker size (D8s_v5) has 32 GB.
                args       = @('--max-old-space-size=8192', "$WorkerRoot\app\dist\src\index.js", 'prepare-bundle',
                    '--sources', '${WORK_DIR}\sources.json', '--db-path', '${SOURCE_DB}',
                    '--bundle-options', '${BUNDLE_OPTIONS_FILE}')
            })
        destination       = Get-ArtifactDestination
    }
}

function Step-PrepareWorker {
    Write-Step 'Preparing the worker for scheduled acquisition'
    $pin = if ($AppVersion) { "-AppVersion '$AppVersion'" } else { '' }
    $json = New-AcquisitionConfig | ConvertTo-Json -Depth 10
    # The preflight reads the secret from the worker vault, signs in to Dataverse, reads the F&O
    # version and resolves the three download URLs without downloading. The config is written
    # only when that passes.
    $vmScript = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$sources = '__ROOT__\app\scripts\worker\acquire-ude-sources.ps1'
if (-not (Test-Path -LiteralPath $sources)) { throw "$sources is missing. Run -Step SetupWorker to install the current worker build." }
& $sources -TenantId '__TENANT__' -ApplicationId '__APP__' -DataverseEnvironmentUri '__URL__' -SecretName '__SECRET__' -CacheRoot '__ROOT__\cache' -Preflight __PIN__
__WRITE__
Write-Output 'STEP-OK'
'@.Replace('__ROOT__', $WorkerRoot).Replace('__TENANT__', $PowerPlatformTenantId).Replace('__APP__', $WorkerApplicationId).
        Replace('__URL__', $DataverseUrl).Replace('__SECRET__', $WorkerSecretName).Replace('__PIN__', $pin).
        Replace('__WRITE__', (Get-WriteFileScript "$WorkerRoot\acquisition.json" $json))
    try {
        Invoke-WorkerScript 'prepare-worker' $vmScript
    }
    catch {
        Write-Host @"

The worker could not reach the environment. Check, in this order:
  - Token refused (AADSTS...): -WorkerApplicationId and -PowerPlatformTenantId name the app whose
    secret is '$WorkerSecretName' in $WorkerVault. Rerun SeedWorkerSecret if the secret changed.
  - Dataverse refused (401/403 or a privilege error): in the Power Platform admin center, open the
    environment, Settings > Users + permissions > Application users > New app user, add app
    $WorkerApplicationId and give it the Basic User role. If the error names a missing privilege,
    add that privilege through a custom role. Avoid System Administrator: anyone who can run code
    on the worker could use this secret with full control of the environment.
  - Vault refused: rerun SetupWorker, which reinstalls the worker's secret helper.
"@ -ForegroundColor Yellow
        throw
    }
    Write-Host "The worker is ready. acquisition.json follows the F&O version of $DataverseUrl."
}

function Step-UploadConfig {
    Write-Step 'Uploading your acquisition.json'
    if (-not $AcquisitionConfig) { throw 'Pass -AcquisitionConfig <path to your acquisition.json>.' }
    $raw = Get-Content -LiteralPath $AcquisitionConfig -Raw
    Assert-NoSecretInConfig $raw
    $config = $raw | ConvertFrom-Json -AsHashtable
    $config['runsRoot'] = "$WorkerRoot\runs"
    $config['destination'] = Get-ArtifactDestination
    $vmScript = @"
`$ErrorActionPreference = 'Stop'
$(Get-WriteFileScript "$WorkerRoot\acquisition.json" ($config | ConvertTo-Json -Depth 20))
Write-Output 'STEP-OK'
"@
    Invoke-WorkerScript 'upload-config' $vmScript
}

function Step-FirstAcquisition {
    Write-Step 'Running the first acquisition'
    Start-WorkerVm
    $runId = 'manual-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmZ')
    # Managed Run Command output keeps only the last 4 KB, so failure details come last.
    $vmScript = @'
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\nodejs;__ROOT__\tools;$env:Path"
$runDirectory = '__ROOT__\runs\__RUN__'
& node __ROOT__\app\dist\src\index.js acquire --config __ROOT__\acquisition.json --run-id __RUN__ 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
if ($code -ne 0) {
    Get-ChildItem -LiteralPath "$runDirectory\logs" -Filter *.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc | ForEach-Object {
        Write-Output "--- $($_.Name), last lines:"
        Get-Content -LiteralPath $_.FullName -Tail 12
    }
    $status = Get-Content -LiteralPath "$runDirectory\status.json" -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if ($status) {
        foreach ($phase in $status.phases.PSObject.Properties) {
            $detail = if ($phase.Value.PSObject.Properties['error']) { ": $($phase.Value.error)" } else { '' }
            Write-Output "$($phase.Name) $($phase.Value.state)$detail"
        }
    }
    exit $code
}
$env:D365_ARTIFACT_ACCOUNT_URL = '__ACCOUNT__'
$env:D365_ARTIFACT_CONTAINER = '__CONTAINER__'
$env:D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID = '__CLIENT__'
# Promote already downloaded and validated the bundle; --verify would download it again.
& node __ROOT__\app\dist\src\index.js artifact status --json 2>&1 | ForEach-Object { "$_" }
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'ACQUISITION-OK'
'@.Replace('__ROOT__', $WorkerRoot).Replace('__RUN__', $runId).Replace('__ACCOUNT__', $ArtifactAccountUrl).
        Replace('__CONTAINER__', $ArtifactContainer).Replace('__CLIENT__', $WorkerClientId)

    # Managed Run Command, like the scheduler, so a multi-hour run is not cut off at 90 minutes.
    Write-Host "Starting run '$runId' (up to $RunTimeoutHours hours)..."
    $file = New-ScriptFile 'first-acquisition' $vmScript
    try {
        Invoke-Az vm run-command create -g $ResourceGroup --vm-name $WorkerVm --name first-acquisition `
            --script "@$file" --async-execution true --timeout-in-seconds ($RunTimeoutHours * 3600) --output none | Out-Null
    }
    finally {
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }

    $deadline = (Get-Date).AddHours($RunTimeoutHours).AddMinutes(15)
    $state = $null
    $view = $null
    while ($state -notin @('Succeeded', 'Failed', 'TimedOut', 'Canceled')) {
        if ((Get-Date) -gt $deadline) { throw "Run '$runId' has not finished after $RunTimeoutHours hours; check run command 'first-acquisition' on $WorkerVm." }
        Start-Sleep -Seconds 60
        # The projection makes absent fields null. A failed poll is retried at the next minute
        # rather than abandoning a running acquisition.
        $json = & az vm run-command show -g $ResourceGroup --vm-name $WorkerVm --name first-acquisition --instance-view `
            --query '{state: instanceView.executionState, exitCode: instanceView.exitCode, output: instanceView.output, error: instanceView.error}' -o json 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $json) { Write-Host "$(Get-Date -Format HH:mm) (status unavailable, retrying)"; continue }
        $view = $json | ConvertFrom-Json
        $state = [string]$view.state
        Write-Host "$(Get-Date -Format HH:mm) $state"
    }

    $output = [string]$view.output
    if ($output) { Write-Host $output }
    if ($view.error) { Write-Warning $view.error }
    & az vm run-command delete -g $ResourceGroup --vm-name $WorkerVm --name first-acquisition --yes --output none

    if ($state -ne 'Succeeded' -or $view.exitCode -ne 0 -or $output -notmatch 'ACQUISITION-OK\s*$') {
        throw "Acquisition run '$runId' ended as $state (exit $($view.exitCode)); see the output above. Fix it before deploying the API."
    }
    $script:BundlePromoted = $true
    Write-Host "Run '$runId' validated and promoted a bundle."
}

function Step-ResumeScheduler {
    Write-Step 'Enabling the acquisition scheduler'
    if (-not $script:BundlePromoted) {
        Confirm-Continue 'Scheduled runs fail until the worker is prepared. Has an acquisition run succeeded?'
    }
    # Enabling can start a run at once; deallocate first so this script does not stop that run.
    Stop-WorkerVm
    Invoke-Az resource update -g $ResourceGroup -n $Scheduler --resource-type Microsoft.Logic/workflows `
        --set properties.state=Enabled --output none | Out-Null
    Write-Host "$Scheduler is enabled."
}

function Step-GitHub {
    Write-Step "Configuring the GitHub 'production' environment"
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Install the GitHub CLI and run gh auth login first.' }

    & gh api -X PUT "repos/$Repository/environments/production" --silent
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the production environment.' }

    $values = [ordered]@{ AZURE_CLIENT_ID = $DeployClientId; AZURE_TENANT_ID = $TenantId; AZURE_SUBSCRIPTION_ID = $SubscriptionId }
    foreach ($name in $values.Keys) {
        & gh secret set $name --env production --repo $Repository --body $values[$name]
        if ($LASTEXITCODE -ne 0) { throw "Could not set secret $name." }
    }

    $smoke = $script:SmokeKey
    if (-not $smoke) { $smoke = ConvertTo-PlainText (Read-Host 'ci-smoke API key (from your password manager)' -AsSecureString) }
    # Piped on stdin so the key is not on a command line.
    $smoke | & gh secret set MCP_SMOKE_API_KEY --env production --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw 'Could not set secret MCP_SMOKE_API_KEY.' }
    $smoke = $null

    $vars = [ordered]@{ RESOURCE_GROUP = $ResourceGroup; WEBAPP_NAME = $WebApp; ACR_NAME = $Registry }
    foreach ($name in $vars.Keys) {
        & gh variable set $name --env production --repo $Repository --body $vars[$name]
        if ($LASTEXITCODE -ne 0) { throw "Could not set variable $name." }
    }
    Write-Host "The production environment has 4 secrets and 3 variables."
}

function Step-Deploy {
    Write-Step 'Deploying the API'
    if (-not $script:BundlePromoted) {
        Confirm-Continue 'The API stays unhealthy until a first bundle is promoted. Has an acquisition run succeeded?'
    }
    $previous = & gh run list --repo $Repository --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId'
    & gh workflow run deploy.yml --repo $Repository --ref master
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the Deploy workflow.' }
    $runId = $null
    for ($attempt = 1; $attempt -le 24 -and -not $runId; $attempt++) {
        Start-Sleep -Seconds 5
        $latest = & gh run list --repo $Repository --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId'
        if ($latest -and $latest -ne $previous) { $runId = $latest }
    }
    if (-not $runId) { throw "The Deploy run did not appear; check https://github.com/$Repository/actions." }
    & gh run watch $runId --repo $Repository --exit-status
    if ($LASTEXITCODE -ne 0) { throw 'The Deploy workflow failed; see the run log on GitHub.' }
    Write-Host "Deployed. Connect clients to https://$WebAppHost/mcp with the $ClientKeyName key."
}

# -- Main ---------------------------------------------------------------------------------------
$order = @('PauseScheduler', 'SeedApiKeys', 'SeedWorkerSecret', 'SetupWorker', 'PrepareWorker', 'UploadConfig',
    'FirstAcquisition', 'ResumeScheduler', 'GitHub', 'Deploy')
$canPrepare = [bool]($DataverseUrl -and $WorkerApplicationId)
$selected = if ($Step -contains 'All') {
    if ($canPrepare -or $AcquisitionConfig) {
        $order | Where-Object { ($_ -ne 'PrepareWorker' -or $canPrepare) -and ($_ -ne 'UploadConfig' -or $AcquisitionConfig) }
    }
    else { $order[0..3] }
} else { $order | Where-Object { $Step -contains $_ } }

if ($selected -contains 'PrepareWorker' -and -not $canPrepare) {
    throw 'PrepareWorker needs -DataverseUrl (the environment linked to F&O) and -WorkerApplicationId (the app whose secret SeedWorkerSecret stored).'
}
if ($selected -contains 'UploadConfig') {
    if (-not $AcquisitionConfig -or -not (Test-Path -LiteralPath $AcquisitionConfig -PathType Leaf)) {
        throw 'UploadConfig needs -AcquisitionConfig <path to your acquisition.json>.'
    }
    Assert-NoSecretInConfig (Get-Content -LiteralPath $AcquisitionConfig -Raw)
}

Resolve-Environment
if (-not $PowerPlatformTenantId) { $PowerPlatformTenantId = $TenantId }

try {
    foreach ($name in $selected) { & "Step-$name" }
    if ($Step -contains 'All' -and -not $canPrepare -and -not $AcquisitionConfig) {
        Write-Host "`nStopped before the first acquisition. Prepare the worker and finish with:"
        Write-Host "  ./scripts/azure-post-deploy.ps1 -ResourceGroup $ResourceGroup -SubscriptionId $SubscriptionId -Repository $Repository -Step PrepareWorker,FirstAcquisition,ResumeScheduler,GitHub,Deploy -DataverseUrl <url> -WorkerApplicationId <app id>"
    }
}
finally {
    $script:SmokeKey = $null
    Stop-WorkerVm -NoWait
}
