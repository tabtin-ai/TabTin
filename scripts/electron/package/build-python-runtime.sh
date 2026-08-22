#!/usr/bin/env bash
# build-python-runtime.sh —— L2 构建层：产出 TabTin 自管 Python 运行时归档。
#
# 流程（A1 + B1）：
#   1. 从 python-build-standalone(astral) 下载 install_only_stripped 解释器（可重定位）
#   2. 用该解释器 pip 安装冻结依赖到其自带 site-packages（离线、确定，避 Codex ）
#   3. 打成 tabtin-python-runtime.tar.gz（内容 = dependencies/python 目录本体）
#   4. 算 sha256 + size 并打印
#
# 注意：manifest **不在此生成**——它在 electron 打包阶段由
# scripts/electron/package/gen-python-runtime-manifest.sh 从本地归档算 sha 生成。
# build-packaged-app.sh 在 Electron 打包阶段通过 prepare-python-runtime-for-electron-packaging.sh 调用。
# 本脚本每次只构建「指定或当前平台」的产物（CI 各平台 runner 分别跑）。不读取任何 codex 路径。
#
# 环境变量：
#   PY_VERSION                 默认 3.12.13     —— 解释器版本 pin
#   PBS_RELEASE                默认 20260610    —— python-build-standalone release tag
#   PBS_VARIANT                默认 install_only_stripped —— PBS 资产变体（可切 install_only）
#   TABTIN_PBS_CACHE_DIR       可选            —— PBS 下载缓存目录（默认使用用户缓存目录）
#   TARGET_MANIFEST_PLATFORM   可选            —— 目标平台键（darwin-arm64 / darwin-x64 / win32-x64 …）
#   TARGET_TRIPLE              可选            —— 覆盖 PBS 三元组（默认由 TARGET_MANIFEST_PLATFORM 推导）
#   ARCHIVE_NAME               可选            —— 覆盖产物文件名（默认取 runtime.config.json archives）
set -euo pipefail

PY_VERSION="${PY_VERSION:-3.12.13}"
PBS_RELEASE="${PBS_RELEASE:-20260610}"
PBS_VARIANT="${PBS_VARIANT:-install_only_stripped}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/python-runtime"
RUNTIME_OUT_DIR="$PKG_DIR/runtime"
REQUIREMENTS="$PKG_DIR/requirements.txt"

manifest_platform_to_triple() {
    case "$1" in
        darwin-arm64) echo "aarch64-apple-darwin" ;;
        darwin-x64) echo "x86_64-apple-darwin" ;;
        win32-x64) echo "x86_64-pc-windows-msvc" ;;
        win32-arm64) echo "aarch64-pc-windows-msvc" ;;
        linux-x64) echo "x86_64-unknown-linux-gnu" ;;
        linux-arm64) echo "aarch64-unknown-linux-gnu" ;;
        *) echo "unsupported-$1" ;;
    esac
}

# ---- 平台三元组（python-build-standalone 命名）----
detect_triple() {
    manifest_platform_to_triple "$(detect_manifest_platform)"
}

# node process.platform-process.arch，用于 manifest.platform
detect_manifest_platform() {
    local os arch
    os="$(uname -s)"; arch="$(uname -m)"
    local node_os node_arch
    case "$os" in
        Darwin) node_os=darwin ;;
        Linux) node_os=linux ;;
        MINGW*|MSYS*|CYGWIN*) node_os=win32 ;;
        *) node_os="$os" ;;
    esac
    case "$arch" in arm64|aarch64) node_arch=arm64 ;; x86_64|amd64) node_arch=x64 ;; *) node_arch="$arch" ;; esac
    echo "${node_os}-${node_arch}"
}

MANIFEST_PLATFORM="${TARGET_MANIFEST_PLATFORM:-$(detect_manifest_platform)}"
TRIPLE="${TARGET_TRIPLE:-$(manifest_platform_to_triple "$MANIFEST_PLATFORM")}"
if [[ "$TRIPLE" == unsupported-* ]]; then
    echo "不支持的平台三元组: $TRIPLE" >&2
    exit 1
fi

# 产物名单一事实源：runtime.config.json archives。<platform>
CONFIG_JSON="$PKG_DIR/runtime.config.json"
derive_archive_name() {
    [ -n "${ARCHIVE_NAME:-}" ] && { printf '%s\n' "$ARCHIVE_NAME"; return 0; }
    if command -v node >/dev/null 2>&1 && [ -f "$CONFIG_JSON" ]; then
        node -e '
            const fs=require("fs");
            const cfg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
            const name=(cfg.archives||{})[process.argv[2]];
            if(name) process.stdout.write(name);
        ' "$CONFIG_JSON" "$MANIFEST_PLATFORM" 2>/dev/null && return 0
    fi
    return 1
}
ARCHIVE_NAME="$(derive_archive_name || true)"
[ -n "$ARCHIVE_NAME" ] || ARCHIVE_NAME="tabtin-python-runtime-${MANIFEST_PLATFORM}.tar.gz"
mkdir -p "$RUNTIME_OUT_DIR"
ARCHIVE_PATH="$RUNTIME_OUT_DIR/$ARCHIVE_NAME"

PBS_ASSET="cpython-${PY_VERSION}+${PBS_RELEASE}-${TRIPLE}-${PBS_VARIANT}.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${PBS_ASSET}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ 准备 python-build-standalone (${MANIFEST_PLATFORM} / ${TRIPLE}): $PBS_URL"
PBS_ARCHIVE="$(bash "$REPO_ROOT/scripts/electron/package/cache-python-build-standalone.sh" "$PBS_URL" "$PBS_ASSET")"

echo "→ 解压解释器"
tar -xzf "$PBS_ARCHIVE" -C "$WORK"   # 得到 $WORK/python/{bin,lib,...}（win 为 python/python.exe）
PY_ROOT="$WORK/python"
# 解释器入口按**目标**平台：win 为根部 python.exe，posix 为 bin/python3。
case "$MANIFEST_PLATFORM" in
  win32-*)
    PY_BIN="$PY_ROOT/python.exe"
    ;;
  *)
    PY_BIN="$PY_ROOT/bin/python3"
    ;;
esac
[ -f "$PY_BIN" ] || { echo "解释器入口缺失: $PY_BIN" >&2; exit 1; }

run_target_python() {
  # Apple Silicon 打 Intel Mac 包：用 Rosetta 跑 x64 解释器完成 pip 安装。
  if [ "$MANIFEST_PLATFORM" = "darwin-x64" ] && [ "$(uname -m)" = "arm64" ] && command -v arch >/dev/null 2>&1; then
    arch -x86_64 "$PY_BIN" "$@"
    return $?
  fi
  "$PY_BIN" "$@"
}

echo "→ 安装冻结依赖到自带 site-packages"
run_target_python -m pip install --disable-pip-version-check --no-input -r "$REQUIREMENTS"

echo "→ 打归档 ${ARCHIVE_NAME}（内容 = dependencies/python 本体）"
tar -czf "$ARCHIVE_PATH" -C "$PY_ROOT" .

echo "→ 计算 sha256 + size"
if command -v shasum >/dev/null 2>&1; then
    SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
else
    SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
fi
SIZE="$(wc -c < "$ARCHIVE_PATH" | tr -d ' ')"

echo "  sha256=$SHA256 size=$SIZE platform=$MANIFEST_PLATFORM"

echo "✅ 完成：$ARCHIVE_PATH"
echo "   platform=${MANIFEST_PLATFORM}  sha256=${SHA256}  size=${SIZE}"
echo "   归档留在 packages/python-runtime/runtime，Electron 打包时随包分发。"
