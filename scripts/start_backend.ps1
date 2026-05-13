param(
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$VenvDir = Join-Path $Root ".venv-win"
$Python = Join-Path $VenvDir "Scripts\python.exe"
$Requirements = Join-Path $Root "requirements.txt"

if (-not (Test-Path $Python)) {
  Write-Host "Creating Windows Python environment at $VenvDir"
  python -m venv $VenvDir
}

if (-not $SkipInstall -and $env:HEIMDALL_SKIP_INSTALL -ne "1") {
  & $Python -m pip install --upgrade pip
  & $Python -m pip install -r $Requirements
}

$env:PYTHONPATH = "$Root"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
if (-not $env:HEIMDALL_API_HOST) { $env:HEIMDALL_API_HOST = "0.0.0.0" }
if (-not $env:HEIMDALL_API_PORT) { $env:HEIMDALL_API_PORT = "5001" }

Set-Location $Root
& $Python "main.py"
