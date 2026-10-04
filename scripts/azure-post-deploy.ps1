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
      PauseScheduler    Disable the Logic App so no scheduled run fires on an unprepared worker.
      SeedApiKeys       Generate two API keys and store MCP_API_KEYS in the API vault.
      SeedWorkerSecret  Store the Power Platform client secret in the worker vault (prompted).
      SetupWorker       Start the VM; data disk, Node.js 24, PAC CLI, AzCopy, worker build, helpers.
      UploadConfig      Copy your acquisition.json to the VM, with destination and runsRoot set.
      FirstAcquisition  Run one acquisition, then verify the promoted bundle.
      ResumeScheduler   Re-enable the Logic App.
      GitHub            Create the 'production' environment with its secrets and variables.
      Deploy            Start the Deploy workflow on master and watch it.

    UploadConfig and FirstAcquisition need -AcquisitionConfig, your acquire/build pipeline from
    the proof VM (see "Scheduled acquisition worker" in docs/hosted-deployment.md). Without it,
    -Step All stops after SetupWorker, before anything that needs a promoted bundle.

    Secret handling: keys and client secrets are generated or prompted in memory, never written
    to disk or printed. Generated API keys go to your clipboard one at a time so you can save
    them in your password manager. The script never rotates the exposed app-registration secret
    and never touches the XRef proof VM.

.EXAMPLE
    ./scripts/azure-post-deploy.ps1 -ResourceGroup rg-d365mcp-prod

.EXAMPLE
    ./scripts/azure-post-deploy.ps1 -ResourceGroup rg-d365mcp-prod -Step UploadConfig,FirstAcquisition,ResumeScheduler,GitHub,Deploy -AcquisitionConfig ./acquisition.json
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

    [ValidateSet('All', 'PauseScheduler', 'SeedApiKeys', 'SeedWorkerSecret', 'SetupWorker', 'UploadConfig',
        'FirstAcquisition', 'ResumeScheduler', 'GitHub', 'Deploy')]
    [string[]]$Step = @('All'),

    [string]$AcquisitionConfig,

    [string]$WorkerSecretName = 'power-platform-client-secret',

    # Name of the client entry in MCP_API_KEYS (the deploy smoke test gets 'ci-smoke').
    [ValidatePattern('^[A-Za-z0-9._-]+$')]
    [string]$ClientKeyName = 'vs-client',

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

# Runs a PowerShell script on the worker VM as SYSTEM (action Run Command, up to ~90 minutes).
# The script must print 'STEP-OK' on its last line when it succeeds.
function Invoke-WorkerScript([string]$Name, [string]$Script) {
    Start-WorkerVm
    $file = Join-Path ([IO.Path]::GetTempPath()) "d365mcp-$Name-$PID.ps1"
    try {
        Set-Content -LiteralPath $file -Value $Script -Encoding utf8NoBOM
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

# Role assignments and network rules take a minute or two to apply, so retry the write.
function Set-VaultSecret([string]$Vault, [string]$Name, [string]$Value) {
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        & az keyvault secret set --vault-name $Vault -n $Name --value $Value --output none 2>$null
        if ($LASTEXITCODE -eq 0) { Write-Host "Stored secret '$Name' in $Vault."; return }
        Write-Host "Waiting for vault access to apply (attempt $attempt of 12)..."
        Start-Sleep -Seconds 15
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
New-Item -ItemType Directory -Force F:\worker, F:\worker\runs, F:\worker\bin, F:\worker\tools | Out-Null

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

# Power Platform CLI (.NET Framework build, needed for 'pac tool xpp')
if (-not (Get-Command pac -ErrorAction SilentlyContinue)) {
    Invoke-WebRequest https://aka.ms/PowerAppsCLI -OutFile "$env:TEMP\pac.msi" -UseBasicParsing
    $p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$env:TEMP\pac.msi`" /qn /norestart"
    if ($p.ExitCode -notin 0, 3010) { throw "PAC CLI install failed ($($p.ExitCode))." }
}

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

# Worker build from master (public repository)
Invoke-WebRequest https://github.com/EGMamo/D365-FnO-MCP-Server/archive/refs/heads/master.zip -OutFile "$env:TEMP\src.zip" -UseBasicParsing
Remove-Item F:\worker\src, F:\worker\app -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive "$env:TEMP\src.zip" F:\worker\src -Force
Move-Item F:\worker\src\D365-FnO-MCP-Server-master F:\worker\app
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
'@.Replace('__HELPER__', (& $encode $secretHelper)).Replace('__WRAPPER__', (& $encode $acquireWrapper))

    Invoke-WorkerScript 'setup-worker' $vmScript
    Write-Host @"

The worker is installed. Still to do on the VM before the first acquisition (RDP via Bastion is
easiest): authenticate PAC non-interactively, run 'pac tool xpp install' and
F:\worker\app\scripts\verify-windows-xpp.ps1, and prepare the XRef database your pipeline imports.
Use F:\worker\bin\acquire-ude-assets.ps1 in acquisition.json; it reads '$WorkerSecretName' from
$WorkerVault, so no secret goes in the file.
"@
}

function Step-UploadConfig {
    Write-Step 'Uploading acquisition.json'
    if (-not $AcquisitionConfig) { throw 'Pass -AcquisitionConfig <path to your acquisition.json>.' }
    $raw = Get-Content -LiteralPath $AcquisitionConfig -Raw
    if ($raw -match '(?i)(client_?secret|password|sig=|sv=20|AccountKey=|Password=)') {
        throw "$AcquisitionConfig looks like it contains a secret, SAS or connection string. Use command env values read from the worker vault instead."
    }
    $config = $raw | ConvertFrom-Json -AsHashtable
    $config['runsRoot'] = "$WorkerRoot\runs"
    $config['destination'] = [ordered]@{
        type                    = 'azure-blob'
        accountUrl              = $ArtifactAccountUrl
        containerName           = $ArtifactContainer
        managedIdentityClientId = $WorkerClientId
    }
    $json = $config | ConvertTo-Json -Depth 20
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $vmScript = @"
`$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText('$WorkerRoot\acquisition.json', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$b64')))
Write-Output 'Wrote $WorkerRoot\acquisition.json'
Write-Output 'STEP-OK'
"@
    Invoke-WorkerScript 'upload-config' $vmScript
}

function Step-FirstAcquisition {
    Write-Step 'Running the first acquisition'
    Start-WorkerVm
    $runId = 'manual-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmZ')
    $vmScript = @"
`$ErrorActionPreference = 'Continue'
`$env:Path = "C:\Program Files\nodejs;F:\worker\tools;`$env:Path"
& node $WorkerRoot\app\dist\src\index.js acquire --config $WorkerRoot\acquisition.json --run-id $runId
`$code = `$LASTEXITCODE
Get-Content $WorkerRoot\runs\$runId\status.json -ErrorAction SilentlyContinue
if (`$code -ne 0) { exit `$code }
`$env:D365_ARTIFACT_ACCOUNT_URL = '$ArtifactAccountUrl'
`$env:D365_ARTIFACT_CONTAINER = '$ArtifactContainer'
`$env:D365_ARTIFACT_MANAGED_IDENTITY_CLIENT_ID = '$WorkerClientId'
& node $WorkerRoot\app\dist\src\index.js artifact status --verify --json
exit `$LASTEXITCODE
"@
    # Managed Run Command, like the scheduler, so a multi-hour run is not cut off at 90 minutes.
    Write-Host "Starting run '$runId' (up to 6 hours)..."
    Invoke-Az vm run-command create -g $ResourceGroup --vm-name $WorkerVm --name first-acquisition `
        --script $vmScript --async-execution true --timeout-in-seconds 21600 --output none | Out-Null

    do {
        Start-Sleep -Seconds 60
        $view = Invoke-Az vm run-command show -g $ResourceGroup --vm-name $WorkerVm --name first-acquisition `
            --instance-view -o json | ConvertFrom-Json
        $state = $view.instanceView.executionState
        Write-Host "$(Get-Date -Format HH:mm) $state"
    } while ($state -in @('Pending', 'Running'))

    if ($view.instanceView.output) { Write-Host $view.instanceView.output }
    if ($view.instanceView.error) { Write-Warning $view.instanceView.error }
    & az vm run-command delete -g $ResourceGroup --vm-name $WorkerVm --name first-acquisition --yes --output none

    if ($state -ne 'Succeeded' -or $view.instanceView.exitCode -ne 0) {
        throw "Acquisition run '$runId' ended as $state (exit $($view.instanceView.exitCode)). Fix it before deploying the API."
    }
    $script:BundlePromoted = $true
    Write-Host "Run '$runId' promoted a bundle. Record the XRef measurements from the run report now."
}

function Step-ResumeScheduler {
    Write-Step 'Re-enabling the acquisition scheduler'
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
    & gh workflow run deploy.yml --repo $Repository --ref master
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the Deploy workflow.' }
    Start-Sleep -Seconds 10
    $runId = & gh run list --repo $Repository --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId'
    & gh run watch $runId --repo $Repository --exit-status
    if ($LASTEXITCODE -ne 0) { throw 'The Deploy workflow failed; see the run log on GitHub.' }
    Write-Host "Deployed. Connect clients to https://$WebAppHost/mcp with the $ClientKeyName key."
}

# -- Main ---------------------------------------------------------------------------------------
Resolve-Environment

$order = @('PauseScheduler', 'SeedApiKeys', 'SeedWorkerSecret', 'SetupWorker', 'UploadConfig',
    'FirstAcquisition', 'ResumeScheduler', 'GitHub', 'Deploy')
$selected = if ($Step -contains 'All') {
    if ($AcquisitionConfig) { $order } else { $order[0..3] }
} else { $order | Where-Object { $Step -contains $_ } }

try {
    foreach ($name in $selected) { & "Step-$name" }
    if ($Step -contains 'All' -and -not $AcquisitionConfig) {
        Write-Host "`nStopped before the first acquisition. Finish the PAC/XRef preparation, then run:"
        Write-Host "  ./scripts/azure-post-deploy.ps1 -ResourceGroup $ResourceGroup -Step UploadConfig,FirstAcquisition,ResumeScheduler,GitHub,Deploy -AcquisitionConfig <path>"
    }
}
finally {
    $script:SmokeKey = $null
    if ($script:VmStarted -and -not $LeaveVmRunning) {
        Write-Host "Deallocating $WorkerVm..."
        & az vm deallocate -g $ResourceGroup -n $WorkerVm --no-wait --output none
    }
}
