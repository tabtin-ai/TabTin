#!/usr/bin/env bash
# 按用户区域准备桌面随包运行时（不把数百 MB 提交进 git）。
#
#   Python  → python-build-standalone（astral）+ 冻结 pip 依赖
#   Office  → The Document Foundation LibreOffice + Poppler（mac: Homebrew，win: poppler-windows）
#
# POSIX 入口。Windows 走独立的 PowerShell 实现，互不调用。
# 启动脚本走 _ensure-desktop-runtimes.sh；打包走 build-packaged-app.sh。
# 跳过：TABTIN_SKIP_DESKTOP_RUNTIME_FETCH=1
# 默认失败只告警、不阻断调用方；需要失败退出时加 --strict。
#
# 用法：
#   bash scripts/electron/runtime/fetch-desktop-runtimes.sh
#   bash scripts/electron/runtime/fetch-desktop-runtimes.sh --only python
#   bash scripts/electron/runtime/fetch-desktop-runtimes.sh --only office --force
#   bash scripts/electron/runtime/fetch-desktop-runtimes.sh --only office --region cn
#   bash scripts/electron/runtime/fetch-desktop-runtimes.sh --platform darwin-arm64
#   bash scripts/electron/runtime/fetch-desktop-runtimes.sh --strict
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCES_JSON="$REPO_ROOT/scripts/electron/runtime/desktop-runtime-official-sources.json"
OFFICE_CONFIG_JSON="${TABTIN_OFFICE_RUNTIME_CONFIG:-$REPO_ROOT/packages/office-preview-runtime/runtime.config.json}"
REGION_RESOLVER="$REPO_ROOT/scripts/electron/runtime/resolve-office-runtime-region.mjs"
ONLY="all"
FORCE=0
STRICT=0
PLATFORM_OVERRIDE=""
REGION="${TABTIN_RUNTIME_REGION:-auto}"

while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      ONLY="${2:-}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --platform)
      PLATFORM_OVERRIDE="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$ONLY" != "all" ] && [ "$ONLY" != "python" ] && [ "$ONLY" != "office" ]; then
  echo "❌ --only 只能是 python、office 或省略（两者都拉）" >&2
  exit 2
fi

if [ "${TABTIN_SKIP_DESKTOP_RUNTIME_FETCH:-0}" = "1" ]; then
  echo "⏭  TABTIN_SKIP_DESKTOP_RUNTIME_FETCH=1：跳过官方运行时拉取"
  exit 0
fi

detect_platform() {
  local os arch
  os="$(uname -s)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW*|MSYS*|CYGWIN*) os=win32 ;;
    *) os=unknown ;;
  esac
  arch="$(uname -m)"
  case "${PROCESSOR_ARCHITECTURE:-}" in
    ARM64|arm64) arch=arm64 ;;
    AMD64|amd64) arch=x64 ;;
    *)
      case "$arch" in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64) arch=x64 ;;
      esac
      ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

if [ -n "$PLATFORM_OVERRIDE" ]; then
  case "$PLATFORM_OVERRIDE" in
    darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-x64|linux-arm64)
      PLATFORM="$PLATFORM_OVERRIDE"
      ;;
    *)
      echo "❌ --platform 只能是 darwin-arm64 / darwin-x64 / win32-x64 / win32-arm64 / linux-x64 / linux-arm64" >&2
      exit 2
      ;;
  esac
else
  PLATFORM="$(detect_platform)"
fi
echo "  · 目标平台/架构: $PLATFORM"

REGION="$(node "$REGION_RESOLVER" --region "$REGION")" || exit 2
echo "  · Office 下载区域: $REGION"

CACHE_DIR="${TABTIN_DESKTOP_RUNTIME_CACHE_DIR:-${HOME}/.cache/tabtin-desktop-runtimes}"
OFFICE_ROOT="${TABTIN_OFFICE_RUNTIME_ROOT:-$REPO_ROOT/packages/office-preview-runtime/runtime}"
mkdir -p "$CACHE_DIR"

source_field() {
  node - "$SOURCES_JSON" "$@" <<'NODE'
const fs = require('node:fs')
const [file, ...keys] = process.argv.slice(2)
let value = JSON.parse(fs.readFileSync(file, 'utf8'))
for (const key of keys) {
  if (value == null || typeof value !== 'object') process.exit(1)
  value = value[key]
}
if (typeof value !== 'string' || !value) process.exit(1)
process.stdout.write(value)
NODE
}

office_config_field() {
  node - "$OFFICE_CONFIG_JSON" "$PLATFORM" "$1" <<'NODE'
const fs = require('node:fs')
const [file, platform, key] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(file, 'utf8'))?.platforms?.[platform]?.[key]
if ((typeof value !== 'string' && typeof value !== 'number') || value === '') process.exit(1)
process.stdout.write(String(value))
NODE
}

download_cached() {
  local url="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if [ -s "$dest" ] && [ "$FORCE" != "1" ]; then
    echo "  · 复用下载缓存: $dest"
    return 0
  fi
  echo "  · 下载 $url"
  if ! curl -fL --retry 3 --retry-delay 2 --retry-all-errors "$url" -o "$dest.part"; then
    rm -f "$dest.part"
    echo "⚠ 下载失败: $url" >&2
    return 1
  fi
  mv -f "$dest.part" "$dest"
}

office_has_soffice() {
  [ -x "$OFFICE_ROOT/bin/soffice" ] || [ -x "$OFFICE_ROOT/bin/soffice.exe" ] || \
    [ -f "$OFFICE_ROOT/native/libreoffice-headless/program/soffice.exe" ] || \
    [ -x "$OFFICE_ROOT/native/libreoffice-headless/libreoffice/LibreOffice.app/Contents/MacOS/soffice" ]
}

office_has_pdftoppm() {
  [ -x "$OFFICE_ROOT/bin/pdftoppm" ] || [ -x "$OFFICE_ROOT/bin/pdftoppm.exe" ] || \
    [ -x "$OFFICE_ROOT/native/poppler/bin/pdftoppm" ] || [ -x "$OFFICE_ROOT/native/poppler/bin/pdftoppm.exe" ]
}

office_ready() {
  office_has_soffice && office_has_pdftoppm
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  sha256sum "$1" | awk '{print $1}'
}

verify_prebuilt_office_archive() {
  local archive="$1"
  local expected_sha="$2"
  local expected_size="$3"
  local actual_size actual_sha
  actual_size="$(wc -c < "$archive" | tr -d '[:space:]')"
  if [ "$actual_size" != "$expected_size" ]; then
    echo "⚠ Office runtime 归档大小不匹配: expected=$expected_size actual=$actual_size" >&2
    return 1
  fi
  actual_sha="$(sha256_file "$archive")"
  if [ "$(printf '%s' "$actual_sha" | tr '[:upper:]' '[:lower:]')" != \
    "$(printf '%s' "$expected_sha" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "⚠ Office runtime 归档 SHA-256 不匹配" >&2
    return 1
  fi
}

install_prebuilt_office_runtime() {
  local url sha size archive staging
  url="$(office_config_field url)" || return 1
  sha="$(office_config_field sha256)" || return 1
  size="$(office_config_field size)" || return 1
  archive="$CACHE_DIR/${PLATFORM}-$(basename "$url")"

  if [ -s "$archive" ] && ! verify_prebuilt_office_archive "$archive" "$sha" "$size"; then
    echo "  · 丢弃校验失败的 Office runtime 缓存"
    rm -f "$archive"
  fi
  download_cached "$url" "$archive" || return 1
  if ! verify_prebuilt_office_archive "$archive" "$sha" "$size"; then
    rm -f "$archive"
    return 1
  fi

  staging="$(mktemp -d "$CACHE_DIR/office-runtime-${PLATFORM}.XXXXXX")"
  if ! tar -xzf "$archive" -C "$staging"; then
    rm -rf "$staging"
    return 1
  fi
  if ! (
    [ -x "$staging/bin/soffice" ] || [ -f "$staging/bin/soffice.exe" ] || \
      [ -f "$staging/native/libreoffice-headless/program/soffice.exe" ]
  ) || ! (
    [ -x "$staging/bin/pdftoppm" ] || [ -f "$staging/bin/pdftoppm.exe" ] || \
      [ -x "$staging/native/poppler/bin/pdftoppm" ] || [ -f "$staging/native/poppler/bin/pdftoppm.exe" ]
  ); then
    echo "⚠ 国内 Office runtime 归档缺少 soffice 或 pdftoppm" >&2
    rm -rf "$staging"
    return 1
  fi

  rm -rf "$OFFICE_ROOT"
  mkdir -p "$(dirname "$OFFICE_ROOT")"
  mv "$staging" "$OFFICE_ROOT"
  echo "  · 国内预构建 Office runtime 已通过大小和 SHA-256 校验"
}

write_posix_wrapper() {
  local wrapper="$1"
  local target="$2"
  mkdir -p "$(dirname "$wrapper")"
  cat > "$wrapper" <<EOF
#!/bin/bash
exec "\$(cd "\$(dirname "\$0")" && pwd)/$target" "\$@"
EOF
  chmod +x "$wrapper"
}

bundle_macos_executable() {
  local src="$1"
  local dest="$2"
  local libdir
  libdir="$(cd "$(dirname "$dest")" && pwd)/../lib"
  mkdir -p "$(dirname "$dest")" "$libdir"
  cp "$src" "$dest"
  chmod +x "$dest"
  local dylib
  while IFS= read -r dylib; do
    [ -n "$dylib" ] || continue
    case "$dylib" in
      /usr/lib/*|/System/*|@*) continue ;;
    esac
    [ -f "$dylib" ] || continue
    local base
    base="$(basename "$dylib")"
    [ -f "$libdir/$base" ] || cp "$dylib" "$libdir/$base"
    install_name_tool -change "$dylib" "@executable_path/../lib/$base" "$dest" 2>/dev/null || true
  done < <(otool -L "$dest" | awk '/^\t/ { print $1 }')
}

install_mac_poppler() {
  local formula
  formula="$(source_field popplerMac formula)"
  if ! command -v brew >/dev/null 2>&1; then
    echo "⚠ macOS 需要 Homebrew 才能从官方 formula 安装 Poppler（$formula）。" >&2
    echo "   安装 Homebrew 后重试，或自行提供 TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE。" >&2
    return 1
  fi
  if ! brew list --versions "$formula" >/dev/null 2>&1; then
    echo "  · brew install $formula"
    brew install "$formula"
  fi
  local prefix
  prefix="$(brew --prefix "$formula")"
  local src_bin="$prefix/bin/pdftoppm"
  [ -x "$src_bin" ] || { echo "⚠ Homebrew poppler 缺少 pdftoppm: $src_bin" >&2; return 1; }
  mkdir -p "$OFFICE_ROOT/native/poppler/bin"
  bundle_macos_executable "$src_bin" "$OFFICE_ROOT/native/poppler/bin/pdftoppm"
  write_posix_wrapper "$OFFICE_ROOT/bin/pdftoppm" "../native/poppler/bin/pdftoppm"
}

install_mac_libreoffice() {
  local url kind app_name dmg mount
  url="$(source_field libreOffice downloads "$PLATFORM" url)"
  kind="$(source_field libreOffice downloads "$PLATFORM" kind)"
  app_name="$(source_field libreOffice downloads "$PLATFORM" appName)"
  [ "$kind" = "dmg" ] || { echo "⚠ $PLATFORM 的 LibreOffice 源不是 dmg" >&2; return 1; }
  dmg="$CACHE_DIR/$(basename "$url")"
  download_cached "$url" "$dmg" || return 1
  mount="$(hdiutil attach -nobrowse -readonly "$dmg" | awk '/\/Volumes\// { print $NF; exit }')"
  if [ -z "$mount" ] || [ ! -d "$mount/$app_name" ]; then
    echo "⚠ 未能挂载 LibreOffice DMG 或找不到 $app_name" >&2
    return 1
  fi
  mkdir -p "$OFFICE_ROOT/native/libreoffice-headless/libreoffice"
  rm -rf "$OFFICE_ROOT/native/libreoffice-headless/libreoffice/$app_name"
  echo "  · 复制 $app_name"
  cp -R "$mount/$app_name" "$OFFICE_ROOT/native/libreoffice-headless/libreoffice/$app_name"
  hdiutil detach "$mount" >/dev/null
  write_posix_wrapper "$OFFICE_ROOT/bin/soffice" "../native/libreoffice-headless/libreoffice/$app_name/Contents/MacOS/soffice"
}

install_win_libreoffice() {
  local url msi extract
  url="$(source_field libreOffice downloads "$PLATFORM" url)"
  msi="$CACHE_DIR/$(basename "$url")"
  download_cached "$url" "$msi" || return 1
  extract="$CACHE_DIR/libreoffice-msi-${PLATFORM}"
  rm -rf "$extract"
  mkdir -p "$extract"
  if command -v msiexec.exe >/dev/null 2>&1; then
    msiexec.exe /a "$(cygpath -w "$msi" 2>/dev/null || echo "$msi")" /qn "TARGETDIR=$(cygpath -w "$extract" 2>/dev/null || echo "$extract")"
  else
    echo "⚠ Windows 需要 msiexec 才能展开官方 LibreOffice MSI" >&2
    return 1
  fi
  local soffice
  soffice="$(find "$extract" -name soffice.exe -path '*/program/soffice.exe' | head -1)"
  [ -n "$soffice" ] || { echo "⚠ MSI 展开后找不到 program/soffice.exe" >&2; return 1; }
  local program_dir
  program_dir="$(dirname "$soffice")"
  mkdir -p "$OFFICE_ROOT/native/libreoffice-headless/program"
  rm -rf "$OFFICE_ROOT/native/libreoffice-headless/program"
  cp -R "$program_dir" "$OFFICE_ROOT/native/libreoffice-headless/program"
  mkdir -p "$OFFICE_ROOT/bin"
  cp "$OFFICE_ROOT/native/libreoffice-headless/program/soffice.exe" "$OFFICE_ROOT/bin/soffice.exe"
}

install_win_poppler() {
  local url zip extract
  url="$(source_field popplerWindows url)"
  zip="$CACHE_DIR/$(basename "$url")"
  download_cached "$url" "$zip" || return 1
  extract="$CACHE_DIR/poppler-windows"
  rm -rf "$extract"
  mkdir -p "$extract"
  if command -v tar >/dev/null 2>&1; then
    tar -xf "$zip" -C "$extract" || return 1
  else
    echo "⚠ 需要 tar 才能解压 poppler-windows zip" >&2
    return 1
  fi
  local ppm
  ppm="$(find "$extract" -name pdftoppm.exe | head -1)"
  [ -n "$ppm" ] || { echo "⚠ zip 里找不到 pdftoppm.exe" >&2; return 1; }
  mkdir -p "$OFFICE_ROOT/native/poppler/bin" "$OFFICE_ROOT/bin"
  cp "$(dirname "$ppm")"/* "$OFFICE_ROOT/native/poppler/bin/"
  cp "$OFFICE_ROOT/native/poppler/bin/pdftoppm.exe" "$OFFICE_ROOT/bin/pdftoppm.exe"
}

fetch_python() {
  echo "=== Python runtime（官方 python-build-standalone）==="
  bash "$REPO_ROOT/scripts/electron/package/build-python-runtime-for-target.sh" "$PLATFORM" || return 1
  bash "$REPO_ROOT/scripts/electron/package/gen-python-runtime-manifest.sh" --required-platform "$PLATFORM" || return 1
  echo "  · Python 已就绪: $REPO_ROOT/packages/python-runtime/runtime"
}

install_official_office_runtime() {
  mkdir -p "$OFFICE_ROOT/bin" "$OFFICE_ROOT/native"
  case "$PLATFORM" in
    darwin-*)
      install_mac_libreoffice || return 1
      install_mac_poppler || return 1
      ;;
    win32-*)
      install_win_libreoffice || return 1
      install_win_poppler || return 1
      ;;
    *)
      echo "⚠ 当前平台 $PLATFORM 没有官方 Office runtime 拉取路径（支持 darwin-arm64 / darwin-x64 / win32-x64 / win32-arm64）" >&2
      return 1
      ;;
  esac
}

fetch_office() {
  echo "=== Office preview runtime（国内预构建 / 官方 LibreOffice + Poppler）==="
  if office_ready && [ "$FORCE" != "1" ]; then
    echo "  · 已存在可用 Office runtime，跳过（--force 可重建）"
    return 0
  fi

  if [ "$REGION" = "cn" ]; then
    echo "  · 国内地址优先预构建 OSS 归档，失败后回退官方源"
    install_prebuilt_office_runtime || {
      echo "⚠ 国内 Office runtime 源不可用，回退官方源" >&2
      install_official_office_runtime || return 1
    }
  else
    echo "  · 海外地址优先 LibreOffice / Poppler 官方源，失败后回退国内归档"
    install_official_office_runtime || {
      echo "⚠ 官方 Office runtime 源不可用，回退国内归档" >&2
      install_prebuilt_office_runtime || return 1
    }
  fi

  if ! office_ready; then
    echo "⚠ Office runtime 组装后仍缺少 soffice 或 pdftoppm" >&2
    return 1
  fi
  echo "  · Office 已就绪: $OFFICE_ROOT"
}

warn_step_failed() {
  echo "⚠ $1 未就绪（不阻断启动/打包）。稍后可重试: pnpm runtimes:fetch" >&2
}

STEP_FAILED=0
if [ "$ONLY" = "all" ] || [ "$ONLY" = "python" ]; then
  if ! fetch_python; then
    warn_step_failed "Python runtime"
    STEP_FAILED=1
  fi
fi
if [ "$ONLY" = "all" ] || [ "$ONLY" = "office" ]; then
  if ! fetch_office; then
    warn_step_failed "Office preview runtime"
    STEP_FAILED=1
  fi
fi

if [ "$STEP_FAILED" -eq 0 ]; then
  echo "✅ 桌面运行时已准备。随后可打包："
  echo "   bash apps/tabtin-electron/scripts/build-packaged-app.sh mac local"
  exit 0
fi

if [ "$STRICT" -eq 1 ]; then
  echo "❌ 桌面运行时拉取失败（--strict）" >&2
  exit 1
fi
exit 0
