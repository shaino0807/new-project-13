param(
    [string]$DestinationRoot = "$env:USERPROFILE\.codex\skills"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sourceRoot = Join-Path $projectRoot "project-skills"

if (-not (Test-Path -LiteralPath $sourceRoot -PathType Container)) {
    throw "project-skills folder not found: $sourceRoot"
}

New-Item -ItemType Directory -Path $DestinationRoot -Force | Out-Null

Get-ChildItem -LiteralPath $sourceRoot -Directory | ForEach-Object {
    $skillFile = Join-Path $_.FullName "SKILL.md"
    if (-not (Test-Path -LiteralPath $skillFile -PathType Leaf)) {
        Write-Warning "Skipping '$($_.Name)': missing SKILL.md"
        return
    }

    $destination = Join-Path $DestinationRoot $_.Name
    if (Test-Path -LiteralPath $destination) {
        Write-Host "Exists: $destination"
        return
    }

    Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse
    Write-Host "Installed: $($_.Name)"
}
