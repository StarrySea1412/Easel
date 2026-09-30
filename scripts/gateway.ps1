$ErrorActionPreference = 'Stop'
$Profile = 'easel'
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
$ConfigDir = Join-Path $HOME ".openclaw-$Profile"
if ($env:EASEL_OPENCLAW_STATE_DIR) { $ConfigDir = $env:EASEL_OPENCLAW_STATE_DIR }
function ConvertTo-GatewayPort([string]$Raw) {
    $value = $Raw.Trim()
    if ($value -match '^\d+$') { $digits = $value }
    elseif ($value -match '^\[[^\]]+\]:(\d+)$') { $digits = $matches[1] }
    elseif ($value -match '^[^:]+:(\d+)$') { $digits = $matches[1] }
    else { return 0 }
    $number = 0
    if ([int]::TryParse($digits, [ref]$number) -and $number -gt 0 -and $number -le 65535) { return $number }
    return 0
}
function Get-ProfilePort([string]$Name) {
    if (-not $Name -or $Name -ieq 'default') { return 18789 }
    [long]$hash = 2166136261
    foreach ($byte in [Text.Encoding]::UTF8.GetBytes($Name)) { $hash = (($hash -bxor $byte) * 16777619) -band 4294967295L }
    return [int](20000 + $hash % 40000)
}
function Get-ConfiguredPort([string]$Directory) {
    try {
        $value = (Get-Content -LiteralPath (Join-Path $Directory 'openclaw.json') -Raw -Encoding UTF8 | ConvertFrom-Json).gateway.port
        if (($value -is [int] -or $value -is [long] -or $value -is [double]) -and $value -eq [Math]::Floor($value) -and $value -gt 0 -and $value -le 65535) { return [int][Math]::Floor($value) }
    } catch { }
    return 0
}
$Port = ConvertTo-GatewayPort $env:OPENCLAW_GATEWAY_PORT
if (-not $Port) { $Port = ConvertTo-GatewayPort $env:EASEL_GATEWAY_PORT }
if (-not $Port) { $Port = Get-ConfiguredPort $ConfigDir }
if (-not $Port) { $Port = Get-ProfilePort $Profile }
$env:OPENCLAW_GATEWAY_PORT = [string]$Port

function Test-Gateway {
    try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
    catch { return $false }
}

function Get-GatewayProcess {
    # Match the complete profile argument; easel-other belongs to another user
    # profile and must never be stopped by Easel's restart command.
    $commandPattern = 'openclaw.*(?:^|\s)--profile\s+(?:"{0}"|''{0}''|{0})\s+gateway(?:\s|$)' -f [regex]::Escape($Profile)
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
        Write-Host "[easel] Starting Easel gateway (profile: $Profile)..."
        $command = "openclaw --profile $Profile gateway run --allow-unconfigured --bind loopback --port $Port"
        Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command', $command `
            -WorkingDirectory $Root -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLogFile -WindowStyle Hidden | Out-Null
        $ready = $false
        $deadline = [DateTime]::UtcNow.AddSeconds(300)
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
        if (Test-Gateway) { Write-Host "[easel] Gateway running (profile: $Profile)" }
        else { Write-Host '[easel] Gateway not running' }
    }
    'logs' { Get-Content $LogFile -Wait }
    default { Write-Host 'Usage: gateway.ps1 {start|stop|restart|status|logs}'; exit 1 }
}
