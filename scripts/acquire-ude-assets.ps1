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
    [string[]]$AssetNames = @("finopsvsix22", "finopsvsix", "crossreference"),

    [string]$OutputDirectory = "$env:USERPROFILE\Documents\D365SdkProof\UdeAssets",

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
        Authorization = "Bearer $AccessToken"
        dataverseEnvironmentUri = $EnvironmentUri
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
            return [pscustomobject]@{
                ResourceName = $AssetName
                FileName = Get-ResponseFileName -Response $response -AssetUri $AssetUri `
                    -AssetName $AssetName
                ContentLength = $response.Content.Headers.ContentLength
                ContentType = [string]$response.Content.Headers.ContentType
                Downloaded = $false
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
        [string]$DestinationRoot
    )

    $response = $Client.GetAsync(
        $AssetUri,
        [Net.Http.HttpCompletionOption]::ResponseHeadersRead
    ).GetAwaiter().GetResult()
    try {
        $response.EnsureSuccessStatusCode() | Out-Null
        $fileName = Get-ResponseFileName -Response $response -AssetUri $AssetUri `
            -AssetName $AssetName
        $assetDirectory = Join-Path $DestinationRoot $AssetName
        New-Item -ItemType Directory -Force -Path $assetDirectory | Out-Null

        $destinationPath = Join-Path $assetDirectory $fileName
        if (Test-Path -LiteralPath $destinationPath) {
            throw "Destination already exists for '$AssetName': $destinationPath"
        }
        $partialPath = "$destinationPath.partial-$PID"
        $expectedLength = $response.Content.Headers.ContentLength
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
        Move-Item -LiteralPath $partialPath -Destination $destinationPath
        $hash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash.ToLowerInvariant()

        return [pscustomobject]@{
            ResourceName = $AssetName
            FileName = $fileName
            ContentLength = $actualLength
            ContentType = [string]$response.Content.Headers.ContentType
            Downloaded = $true
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
        -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
        -ContentType "application/x-www-form-urlencoded" `
        -Body @{
            client_id = $ApplicationId
            client_secret = $plainSecret
            grant_type = "client_credentials"
            scope = "$($environmentUri.TrimEnd('/'))/.default"
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
                -DestinationRoot $OutputDirectory
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
