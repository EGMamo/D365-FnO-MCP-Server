[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[0-9a-fA-F-]{36}$")]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[0-9a-fA-F-]{36}$")]
    [string]$ApplicationId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^https://[^/]+/?$")]
    [string]$DataverseEnvironmentUri,

    [Parameter(Mandatory = $true)]
    [ValidatePattern("^\d+\.\d+\.\d+\.\d+$")]
    [string]$AppVersion,

    # systemmetadata is the X++ SDK zip (PackagesLocalDirectory) that 'pac tool xpp install'
    # downloads from the same Dev Tools endpoint.
    [ValidateSet("systemmetadata", "finopsvsix22", "finopsvsix", "crossreference")]
    [string[]]$AssetNames = @("finopsvsix22", "crossreference"),

    [string]$OutputDirectory = "$env:USERPROFILE\Documents\D365SdkProof\UdeAssets",

    [string]$AzCopyPath,

    [Security.SecureString]$ClientSecret,

    [switch]$MetadataOnly,

    # How much the script prints: Error, Warning, Info (default), Verbose or Debug. -Verbose and
    # -Debug also work. A level you set also sets AzCopy's --log-level. No level prints the client
    # secret, a token or a SAS query string.
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
# True only when the caller passed -LogLevel, -Verbose or -Debug, so a default run calls AzCopy
# exactly as before.
$script:LogLevelRequested = $PSBoundParameters.ContainsKey("LogLevel") -or [bool]$PSBoundParameters["Verbose"] -or
    [bool]$PSBoundParameters["Debug"]
$VerbosePreference = if ($script:LogRank -ge 3) { "Continue" } else { "SilentlyContinue" }
# Never "Inquire" (what -Debug sets in Windows PowerShell 5.1): Run Command cannot answer prompts.
$DebugPreference = if ($script:LogRank -ge 4) { "Continue" } else { "SilentlyContinue" }
# Only ever lowered, so -WarningAction, -InformationAction and the caller's preferences still apply
# at Info and above.
if ($script:LogRank -lt 1) { $WarningPreference = "SilentlyContinue" }
if ($script:LogRank -lt 2) { $InformationPreference = "SilentlyContinue" }
# The in-process download's progress bar is Info-level output too.
if ($script:LogRank -lt 2) { $ProgressPreference = "SilentlyContinue" }
# AzCopy's own log lives in the staging folder, which is removed after each download; at Verbose
# and Debug its last lines are shown when AzCopy fails.
$script:AzCopyLogLevel = "ERROR"
if ($script:LogLevelRequested) {
    $script:AzCopyLogLevel = @("ERROR", "WARNING", "INFO", "INFO", "DEBUG")[$script:LogRank]
}
Write-Verbose "Log level $($script:LogLevelName); PowerShell $($PSVersionTable.PSVersion)."

Add-Type -AssemblyName System.Net.Http

# Write-Host ignores the preference variables, so Info-level progress goes through here.
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

function Get-PlainTextSecret {
    param(
        [Parameter(Mandatory = $true)]
        [Security.SecureString]$SecureValue
    )

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Get-RedactedText {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Text
    )

    if ([string]::IsNullOrEmpty($Text)) {
        return $Text
    }
    # Strip query strings from any URL (SAS tokens live there) and any stray
    # SAS signature parameter that appears outside a recognizable URL.
    $redacted = [regex]::Replace($Text, '(https?://[^\s"''?]+)\?[^\s"'']*', '$1?<redacted>')
    return [regex]::Replace($redacted, '(?i)(sig=)[^&\s"'']+', '$1<redacted>')
}

# An asset URL fit for log output: the query string, which holds the SAS, is dropped before the
# text is redacted, so a path the redaction pattern does not recognize cannot expose it.
function Get-DisplayUri {
    param(
        [Parameter(Mandatory = $true)]
        [Uri]$Uri
    )

    return Get-RedactedText -Text $Uri.GetLeftPart([UriPartial]::Path)
}

function Get-FileContentMd5 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $md5 = [Security.Cryptography.MD5]::Create()
    try {
        $stream = [IO.File]::OpenRead($Path)
        try {
            return [Convert]::ToBase64String($md5.ComputeHash($stream))
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $md5.Dispose()
    }
}

function Assert-ContentMd5 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [AllowNull()]
        [AllowEmptyString()]
        [string]$ExpectedContentMd5,

        [Parameter(Mandatory = $true)]
        [string]$AssetName
    )

    # Blob Storage reports Content-MD5 only when the blob has one stored; the
    # length check remains the baseline when it is absent.
    if ([string]::IsNullOrWhiteSpace($ExpectedContentMd5)) {
        return
    }
    $actualContentMd5 = Get-FileContentMd5 -Path $Path
    if ($actualContentMd5 -cne $ExpectedContentMd5) {
        throw "Content-MD5 mismatch for '$AssetName': expected $ExpectedContentMd5, " +
            "got $actualContentMd5."
    }
}

function Get-AssetUri {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AssetName,

        [Parameter(Mandatory = $true)]
        [string]$Version,

        [Parameter(Mandatory = $true)]
        [string]$EnvironmentUri,

        [Parameter(Mandatory = $true)]
        [string]$AccessToken
    )

    $versionPath = $Version.Replace(".", "-")
    $metadataUri = "https://developertools.powerplatform.microsoft.com/api/clientmetadata/" +
        "$([Uri]::EscapeDataString($AssetName))?version=$([Uri]::EscapeDataString($versionPath))"
    $headers = @{
        Accept = "application/json"
        Authorization = "Bearer $AccessToken"
        Correlationid = [guid]::NewGuid().ToString()
        dataverseEnvironmentUri = $EnvironmentUri
        "OData-MaxVersion" = "4.0"
        "OData-Version" = "4.0"
    }

    Write-Debug "GET $metadataUri (correlation id $($headers.Correlationid))"
    # The request carries the access token and the response is the SAS URL, so the cmdlet's own
    # verbose and debug output stays off at every level.
    $response = Invoke-RestMethod -Method Get -Uri $metadataUri -Headers $headers `
        -Verbose:$false -Debug:$false
    $uriText = ([string]$response).Trim().Trim('"')
    $assetUri = $null
    if (-not [Uri]::TryCreate($uriText, [UriKind]::Absolute, [ref]$assetUri)) {
        throw "The Dev Tools service returned an invalid URI for '$AssetName'."
    }
    if ($assetUri.Scheme -ne "https") {
        throw "The Dev Tools service returned a non-HTTPS URI for '$AssetName'."
    }
    if (-not $assetUri.Host.EndsWith(".blob.core.windows.net", [StringComparison]::OrdinalIgnoreCase)) {
        throw "The Dev Tools service returned an unexpected host for '$AssetName'."
    }

    Write-Verbose "$AssetName is at $(Get-DisplayUri -Uri $assetUri)"
    return $assetUri
}

function Get-ResponseFileName {
    param(
        [Parameter(Mandatory = $true)]
        [Net.Http.HttpResponseMessage]$Response,

        [Parameter(Mandatory = $true)]
        [Uri]$AssetUri,

        [Parameter(Mandatory = $true)]
        [string]$AssetName
    )

    $fileName = $null
    if ($null -ne $Response.Content.Headers.ContentDisposition) {
        $fileName = $Response.Content.Headers.ContentDisposition.FileNameStar
        if ([string]::IsNullOrWhiteSpace($fileName)) {
            $fileName = $Response.Content.Headers.ContentDisposition.FileName
        }
    }
    if ([string]::IsNullOrWhiteSpace($fileName)) {
        $fileName = [Uri]::UnescapeDataString([IO.Path]::GetFileName($AssetUri.AbsolutePath))
    }
    if ([string]::IsNullOrWhiteSpace($fileName)) {
        $fileName = $AssetName
    }

    $fileName = $fileName.Trim().Trim('"')
    foreach ($invalidCharacter in [IO.Path]::GetInvalidFileNameChars()) {
        $fileName = $fileName.Replace([string]$invalidCharacter, "_")
    }
    return $fileName
}

function Get-AssetMetadata {
    param(
        [Parameter(Mandatory = $true)]
        [Net.Http.HttpClient]$Client,

        [Parameter(Mandatory = $true)]
        [Uri]$AssetUri,

        [Parameter(Mandatory = $true)]
        [string]$AssetName
    )

    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Head, $AssetUri)
    try {
        $response = $Client.SendAsync(
            $request,
            [Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        try {
            $response.EnsureSuccessStatusCode() | Out-Null
            $contentMd5 = $null
            if ($null -ne $response.Content.Headers.ContentMD5) {
                $contentMd5 = [Convert]::ToBase64String($response.Content.Headers.ContentMD5)
            }
            Write-Debug ("HEAD for {0}: HTTP {1}, {2} bytes, Content-MD5 {3}, type '{4}'" -f
                $AssetName, [int]$response.StatusCode, $response.Content.Headers.ContentLength,
                $(if ($null -eq $contentMd5) { "absent" } else { $contentMd5 }),
                [string]$response.Content.Headers.ContentType)
            return [pscustomobject]@{
                ResourceName = $AssetName
                FileName = Get-ResponseFileName -Response $response -AssetUri $AssetUri `
                    -AssetName $AssetName
                ContentLength = $response.Content.Headers.ContentLength
                ContentMd5 = $contentMd5
                ContentType = [string]$response.Content.Headers.ContentType
                Downloaded = $false
                Reused = $false
                Path = $null
                Sha256 = $null
            }
        }
        finally {
            $response.Dispose()
        }
    }
    finally {
        $request.Dispose()
    }
}

function Save-Asset {
    param(
        [Parameter(Mandatory = $true)]
        [Net.Http.HttpClient]$Client,

        [Parameter(Mandatory = $true)]
        [Uri]$AssetUri,

        [Parameter(Mandatory = $true)]
        [string]$AssetName,

        [Parameter(Mandatory = $true)]
        [string]$DestinationRoot,

        [string]$AzCopyExecutable
    )

    $metadata = Get-AssetMetadata -Client $Client -AssetUri $AssetUri -AssetName $AssetName
    if ($null -eq $metadata.ContentLength -or $metadata.ContentLength -le 0) {
        throw "The service did not report a valid content length for '$AssetName'."
    }

    $assetDirectory = Join-Path $DestinationRoot $AssetName
    New-Item -ItemType Directory -Force -Path $assetDirectory | Out-Null
    $destinationPath = Join-Path $assetDirectory $metadata.FileName

    if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
        $existingLength = (Get-Item -LiteralPath $destinationPath).Length
        if ($existingLength -ne $metadata.ContentLength) {
            throw "Existing file length mismatch for '$AssetName': expected " +
                "$($metadata.ContentLength), got $existingLength."
        }

        Write-Verbose "Reusing $destinationPath ($existingLength bytes, the expected length)."
        Write-Info "Validating existing $AssetName asset..."
        Assert-ContentMd5 -Path $destinationPath -ExpectedContentMd5 $metadata.ContentMd5 `
            -AssetName $AssetName
        $existingHash = (
            Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        Write-Debug "SHA-256 of ${destinationPath}: $existingHash"
        return [pscustomobject]@{
            ResourceName = $AssetName
            FileName = $metadata.FileName
            ContentLength = $existingLength
            ContentMd5 = $metadata.ContentMd5
            ContentType = $metadata.ContentType
            Downloaded = $true
            Reused = $true
            Path = $destinationPath
            Sha256 = $existingHash
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($AzCopyExecutable)) {
        $stagingDirectory = Join-Path $assetDirectory ".azcopy-$PID"
        New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
        $previousLogLocation = $env:AZCOPY_LOG_LOCATION
        $previousPlanLocation = $env:AZCOPY_JOB_PLAN_LOCATION
        $env:AZCOPY_LOG_LOCATION = Join-Path $stagingDirectory "logs"
        $env:AZCOPY_JOB_PLAN_LOCATION = Join-Path $stagingDirectory "plans"

        try {
            Write-Info "Downloading $AssetName with AzCopy..."
            # Limitation: the Dev Tools service hands back a pre-signed SAS URL
            # for a storage account this identity does not own, so AzCopy's
            # environment-based auth (AZCOPY_AUTO_LOGIN_TYPE, managed identity,
            # service principal) does not apply, and AzCopy accepts a SAS only
            # as part of the source URL. The SAS is therefore visible on this
            # child process's command line for the lifetime of the transfer.
            # It is short-lived and never echoed: AzCopy output and its log are
            # captured, redacted before any error message or Verbose/Debug line,
            # and then discarded. Omit AzCopy (no -AzCopyPath and not on PATH)
            # to keep the SAS in-process.
            $azCopyOptions = @(
                "--from-to=BlobLocal", "--overwrite=false", "--check-length=true",
                "--output-type=json", "--output-level=essential",
                "--log-level=$script:AzCopyLogLevel"
            )
            Write-Verbose ("$AzCopyExecutable copy " +
                "$(Get-DisplayUri -Uri $AssetUri)?<SAS not shown> $stagingDirectory " +
                ($azCopyOptions -join " "))
            $azCopyTimer = [Diagnostics.Stopwatch]::StartNew()
            $previousErrorActionPreference = $ErrorActionPreference
            # Windows PowerShell 5.1 turns redirected native stderr into
            # terminating errors under Stop; rely on the exit code instead.
            $ErrorActionPreference = "Continue"
            try {
                $azCopyOutput = & $AzCopyExecutable copy $AssetUri.AbsoluteUri $stagingDirectory `
                    @azCopyOptions 2>&1
                $azCopyExitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            Write-Verbose ("AzCopy exited with code $azCopyExitCode after " +
                "$([int]$azCopyTimer.Elapsed.TotalSeconds)s.")
            if ($script:LogRank -ge 4) {
                foreach ($azCopyLine in @($azCopyOutput)) {
                    Write-Debug ("AzCopy: " + (Get-RedactedText -Text ([string]$azCopyLine)))
                }
            }
            if ($azCopyExitCode -ne 0) {
                if ($script:LogRank -ge 3) {
                    # The log goes with the staging folder, so show how it ends first.
                    $azCopyLogs = @(
                        Get-ChildItem -LiteralPath $env:AZCOPY_LOG_LOCATION -Filter "*.log" -File `
                            -ErrorAction SilentlyContinue
                    )
                    foreach ($azCopyLog in $azCopyLogs) {
                        # Best effort: a log that cannot be read must not hide the AzCopy error.
                        try {
                            $logTail = @(
                                Get-Content -LiteralPath $azCopyLog.FullName -Tail 40
                            ) -join [Environment]::NewLine
                            Write-Verbose ("End of AzCopy log $($azCopyLog.Name):" +
                                [Environment]::NewLine + (Get-RedactedText -Text $logTail))
                        }
                        catch {
                            Write-Verbose ("Could not read AzCopy log $($azCopyLog.Name): " +
                                (Get-RedactedText -Text $_.Exception.Message))
                        }
                    }
                }
                $azCopyTail = (
                    @($azCopyOutput | ForEach-Object { [string]$_ }) |
                        Select-Object -Last 5
                ) -join [Environment]::NewLine
                $azCopyOutput = $null
                throw "AzCopy failed for '$AssetName' with exit code $azCopyExitCode." +
                    [Environment]::NewLine + (Get-RedactedText -Text $azCopyTail)
            }
            $azCopyOutput = $null

            $downloadedFiles = @(
                Get-ChildItem -LiteralPath $stagingDirectory -File -Recurse |
                    Where-Object {
                        $_.FullName -notlike "$($env:AZCOPY_LOG_LOCATION)\*" -and
                        $_.FullName -notlike "$($env:AZCOPY_JOB_PLAN_LOCATION)\*"
                    }
            )
            if ($downloadedFiles.Count -ne 1) {
                throw "AzCopy produced $($downloadedFiles.Count) files for '$AssetName'; expected one."
            }

            $downloadedPath = $downloadedFiles[0].FullName
            $actualLength = $downloadedFiles[0].Length
            if ($null -ne $metadata.ContentLength -and
                $actualLength -ne $metadata.ContentLength) {
                throw "Length mismatch for '$AssetName': expected $($metadata.ContentLength), " +
                    "got $actualLength."
            }
            Assert-ContentMd5 -Path $downloadedPath -ExpectedContentMd5 $metadata.ContentMd5 `
                -AssetName $AssetName
            Move-Item -LiteralPath $downloadedPath -Destination $destinationPath
        }
        finally {
            $env:AZCOPY_LOG_LOCATION = $previousLogLocation
            $env:AZCOPY_JOB_PLAN_LOCATION = $previousPlanLocation
            Remove-Item -LiteralPath $stagingDirectory -Recurse -Force `
                -ErrorAction SilentlyContinue
        }

        $hash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Debug "SHA-256 of ${destinationPath}: $hash"
        return [pscustomobject]@{
            ResourceName = $AssetName
            FileName = $metadata.FileName
            ContentLength = $actualLength
            ContentMd5 = $metadata.ContentMd5
            ContentType = $metadata.ContentType
            Downloaded = $true
            Reused = $false
            Path = $destinationPath
            Sha256 = $hash
        }
    }

    Write-Verbose ("Downloading $AssetName in-process from " +
        "$(Get-DisplayUri -Uri $AssetUri)?<SAS not shown> to $destinationPath")
    $downloadTimer = [Diagnostics.Stopwatch]::StartNew()
    $response = $Client.GetAsync(
        $AssetUri,
        [Net.Http.HttpCompletionOption]::ResponseHeadersRead
    ).GetAwaiter().GetResult()
    try {
        $response.EnsureSuccessStatusCode() | Out-Null
        $partialPath = "$destinationPath.partial-$PID"
        $expectedLength = $metadata.ContentLength
        $expectedContentMd5 = $metadata.ContentMd5
        if ([string]::IsNullOrWhiteSpace($expectedContentMd5) -and
            $null -ne $response.Content.Headers.ContentMD5) {
            $expectedContentMd5 = [Convert]::ToBase64String($response.Content.Headers.ContentMD5)
        }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [IO.File]::Open(
            $partialPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None
        )
        try {
            $buffer = New-Object byte[] (1024 * 1024)
            [long]$downloaded = 0
            while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $outputStream.Write($buffer, 0, $read)
                $downloaded += $read
                if ($null -ne $expectedLength -and $expectedLength -gt 0) {
                    $percent = [Math]::Min(100, [int](100 * $downloaded / $expectedLength))
                    Write-Progress -Activity "Downloading $AssetName" -Status "$percent%" `
                        -PercentComplete $percent
                }
                else {
                    Write-Progress -Activity "Downloading $AssetName" `
                        -Status "$downloaded bytes"
                }
            }
        }
        catch {
            $outputStream.Dispose()
            $inputStream.Dispose()
            Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue
            throw
        }
        finally {
            $outputStream.Dispose()
            $inputStream.Dispose()
            Write-Progress -Activity "Downloading $AssetName" -Completed
        }

        $actualLength = (Get-Item -LiteralPath $partialPath).Length
        if ($null -ne $expectedLength -and $actualLength -ne $expectedLength) {
            Remove-Item -LiteralPath $partialPath -Force
            throw "Length mismatch for '$AssetName': expected $expectedLength, got $actualLength."
        }
        try {
            Assert-ContentMd5 -Path $partialPath -ExpectedContentMd5 $expectedContentMd5 `
                -AssetName $AssetName
        }
        catch {
            Remove-Item -LiteralPath $partialPath -Force -ErrorAction SilentlyContinue
            throw
        }
        Move-Item -LiteralPath $partialPath -Destination $destinationPath
        Write-Verbose ("Downloaded $actualLength bytes of $AssetName in " +
            "$([int]$downloadTimer.Elapsed.TotalSeconds)s.")
        $hash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Debug "SHA-256 of ${destinationPath}: $hash"

        return [pscustomobject]@{
            ResourceName = $AssetName
            FileName = $metadata.FileName
            ContentLength = $actualLength
            ContentMd5 = $expectedContentMd5
            ContentType = $metadata.ContentType
            Downloaded = $true
            Reused = $false
            Path = $destinationPath
            Sha256 = $hash
        }
    }
    finally {
        $response.Dispose()
    }
}

$environmentUri = $DataverseEnvironmentUri.TrimEnd("/") + "/"
Write-Verbose ("Tenant $TenantId, app $ApplicationId, environment $environmentUri, " +
    "version $AppVersion, assets $($AssetNames -join ', '), output $OutputDirectory.")
if ($null -eq $ClientSecret) {
    $ClientSecret = Read-Host "Client secret value" -AsSecureString
}

$plainSecret = Get-PlainTextSecret -SecureValue $ClientSecret
try {
    Write-Verbose "Requesting a client-credentials token from tenant $TenantId for $environmentUri."
    # The body carries the client secret and the response the token, so the cmdlet's own verbose
    # and debug output stays off at every level.
    $tokenResponse = Invoke-RestMethod -Method Post `
        -Uri "https://login.microsoftonline.com/$TenantId/oauth2/token" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body @{
            client_id = $ApplicationId
            client_secret = $plainSecret
            grant_type = "client_credentials"
            resource = $environmentUri
        } `
        -Verbose:$false -Debug:$false
}
finally {
    $plainSecret = $null
    $ClientSecret = $null
}

if ([string]::IsNullOrWhiteSpace([string]$tokenResponse.access_token)) {
    throw "Microsoft Entra ID did not return an access token."
}
$tokenLifetime = $tokenResponse.PSObject.Properties["expires_in"]
if ($null -ne $tokenLifetime) {
    Write-Verbose "Got an access token that expires in $($tokenLifetime.Value)s."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolvedAzCopyPath = $null
if (-not [string]::IsNullOrWhiteSpace($AzCopyPath)) {
    $resolvedAzCopyPath = (Get-Item -LiteralPath $AzCopyPath -ErrorAction Stop).FullName
}
else {
    $azCopyCommand = Get-Command azcopy -CommandType Application -ErrorAction SilentlyContinue
    if ($null -ne $azCopyCommand) {
        $resolvedAzCopyPath = $azCopyCommand.Source
    }
}
if ($null -ne $resolvedAzCopyPath) {
    Write-Info "Using AzCopy: $resolvedAzCopyPath"
}
else {
    Write-Verbose "AzCopy is not on PATH and -AzCopyPath is not set; downloading in-process."
}

$httpClient = [Net.Http.HttpClient]::new()
$httpClient.Timeout = [Threading.Timeout]::InfiniteTimeSpan

try {
    $assetResults = foreach ($assetName in $AssetNames) {
        $assetTimer = [Diagnostics.Stopwatch]::StartNew()
        Write-Info "Resolving $assetName metadata..."
        $assetUri = Get-AssetUri -AssetName $assetName -Version $AppVersion `
            -EnvironmentUri $environmentUri -AccessToken $tokenResponse.access_token
        if ($MetadataOnly) {
            Get-AssetMetadata -Client $httpClient -AssetUri $assetUri -AssetName $assetName
        }
        else {
            Save-Asset -Client $httpClient -AssetUri $assetUri -AssetName $assetName `
                -DestinationRoot $OutputDirectory -AzCopyExecutable $resolvedAzCopyPath
        }
        Write-Verbose "$assetName took $([int]$assetTimer.Elapsed.TotalSeconds)s."
    }
}
finally {
    $tokenResponse = $null
    $httpClient.Dispose()
}

$proof = [pscustomobject]@{
    CapturedAtUtc = [DateTime]::UtcNow.ToString("o")
    DataverseEnvironmentUri = $environmentUri
    AppVersion = $AppVersion
    MetadataOnly = [bool]$MetadataOnly
    Assets = @($assetResults)
}
$proofPath = Join-Path $OutputDirectory "ude-assets-proof.json"
$proof | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $proofPath -Encoding UTF8

Write-Info "UDE asset evidence written to:"
Write-Info "  $proofPath"
