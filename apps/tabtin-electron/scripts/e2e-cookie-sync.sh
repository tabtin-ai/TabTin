#!/usr/bin/env bash
# Wave 2b 任务 E · 真实 Electron session E2E 脚本的 shell wrapper。
#
# 负责：
#   1. 检查前置（electron bin、esbuild 可用）
#   2. 用 esbuild 把 e2e-cookie-sync.ts（含 CookieSyncService 真源）打包成
#      单文件 CJS（external: electron）——这样 Electron 可直接 require 运行，
#      不需要在运行时挂任何 TS loader（TSX/ESM loader 在 Electron 的 node 内
#      嵌版本下行为不稳定，而 esbuild 打包是 O(20ms) 的 offline 转换）
#   3. 启动 Electron 加载打包产物；打印断言结果；退出码对齐 TS 脚本
#
# 使用：
#   # 有 display（本地 macOS / Linux 桌面）
#   bash apps/tabtin-electron/scripts/e2e-cookie-sync.sh
#
#   # 无 display（CI Linux 容器 / 远程机器）
#   xvfb-run -a bash apps/tabtin-electron/scripts/e2e-cookie-sync.sh
#
# 环境要求：Electron 运行时依赖（libgtk-3、libatk、libgbm 等）。缺失会报
# "error while loading shared libraries"——请在 CI 镜像中安装或用 xvfb。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"

GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

log() { echo -e "${YELLOW}[e2e-cookie-sync]${RESET} $*"; }
err() { echo -e "${RED}[e2e-cookie-sync]${RESET} $*" >&2; }

ELECTRON_BIN="${APP_DIR}/node_modules/.bin/electron"
if [[ ! -x "${ELECTRON_BIN}" ]]; then
  ELECTRON_BIN="${REPO_ROOT}/node_modules/.bin/electron"
fi
if [[ ! -x "${ELECTRON_BIN}" ]]; then
  err "未找到 electron bin — 请先跑 pnpm install"
  exit 2
fi

# 定位 esbuild 二进制（pnpm hoist 后常驻 .pnpm 下）
ESBUILD_BIN="$(find "${REPO_ROOT}/node_modules/.pnpm" -maxdepth 5 -path '*/esbuild/bin/esbuild' -type f 2>/dev/null | head -n 1)"
if [[ -z "${ESBUILD_BIN}" || ! -x "${ESBUILD_BIN}" ]]; then
  err "未找到 esbuild bin — 请先跑 pnpm install"
  exit 2
fi

SCRIPT_TS="${SCRIPT_DIR}/e2e-cookie-sync.ts"
if [[ ! -f "${SCRIPT_TS}" ]]; then
  err "未找到 ${SCRIPT_TS}"
  exit 2
fi

# Bundle 到项目内临时目录 —— 关键是 Node 的 require 解析会沿着**bundle 文件所在
# 路径**向上找 `node_modules`。放 /tmp 找不到 `keytar` 等 external 包；放项目内
# 能沿着 apps/tabtin-electron/node_modules → repo-root/node_modules 解析到。
BUNDLE_DIR="${APP_DIR}/.e2e-bundle"
mkdir -p "${BUNDLE_DIR}"
BUNDLE_OUT="${BUNDLE_DIR}/cookie-sync.$$.cjs"
trap 'rm -f "${BUNDLE_OUT}"' EXIT

log "Electron: ${ELECTRON_BIN}"
log "脚本: ${SCRIPT_TS}"
log "esbuild 打包 → ${BUNDLE_OUT}"

"${ESBUILD_BIN}" \
  --bundle \
  --platform=node \
  --target=node18 \
  --format=cjs \
  --external:electron \
  --external:keytar \
  --log-level=warning \
  "--outfile=${BUNDLE_OUT}" \
  "${SCRIPT_TS}"

log "启动 Electron…"
cd "${APP_DIR}"
# E2E 脚本用 FakeBrowserEnvironmentService，不依赖真实后端；但 api 配置模块
# 会在模块加载时校验 API_BASE_URL 必填，所以注入一个 dummy 以通过校验。
export TABTIN_API_BASE_URL="${TABTIN_API_BASE_URL:-http://e2e.invalid/api}"
"${ELECTRON_BIN}" \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  "${BUNDLE_OUT}"
