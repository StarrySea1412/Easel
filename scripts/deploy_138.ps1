[CmdletBinding()]
param(
    [string]$ProjectDir,
    [string]$HostName = '192.168.0.138',
    [string]$UserName = 'ubuntu',
    [string]$RemoteBase = '/home/ubuntu',
    [string]$RemoteReleases = '/home/ubuntu/easel-releases',
    [string]$Commit = 'HEAD',
    [string]$NginxImage = 'nginx:1.29.2-alpine@sha256:61e01287e546aac28a3f56839c136b31f590273f3b41187a36f46f6a03bbfe22',
    [switch]$Activate,
    [switch]$IsolatedTest,
    [switch]$AllowDirty,
    [switch]$KeepRemoteArchive
)

$ErrorActionPreference = 'Stop'

function Assert-SafeValue([string]$Value, [string]$Name, [string]$Pattern) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch $Pattern -or $Value.Contains('..')) {
        throw "Invalid $Name."
    }
}

function Invoke-Checked([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE."
    }
}

try {
    if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent $PSScriptRoot }
    $root = (Resolve-Path -LiteralPath $ProjectDir -ErrorAction Stop).ProviderPath
    $builder = Join-Path $root 'deployment\138\build_release.py'
    if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) {
        throw "Easel project was not found at $root."
    }

    Assert-SafeValue $HostName 'HostName' '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    Assert-SafeValue $UserName 'UserName' '^[A-Za-z0-9][A-Za-z0-9._-]*$'
    Assert-SafeValue $RemoteBase 'RemoteBase' '^/[A-Za-z0-9._/-]+$'
    Assert-SafeValue $RemoteReleases 'RemoteReleases' '^/[A-Za-z0-9._/-]+$'
    Assert-SafeValue $NginxImage 'NginxImage' '^[A-Za-z0-9_./:@-]+$'

    $git = (Get-Command git -ErrorAction Stop).Source
    $ssh = (Get-Command ssh -ErrorAction Stop).Source
    $scp = (Get-Command scp -ErrorAction Stop).Source
    $python = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        $python = (Get-Command python -ErrorAction Stop).Source
    }

    $dirty = @(& $git -C $root status --porcelain --untracked-files=normal)
    if ($dirty.Count -gt 0 -and -not $AllowDirty) {
        throw "Working tree is dirty. Commit the release first, or explicitly use -AllowDirty (the selected commit is still the only shipped source)."
    }

    $revision = (& $git -C $root rev-parse --verify ($Commit + '^{commit}')).Trim()
    if ($LASTEXITCODE -ne 0 -or $revision -notmatch '^[0-9a-f]{40}$') {
        throw "Cannot resolve commit '$Commit'."
    }
    $short = $revision.Substring(0, 12)
    $archive = Join-Path $root "dist\Easel-138-$short.zip"
    $receiptPath = [IO.Path]::ChangeExtension($archive, '.receipt.json')
    $image = "easel:$short"
    $target = "$UserName@$HostName"
    $remoteArchive = "$RemoteReleases/Easel-138-$short.zip"
    $remoteStage = "$RemoteReleases/Easel-138-$short"
    $testArg = if ($IsolatedTest) { '--isolated-test' } else { '' }
    $testLabel = if ($IsolatedTest) { 'isolated-test' } else { 'production' }
    $activateFlag = if ($Activate) { '1' } else { '0' }
    $keepFlag = if ($KeepRemoteArchive) { '1' } else { '0' }

    Write-Host "Easel 138 quick deploy ($testLabel)" -ForegroundColor Cyan
    Write-Host "Source commit: $revision"
    Write-Host "Target:        $target"
    Write-Host "Archive:       $archive"
    Write-Host "Activation:    $(if ($Activate) { 'EXPLICITLY ENABLED' } else { 'candidate only' })"

    Invoke-Checked $python @($builder, '--repo', $root, '--commit', $revision, '--output', $archive)
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf) -or -not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        throw 'Release archive or receipt was not produced.'
    }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.commit -ne $revision) { throw 'Release receipt commit does not match the selected commit.' }
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($receipt.zipSha256 -ne $hash) { throw 'Release receipt ZIP SHA-256 does not match the archive.' }
    Write-Host "Archive SHA-256: $hash"

    $sshCommon = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=120')
    Write-Host 'Preparing remote staging directory...'
    Invoke-Checked $ssh ($sshCommon + @($target, "umask 077; mkdir -p '$RemoteReleases'"))
    Write-Host 'Transferring release archive...'
    Invoke-Checked $scp ($sshCommon + @($archive, "${target}:$remoteArchive"))

    $remoteScript = @'
set -eu
archive='__REMOTE_ARCHIVE__'
stage='__REMOTE_STAGE__'
base='__REMOTE_BASE__'
image='__IMAGE__'
nginx='__NGINX__'
activate='__ACTIVATE__'
keep='__KEEP__'
test_arg='__TEST_ARG__'
expected_sha='__ARCHIVE_SHA__'

actual_sha=$(sha256sum "$archive" | awk '{print $1}')
[ "$actual_sha" = "$expected_sha" ] || { echo "Archive SHA-256 mismatch" >&2; exit 1; }
if [ -e "$stage" ] || [ -L "$stage" ]; then
  [ -d "$stage" ] && [ ! -L "$stage" ] || { echo "Unsafe existing release stage" >&2; exit 1; }
  echo "Reusing existing immutable release stage"
else
  mkdir -m 700 -p "$stage"
  unzip -q "$archive" -d "$stage"
fi
python3 "$stage/deployment/138/manage.py" verify
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["commit"] == sys.argv[2], "Existing stage belongs to another commit"' "$stage/release-manifest.json" '__REVISION__'
if [ "$activate" = 1 ]; then
  python3 "$stage/deployment/138/manage.py" prepare --base "$base" $test_arg
fi
python3 "$stage/deployment/138/manage.py" preflight --base "$base" $test_arg
docker build --progress=plain -f "$stage/deployment/138/Dockerfile" --build-arg EASEL_RELEASE_SHA=__REVISION__ -t "$image" "$stage"

if [ "$activate" = 1 ]; then
  python3 "$stage/deployment/138/manage.py" activate --base "$base" --image "$image" --nginx "$nginx" $test_arg
  project=easel
  secrets_suffix=''
  endpoint='192.168.0.138:8444'
  if [ "$test_arg" = '--isolated-test' ]; then project=easel-test; secrets_suffix='-test'; endpoint='127.0.0.1:8445'; fi
  docker compose -p "$project" --env-file "$base/easel-secrets${secrets_suffix}/deployment.env" -f "$stage/deployment/138/compose.yaml" up -d --no-build --wait --wait-timeout 240
  docker compose -p "$project" --env-file "$base/easel-secrets${secrets_suffix}/deployment.env" -f "$stage/deployment/138/compose.yaml" ps
  curl --cacert "$base/easel-secrets${secrets_suffix}/easel-root-ca.crt" --fail --silent --show-error --output /dev/null "https://$endpoint/login"
  echo "138 activation and HTTPS login probe completed."
else
  echo "Candidate staged at $stage; services were not changed. Re-run with -Activate to back up and switch."
fi

if [ "$keep" != 1 ]; then rm -f "$archive"; fi
'@
    $remoteScript = $remoteScript.Replace('__REMOTE_ARCHIVE__', $remoteArchive)
    $remoteScript = $remoteScript.Replace('__REMOTE_STAGE__', $remoteStage)
    $remoteScript = $remoteScript.Replace('__REMOTE_BASE__', $RemoteBase)
    $remoteScript = $remoteScript.Replace('__IMAGE__', $image)
    $remoteScript = $remoteScript.Replace('__NGINX__', $NginxImage)
    $remoteScript = $remoteScript.Replace('__ACTIVATE__', $activateFlag)
    $remoteScript = $remoteScript.Replace('__KEEP__', $keepFlag)
    $remoteScript = $remoteScript.Replace('__TEST_ARG__', $testArg)
    $remoteScript = $remoteScript.Replace('__ARCHIVE_SHA__', $hash)
    $remoteScript = $remoteScript.Replace('__REVISION__', $revision)

    Write-Host 'Verifying and building on 138. This may take several minutes...'
    $remoteScript | & $ssh @sshCommon $target 'tr -d "\r" | bash -s'
    if ($LASTEXITCODE -ne 0) { throw "Remote release command failed with exit code $LASTEXITCODE." }

    if ($Activate) {
        Write-Host '138 release activated and login probe passed.' -ForegroundColor Green
    } else {
        Write-Host 'Candidate upload/build completed; production was not changed.' -ForegroundColor Green
    }
    $activeLink = if ($IsolatedTest) { 'Easel-test' } else { 'Easel' }
    Write-Host "Rollback (if an activated release fails): ssh $target 'python3 $RemoteBase/$activeLink/deployment/138/manage.py rollback --base $RemoteBase $testArg'"
    exit 0
} catch {
    Write-Host ("138 quick deploy failed: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
