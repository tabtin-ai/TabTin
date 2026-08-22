#!/usr/bin/env bash
# Wave 4 T5 · 真实 Electron session E2E：Agent 后台 view 自动 fill+submit。
#
# 使用：
#   bash apps/tabtin-electron/scripts/e2e-agent-autofill.sh
#   xvfb-run -a bash apps/tabtin-electron/scripts/e2e-agent-autofill.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${APP_DIR}/../.." && pwd)"

GREEN="\033[32m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

log() { echo -e "${YELLOW}[e2e-agent-autofill]${RESET} $*"; }
err() { echo -e "${RED}[e2e-agent-autofill]${RESET} $*" >&2; }

ELECTRON_BIN="${APP_DIR}/node_modules/.bin/electron"
if [[ ! -x "${ELECTRON_BIN}" ]]; then
  ELECTRON_BIN="${REPO_ROOT}/node_modules/.bin/electron"
fi
if [[ ! -x "${ELECTRON_BIN}" ]]; then
  err "未找到 electron bin — 请先跑 pnpm install"
  exit 2
fi

ESBUILD_BIN="$(find "${REPO_ROOT}/node_modules/.pnpm" -maxdepth 5 -path '*/esbuild/bin/esbuild' -type f 2>/dev/null | head -n 1)"
if [[ -z "${ESBUILD_BIN}" || ! -x "${ESBUILD_BIN}" ]]; then
  err "未找到 esbuild bin — 请先跑 pnpm install"
  exit 2
fi

SCRIPT_TS="${SCRIPT_DIR}/e2e-agent-autofill.ts"
if [[ ! -f "${SCRIPT_TS}" ]]; then
  err "未找到 ${SCRIPT_TS}"
  exit 2
fi

BUNDLE_DIR="${APP_DIR}/.e2e-bundle"
mkdir -p "${BUNDLE_DIR}"
BUNDLE_OUT="${BUNDLE_DIR}/agent-autofill.$$.cjs"
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
export TABTIN_API_BASE_URL="${TABTIN_API_BASE_URL:-http://e2e.invalid/api}"
"${ELECTRON_BIN}" \
  --no-sandbox \
  --disable-gpu \
  --disable-software-rasterizer \
  "${BUNDLE_OUT}"
