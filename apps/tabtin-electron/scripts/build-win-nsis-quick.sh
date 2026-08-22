#!/bin/bash
# Windows 高频 local NSIS 快路径（对齐 build-mac-dmg-quick.sh）
#
# 与完整 build:win:local 的差异：
#   - TABTIN_PACK_QUICK=1：跳过 sourcemap
#   - Windows 复用按依赖契约校验的 deploy；命中后刷新当前 workspace 包产物
#   - NSIS compression 默认 normal（对齐 Mac 体积量级；TABTIN_WIN_NSIS_COMPRESSION 可改）
#   - 单遍 deep prune 先移除 build.files 已排除的 map/types/tests/docs，减少 builder 扫描
# 不变（保证产物可用）：
#   - Office/Python/embedding/filegen/CLI staging
#   - Windows deploy 外链物化（ensure-deploy-self-contained.mjs，与正式包共用 build-packaged-app.sh）
#   - electron-builder NSIS + packaged artifact audit（blocking）
#
# 用法：
#   bash scripts/build-win-nsis-quick.sh              # local x64
#   TABTIN_WIN_NSIS_COMPRESSION=normal bash scripts/build-win-nsis-quick.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

PROFILE="${1:-${TABTIN_BUILD_PROFILE:-local}}"
ARCH="${2:-${TABTIN_BUILD_ARCH:-x64}}"

if [ "$PROFILE" != "local" ]; then
  echo "Unsupported profile for win quick: $PROFILE (仅允许 local)" >&2
  exit 1
fi

case "$ARCH" in
  x64|arm64) ;;
  *)
    echo "Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    if [ "${OS:-}" != "Windows_NT" ]; then
      echo "Windows NSIS quick build 应在 Windows 打包机（Git Bash / MSYS）上运行。" >&2
      exit 1
    fi
    ;;
esac

PACK_TIMING_SCRIPT="${REPO_ROOT}/scripts/_pack-timing.sh"
if [ -f "$PACK_TIMING_SCRIPT" ]; then
  # shellcheck disable=SC1091
  source "$PACK_TIMING_SCRIPT"
else
  pack_time_begin() { :; }
  pack_time_step() { "$@"; }
  pack_time_summary() { :; }
fi

pack_time_begin "Win NSIS quick (profile=${PROFILE}, arch=${ARCH})"
echo "=== TabTin Windows NSIS Quick (profile=${PROFILE}, arch=${ARCH}) ==="
echo "  · quick：跳过 sourcemap 生成及上传；保留 staging + audit"
echo "  · deploy strategy: validated warm cache（依赖变化自动全量重建）"
echo "  · NSIS compression: ${TABTIN_WIN_NSIS_COMPRESSION:-normal}"

pack_time_step "quick NSIS 构建" \
  env TABTIN_PACK_QUICK=1 TABTIN_BUILD_PROFILE="$PROFILE" TABTIN_BUILD_ARCH="$ARCH" \
  bash "$SCRIPT_DIR/build-packaged-app.sh" win "$PROFILE" "$ARCH"

echo ""
echo "=== Win NSIS quick complete ==="
find "$APP_DIR/dist-app" -maxdepth 1 -type f \( -name '*Setup*.exe' -o -name '*.exe' \) 2>/dev/null | sort || true
pack_time_summary
