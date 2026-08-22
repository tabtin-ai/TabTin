#!/usr/bin/env bash
set -euo pipefail

# 增量模式：本地协同服务
# -----------------------------------------------------------------------------
# 用途：
#   只启动本地 Collab-Live 服务，用于调试实时协同代码。
#   这是默认轻量模式的增量能力，不是替代方案。
#
# 本脚本会启动：
#   - 先增量构建 Collab 的 workspace 依赖闭包（@tabtin/doc-editor 等 export dist 的包）
#   - Collab-Live，端口为 COLLAB_LIVE_PORT（默认 4100）
#
# 本脚本不会启动：
#   - Electron/Web 客户端
#   - Django
#   - PostgreSQL / Redis
#   - Celery worker / beat
#   - Centrifugo
#
# 启动顺序：
#   - 和任务调试没有固定先后顺序。
#   - 可以先运行本脚本，再运行 celery-worker-local.sh。
#   - 也可以先运行 celery-worker-local.sh，再运行本脚本。
#   - 两者是互相独立的增量进程。
#
# 注意：
#   - 如果要让客户端使用本地 Collab-Live，需要在 .env.local 设置：
#       VITE_COLLAB_WS_BASE=ws://127.0.0.1:4100
#     然后重启客户端。
#   - 本脚本当前会让 Collab-Live 指向本地 Django：
#       DJANGO_API_URL=http://127.0.0.1:${DJANGO_BIND_PORT}
#     因此如果要验证持久化/API 回调，本地 Django 也需要运行。
# -----------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_safe-port-kill.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_detach-spawn.sh"

ENV_LOCAL="${ROOT_DIR}/.env.local"
if [[ -f "${ENV_LOCAL}" ]]; then
  if [[ -z "${LIVE_SECRET:-}" ]]; then
    LIVE_SECRET="$(grep -E '^LIVE_SECRET=' "${ENV_LOCAL}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)"
  fi
  if [[ -z "${LIVE_SECRET:-}" ]]; then
    LIVE_SECRET="$(grep -E '^COLLAB_LIVE_SECRET=' "${ENV_LOCAL}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)"
  fi
fi
export LIVE_SECRET

COLLAB_LIVE_DIR="${ROOT_DIR}/apps/collab-live"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
PID_FILE="${LOG_DIR}/collab-live.pid"
LOG_FILE="${LOG_DIR}/collab-live.log"

if [[ ! -d "${COLLAB_LIVE_DIR}" ]]; then
  echo "⚠️  ${COLLAB_LIVE_DIR} 不存在，跳过 Collab Live 启动"
  exit 0
fi

if [[ -f "${PID_FILE}" ]]; then
  if kill -0 "$(cat "${PID_FILE}")" >/dev/null 2>&1; then
    echo "Collab Live already running (pid $(cat "${PID_FILE}"))"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

echo "🔍 清理 ${COLLAB_LIVE_PORT} 端口上的残留进程..."
_safe_kill_port "${COLLAB_LIVE_PORT}"
sleep 1

mkdir -p "${LOG_DIR}"

# Collab 走 tsx 源码，但 workspace 包 export dist。启动前按真实依赖图增量补齐，
# 避免冷启动缺 @tabtin/doc-editor / @tabtin/config 等导致 4100 健康检查失败。
echo "🔍 准备 Collab workspace 依赖..."
node "${ROOT_DIR}/scripts/electron/run-predev-build-with-lock.mjs" --seed collab-live

# 同 django-start：脱离 Cursor 短 shell 的进程组（nohup 不够）。
export NODE_ENV=development
export PORT="${COLLAB_LIVE_PORT}"
export DJANGO_API_URL="http://127.0.0.1:${DJANGO_BIND_PORT}"
_detach_spawn "${PID_FILE}" "${LOG_FILE}" "${COLLAB_LIVE_DIR}" -- npx tsx src/start.ts

echo "Collab Live started (pid $(cat "${PID_FILE}"), port ${COLLAB_LIVE_PORT})"
