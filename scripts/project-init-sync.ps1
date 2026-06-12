param(
    [string]$DestinationRoot = "$env:USERPROFILE\.codex\skills",
    [switch]$RestoreSkills
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$requiredDirectories = @(
    "project-skills",
    "scripts"
)

$trackedFiles = @(
    "AGENTS.md",
    "README.md",
    ".gitignore",
    "scripts\restore-skills.ps1"
)

Write-Host "Project init sync"
Write-Host "Root: $projectRoot"
Write-Host ""

Write-Host "Inventory"
foreach ($path in $requiredDirectories) {
    $fullPath = Join-Path $projectRoot $path
    if (Test-Path -LiteralPath $fullPath -PathType Container) {
        Write-Host "Exists directory: $path"
    } else {
        Write-Host "Missing directory: $path"
    }
}

foreach ($path in $trackedFiles) {
    $fullPath = Join-Path $projectRoot $path
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        Write-Host "Exists file: $path"
    } else {
        Write-Host "Missing file: $path"
    }
}

Write-Host ""
Write-Host "Adding missing directories"
foreach ($path in $requiredDirectories) {
    $fullPath = Join-Path $projectRoot $path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
        Write-Host "Created directory: $path"
    }
}

$restoreScript = Join-Path $projectRoot "scripts\restore-skills.ps1"
if ($RestoreSkills) {
    if (-not (Test-Path -LiteralPath $restoreScript -PathType Leaf)) {
        throw "Cannot restore skills because scripts\restore-skills.ps1 is missing."
    }

    Write-Host ""
    Write-Host "Restoring project skills"
    & $restoreScript -DestinationRoot $DestinationRoot
} else {
    Write-Host ""
    Write-Host "Skill restore skipped. Run with -RestoreSkills to install missing project skills."
}

Write-Host ""
Write-Host "Project init sync complete."
