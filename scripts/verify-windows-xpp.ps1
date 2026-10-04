[CmdletBinding()]
param(
    [string]$OutputDirectory = "$env:USERPROFILE\Documents\D365SdkProof",
    [switch]$ExecuteCompiler
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$pac = Get-Command pac -ErrorAction Stop
$pacListPath = Join-Path $OutputDirectory "pac-tool-xpp-list.txt"
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

$configResults = foreach ($configFile in $configFiles) {
    try {
        $config = Get-Content -LiteralPath $configFile.FullName -Raw | ConvertFrom-Json
        $referencePaths = @($config.ReferencePackagesPaths) |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }

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

    $compilerIndex = 0
    $compilerResults = foreach ($compilerPath in $compilerPaths) {
        $compilerIndex++
        $stdoutPath = Join-Path $OutputDirectory "xppc-$compilerIndex.stdout.txt"
        $stderrPath = Join-Path $OutputDirectory "xppc-$compilerIndex.stderr.txt"

        try {
            $process = Start-Process -FilePath $compilerPath -ArgumentList "/?" -PassThru `
                -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
            $exited = $process.WaitForExit(30000)
            if (-not $exited) {
                $process.Kill()
                $process.WaitForExit()
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

Write-Host "X++ verification evidence written to:"
Write-Host "  $resultPath"
Write-Host "  $pacListPath"
