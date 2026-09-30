[CmdletBinding()]
param([switch]$InstallOnly, [switch]$NoBrowser, [switch]$NoWinget)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Data = Join-Path $Root 'data'
$env:EASEL_DATA_DIR = $Data
try {
    $Python = Join-Path $Root '.venv\Scripts\python.exe'
    $stateFile = Join-Path $Data 'install-state.json'
    $installed = $false
    if ((Test-Path -LiteralPath $Python) -and (Test-Path -LiteralPath $stateFile)) {
        $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $installed = $state.phases.gateway.status -eq 'ok'
    }
    if ($InstallOnly -or -not $installed) {
        Write-Host 'First setup downloads Python dependencies, OpenClaw and Chromium. Keep this window open.'
        $setupArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'setup.ps1'),'-NonInteractive','-DataDir',$Data)
        if (-not $NoWinget) { $setupArgs += '-AllowWinget' }
        & powershell @setupArgs
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (-not $InstallOnly) {
        $launchArgs = @((Join-Path $Root 'scripts\start_workspace.py'),'--root',$Root,'--data-dir',$Data)
        if ($NoBrowser) { $launchArgs += '--no-browser' }
        & $Python @launchArgs
        exit $LASTEXITCODE
    }
    Write-Host 'Installation complete. Double-click Start-Easel.cmd to open the workbench.'
    exit 0
} catch { Write-Error $_; exit 1 }
