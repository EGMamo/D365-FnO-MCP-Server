[CmdletBinding()]
param(
    [string]$OutputDirectory = "$env:USERPROFILE\Documents\D365SdkProof",
    [switch]$ExecuteCompiler,
    # How much the script prints: Error, Warning, Info (default), Verbose or Debug. -Verbose and
    # -Debug also work. Verbose adds what it checks and runs; the evidence files do not change.
    [ValidateSet("Error", "Warning", "Info", "Verbose", "Debug")]
    [string]$LogLevel = "Info"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

# -Verbose and -Debug raise the level; the preference variables then follow the resolved level.
$script:LogRank = @{ Error = 0; Warning = 1; Info = 2; Verbose = 3; Debug = 4 }[$LogLevel]
if ($VerbosePreference -eq "Continue" -and $script:LogRank -lt 3) { $script:LogRank = 3 }
if ($DebugPreference -in @("Continue", "Inquire")) { $script:LogRank = 4 }
$script:LogLevelName = @("Error", "Warning", "Info", "Verbose", "Debug")[$script:LogRank]
$VerbosePreference = if ($script:LogRank -ge 3) { "Continue" } else { "SilentlyContinue" }
# Never "Inquire" (what -Debug sets in Windows PowerShell 5.1): it would stop at every Write-Debug.
$DebugPreference = if ($script:LogRank -ge 4) { "Continue" } else { "SilentlyContinue" }
# Only ever lowered, so -WarningAction, -InformationAction and the caller's preferences still apply
# at Info and above.
if ($script:LogRank -lt 1) { $WarningPreference = "SilentlyContinue" }
if ($script:LogRank -lt 2) { $InformationPreference = "SilentlyContinue" }
Write-Verbose "Log level $($script:LogLevelName); PowerShell $($PSVersionTable.PSVersion)."

# Write-Host ignores the preference variables, so Info-level output goes through here.
function Write-Info {
    param(
        [string]$Text,

        [ConsoleColor]$ForegroundColor
    )

    if ($script:LogRank -lt 2) {
        return
    }
    $colour = @{}
    if ($PSBoundParameters.ContainsKey("ForegroundColor")) {
        $colour.ForegroundColor = $ForegroundColor
    }
    Write-Host $Text @colour
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$pac = Get-Command pac -ErrorAction Stop
$pacListPath = Join-Path $OutputDirectory "pac-tool-xpp-list.txt"
Write-Verbose "Running: $($pac.Source) tool xpp list"
$pacTimer = [Diagnostics.Stopwatch]::StartNew()
$previousErrorActionPreference = $ErrorActionPreference
# Windows PowerShell 5.1 turns redirected native stderr into terminating errors
# under Stop; capture it as text and rely on the exit code instead.
$ErrorActionPreference = "Continue"
try {
    $pacList = & $pac.Source tool xpp list 2>&1 | ForEach-Object { [string]$_ } | Out-String
    $pacExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $previousErrorActionPreference
}
Write-Verbose ("'pac tool xpp list' exited with code $pacExitCode after " +
    "$([int]$pacTimer.Elapsed.TotalSeconds)s; output in $pacListPath.")
$pacList | Set-Content -Path $pacListPath -Encoding UTF8
if ($pacExitCode -ne 0) {
    Write-Error ("'pac tool xpp list' failed with exit code $pacExitCode. " +
        "Output written to: $pacListPath") -ErrorAction Continue
    exit 1
}

$dynamicsRoot = Join-Path $env:LOCALAPPDATA "Microsoft\Dynamics365"
$configRoot = Join-Path $dynamicsRoot "XPPConfig"
$configFiles = @()
if (Test-Path -LiteralPath $configRoot) {
    $configFiles = @(Get-ChildItem -LiteralPath $configRoot -Filter "*.json" -File)
}
Write-Verbose "$($configFiles.Count) XPPConfig file(s) in $configRoot."

$configResults = foreach ($configFile in $configFiles) {
    try {
        $config = Get-Content -LiteralPath $configFile.FullName -Raw | ConvertFrom-Json
        $referencePaths = @($config.ReferencePackagesPaths) |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
        Write-Verbose "$($configFile.Name): $(@($referencePaths).Count) reference package path(s)."

        $references = foreach ($referencePath in $referencePaths) {
            $exists = Test-Path -LiteralPath $referencePath -PathType Container
            $directoryCount = 0
            $compilerPaths = @()

            if ($exists) {
                $directoryCount = @(
                    Get-ChildItem -LiteralPath $referencePath -Directory -ErrorAction Stop
                ).Count
                $compilerPaths = @(
                    Get-ChildItem -LiteralPath $referencePath -Filter "xppc.exe" -File -Recurse `
                        -ErrorAction SilentlyContinue |
                        Select-Object -ExpandProperty FullName
                )
            }
            Write-Debug ("Reference {0}: exists {1}, {2} top-level folder(s), {3} xppc.exe" -f
                $referencePath, $exists, $directoryCount, $compilerPaths.Count)

            [pscustomobject]@{
                Path = [string]$referencePath
                Exists = $exists
                TopLevelDirectoryCount = $directoryCount
                CompilerPaths = $compilerPaths
            }
        }

        [pscustomobject]@{
            ConfigFile = $configFile.Name
            Description = [string]$config.Description
            CrossReferenceDatabaseName = [string]$config.CrossReferencesDatabaseName
            CrossReferenceDatabaseServer = [string]$config.CrossReferencesDbServerName
            References = @($references)
            Error = $null
        }
    }
    catch {
        Write-Verbose "Could not inspect $($configFile.Name): $($_.Exception.Message)"
        [pscustomobject]@{
            ConfigFile = $configFile.Name
            Description = $null
            CrossReferenceDatabaseName = $null
            CrossReferenceDatabaseServer = $null
            References = @()
            Error = $_.Exception.Message
        }
    }
}

$compilerResults = @()
if ($ExecuteCompiler) {
    $compilerPaths = @(
        $configResults |
            ForEach-Object { $_.References } |
            ForEach-Object { $_.CompilerPaths } |
            Sort-Object -Unique
    )

    if (Test-Path -LiteralPath $dynamicsRoot -PathType Container) {
        $compilerPaths += @(
            Get-ChildItem -LiteralPath $dynamicsRoot -Directory -ErrorAction Stop |
                ForEach-Object {
                    Join-Path $_.FullName "PackagesLocalDirectory\bin\xppc.exe"
                } |
                Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
        )
    }
    $compilerPaths = @($compilerPaths | Sort-Object -Unique)
    Write-Verbose "Found $($compilerPaths.Count) xppc.exe to run with /?."

    $compilerIndex = 0
    $compilerResults = foreach ($compilerPath in $compilerPaths) {
        $compilerIndex++
        $stdoutPath = Join-Path $OutputDirectory "xppc-$compilerIndex.stdout.txt"
        $stderrPath = Join-Path $OutputDirectory "xppc-$compilerIndex.stderr.txt"

        try {
            Write-Verbose "Running: $compilerPath /?"
            $process = Start-Process -FilePath $compilerPath -ArgumentList "/?" -PassThru `
                -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
            $exited = $process.WaitForExit(30000)
            if (-not $exited) {
                Write-Verbose "$compilerPath did not exit within 30 seconds; stopping it."
                $process.Kill()
                $process.WaitForExit()
            }
            else {
                Write-Verbose "$compilerPath exited with code $($process.ExitCode)."
            }

            [pscustomobject]@{
                Path = $compilerPath
                Started = $true
                ExitedWithin30Seconds = $exited
                ExitCode = if ($exited) { $process.ExitCode } else { $null }
                StandardOutputFile = $stdoutPath
                StandardErrorFile = $stderrPath
                Error = $null
            }
        }
        catch {
            Write-Verbose "$compilerPath could not be started: $($_.Exception.Message)"
            [pscustomobject]@{
                Path = $compilerPath
                Started = $false
                ExitedWithin30Seconds = $false
                ExitCode = $null
                StandardOutputFile = $stdoutPath
                StandardErrorFile = $stderrPath
                Error = $_.Exception.Message
            }
        }
    }
}

$result = [pscustomobject]@{
    CapturedAtUtc = [DateTime]::UtcNow.ToString("o")
    WindowsArchitecture = $env:PROCESSOR_ARCHITECTURE
    Is64BitProcess = [Environment]::Is64BitProcess
    PowerShellVersion = $PSVersionTable.PSVersion.ToString()
    PacPath = $pac.Source
    PacListOutputFile = $pacListPath
    DynamicsRootExists = Test-Path -LiteralPath $dynamicsRoot -PathType Container
    XppConfigRootExists = Test-Path -LiteralPath $configRoot -PathType Container
    Configurations = @($configResults)
    CompilerExecutionRequested = [bool]$ExecuteCompiler
    CompilerExecutions = @($compilerResults)
}

$resultPath = Join-Path $OutputDirectory "windows-xpp-proof.json"
$result | ConvertTo-Json -Depth 8 | Set-Content -Path $resultPath -Encoding UTF8

Write-Info "X++ verification evidence written to:"
Write-Info "  $resultPath"
Write-Info "  $pacListPath"
