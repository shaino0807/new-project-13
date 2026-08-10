[CmdletBinding()]
param(
  [ValidateSet('dry-run', 'transport-test', 'deploy')]
  [string]$Mode = 'dry-run',
  [string[]]$Files = @(),
  [switch]$ConfirmChangedFiles,
  [ValidateRange(1, 30)]
  [int]$MaxRuntimeMinutes = 15
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$worker = Join-Path $PSScriptRoot 'appdeploy-safe-deploy.mjs'
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'

if (Test-Path -LiteralPath $bundledNode) {
  $node = $bundledNode
} else {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $node = $nodeCommand.Source
}

if ($Mode -eq 'deploy' -and $Files.Count -eq 0) {
  throw 'Deploy mode requires an explicit -Files list. Unchanged files must not be resent.'
}
if ($Mode -eq 'deploy' -and -not $ConfirmChangedFiles) {
  throw 'Deploy mode requires -ConfirmChangedFiles after verifying the listed files actually changed.'
}

if ($Files.Count -eq 0) {
  $Files = @('index.html', 'backend/index.ts', 'tests/tests.txt')
}

$workerArguments = @(
  '--max-old-space-size=256',
  $worker,
  "--mode=$Mode",
  "--max-runtime-minutes=$MaxRuntimeMinutes"
)
$workerArguments += $Files | ForEach-Object { "--file=$_" }
if ($ConfirmChangedFiles) {
  $workerArguments += '--confirm-changed-files'
}

Push-Location $projectRoot
try {
  & $node @workerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "AppDeploy worker exited with code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
