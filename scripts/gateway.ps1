$ErrorActionPreference = 'Stop'
$Profile = 'easel'
$Root = Split-Path -Parent $PSScriptRoot
$env:EASEL_ROOT = $Root
if (-not $env:EASEL_DATA_DIR) { $env:EASEL_DATA_DIR = $Root }
$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
if (-not $env:EASEL_PYTHON -and (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
    $env:EASEL_PYTHON = $VenvPython
}
if ($env:EASEL_OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR = $env:EASEL_OPENCLAW_STATE_DIR }
$LogFile = Join-Path $env:TEMP 'easel-gateway.log'
$ErrorLogFile = Join-Path $env:TEMP 'easel-gateway.error.log'
$ConfigDir = Join-Path $HOME ".openclaw-$Profile"
if ($env:EASEL_OPENCLAW_STATE_DIR) { $ConfigDir = $env:EASEL_OPENCLAW_STATE_DIR }
$Port = 18789

function Test-Gateway {
    try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
    catch { return $false }
}

function Get-GatewayProcess {
    # Match the complete profile argument; easel-other belongs to another user
    # profile and must never be stopped by Easel's restart command.
    $commandPattern = 'openclaw.*(?:^|\s)--profile\s+(?:"{0}"|''{0}''|{0})\s+gateway(?:\s|$)' -f [regex]::Escape($Profile)
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -match $commandPattern } |
        Select-Object -First 1
}

function Stop-Gateway {
    $process = Get-GatewayProcess
    if ($process) { Stop-Process -Id $process.ProcessId -Force; Write-Host '[easel] Gateway stopped' }
    else { Write-Host '[easel] Gateway was not running' }
}

switch ($args[0]) {
    'start' {
        if (Test-Gateway) {
            if (-not (Get-GatewayProcess)) {
                Write-Error "端口 $Port 已被其他服务占用；未找到 Easel profile 的 Gateway，请先处理端口冲突。"
                exit 1
            }
            Write-Host '[easel] Gateway already running'
            break
        }
        New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
        Write-Host "[easel] Starting Easel gateway (profile: $Profile)..."
        $command = "openclaw --profile $Profile gateway run --allow-unconfigured --bind loopback"
        Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command', $command `
            -WorkingDirectory $Root -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLogFile -WindowStyle Hidden | Out-Null
        $ready = $false
        1..20 | ForEach-Object {
            if (-not $ready) {
                if (Test-Gateway) { $ready = $true }
                else { Start-Sleep -Seconds 1 }
            }
        }
        if ($ready) { Write-Host '[easel] Gateway started' }
        else { Write-Error "Gateway 启动失败；请检查 $LogFile 和 $ErrorLogFile"; exit 1 }
    }
    'stop' { Stop-Gateway }
    'restart' { Stop-Gateway; Start-Sleep -Seconds 2; & $PSCommandPath start }
    'status' {
        if (Test-Gateway) { Write-Host "[easel] Gateway running (profile: $Profile)" }
        else { Write-Host '[easel] Gateway not running' }
    }
    'logs' { Get-Content $LogFile -Wait }
    default { Write-Host 'Usage: gateway.ps1 {start|stop|restart|status|logs}'; exit 1 }
}
