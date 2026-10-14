[CmdletBinding()]
param(
    [string]$ProjectDir,
    [ValidateRange(1, 65535)][int]$Port = 7880,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
try {
    if (-not $ProjectDir) {
        if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'scripts\start_workspace.py')) {
            $ProjectDir = $PSScriptRoot
        } else {
            $ProjectDir = 'C:\project\Easel'
        }
    }
    $projectRoot = (Resolve-Path -LiteralPath $ProjectDir -ErrorAction Stop).ProviderPath
    $pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
    $launcherPath = Join-Path $projectRoot 'scripts\start_workspace.py'
    $frontendPath = Join-Path $projectRoot 'web\frontend\dist\index.html'
    foreach ($requiredPath in @($pythonPath, $launcherPath, $frontendPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required project file is missing: $requiredPath. Run the project setup first."
        }
    }
    $dataPath = Join-Path $projectRoot 'data'
    Write-Host 'Easel Quick Start' -ForegroundColor Cyan
    Write-Host "Project: $projectRoot"
    Write-Host "Data:    $dataPath"
    Write-Host "Preferred URL: http://127.0.0.1:$Port/"
    Write-Host 'Reusing an existing workbench, or starting it with your saved configuration.'
    Write-Host 'Cold startup may take several minutes. Keep this window open until a URL is printed.'
    Write-Host "Startup log: $(Join-Path $dataPath 'logs\launch.log')"

    $launchArgs = @($launcherPath, '--root', $projectRoot, '--data-dir', $dataPath,
        '--port', [string]$Port, '--gateway-timeout', '900')
    if ($NoBrowser) { $launchArgs += '--no-browser' }
    Push-Location -LiteralPath $projectRoot
    try {
        & $pythonPath @launchArgs
        $launchExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($launchExit -ne 0) {
        Write-Host "Startup failed. Check $(Join-Path $dataPath 'logs\launch.log') and the gateway logs in $dataPath." -ForegroundColor Red
        exit $launchExit
    }
    Write-Host 'Ready. Services stay running in the background.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ("Unable to start Easel: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
