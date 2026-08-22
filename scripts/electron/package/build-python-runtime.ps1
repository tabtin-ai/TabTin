<#
build-python-runtime.ps1 - Windows-native equivalent of build-python-runtime.sh.

Flow:
  1. Download a relocatable interpreter from python-build-standalone (astral)
  2. pip install frozen requirements into bundled site-packages
  3. Create tar.gz (interpreter tree root; entrypoint python.exe)
  4. Print sha256 + size; archive basename aligns with runtime.config.json archives

Requires: Windows 10 1809+ (tar.exe), PowerShell 5+ or PowerShell 7. No system Python needed.

Usage (repo root):
  powershell -ExecutionPolicy Bypass -File scripts\electron\package\build-python-runtime.ps1

Optional env: PY_VERSION / PBS_RELEASE / PBS_VARIANT / TARGET_MANIFEST_PLATFORM / TARGET_TRIPLE / ARCHIVE_NAME
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-EnvOrDefault([string]$name, [string]$default) {
    $v = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($v)) { return $default }
    return $v
}

function Get-TripleFromManifestPlatform([string]$platform) {
    switch ($platform) {
        'darwin-arm64' { return 'aarch64-apple-darwin' }
        'darwin-x64'   { return 'x86_64-apple-darwin' }
        'win32-x64'    { return 'x86_64-pc-windows-msvc' }
        'win32-arm64'  { return 'aarch64-pc-windows-msvc' }
        'linux-x64'    { return 'x86_64-unknown-linux-gnu' }
        'linux-arm64'  { return 'aarch64-unknown-linux-gnu' }
        default { throw "Unsupported TARGET_MANIFEST_PLATFORM: $platform" }
    }
}

function Get-ManifestPlatformFromHost() {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    switch ($arch) {
        'AMD64' { return 'win32-x64' }
        'ARM64' { return 'win32-arm64' }
        default { throw "Unsupported Windows architecture: $arch" }
    }
}

function Get-PbsDownloadUrl([string]$release, [string]$asset) {
    $encodedAsset = $asset.Replace('+', '%2B')
    return "https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${encodedAsset}"
}

function Resolve-CurlExe {
    # Prefer System32: packaging PATH may omit Git mingw, and `curl` alone is a
    # PowerShell alias for Invoke-WebRequest (broken for GitHub PBS assets).
    $systemCurl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $systemCurl) { return $systemCurl }
    $cmd = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return $null
}

function Resolve-TarExe {
    # Prefer System32 bsdtar: Git GNU tar treats C:\path as remote host "C".
    $systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $systemTar) { return $systemTar }
    $cmd = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    return $null
}

function Test-GzipTarArchive([string]$path) {
    if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -le 0) {
        return $false
    }
    $tar = Resolve-TarExe
    if (-not $tar) { return $false }
    & $tar -tzf $path 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Get-PbsCacheDir {
    $override = [Environment]::GetEnvironmentVariable('TABTIN_PBS_CACHE_DIR')
    if (-not [string]::IsNullOrWhiteSpace($override)) { return $override }
    # Align with scripts/electron/package/cache-python-build-standalone.sh on Windows Git Bash.
    return (Join-Path $env:USERPROFILE '.cache\tabtin\python-build-standalone')
}

function Download-UrlToFile {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$OutFile,
        [string]$CacheAssetName = ''
    )

    if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }

    $curl = Resolve-CurlExe
    if (-not $curl) {
        throw 'curl.exe required (C:\Windows\System32\curl.exe or PATH). Invoke-WebRequest is not supported for PBS downloads.'
    }

    $sourcePath = $null
    if (-not [string]::IsNullOrWhiteSpace($CacheAssetName)) {
        $cacheDir = Get-PbsCacheDir
        New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
        $cachePath = Join-Path $cacheDir $CacheAssetName
        if (Test-GzipTarArchive $cachePath) {
            Write-Host "-> Reuse python-build-standalone cache: $cachePath"
            $sourcePath = $cachePath
        } else {
            if (Test-Path -LiteralPath $cachePath) {
                Write-Host "-> Stale PBS cache, re-download: $cachePath"
                Remove-Item -LiteralPath $cachePath -Force
            }
            $partial = "$cachePath.part"
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
            Write-Host "-> Download python-build-standalone via curl: $Url"
            & $curl -fSL --retry 3 --retry-delay 2 --connect-timeout 30 --max-time 900 -o $partial $Url
            if ($LASTEXITCODE -ne 0) {
                throw "curl download failed (exit=$LASTEXITCODE) url=$Url curl=$curl"
            }
            if (-not (Test-GzipTarArchive $partial)) {
                Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
                throw "download is not a valid tar.gz: $Url"
            }
            Move-Item -LiteralPath $partial -Destination $cachePath -Force
            Write-Host "-> Cached python-build-standalone: $cachePath"
            $sourcePath = $cachePath
        }
        Copy-Item -LiteralPath $sourcePath -Destination $OutFile -Force
    } else {
        Write-Host "-> Download via curl: $Url"
        & $curl -fSL --retry 3 --retry-delay 2 --connect-timeout 30 --max-time 900 -o $OutFile $Url
        if ($LASTEXITCODE -ne 0) {
            throw "curl download failed (exit=$LASTEXITCODE) url=$Url curl=$curl"
        }
    }

    if (-not (Test-Path -LiteralPath $OutFile) -or (Get-Item -LiteralPath $OutFile).Length -le 0) {
        throw "download produced empty file: $OutFile url=$Url"
    }
}

$PyVersion  = Get-EnvOrDefault 'PY_VERSION'  '3.12.13'
$PbsRelease = Get-EnvOrDefault 'PBS_RELEASE' '20260610'
$PbsVariant = Get-EnvOrDefault 'PBS_VARIANT' 'install_only_stripped'

$RepoRoot      = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$PkgDir        = Join-Path $RepoRoot 'packages\python-runtime'
$RuntimeOutDir = Join-Path $PkgDir 'runtime'
$Requirements  = Join-Path $PkgDir 'requirements.txt'
$ConfigJson    = Join-Path $PkgDir 'runtime.config.json'

$ManifestPlatform = $env:TARGET_MANIFEST_PLATFORM
if ([string]::IsNullOrWhiteSpace($ManifestPlatform)) {
    $ManifestPlatform = Get-ManifestPlatformFromHost
}
$Triple = if ($env:TARGET_TRIPLE) { $env:TARGET_TRIPLE } else { Get-TripleFromManifestPlatform $ManifestPlatform }

$ArchiveName = $env:ARCHIVE_NAME
if ([string]::IsNullOrWhiteSpace($ArchiveName) -and (Test-Path $ConfigJson)) {
    try {
        $cfg = Get-Content $ConfigJson -Raw | ConvertFrom-Json
        $name = $cfg.archives.$ManifestPlatform
        if ($name) { $ArchiveName = [string]$name }
    } catch { }
}
if ([string]::IsNullOrWhiteSpace($ArchiveName)) {
    $ArchiveName = "tabtin-python-runtime-${ManifestPlatform}.tar.gz"
}

$PbsAsset = "cpython-${PyVersion}+${PbsRelease}-${Triple}-${PbsVariant}.tar.gz"
$PbsUrl   = Get-PbsDownloadUrl $PbsRelease $PbsAsset

if (-not (Resolve-TarExe)) {
    throw 'tar.exe not found (requires Windows 10 1809+ System32 tar).'
}

$TarExe = Resolve-TarExe
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("tabtin-pyrt-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Work | Out-Null
try {
    Write-Host "-> Resolve python-build-standalone: $PbsUrl"
    $pbsTar = Join-Path $Work 'pbs.tar.gz'
    Download-UrlToFile -Url $PbsUrl -OutFile $pbsTar -CacheAssetName $PbsAsset

    Write-Host '-> Extract interpreter'
    & $TarExe -xzf $pbsTar -C $Work
    $PyRoot = Join-Path $Work 'python'
    $PyBin  = Join-Path $PyRoot 'python.exe'
    if (-not (Test-Path $PyBin)) { throw "Interpreter entry missing: $PyBin" }

    Write-Host '-> Install frozen requirements into bundled site-packages'
    & $PyBin -m pip install --disable-pip-version-check --no-input -r $Requirements
    if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit=$LASTEXITCODE)" }

    Write-Host "-> Create archive $ArchiveName"
    New-Item -ItemType Directory -Force -Path $RuntimeOutDir | Out-Null
    $ArchivePath = Join-Path $RuntimeOutDir $ArchiveName
    if (Test-Path $ArchivePath) { Remove-Item $ArchivePath -Force }
    & $TarExe -czf $ArchivePath -C $PyRoot .
    if ($LASTEXITCODE -ne 0) { throw "tar packaging failed (exit=$LASTEXITCODE)" }

    $Sha  = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLower()
    $Size = (Get-Item $ArchivePath).Length

    Write-Host ''
    Write-Host "OK: $ArchivePath"
    Write-Host "   platform=$ManifestPlatform  sha256=$Sha  size=$Size"
    Write-Host '   Archive stays in packages/python-runtime/runtime and is bundled by Electron packaging.'
}
finally {
    if (Test-Path $Work) { Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue }
}
