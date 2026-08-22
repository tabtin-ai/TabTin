#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_safe-port-kill.sh"

LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
PID_FILE="${LOG_DIR}/collab-live.pid"

echo "🛑 停止 Collab Live..."

if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}")"
  if kill -0 "${PID}" >/dev/null 2>&1; then
    echo "  停止进程 (PID: ${PID})..."
    kill -TERM "${PID}" 2>/dev/null || true

    waited=0
    while kill -0 "${PID}" >/dev/null 2>&1 && [[ ${waited} -lt 5 ]]; do
      sleep 1
      waited=$((waited + 1))
    done

    if kill -0 "${PID}" >/dev/null 2>&1; then
      echo "  进程未响应，强制杀死..."
      kill -9 "${PID}" 2>/dev/null || true
    fi
    echo "  ✅ 已停止 (PID: ${PID})"
  else
    echo "  ⚠️  PID 文件中的进程已不存在 (${PID})"
  fi
  rm -f "${PID_FILE}"
fi

echo "  🔍 清理 ${COLLAB_LIVE_PORT} 端口上的残留进程..."
_safe_kill_port "${COLLAB_LIVE_PORT}"
sleep 1

echo "  ✅ Collab Live 已完全停止"
exit 0
