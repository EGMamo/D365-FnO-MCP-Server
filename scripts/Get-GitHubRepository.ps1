<#
.SYNOPSIS
    Prints the owner/name of the GitHub repository this clone's 'origin' remote points at.

.DESCRIPTION
    The Azure scripts use it as their default -GitHubRepository / -Repository, so moving the
    repository to another owner or organization needs no script change: update the remote
    (git remote set-url origin https://github.com/<new-owner>/<name>.git) and rerun them.
#>
#Requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$url = $null
if (Get-Command git -ErrorAction SilentlyContinue) {
    $url = & git -C $PSScriptRoot remote get-url origin 2>$null
    if ($LASTEXITCODE -ne 0) { $url = $null }
}
# https://github.com/owner/name(.git), git@github.com:owner/name(.git) or ssh://git@github.com/owner/name
if ("$url" -match 'github\.com[:/](?<repo>[A-Za-z0-9-]+/[A-Za-z0-9._-]+?)(\.git)?/?$') {
    return $Matches.repo
}
throw "Could not read a GitHub repository from the 'origin' remote ('$url'). Pass it explicitly as owner/name (-GitHubRepository or -Repository)."
