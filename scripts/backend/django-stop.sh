#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_safe-port-kill.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_celery-platform.sh"

DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
PID_FILE="${DJANGO_DIR}/logs/django-dev.pid"
BIND_PORT="${DJANGO_BIND_PORT}"

echo "🛑 停止 Django..."

# 1. 尝试通过 PID 文件停止
if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}")"
  if _celery_pid_alive "${PID}"; then
    echo "  停止进程 (PID: ${PID})..."
    if _celery_platform_is_windows; then
      powershell.exe -NoProfile -Command "Stop-Process -Id ${PID} -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
    else
      kill -TERM "${PID}" 2>/dev/null || true
      sleep 1
      if _celery_pid_alive "${PID}"; then
        echo "  进程未响应，强制杀死..."
        kill -9 "${PID}" 2>/dev/null || true
      fi
    fi
    echo "  ✅ 已停止 (PID: ${PID})"
  else
    echo "  ⚠️  PID 文件中的进程已不存在 (${PID})"
  fi
  rm -f "${PID_FILE}"
fi

# 2. 清理占用当前方案端口的残留进程（不影响其他隔离方案）
# Windows 上 lsof 常看不到 Win32 监听进程，直接走 _safe_kill_port（内含 PowerShell 回退）
echo "  🔍 清理 ${BIND_PORT} 端口残留（如有）..."
_safe_kill_port "${BIND_PORT}"

# 4. 清理 Redis 中的 WS 连接计数（强杀进程时 disconnect 无法正常递减）
if command -v redis-cli >/dev/null 2>&1; then
  WS_KEYS=$(redis-cli --no-auth-warning KEYS 'ws:conn:*' 2>/dev/null || true)
  if [[ -n "${WS_KEYS}" ]]; then
    echo "${WS_KEYS}" | xargs redis-cli --no-auth-warning DEL >/dev/null 2>&1 || true
    echo "  🧹 已清理 Redis WS 连接计数"
  fi
fi

echo "  ✅ Django 已完全停止"
exit 0
