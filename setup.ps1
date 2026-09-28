# UTF-8 BOM is required by Windows PowerShell 5.1.
[CmdletBinding()]
param(
    [ValidateSet('', 'system', 'openclaw', 'pydeps', 'frontend', 'chromium', 'profile', 'skills', 'gateway')]
    [string]$Phase = '',
    [switch]$NonInteractive,
    [switch]$AllowWinget,
    [string]$DataDir = $env:EASEL_DATA_DIR
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
if (-not $DataDir) { $DataDir = $Root }
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
$env:EASEL_DATA_DIR = $DataDir
$env:EASEL_ROOT = $Root
if ($env:EASEL_OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR = $env:EASEL_OPENCLAW_STATE_DIR }
$env:PYTHONUTF8 = '1'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$Venv = Join-Path $Root '.venv'
$Python = Join-Path $Venv 'Scripts\python.exe'
$Manifest = $null
$manifestPath = Join-Path $Root 'release-manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
    $Manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($Manifest.schemaVersion -ne 1 -or -not $Manifest.dependencies.openclaw -or -not $Manifest.dependencies.pythonLock) {
        throw '发行包 release-manifest.json 缺少锁定依赖信息。'
    }
}
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

function Save-SystemBootstrap($Status, $Detail) {
    # This path must work before Python exists. Keep the same identity/state schema
    # as install_core and write UTF-8 without BOM for Python json.loads.
    $version = if ($Manifest) { [string]$Manifest.version } else {
        $project = Get-Content -LiteralPath (Join-Path $Root 'pyproject.toml') -Raw
        if ($project -match '(?m)^version\s*=\s*"([^"]+)"') { 'source-' + $matches[1] } else { 'source-unknown' }
    }
    $stateFile = Join-Path $DataDir 'install-state.json'
    $logDir = Join-Path $DataDir 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $logFile = Join-Path $logDir 'install.log'
    $state = $null
    try {
        if (Test-Path -LiteralPath $stateFile) { $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    } catch { $state = $null }
    if (-not $state -or $state.version -ne 1 -or $state.installation.root -ne $Root.ToLowerInvariant() -or $state.installation.version -ne $version -or -not $state.phases) {
        $state = [pscustomobject]@{ version=1; installation=@{ root=$Root.ToLowerInvariant(); version=$version }; phases=[pscustomobject]@{} }
    }
    if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
        foreach ($dependent in @('pydeps', 'chromium', 'gateway')) { $state.phases.PSObject.Properties.Remove($dependent) }
    }
    $attempts = 0
    if ($state.phases.system -and $state.phases.system.attempts -match '^\d+$') { $attempts = [int]$state.phases.system.attempts }
    if ($Status -ne 'running') { $attempts += 1 }
    $result = @{ status=$Status; lastRun=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); attempts=$attempts; detail=$Detail }
    $state.phases | Add-Member -NotePropertyName system -NotePropertyValue $result -Force
    $state | Add-Member -NotePropertyName logPath -NotePropertyValue $logFile -Force
    $encoding = New-Object System.Text.UTF8Encoding $false
    $temporary = $stateFile + '.tmp'
    [System.IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json -Depth 30), $encoding)
    Move-Item -LiteralPath $temporary -Destination $stateFile -Force
    [System.IO.File]::AppendAllText($logFile, "[system] $Status $Detail`n", $encoding)
}

function Info($Message) { Write-Host "[easel] $Message" -ForegroundColor Cyan }
function Ok($Message) { Write-Host "  [OK] $Message" -ForegroundColor Green }
function Fail($Message) { throw $Message }
function Require-Command($Name, $Hint) { if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "$Name 未找到。$Hint" } }
function Ensure-Command($Name, $PackageId, $Hint) {
    if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
    if (-not $AllowWinget) { Fail "$Name 未找到。$Hint 使用 -AllowWinget 显式允许安装系统依赖后可重试。" }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail "$Name 未找到。$Hint`n也可以先安装 Windows App Installer（winget）后重试。" }
    Info "未找到 $Name，使用 winget 安装 $PackageId..."
    & winget install --id $PackageId --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Fail "$Name 自动安装失败。$Hint" }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    Require-Command $Name $Hint
}
function Read-EnvFile($Path) {
    $values = @{}
    if (Test-Path $Path) { Get-Content $Path | ForEach-Object { if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { $values[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'") } } }
    return $values
}
function Read-Secret($Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    return [System.Net.NetworkCredential]::new('', $secure).Password
}
function OpenClaw-Config($Key, $Value, [switch]$Json) {
    $ErrorActionPreference = 'Continue'
    $arguments = @('--profile','easel','config','set',$Key,$Value)
    if ($Json) { $arguments += '--strict-json' }
    & openclaw @arguments 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "OpenClaw 配置失败：$Key" }
}
# 尽力而为版：写入失败不 Fail，只返回是否成功，用于探测不同 OpenClaw 版本接受哪套配置 key。
function Try-OpenClawConfig($Key, $Value, [switch]$Json) {
    $ErrorActionPreference = 'Continue'
    $arguments = @('--profile','easel','config','set',$Key,$Value)
    if ($Json) { $arguments += '--strict-json' }
    & openclaw @arguments 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}
# JSON 值的配置写入。Windows PowerShell 5.1（系统自带版本）向原生程序传参时会剥掉字符串里的
# 双引号：任何含 JSON 的 config set 都会变成裸键值、--strict-json 解析失败（见 issue #41）。
# 这里改走 --batch-file：argv 里只出现临时文件路径（无引号字符），JSON 从文件读，5.1/7 行为一致。
function OpenClaw-ConfigBatch($Operations) {
    $ErrorActionPreference = 'Continue'
    $batchPath = Join-Path ([System.IO.Path]::GetTempPath()) "easel-config-set-$(Get-Random).json"
    try {
        [System.IO.File]::WriteAllText($batchPath, (ConvertTo-Json -InputObject $Operations -Depth 40 -Compress))
        & openclaw --profile easel config set --batch-file $batchPath 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        # 老版本 openclaw 不认 --batch-file：退回逐条写入（PS7 可用；Windows PS5.1 下请升级 openclaw）
        Write-Warning '当前 OpenClaw 不支持 --batch-file，退回逐条写入；建议 npm i -g openclaw@latest 升级。'
        foreach ($op in $Operations) {
            OpenClaw-Config $op.path (ConvertTo-Json -InputObject $op.value -Depth 40 -Compress) -Json
        }
    } finally { Remove-Item $batchPath -Force -ErrorAction SilentlyContinue }
}
# 原子写入 anthropic provider。部分 OpenClaw 版本（如 2026.3.x）的 schema 要求 provider 一次性带齐
# baseUrl + models，逐字段 config set 会因中间态缺字段而整体校验失败（baseUrl/models: received undefined）。
# 用 venv Python 生成 JSON，避开 ConvertTo-Json 对空数组的序列化坑；整块替换也会顺带清掉旧的残留 header。
function Write-AnthropicProvider($BaseUrl, $ApiKey, $ApiKeyHeader, $AnthropicVersion, $Provider = 'anthropic', $Model = '') {
    $env:A_BASE_URL = $BaseUrl
    $env:A_API_KEY = $ApiKey
    $env:A_HDR = $ApiKeyHeader
    $env:A_VER = $AnthropicVersion
    $env:A_MODEL = $Model
    $seed = @'
import json, os
p = {"baseUrl": os.environ["A_BASE_URL"], "apiKey": os.environ["A_API_KEY"], "api": "anthropic-messages", "models": []}
if os.environ.get("A_MODEL"):
    p["models"] = [{"id": os.environ["A_MODEL"], "name": os.environ["A_MODEL"], "input": ["text", "image"]}]
hdr = os.environ.get("A_HDR"); ver = os.environ.get("A_VER")
if hdr or ver:
    h = {}
    if hdr: h[hdr] = os.environ["A_API_KEY"]
    if ver: h["anthropic-version"] = ver
    p["headers"] = h
print(json.dumps(p))
'@ | & $Python -
    Remove-Item Env:A_BASE_URL, Env:A_API_KEY, Env:A_HDR, Env:A_VER, Env:A_MODEL -ErrorAction SilentlyContinue
    OpenClaw-ConfigBatch @(@{ path = "models.providers.$Provider"; value = ($seed | ConvertFrom-Json) })
}

function Resolve-SetupModel($Values, $Key, $Provider) {
    $model = ([string]$Values[$Key]).Trim()
    if (-not $model) {
        $legacy = ([string]$Values['CLAUDE_MODEL']).Trim()
        if ($legacy -notmatch '/') { $model = $legacy }
        elseif ($legacy.StartsWith($Provider + '/')) { $model = $legacy.Substring($Provider.Length + 1) }
        elseif ($Key -eq 'EASEL_LLM_MODEL' -and $legacy.StartsWith('anthropic/')) { $model = $legacy.Substring(10) }
    }
    if ($model.StartsWith($Provider + '/')) { $model = $model.Substring($Provider.Length + 1) }
    if (-not $model) { $model = 'claude-sonnet-4-6' }
    return $model
}

function Invoke-system {

Info '检查系统环境...'
Ensure-Command 'git' 'Git.Git' '请安装 Git for Windows 并加入 PATH。'
Ensure-Command 'node' 'OpenJS.NodeJS.LTS' '请安装 Node.js 24.16+ 并加入 PATH。'
Ensure-Command 'npm' 'OpenJS.NodeJS.LTS' '请安装 Node.js 24.16+ 并加入 PATH。'
Ensure-Command 'ffmpeg' 'Gyan.FFmpeg' '请安装 FFmpeg 并加入 PATH。'
$nodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^(\d+)\.(\d+)\.') { Fail '无法读取 Node.js 版本。' }
$major = [int]$matches[1]; $minor = [int]$matches[2]
if (-not (($major -eq 24 -and $minor -ge 16) -or ($major -eq 26 -and $minor -ge 1) -or $major -ge 27)) {
    Fail 'Node.js 版本不兼容：需要 24.16+（24.x）或 26.1+；请手动更新后重试。'
}
$pythonCommand = $null
$pythonArgs = @()
$versionCheck = if ($Manifest) { 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' } else { 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' }
# Prefer py for release Python 3.12; ignore the non-working Microsoft Store alias.
$candidates = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
    $selector = if ($Manifest) { '-3.12' } else { '-3' }
    $candidates += @{ command = (Get-Command py).Source; arguments = @($selector) }
}
if (Get-Command python -ErrorAction SilentlyContinue) { $candidates += @{ command = (Get-Command python).Source; arguments = @() } }
if (Get-Command py -ErrorAction SilentlyContinue) {
    $registered = & py -0p
    foreach ($entry in $registered) {
        if ($entry -match '([A-Za-z]:\\.*python(?:\d+(?:\.\d+)?)?\.exe)\s*$') {
            $registeredPython = $matches[1].Trim()
            if (Test-Path -LiteralPath $registeredPython) { $candidates += @{ command=$registeredPython; arguments=@() } }
        }
    }
}

foreach ($candidate in $candidates) {
    $candidateArgs = $candidate.arguments
    & $candidate.command @candidateArgs -c $versionCheck
    if ($LASTEXITCODE -eq 0) { $pythonCommand = $candidate.command; $pythonArgs = $candidateArgs; break }
}
if (-not $pythonCommand) {
    if (-not $AllowWinget) { Fail '没有符合要求的 Python（发行版需要 3.12，源码需要 3.10+）；手动安装或用 -AllowWinget 重试。' }
    Require-Command 'winget' '请安装 Windows App Installer。'
    & winget install --id Python.Python.3.12 --exact --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Fail 'Python 3.12 安装失败。' }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if (Get-Command py -ErrorAction SilentlyContinue) { $pythonCommand = (Get-Command py).Source; $pythonArgs = @('-3.12') }
    elseif (Get-Command python -ErrorAction SilentlyContinue) { $pythonCommand = (Get-Command python).Source; $pythonArgs = @() }
    else { Fail 'Python 已安装，但当前环境未找到；重新运行安装器。' }
}
& $pythonCommand @pythonArgs -c $versionCheck
if ($LASTEXITCODE -ne 0) { Fail 'Python 版本不兼容。' }
if (-not (Test-Path -LiteralPath $Python)) {
    Info '创建 Python 虚拟环境...'
    & $pythonCommand @pythonArgs -m venv $Venv
    if ($LASTEXITCODE -ne 0) { Fail 'Python venv 创建失败。' }
}
& $Python -c $versionCheck
if ($LASTEXITCODE -ne 0) { Fail '已有虚拟环境 Python 版本不兼容；请为本版本使用新的安装目录。' }
Ok '系统环境检查完成'

}

function Invoke-openclaw {

Info '安装 OpenClaw...'
$wantedVersion = if ($Manifest) { [string]$Manifest.dependencies.openclaw } else { 'latest' }
if ($Manifest -and $wantedVersion -notmatch '^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$') { Fail '发行包 OpenClaw 版本没有精确锁定。' }
if (Get-Command openclaw -ErrorAction SilentlyContinue) {
    $installedVersion = (& openclaw --version | Out-String)
    if ($LASTEXITCODE -ne 0) { Fail '已有 OpenClaw 无法运行。' }
    if ($Manifest -and ($installedVersion -notmatch '(?<!\d)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)' -or $matches[1] -ne $wantedVersion)) {
        Fail "OpenClaw 版本不兼容：此发行版要求 $wantedVersion，请手动确认更新已有全局安装后重试。"
    }
} else {
    & npm install -g "openclaw@$wantedVersion" --loglevel warn
    if ($LASTEXITCODE -ne 0) { Fail 'OpenClaw 安装失败。' }
}
Require-Command 'openclaw' '请确认 npm 全局 bin 已加入 PATH。'
& openclaw --version
if ($LASTEXITCODE -ne 0) { Fail 'OpenClaw 安装后验证失败。' }

}

function Invoke-pydeps {

Info '安装 Easel Python 依赖...'
if ($Manifest) {
    $lockPath = [System.IO.Path]::GetFullPath((Join-Path $Root ([string]$Manifest.dependencies.pythonLock)))
    if (-not $lockPath.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { Fail '发行包 Python 锁文件缺失或路径无效。' }
    & $Python -m pip install -r $lockPath --progress-bar on
    if ($LASTEXITCODE -ne 0) { Fail '锁定的 Python 依赖安装失败。' }
    & $Python -m pip install --no-deps --no-build-isolation -e $Root --progress-bar on
} else {
    & $Python -m pip install -e $Root --progress-bar on
}
if ($LASTEXITCODE -ne 0) { Fail 'Easel Python 依赖安装失败。' }
& $Python -m pip check
if ($LASTEXITCODE -ne 0) { Fail 'Python 依赖版本不兼容。' }

}

function Invoke-frontend {

Info '准备 Web 前端...'
$Frontend = Join-Path $Root 'web\frontend'
if ($Manifest -and (Test-Path -LiteralPath (Join-Path $Frontend 'dist\index.html'))) { Ok '使用发行包预构建前端'; return }
if (-not (Test-Path -LiteralPath (Join-Path $Frontend 'package-lock.json'))) { Fail 'Web 前端缺少 package-lock.json。' }
Push-Location -LiteralPath $Frontend
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { Fail 'Web 前端依赖安装失败。' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { Fail 'Web 前端构建失败。' }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath (Join-Path $Frontend 'dist\index.html'))) { Fail 'Web 前端构建没有产出 index.html。' }

}

function Invoke-chromium {

Info '安装 Playwright Chromium...'
& $Python -m playwright install chromium
if ($LASTEXITCODE -ne 0) { Fail 'Playwright Chromium 安装失败。' }

}

function Invoke-profile {
    $envPath = Join-Path $DataDir '.env'
    if (-not (Test-Path -LiteralPath $envPath)) { Copy-Item -LiteralPath (Join-Path $Root '.env.example') -Destination $envPath }
    $profileDir = if ($env:EASEL_OPENCLAW_STATE_DIR) { $env:EASEL_OPENCLAW_STATE_DIR } else { Join-Path $HOME '.openclaw-easel' }
    $configPath = Join-Path $profileDir 'openclaw.json'
    $previousConfigPath = $env:OPENCLAW_CONFIG_PATH
    try {
        if (Test-Path -LiteralPath $configPath) {
            $env:OPENCLAW_CONFIG_PATH = $configPath
            Info '保留已有 OpenClaw profile；模型配置请在 Web 设置中修改。'
            & openclaw --profile easel config validate
            if ($LASTEXITCODE -ne 0) { Fail '已有 OpenClaw 配置无效，请修复后继续；安装器不会覆盖它。' }
            return
        }
        # Publish a new config only once all writes/validation have succeeded.
        # A crash leaves only our pending file; the next run repeats initialization.
        # OPENCLAW_CONFIG_PATH is the OpenClaw-supported explicit config override.
        New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
        $pendingConfig = Join-Path $profileDir 'openclaw.easel-install-pending.json'
        $env:OPENCLAW_CONFIG_PATH = $pendingConfig
        Invoke-profile-content
        if (-not (Test-Path -LiteralPath $pendingConfig)) { Fail 'OpenClaw 未生成待提交配置。' }
        # File.Move deliberately fails if another process created the final file.
        [System.IO.File]::Move($pendingConfig, $configPath)
    } finally {
        if ($null -eq $previousConfigPath) { Remove-Item Env:OPENCLAW_CONFIG_PATH -ErrorAction SilentlyContinue }
        else { $env:OPENCLAW_CONFIG_PATH = $previousConfigPath }
    }
}

function Invoke-profile-content {
Info '准备 Easel OpenClaw profile...'
$onboardHelp = (& openclaw onboard --help | Out-String)
if ($LASTEXITCODE -ne 0) { Fail '无法读取 OpenClaw 初始化选项。' }
$onboardArgs = @('--profile','easel','onboard','--non-interactive','--mode','local','--accept-risk')
foreach ($flag in @('--skip-health','--skip-channels','--skip-skills','--skip-ui','--skip-hooks','--skip-search','--skip-daemon')) {
    if ($onboardHelp -match [regex]::Escape($flag)) { $onboardArgs += $flag }
}
if ($onboardHelp -match '--no-install-daemon' -and $onboardHelp -notmatch '--skip-daemon') { $onboardArgs += '--no-install-daemon' }
& openclaw @onboardArgs | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'OpenClaw profile 初始化失败，请检查上方输出。' }

$envPath = Join-Path $DataDir '.env'
if (-not (Test-Path $envPath)) { Copy-Item (Join-Path $Root '.env.example') $envPath }
$envValues = Read-EnvFile $envPath
function Is-UsableKey($Value) { return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -notmatch 'REPLACE_ME|your[-_ ]?api[-_ ]?key' }
if (-not $NonInteractive -and -not (Is-UsableKey $envValues['ANTHROPIC_API_KEY']) -and -not (Is-UsableKey $envValues['OPENAI_API_KEY']) -and -not (Is-UsableKey $envValues['ANTHROPIC_AUTH_TOKEN']) -and -not (Is-UsableKey $envValues['EASEL_LLM_API_KEY']) -and -not (Is-UsableKey $envValues['OPENAI_MAAS_API_KEY'])) {
    $choice = Read-Host '模型服务：1 Anthropic / 2 OpenAI-compatible / 0 稍后配置 [1]'
    if ($choice -eq '2') { $key = Read-Secret 'OpenAI API Key（不会回显）'; $url = Read-Host 'Base URL [https://api.openai.com/v1]'; $model = Read-Host '模型 [gpt-4o]'; Add-Content $envPath "`nOPENAI_API_KEY=$key`nOPENAI_BASE_URL=$url`nOPENAI_MODEL=$model" }
    elseif ($choice -eq '1' -or [string]::IsNullOrWhiteSpace($choice)) { $key = Read-Secret 'Anthropic API Key（不会回显）'; $model = Read-Host '模型 [anthropic/claude-sonnet-4-6]'; Add-Content $envPath "`nANTHROPIC_API_KEY=$key`nCLAUDE_MODEL=$model" }
}
$envValues = Read-EnvFile $envPath

# 仅当真正写了 anthropic provider 时，才补设它的 provider 级超时（见文末 timeoutSeconds）；
# 否则会给 OpenAI/MAAS 用户凭空造出一个只有 timeoutSeconds、缺 baseUrl/models 的残缺 anthropic provider。
$anthropicSynced = $false
$syncedProvider = 'anthropic'
# 注意函数调用外面这对括号不能省：`if (Is-UsableKey $x -and $y)` 会让解析器进入命令模式，
# 把 `-and` 当成 Is-UsableKey 的参数名（简单函数会把它静默吞进 $args），
# 于是 ContainsKey 那半边守卫被丢掉且不报错。加括号才让 -and 回到运算符语义。
if ((Is-UsableKey $envValues['OPENAI_MAAS_API_KEY']) -and $envValues.ContainsKey('OPENAI_MAAS_ENDPOINT')) {
    $model = if ($envValues.ContainsKey('OPENAI_MAAS_MODEL')) { $envValues['OPENAI_MAAS_MODEL'] } else { 'gpt-5.5' }
    $port = if ($envValues.ContainsKey('OPENAI_MAAS_ADAPTER_PORT')) { $envValues['OPENAI_MAAS_ADAPTER_PORT'] } else { '18791' }
    $adapter = Join-Path $Root 'scripts\openai_maas_adapter.py'
    $provider = @{ baseUrl = "http://127.0.0.1:$port/v1"; api = 'openai-completions'; apiKey = 'local-adapter'; timeoutSeconds = 600; request = @{ allowPrivateNetwork = $true }; models = @(@{ id = $model; name = 'OpenAI-compatible model'; reasoning = $true; input = @('text') }); localService = @{ command = $Python; args = @($adapter, '--port', $port); cwd = $Root; healthUrl = "http://127.0.0.1:$port/health"; idleStopMs = 0; env = @{ OPENAI_MAAS_API_KEY = $envValues['OPENAI_MAAS_API_KEY']; OPENAI_MAAS_ENDPOINT = $envValues['OPENAI_MAAS_ENDPOINT']; OPENAI_MAAS_MODEL = $model; OPENAI_MAAS_API_KEY_HEADER = if ($envValues.ContainsKey('OPENAI_MAAS_API_KEY_HEADER')) { $envValues['OPENAI_MAAS_API_KEY_HEADER'] } else { 'Authorization' } } } }
    OpenClaw-ConfigBatch @(@{ path = 'models.providers.rednote-openai'; value = $provider })
    OpenClaw-Config 'agents.defaults.model.primary' "rednote-openai/$model"
} elseif (Is-UsableKey $envValues['OPENAI_API_KEY']) {
    $model = if ($envValues.ContainsKey('OPENAI_MODEL')) { $envValues['OPENAI_MODEL'] } else { 'gpt-4o' }
    OpenClaw-ConfigBatch @(
        @{ path = 'models.providers.openai.api'; value = 'openai-completions' },
        @{ path = 'models.providers.openai.apiKey'; value = $envValues['OPENAI_API_KEY'] },
        @{ path = 'models.providers.openai.baseUrl'; value = $(if ($envValues.ContainsKey('OPENAI_BASE_URL')) { $envValues['OPENAI_BASE_URL'] } else { 'https://api.openai.com/v1' }) },
        @{ path = 'models.providers.openai.models'; value = @(@{ id = $model; name = 'OpenAI model'; reasoning = $true; input = @('text', 'image') }) },
        @{ path = 'agents.defaults.model.primary'; value = "openai/$model" }
    )
} elseif ((Is-UsableKey $envValues['EASEL_LLM_API_KEY']) -and $envValues.ContainsKey('EASEL_LLM_BASE_URL')) {
    # 原子写入整块 provider（含 header 与 anthropic-version）；整块替换会顺带清掉旧的专用 header。
    $hdr = if ($envValues.ContainsKey('EASEL_LLM_API_KEY_HEADER')) { $envValues['EASEL_LLM_API_KEY_HEADER'] } else { 'api-key' }
    $ver = if ($envValues.ContainsKey('EASEL_LLM_ANTHROPIC_VERSION')) { $envValues['EASEL_LLM_ANTHROPIC_VERSION'] } else { '2023-06-01' }
    $syncedProvider = if ([string]::IsNullOrWhiteSpace($envValues['EASEL_LLM_MODEL'])) { 'anthropic' } else { 'relay' }
    $model = Resolve-SetupModel $envValues 'EASEL_LLM_MODEL' $syncedProvider
    Write-AnthropicProvider $envValues['EASEL_LLM_BASE_URL'] $envValues['EASEL_LLM_API_KEY'] $hdr $ver $syncedProvider $model
    $anthropicSynced = $true
    OpenClaw-Config 'agents.defaults.model.primary' "$syncedProvider/$model"
} elseif ((Is-UsableKey $envValues['ANTHROPIC_AUTH_TOKEN']) -and $envValues.ContainsKey('ANTHROPIC_BASE_URL')) {
    $model = Resolve-SetupModel $envValues 'ANTHROPIC_MODEL' 'anthropic'
    Write-AnthropicProvider $envValues['ANTHROPIC_BASE_URL'] $envValues['ANTHROPIC_AUTH_TOKEN'] '' '' 'anthropic' $model
    $anthropicSynced = $true
    OpenClaw-Config 'agents.defaults.model.primary' "anthropic/$model"
} elseif (Is-UsableKey $envValues['ANTHROPIC_API_KEY']) {
    # 官方 ANTHROPIC_API_KEY 可搭配 ANTHROPIC_BASE_URL 指向自定义代理/网关；未指定时显式指向官方端点，
    # 否则请求会发往默认的 api.anthropic.com，代理网络下会直接超时。provider 由 Write-AnthropicProvider 原子写入，
    # 避免逐字段写入时 baseUrl/models 缺失导致 2026.3.x 报 expected string/array, received undefined。
    $baseUrl = if (-not [string]::IsNullOrWhiteSpace($envValues['ANTHROPIC_BASE_URL'])) { $envValues['ANTHROPIC_BASE_URL'] } else { 'https://api.anthropic.com' }
    $model = Resolve-SetupModel $envValues 'ANTHROPIC_MODEL' 'anthropic'
    Write-AnthropicProvider $baseUrl $envValues['ANTHROPIC_API_KEY'] '' '' 'anthropic' $model
    $anthropicSynced = $true
    OpenClaw-Config 'agents.defaults.model.primary' "anthropic/$model"
}
$embeddingKeyNames = @('EASEL_EMBEDDING_API_KEY', 'EASEL_EMBEDDINGS_API_KEY', 'OPENAI_EMBEDDING_API_KEY', 'EMBEDDING_API_KEY', 'EMBEDDINGS_API_KEY')
$embeddingUrlNames = @('EASEL_EMBEDDING_BASE_URL', 'EASEL_EMBEDDINGS_BASE_URL', 'OPENAI_EMBEDDING_BASE_URL', 'EMBEDDING_BASE_URL', 'EMBEDDINGS_BASE_URL')
$embeddingModelNames = @('EASEL_EMBEDDING_MODEL', 'EASEL_EMBEDDINGS_MODEL', 'OPENAI_EMBEDDING_MODEL', 'EMBEDDING_MODEL', 'EMBEDDINGS_MODEL')
$embeddingKey = $embeddingKeyNames | Where-Object { Is-UsableKey $envValues[$_] } | Select-Object -First 1
$embeddingUrl = $embeddingUrlNames | Where-Object { -not [string]::IsNullOrWhiteSpace($envValues[$_]) } | Select-Object -First 1
$embeddingModel = $embeddingModelNames | Where-Object { -not [string]::IsNullOrWhiteSpace($envValues[$_]) } | Select-Object -First 1
if ($embeddingKey -and $embeddingUrl -and $embeddingModel) {
    # 记忆检索 schema 位置随 OpenClaw 版本变化：2026.9.x 起在顶层 memory.search.*，之前在 agents.defaults.memorySearch.*。
    # 两者互斥，用「先试新 key、失败再退老 key」自适应：第一条写入既是真实配置也是版本探测。
    if (Try-OpenClawConfig 'memory.search.provider' 'openai-compatible') {
        OpenClaw-Config 'memory.search.enabled' 'true' -Json; OpenClaw-Config 'memory.search.model' $envValues[$embeddingModel]; OpenClaw-Config 'memory.search.remote.baseUrl' $envValues[$embeddingUrl]; OpenClaw-Config 'memory.search.remote.apiKey' $envValues[$embeddingKey]
        Ok "独立向量模型已配置（memory.search）：$($envValues[$embeddingModel])"
    } else {
        OpenClaw-Config 'agents.defaults.memorySearch.provider' 'openai-compatible'; OpenClaw-Config 'agents.defaults.memorySearch.model' $envValues[$embeddingModel]; OpenClaw-Config 'agents.defaults.memorySearch.remote.baseUrl' $envValues[$embeddingUrl]; OpenClaw-Config 'agents.defaults.memorySearch.remote.apiKey' $envValues[$embeddingKey]
        Ok "独立向量模型已配置（memorySearch）：$($envValues[$embeddingModel])"
    }
} else {
    # 新 schema 用 memory.search.enabled=false 关闭向量检索；老 schema 用 provider=none。
    if (-not (Try-OpenClawConfig 'memory.search.enabled' 'false' -Json)) {
        OpenClaw-Config 'agents.defaults.memorySearch.provider' 'none'
    }
    if (($embeddingKeyNames + $embeddingUrlNames + $embeddingModelNames | Where-Object { $envValues.ContainsKey($_) }).Count -gt 0) { Write-Warning '向量 API 配置不完整，已关闭向量检索；需要同时设置向量 API key、Base URL 和模型名' } else { Info '未配置独立向量 API，使用关键词记忆检索' }
}
OpenClaw-Config 'agents.defaults.timeoutSeconds' '7200'; OpenClaw-Config 'gateway.mode' 'local'; OpenClaw-Config 'gateway.bind' 'loopback'; OpenClaw-Config 'gateway.auth.mode' 'none'
# 对话直连常驻网关（web/app.py 的 http 传输层）要用 OpenAI 兼容端点，而 openclaw 默认不挂这条
# 路由（chatCompletions.enabled 默认 false），不开则 POST /v1/chat/completions 一律 404、只能
# 退回每轮 spawn 客户端的老路径。端点只绑 loopback + auth.mode=none 的本机网关，不扩暴露面。
# 走尽力而为版：老版本没这个 key 时只是拿不到提速，不该让整个安装失败。
if (-not (Try-OpenClawConfig 'gateway.http.endpoints.chatCompletions.enabled' 'true' -Json)) {
    Info '当前 OpenClaw 不支持 chatCompletions 端点，对话将走每轮启动客户端的兼容路径（可用，只是每轮慢几秒）'
}
# 单次 LLM 请求的「空闲超时」。尽力而为：老版本 OpenClaw（如 2026.3.x）的 provider schema 不认识
# timeoutSeconds，会报 Unrecognized key 并拒绝写入。这里吞掉这条噪音、绝不让它中断安装；
# 新版本 OpenClaw 才会真正把它调到 600s。想彻底拿到更长超时，请 npm i -g openclaw@latest 升级。
if ($anthropicSynced) {
    $null = Try-OpenClawConfig "models.providers.$syncedProvider.timeoutSeconds" '600'
}
& openclaw --profile easel config validate
if ($LASTEXITCODE -ne 0) { Fail 'OpenClaw 配置校验失败。' }

}

function Ensure-WorkspaceLink($LinkPath, $TargetPath, $Folder, $WorkspacePath) {
    $absoluteLink = [System.IO.Path]::GetFullPath($LinkPath)
    $absoluteWorkspace = [System.IO.Path]::GetFullPath($WorkspacePath).TrimEnd('\') + '\'
    if (-not $absoluteLink.StartsWith($absoluteWorkspace, [StringComparison]::OrdinalIgnoreCase)) { Fail '数据链接超出目标 workspace。' }
    if (-not (Test-Path -LiteralPath $LinkPath)) {
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
        return
    }
    $item = Get-Item -LiteralPath $LinkPath -Force
    $oldTarget = if ($item.LinkType -eq 'Junction') { [System.IO.Path]::GetFullPath([string]$item.Target[0]) } else { '' }
    if ($oldTarget -eq $TargetPath) { return }
    $migrationRoot = $env:EASEL_INSTALL_MIGRATE_FROM
    $allowedOld = if ($migrationRoot) { [System.IO.Path]::GetFullPath((Join-Path $migrationRoot $Folder)) } else { '' }
    if (-not $oldTarget -or -not $allowedOld -or $oldTarget -ne $allowedOld) {
        Fail "$LinkPath 路径冲突：现有目录不指向 $TargetPath；请先迁移，安装器不会覆盖用户文件。"
    }
    # bootstrap passes this source only after copying missing data successfully.
    # Delete the junction itself non-recursively; never delete its old contents.
    Info "迁移 workspace 数据链接：$LinkPath → $TargetPath（保留旧数据）"
    [System.IO.Directory]::Delete($absoluteLink)
    try {
        New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath -ErrorAction Stop | Out-Null
    } catch {
        if (-not (Test-Path -LiteralPath $LinkPath)) {
            New-Item -ItemType Junction -Path $LinkPath -Target $oldTarget -ErrorAction Stop | Out-Null
        }
        throw
    }
}

function Invoke-skills {

Info '同步 skills 与 workspace...'
$workspace = $env:EASEL_OPENCLAW_WORKSPACE
if (-not $workspace) {
    $workspace = (& $Python (Join-Path $Root 'easel\openclaw_workspace.py') | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) { Fail '无法确定 OpenClaw workspace。' }
}
if ([string]::IsNullOrWhiteSpace($workspace)) { Fail '无法确定 OpenClaw workspace。' }
$workspace = [System.IO.Path]::GetFullPath($workspace.Trim())
$skillsPath = Join-Path $workspace 'skills'
New-Item -ItemType Directory -Force -Path $skillsPath | Out-Null
Copy-Item (Join-Path $Root 'skills\openclaw\*') -Destination $skillsPath -Recurse -Force
# Workspace personal instructions are never overwritten during upgrades.
Get-ChildItem -LiteralPath (Join-Path $Root 'openclaw\workspace') -Filter '*.md' | ForEach-Object {
    $destination = Join-Path $workspace $_.Name
    if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $_.FullName -Destination $destination }
}
$context = Join-Path $workspace 'CONTEXT.md'
@"
# Easel 项目路径

项目根目录：$Root
持久数据目录：$DataDir
产物输出到：$(Join-Path $DataDir 'outputs')
用户素材在：$(Join-Path $DataDir 'assets')
用户画像在：$(Join-Path $DataDir 'profiles')
"@ | Set-Content -LiteralPath $context -Encoding UTF8
$shared = Join-Path $workspace 'shared'
New-Item -ItemType Directory -Force -Path $shared | Out-Null
Copy-Item (Join-Path $Root 'skills\shared\*') -Destination $shared -Recurse -Force
foreach ($mapping in @(@{ name='easel-profiles'; folder='profiles' }, @{ name='outputs'; folder='outputs' }, @{ name='assets'; folder='assets' })) {
    $targetPath = Join-Path $DataDir $mapping.folder
    New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
    $linkPath = Join-Path $workspace $mapping.name
    Ensure-WorkspaceLink $linkPath $targetPath $mapping.folder $workspace
}

}

function Invoke-gateway {

Info '验证配置并启动 Gateway...'
& openclaw --profile easel config validate
if ($LASTEXITCODE -ne 0) { Fail 'OpenClaw 配置无效。' }
$identityFile = Join-Path $DataDir 'gateway-installation.json'
$currentIdentity = @{ root=$Root.ToLowerInvariant(); version=$(if ($Manifest) { [string]$Manifest.version } else { (Get-Content -LiteralPath (Join-Path $Root 'pyproject.toml') -Raw) }) }
$previousIdentity = $null
try { if (Test-Path -LiteralPath $identityFile) { $previousIdentity = Get-Content -LiteralPath $identityFile -Raw -Encoding UTF8 | ConvertFrom-Json } } catch { $previousIdentity = $null }
# An existing Gateway carries the environment of the previous install. Restart
# only the Easel-owned process (gateway.ps1 verifies ownership) on a new version.
$action = if ($previousIdentity -and $previousIdentity.root -eq $currentIdentity.root -and $previousIdentity.version -eq $currentIdentity.version) { 'start' } else { 'restart' }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\gateway.ps1') $action
if ($LASTEXITCODE -ne 0) { Fail 'Easel Gateway 启动失败。' }
& $Python -m easel doctor --install-mode
if ($LASTEXITCODE -ne 0) { Fail '安装环境检查失败；请按 doctor 提示修复。' }
& $Python (Join-Path $Root 'easel\install_runner.py') --root $Root --data-dir $DataDir --verify-web
if ($LASTEXITCODE -ne 0) { Fail 'Web 页面启动验证失败。' }
$identityTemp = $identityFile + '.tmp'
[System.IO.File]::WriteAllText($identityTemp, ($currentIdentity | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
Move-Item -LiteralPath $identityTemp -Destination $identityFile -Force

}

$setupLock = $null
try {
    if ($Phase) {
        & ('Invoke-' + $Phase)
        exit 0
    }
    # Serialize the pre-Python bootstrap too, before touching its checkpoint.
    try { $setupLock = [System.IO.File]::Open((Join-Path $DataDir 'setup.lock'), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None) }
    catch { Fail '另一个 Easel 安装正在使用此数据目录，请等待它完成。' }
    Write-Host "`nEasel · Windows 安装向导" -ForegroundColor Magenta
    # Python must exist before the stdlib runner can persist and execute phases.
    Save-SystemBootstrap 'running' '检查系统环境并准备 Python'
    try {
        Invoke-system
        Save-SystemBootstrap 'ok' '系统环境检查完成'
    } catch {
        Save-SystemBootstrap 'failed' $_.Exception.Message
        throw
    }
    $runnerArgs = @((Join-Path $Root 'easel\install_runner.py'), '--root', $Root, '--data-dir', $DataDir)
    if ($NonInteractive) { $runnerArgs += '--non-interactive' }
    if ($AllowWinget) { $runnerArgs += '--allow-winget' }
    & $Python @runnerArgs
    exit $LASTEXITCODE
} catch {
    Write-Host "[easel] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($setupLock) { $setupLock.Dispose() }
}
