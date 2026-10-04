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

    [ValidateSet("finopsvsix22", "finopsvsix", "crossreference")]
    [string[]]$AssetNames = @("finopsvsix22", "crossreference"),

    [string]$OutputDirectory = "$env:USERPROFILE\Documents\D365SdkProof\UdeAssets",

    [string]$AzCopyPath,

    [Security.SecureString]$ClientSecret,

    [switch]$MetadataOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.Net.Http

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

    $response = Invoke-RestMethod -Method Get -Uri $metadataUri -Headers $headers
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

        Write-Host "Validating existing $AssetName asset..."
        Assert-ContentMd5 -Path $destinationPath -ExpectedContentMd5 $metadata.ContentMd5 `
            -AssetName $AssetName
        $existingHash = (
            Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
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
            Write-Host "Downloading $AssetName with AzCopy..."
            # Limitation: the Dev Tools service hands back a pre-signed SAS URL
            # for a storage account this identity does not own, so AzCopy's
            # environment-based auth (AZCOPY_AUTO_LOGIN_TYPE, managed identity,
            # service principal) does not apply, and AzCopy accepts a SAS only
            # as part of the source URL. The SAS is therefore visible on this
            # child process's command line for the lifetime of the transfer.
            # It is short-lived and never echoed: AzCopy output is captured,
            # redacted before any error message, and then discarded. Omit
            # AzCopy (no -AzCopyPath and not on PATH) to keep the SAS in-process.
            $previousErrorActionPreference = $ErrorActionPreference
            # Windows PowerShell 5.1 turns redirected native stderr into
            # terminating errors under Stop; rely on the exit code instead.
            $ErrorActionPreference = "Continue"
            try {
                $azCopyOutput = & $AzCopyExecutable copy $AssetUri.AbsoluteUri $stagingDirectory `
                    --from-to=BlobLocal --overwrite=false --check-length=true `
                    --output-type=json --output-level=essential --log-level=ERROR 2>&1
                $azCopyExitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $previousErrorActionPreference
            }
            if ($azCopyExitCode -ne 0) {
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
        $hash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()

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
if ($null -eq $ClientSecret) {
    $ClientSecret = Read-Host "Client secret value" -AsSecureString
}

$plainSecret = Get-PlainTextSecret -SecureValue $ClientSecret
try {
    $tokenResponse = Invoke-RestMethod -Method Post `
        -Uri "https://login.microsoftonline.com/$TenantId/oauth2/token" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body @{
            client_id = $ApplicationId
            client_secret = $plainSecret
            grant_type = "client_credentials"
            resource = $environmentUri
        }
}
finally {
    $plainSecret = $null
    $ClientSecret = $null
}

if ([string]::IsNullOrWhiteSpace([string]$tokenResponse.access_token)) {
    throw "Microsoft Entra ID did not return an access token."
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
    Write-Host "Using AzCopy: $resolvedAzCopyPath"
}

$httpClient = [Net.Http.HttpClient]::new()
$httpClient.Timeout = [Threading.Timeout]::InfiniteTimeSpan

try {
    $assetResults = foreach ($assetName in $AssetNames) {
        Write-Host "Resolving $assetName metadata..."
        $assetUri = Get-AssetUri -AssetName $assetName -Version $AppVersion `
            -EnvironmentUri $environmentUri -AccessToken $tokenResponse.access_token
        if ($MetadataOnly) {
            Get-AssetMetadata -Client $httpClient -AssetUri $assetUri -AssetName $assetName
        }
        else {
            Save-Asset -Client $httpClient -AssetUri $assetUri -AssetName $assetName `
                -DestinationRoot $OutputDirectory -AzCopyExecutable $resolvedAzCopyPath
        }
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

Write-Host "UDE asset evidence written to:"
Write-Host "  $proofPath"
