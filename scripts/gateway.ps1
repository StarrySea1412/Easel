$ErrorActionPreference = 'Stop'
# 不要用 $Profile：它是 PowerShell 的自动变量（当前用户的配置脚本路径），
# 覆写它会遮蔽自动变量，PSScriptAnalyzer 也会直接报警。
$ProfileName = 'easel'
$Root = Split-Path -Parent $PSScriptRoot
$env:EASEL_ROOT = $Root
if (-not $env:EASEL_DATA_DIR) { $env:EASEL_DATA_DIR = $Root }
$StreamLogDir = Join-Path $env:EASEL_DATA_DIR 'logs'
New-Item -ItemType Directory -Path $StreamLogDir -Force | Out-Null
$env:OPENCLAW_RAW_STREAM = '1'
$env:OPENCLAW_RAW_STREAM_PATH = Join-Path $StreamLogDir 'raw-stream.jsonl'
$VenvPython = Join-Path $Root '.venv\Scripts\python.exe'
if (-not $env:EASEL_PYTHON -and (Test-Path -LiteralPath $VenvPython -PathType Leaf)) {
    $env:EASEL_PYTHON = $VenvPython
}
if ($env:EASEL_OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR = $env:EASEL_OPENCLAW_STATE_DIR }
$LogFile = Join-Path $env:EASEL_DATA_DIR 'gateway.log'
$ErrorLogFile = Join-Path $env:EASEL_DATA_DIR 'gateway.error.log'
# The launcher and Web/doctor must resolve exactly the same endpoint. In
# particular, JSON floats/strings are not valid configured ports in Python.
$ResolverPython = $env:EASEL_PYTHON
if (-not $ResolverPython) { $ResolverPython = (Get-Command python -ErrorAction Stop).Source }
$resolvedPort = & $ResolverPython -c "import sys; sys.path.insert(0, sys.argv[1]); from easel.gateway_endpoint import resolve_gateway_port; print(resolve_gateway_port())" $Root
if ($LASTEXITCODE -ne 0 -or @($resolvedPort).Count -ne 1 -or [string]$resolvedPort -notmatch '^\d+$') {
    throw 'Cannot resolve the Easel gateway port; no service was started or stopped.'
}
$Port = 0
if (-not [int]::TryParse([string]$resolvedPort, [ref]$Port) -or $Port -lt 1 -or $Port -gt 65535) {
    throw 'Invalid Easel gateway port; no service was started or stopped.'
}
$env:OPENCLAW_GATEWAY_PORT = "$Port"
$StartupTimeout = 300
if ($env:EASEL_GATEWAY_STARTUP_TIMEOUT) {
    $requestedTimeout = 0
    if (-not [int]::TryParse($env:EASEL_GATEWAY_STARTUP_TIMEOUT, [ref]$requestedTimeout) -or
        $requestedTimeout -lt 30 -or $requestedTimeout -gt 1800) {
        throw 'Gateway startup timeout must be between 30 and 1800 seconds.'
    }
    $StartupTimeout = $requestedTimeout
}

function Test-Gateway {
    try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
    catch { return $false }
}

function Get-GatewayProcess {
    # Match the complete profile argument; easel-other belongs to another user
    # profile and must never be stopped by Easel's restart command.
    $commandPattern = 'openclaw.*(?:^|\s)--profile\s+(?:"{0}"|''{0}''|{0})\s+gateway(?:\s|$)' -f [regex]::Escape($ProfileName)
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -match $commandPattern -and $_.CommandLine -match ('--port\s+' + $Port + '(?:\s|$)') }
}

function Stop-OwnedGatewayTree([int]$ProcessId) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return }
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
        throw 'Unable to stop the owned Gateway process tree.'
    }
}

function Stop-Gateway {
    $process = Get-GatewayProcess
    if ($process) { $process | ForEach-Object { Stop-OwnedGatewayTree $_.ProcessId }; Write-Host '[easel] Gateway stopped' }
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
        Write-Host "[easel] Starting Easel gateway (profile: $ProfileName)..."
        $command = "openclaw --profile $ProfileName gateway run --allow-unconfigured --bind loopback --port $Port"
        Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command', $command `
            -WorkingDirectory $Root -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLogFile -WindowStyle Hidden | Out-Null
        $ready = $false
        $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeout)
        while (-not $ready -and [DateTime]::UtcNow -lt $deadline) {
            if (Test-Gateway) { $ready = $true }
            else { Start-Sleep -Seconds 1 }
        }
        if ($ready) { Write-Host '[easel] Gateway started' }
        else { Write-Error "Gateway 启动失败；请检查 $LogFile 和 $ErrorLogFile"; exit 1 }
    }
    'stop' { Stop-Gateway }
    'restart' { Stop-Gateway; Start-Sleep -Seconds 2; & $PSCommandPath start }
    'status' {
        if (Test-Gateway) { Write-Host "[easel] Gateway running (profile: $ProfileName, port: $Port)" }
        else { Write-Host "[easel] Gateway not running (profile: $ProfileName, port: $Port)" }
    }
    'logs' { Get-Content $LogFile -Wait }
    default { Write-Host 'Usage: gateway.ps1 {start|stop|restart|status|logs}'; exit 1 }
}
