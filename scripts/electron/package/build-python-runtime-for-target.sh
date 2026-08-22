#!/usr/bin/env bash
# build-python-runtime-for-target.sh —— 按目标平台构建 TabTin 自管 Python 运行时重档（L2 入口）。
#
# 用法：
#   bash scripts/electron/package/build-python-runtime-for-target.sh
#   bash scripts/electron/package/build-python-runtime-for-target.sh darwin-arm64
#   bash scripts/electron/package/build-python-runtime-for-target.sh darwin-x64
#   bash scripts/electron/package/build-python-runtime-for-target.sh win32-x64
#
# 环境变量：
#   TABTIN_FORCE_PYTHON_RUNTIME_BUILD=1  强制重建（即使产物已存在）
#   TABTIN_PYTHON_RUNTIME_REQUIRED=1     构建失败时 exit 1
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PY_RUNTIME_PKG_DIR="$REPO_ROOT/packages/python-runtime"
PY_RUNTIME_OUT_DIR="$PY_RUNTIME_PKG_DIR/runtime"

HOST_ARCH_RAW="$(uname -m)"
case "$HOST_ARCH_RAW" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|amd64) HOST_ARCH="x64" ;;
  *) HOST_ARCH="x64" ;;
esac

case "$(uname -s)" in
  Darwin) HOST_RUNTIME="darwin" ;;
  Linux) HOST_RUNTIME="linux" ;;
  MINGW*|MSYS*|CYGWIN*) HOST_RUNTIME="win32" ;;
  *) HOST_RUNTIME="unknown" ;;
esac

detect_manifest_platform() {
  case "$HOST_RUNTIME" in
    darwin|win32|linux) echo "${HOST_RUNTIME}-${HOST_ARCH}" ;;
    *) return 1 ;;
  esac
}

TARGET_MANIFEST_PLATFORM="${1:-$(detect_manifest_platform || true)}"
if [ -z "$TARGET_MANIFEST_PLATFORM" ]; then
  echo "❌ 无法推断 Python 运行时目标平台，请显式传入 darwin-arm64 / darwin-x64 / win32-x64 / win32-arm64 / linux-x64 / linux-arm64" >&2
  exit 1
fi

derive_python_runtime_archive_name() {
  node -e '
    const fs = require("fs")
    const path = require("path")
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const name = (cfg.archives || {})[process.argv[2]]
    if (!name) process.exit(1)
    process.stdout.write(name)
  ' "$PY_RUNTIME_PKG_DIR/runtime.config.json" "$TARGET_MANIFEST_PLATFORM" 2>/dev/null
}

ARCHIVE_NAME="$(derive_python_runtime_archive_name || echo "tabtin-python-runtime-${TARGET_MANIFEST_PLATFORM}.tar.gz")"
ARCHIVE_PATH="$PY_RUNTIME_OUT_DIR/$ARCHIVE_NAME"
REQUIRED="${TABTIN_PYTHON_RUNTIME_REQUIRED:-0}"

python_runtime_dist_ready() {
  [ -s "$ARCHIVE_PATH" ] && [ "${TABTIN_FORCE_PYTHON_RUNTIME_BUILD:-0}" != "1" ]
}

if python_runtime_dist_ready; then
  echo "  · 跳过 Python 运行时构建：产物已存在 $ARCHIVE_PATH"
  exit 0
fi

can_build_python_runtime_on_host() {
  case "$TARGET_MANIFEST_PLATFORM" in
    darwin-arm64)
      [ "$HOST_RUNTIME" = "darwin" ] && [ "$HOST_ARCH" = "arm64" ]
      ;;
    darwin-x64)
      [ "$HOST_RUNTIME" = "darwin" ]
      ;;
    win32-x64)
      [ "$HOST_RUNTIME" = "win32" ] && [ "$HOST_ARCH" = "x64" ]
      ;;
    win32-arm64)
      [ "$HOST_RUNTIME" = "win32" ] && [ "$HOST_ARCH" = "arm64" ]
      ;;
    linux-x64)
      [ "$HOST_RUNTIME" = "linux" ] && [ "$HOST_ARCH" = "x64" ]
      ;;
    linux-arm64)
      [ "$HOST_RUNTIME" = "linux" ] && [ "$HOST_ARCH" = "arm64" ]
      ;;
    *)
      return 1
      ;;
  esac
}

run_python_runtime_build() {
  export TARGET_MANIFEST_PLATFORM
  if [ "$HOST_RUNTIME" = "win32" ] && command -v powershell.exe >/dev/null 2>&1; then
    local ps1_path="$REPO_ROOT/scripts/electron/package/build-python-runtime.ps1"
    if command -v cygpath >/dev/null 2>&1; then
      ps1_path="$(cygpath -w "$ps1_path")"
    elif [[ "$ps1_path" =~ ^/[a-zA-Z]/ ]]; then
      local drive rest
      drive="$(printf '%s' "${ps1_path:1:1}" | tr '[:lower:]' '[:upper:]')"
      rest="${ps1_path:3}"
      ps1_path="${drive}:\\${rest//\//\\}"
    fi
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ps1_path"
    return $?
  fi
  bash "$REPO_ROOT/scripts/electron/package/build-python-runtime.sh"
}

if ! can_build_python_runtime_on_host; then
  if [ "$REQUIRED" = "1" ]; then
    echo "❌ 当前宿主无法现场构建 ${TARGET_MANIFEST_PLATFORM}，且缺少产物 ${ARCHIVE_PATH}" >&2
    echo "   请在对应 OS runner 构建，或预置本地归档到 packages/python-runtime/runtime。" >&2
    exit 1
  fi
  echo "  · 跳过 Python 运行时构建：宿主不支持 ${TARGET_MANIFEST_PLATFORM}" >&2
  exit 0
fi

echo "  · 构建 Python 运行时 (${TARGET_MANIFEST_PLATFORM})..."
if run_python_runtime_build; then
  echo "  ✓ Python 运行时构建完成: $ARCHIVE_PATH"
  echo "  · 归档将随 Electron 安装包分发"
  exit 0
fi

if [ "$REQUIRED" = "1" ]; then
  echo "❌ Python 运行时构建失败：preprod/production 包必须可 provision 内建 python" >&2
  exit 1
fi

echo "  ⚠ Python 运行时构建失败（非致命）" >&2
exit 0
