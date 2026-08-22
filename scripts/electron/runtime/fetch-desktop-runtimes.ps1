# Windows-native regional fetch for desktop runtimes.
# Official component sources and verified China archives remain separate.
$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$SourcesJson = Join-Path $PSScriptRoot 'desktop-runtime-official-sources.json'
$OfficeConfigJson = if ($env:TABTIN_OFFICE_RUNTIME_CONFIG) {
    $env:TABTIN_OFFICE_RUNTIME_CONFIG
} else {
    Join-Path $RepoRoot 'packages\office-preview-runtime\runtime.config.json'
}
$RegionResolver = Join-Path $PSScriptRoot 'resolve-office-runtime-region.mjs'
$OfficeRoot = if ($env:TABTIN_OFFICE_RUNTIME_ROOT) {
    $env:TABTIN_OFFICE_RUNTIME_ROOT
} else {
    Join-Path $RepoRoot 'packages\office-preview-runtime\runtime'
}
$PythonRuntimeDir = Join-Path $RepoRoot 'packages\python-runtime\runtime'
$PythonConfig = Join-Path $RepoRoot 'packages\python-runtime\runtime.config.json'

$Only = 'all'
$Force = $false
$Strict = $false
$PlatformOverride = ''
$Region = if ($env:TABTIN_RUNTIME_REGION) { $env:TABTIN_RUNTIME_REGION } else { 'auto' }

$i = 0
while ($i -lt $args.Count) {
    switch ($args[$i]) {
        '--only' {
            $Only = [string]$args[$i + 1]
            $i += 2
        }
        '--force' {
            $Force = $true
            $i += 1
        }
        '--strict' {
            $Strict = $true
            $i += 1
        }
        '--platform' {
            $PlatformOverride = [string]$args[$i + 1]
            $i += 2
        }
        '--region' {
            $Region = [string]$args[$i + 1]
            $i += 2
        }
        { $_ -in @('-h', '--help') } {
            Write-Host @'
按用户区域准备桌面随包运行时（Windows）。

  Python  → python-build-standalone（astral）+ 冻结 pip 依赖
  Office  → The Document Foundation LibreOffice + poppler-windows

  scripts\electron\runtime\fetch-desktop-runtimes.bat
  scripts\electron\runtime\fetch-desktop-runtimes.bat --only python
  scripts\electron\runtime\fetch-desktop-runtimes.bat --only office --force
  scripts\electron\runtime\fetch-desktop-runtimes.bat --only office --region cn
  scripts\electron\runtime\fetch-desktop-runtimes.bat --platform win32-x64
  scripts\electron\runtime\fetch-desktop-runtimes.bat --strict
'@
            exit 0
        }
        default {
            Write-Error "未知参数: $($args[$i])"
            exit 2
        }
    }
}

if ($Only -notin @('all', 'python', 'office')) {
    Write-Error '--only 只能是 python、office 或省略（两者都拉）'
    exit 2
}

if ($env:TABTIN_SKIP_DESKTOP_RUNTIME_FETCH -eq '1') {
    Write-Host '⏭  TABTIN_SKIP_DESKTOP_RUNTIME_FETCH=1：跳过官方运行时拉取'
    exit 0
}

function Get-HostPlatform {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
    switch ($arch) {
        'AMD64' { return 'win32-x64' }
        'ARM64' { return 'win32-arm64' }
        default { throw "Unsupported Windows architecture: $arch" }
    }
}

$AllowedPlatforms = @(
    'darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'
)
if ($PlatformOverride) {
    if ($PlatformOverride -notin $AllowedPlatforms) {
        Write-Error "--platform 只能是 $($AllowedPlatforms -join ' / ')"
        exit 2
    }
    $Platform = $PlatformOverride
} else {
    $Platform = Get-HostPlatform
}
Write-Host "  · 目标平台/架构: $Platform"

$resolvedRegion = & node $RegionResolver --region $Region
if ($LASTEXITCODE -ne 0) { exit 2 }
$Region = ([string]$resolvedRegion).Trim()
Write-Host "  · Office 下载区域: $Region"

$CacheDir = if ($env:TABTIN_DESKTOP_RUNTIME_CACHE_DIR) {
    $env:TABTIN_DESKTOP_RUNTIME_CACHE_DIR
} else {
    Join-Path $env:USERPROFILE '.cache\tabtin-desktop-runtimes'
}
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

function Read-SourceField([string[]]$Keys) {
    $value = Get-Content -LiteralPath $SourcesJson -Raw | ConvertFrom-Json
    foreach ($key in $Keys) {
        $value = $value.$key
        if ($null -eq $value) { throw "missing source field: $($Keys -join '.')" }
    }
    return [string]$value
}

function Read-OfficeConfigField([string]$Key) {
    $config = Get-Content -LiteralPath $OfficeConfigJson -Raw | ConvertFrom-Json
    $value = $config.platforms.$Platform.$Key
    if ($null -eq $value -or [string]$value -eq '') {
        throw "missing Office runtime config field: platforms.$Platform.$Key"
    }
    return [string]$value
}

function Resolve-CurlExe {
    $systemCurl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $systemCurl) { return $systemCurl }
    $cmd = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    throw '需要 curl.exe'
}

function Resolve-TarExe {
    $systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $systemTar) { return $systemTar }
    $cmd = Get-Command tar.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) { return $cmd.Source }
    throw '需要 tar.exe'
}

function Save-CachedDownload([string]$Url, [string]$Dest) {
    $destDir = Split-Path -Parent $Dest
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    if ((Test-Path -LiteralPath $Dest) -and -not $Force -and (Get-Item -LiteralPath $Dest).Length -gt 0) {
        Write-Host "  · 复用下载缓存: $Dest"
        return
    }
    Write-Host "  · 下载 $Url"
    $part = "$Dest.part"
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    $curl = Resolve-CurlExe
    & $curl -fL --retry 3 --retry-delay 2 --retry-all-errors -o $part $Url
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        throw "下载失败: $Url"
    }
    Move-Item -LiteralPath $part -Destination $Dest -Force
}

function Test-OfficeReady {
    $soffice = @(
        (Join-Path $OfficeRoot 'bin\soffice.exe'),
        (Join-Path $OfficeRoot 'native\libreoffice-headless\program\soffice.exe')
    )
    $pdftoppm = @(
        (Join-Path $OfficeRoot 'bin\pdftoppm.exe'),
        (Join-Path $OfficeRoot 'native\poppler\bin\pdftoppm.exe')
    )
    $hasSoffice = $soffice | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    $hasPdftoppm = $pdftoppm | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    return [bool]$hasSoffice -and [bool]$hasPdftoppm
}

function Test-PrebuiltOfficeArchive(
    [string]$Archive,
    [string]$ExpectedSha256,
    [long]$ExpectedSize
) {
    if (-not (Test-Path -LiteralPath $Archive)) { return $false }
    $actualSize = (Get-Item -LiteralPath $Archive).Length
    if ($actualSize -ne $ExpectedSize) {
        Write-Host "⚠ Office runtime 归档大小不匹配: expected=$ExpectedSize actual=$actualSize"
        return $false
    }
    $actualSha256 = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
    if ($actualSha256 -ne $ExpectedSha256) {
        Write-Host '⚠ Office runtime 归档 SHA-256 不匹配'
        return $false
    }
    return $true
}

function Install-PrebuiltOfficeRuntime {
    $url = Read-OfficeConfigField 'url'
    $sha256 = Read-OfficeConfigField 'sha256'
    $size = [long](Read-OfficeConfigField 'size')
    $archiveName = "$Platform-$(Split-Path -Leaf $url)"
    $archive = Join-Path $CacheDir $archiveName

    if ((Test-Path -LiteralPath $archive) -and
        -not (Test-PrebuiltOfficeArchive $archive $sha256 $size)) {
        Write-Host '  · 丢弃校验失败的 Office runtime 缓存'
        Remove-Item -LiteralPath $archive -Force
    }
    Save-CachedDownload $url $archive
    if (-not (Test-PrebuiltOfficeArchive $archive $sha256 $size)) {
        Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
        throw '国内 Office runtime 归档校验失败'
    }

    $staging = Join-Path $CacheDir "office-runtime-$Platform-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    try {
        $tar = Resolve-TarExe
        & $tar -xzf $archive -C $staging
        if ($LASTEXITCODE -ne 0) { throw '解压国内 Office runtime 归档失败' }

        $sofficeCandidates = @(
            (Join-Path $staging 'bin\soffice.exe'),
            (Join-Path $staging 'native\libreoffice-headless\program\soffice.exe')
        )
        $pdftoppmCandidates = @(
            (Join-Path $staging 'bin\pdftoppm.exe'),
            (Join-Path $staging 'native\poppler\bin\pdftoppm.exe')
        )
        $hasSoffice = $sofficeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        $hasPdftoppm = $pdftoppmCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $hasSoffice -or -not $hasPdftoppm) {
            throw '国内 Office runtime 归档缺少 soffice 或 pdftoppm'
        }

        if (Test-Path -LiteralPath $OfficeRoot) {
            Remove-Item -LiteralPath $OfficeRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OfficeRoot) | Out-Null
        Move-Item -LiteralPath $staging -Destination $OfficeRoot
        Write-Host '  · 国内预构建 Office runtime 已通过大小和 SHA-256 校验'
    } finally {
        if (Test-Path -LiteralPath $staging) {
            Remove-Item -LiteralPath $staging -Recurse -Force
        }
    }
}

function Install-WinLibreOffice {
    $url = Read-SourceField @('libreOffice', 'downloads', $Platform, 'url')
    $msi = Join-Path $CacheDir (Split-Path -Leaf $url)
    Save-CachedDownload $url $msi
    $extract = Join-Path $CacheDir "libreoffice-msi-$Platform"
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    $msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
    if (-not (Test-Path -LiteralPath $msiexec)) { throw 'Windows 需要 msiexec 才能展开官方 LibreOffice MSI' }
    & $msiexec /a $msi /qn "TARGETDIR=$extract"
    if ($LASTEXITCODE -ne 0) { throw "msiexec 展开失败: $msi" }
    $soffice = Get-ChildItem -LiteralPath $extract -Recurse -Filter soffice.exe |
        Where-Object { $_.Directory.Name -eq 'program' } |
        Select-Object -First 1
    if (-not $soffice) { throw 'MSI 展开后找不到 program/soffice.exe' }
    $programDest = Join-Path $OfficeRoot 'native\libreoffice-headless\program'
    if (Test-Path -LiteralPath $programDest) { Remove-Item -LiteralPath $programDest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $programDest) | Out-Null
    Copy-Item -LiteralPath $soffice.Directory.FullName -Destination $programDest -Recurse -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $OfficeRoot 'bin') | Out-Null
    Copy-Item -LiteralPath (Join-Path $programDest 'soffice.exe') -Destination (Join-Path $OfficeRoot 'bin\soffice.exe') -Force
}

function Install-WinPoppler {
    $url = Read-SourceField @('popplerWindows', 'url')
    $zip = Join-Path $CacheDir (Split-Path -Leaf $url)
    Save-CachedDownload $url $zip
    $extract = Join-Path $CacheDir 'poppler-windows'
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    $tar = Resolve-TarExe
    & $tar -xf $zip -C $extract
    if ($LASTEXITCODE -ne 0) { throw '解压 poppler-windows zip 失败' }
    $ppm = Get-ChildItem -LiteralPath $extract -Recurse -Filter pdftoppm.exe | Select-Object -First 1
    if (-not $ppm) { throw 'zip 里找不到 pdftoppm.exe' }
    $nativeBin = Join-Path $OfficeRoot 'native\poppler\bin'
    $bin = Join-Path $OfficeRoot 'bin'
    New-Item -ItemType Directory -Force -Path $nativeBin, $bin | Out-Null
    Copy-Item -LiteralPath (Join-Path $ppm.Directory.FullName '*') -Destination $nativeBin -Force
    Copy-Item -LiteralPath (Join-Path $nativeBin 'pdftoppm.exe') -Destination (Join-Path $bin 'pdftoppm.exe') -Force
}

function Install-PythonRuntime {
    Write-Host '=== Python runtime（官方 python-build-standalone）==='
    if ($Platform -notlike 'win32-*') {
        throw "Windows 入口只能构建 win32 运行时，当前是 $Platform"
    }
    $cfg = Get-Content -LiteralPath $PythonConfig -Raw | ConvertFrom-Json
    $archiveName = [string]$cfg.archives.$Platform
    if (-not $archiveName) { $archiveName = "tabtin-python-runtime-$Platform.tar.gz" }
    $archivePath = Join-Path $PythonRuntimeDir $archiveName
    if ((Test-Path -LiteralPath $archivePath) -and -not $Force -and (Get-Item -LiteralPath $archivePath).Length -gt 0) {
        Write-Host "  · 跳过 Python 运行时构建：产物已存在 $archivePath"
    } else {
        $env:TARGET_MANIFEST_PLATFORM = $Platform
        $builder = Join-Path $PSScriptRoot 'build-python-runtime.ps1'
        & $builder
    }
    $manifest = Join-Path $PSScriptRoot 'gen-python-runtime-manifest.mjs'
    & node $manifest --required-platform $Platform
    if ($LASTEXITCODE -ne 0) { throw '生成 Python runtime manifest 失败' }
    Write-Host "  · Python 已就绪: $PythonRuntimeDir"
}

function Install-OfficialOfficeRuntime {
    if ($Platform -notlike 'win32-*') {
        throw "Windows 入口只能组装 win32 Office runtime，当前是 $Platform"
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $OfficeRoot 'bin'), (Join-Path $OfficeRoot 'native') | Out-Null
    Install-WinLibreOffice
    Install-WinPoppler
}

function Install-OfficeRuntime {
    Write-Host '=== Office preview runtime（国内预构建 / 官方 LibreOffice + Poppler）==='
    if ((Test-OfficeReady) -and -not $Force) {
        Write-Host '  · 已存在可用 Office runtime，跳过（--force 可重建）'
        return
    }

    if ($Region -eq 'cn') {
        Write-Host '  · 国内地址优先预构建 OSS 归档，失败后回退官方源'
        try {
            Install-PrebuiltOfficeRuntime
        } catch {
            Write-Host "⚠ 国内 Office runtime 源不可用，回退官方源: $($_.Exception.Message)"
            Install-OfficialOfficeRuntime
        }
    } else {
        Write-Host '  · 海外地址优先 LibreOffice / Poppler 官方源，失败后回退国内归档'
        try {
            Install-OfficialOfficeRuntime
        } catch {
            Write-Host "⚠ 官方 Office runtime 源不可用，回退国内归档: $($_.Exception.Message)"
            Install-PrebuiltOfficeRuntime
        }
    }

    if (-not (Test-OfficeReady)) {
        throw 'Office runtime 组装后仍缺少 soffice 或 pdftoppm'
    }
    Write-Host "  · Office 已就绪: $OfficeRoot"
}

$stepFailed = $false
if ($Only -in @('all', 'python')) {
    try {
        Install-PythonRuntime
    } catch {
        Write-Host "⚠ Python runtime 未就绪（不阻断启动/打包）。稍后可重试: scripts\electron\runtime\fetch-desktop-runtimes.bat"
        Write-Host "  $($_.Exception.Message)"
        $stepFailed = $true
    }
}
if ($Only -in @('all', 'office')) {
    try {
        Install-OfficeRuntime
    } catch {
        Write-Host "⚠ Office preview runtime 未就绪（不阻断启动/打包）。稍后可重试: scripts\electron\runtime\fetch-desktop-runtimes.bat"
        Write-Host "  $($_.Exception.Message)"
        $stepFailed = $true
    }
}

if (-not $stepFailed) {
    Write-Host '✅ 桌面运行时已准备。随后可打包：'
    Write-Host '   apps/tabtin-electron/scripts/build-packaged-app.sh win local'
    exit 0
}
if ($Strict) {
    Write-Error '桌面运行时拉取失败（--strict）'
    exit 1
}
exit 0
