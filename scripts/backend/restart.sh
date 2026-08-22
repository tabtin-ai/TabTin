#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/backend/_load-scheme.sh"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/backend/_centrifugo-helpers.sh"
# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/backend/_redis-ready.sh"

LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
LONGPOLL_PID_FILE="${LOG_DIR}/channel-longpoll.pid"
DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"

echo "🔄 重启 TabTin 本地后端..."
echo ""

# 先确保基础设施可用，避免停掉应用后才发现 Docker/DB 未就绪。
echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 检查本地基础设施 ($(_tabtin_infra_label "${ROOT_DIR}"))..."
_infra_try_start "${ROOT_DIR}"
if ! _infra_wait_ready "${ROOT_DIR}" 60; then
  echo "  ❌ 基础设施未就绪，已中止；当前应用进程未被停止。"
  exit 1
fi
echo "  ✅ 基础设施已就绪"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🛑 清理历史后端进程..."
bash "${ROOT_DIR}/scripts/backend/django-stop.sh" || true
CELERY_STOP_GRACEFUL_TIMEOUT="${CELERY_STOP_GRACEFUL_TIMEOUT:-20}" \
  bash "${ROOT_DIR}/scripts/backend/celery-stop.sh" || true

if [[ -f "${LONGPOLL_PID_FILE}" ]]; then
  longpoll_pid="$(cat "${LONGPOLL_PID_FILE}")"
  if kill -0 "${longpoll_pid}" 2>/dev/null; then
    kill -TERM "${longpoll_pid}" 2>/dev/null || true
    sleep 1
    kill -9 "${longpoll_pid}" 2>/dev/null || true
  fi
  rm -f "${LONGPOLL_PID_FILE}"
fi
# PID 文件可能在异常退出时丢失，再按本项目 venv 的命令行清理孤儿 Longpoll。
pkill -TERM -f "${DJANGO_DIR}/venv/bin/python.*manage.py run_longpoll" 2>/dev/null || true
sleep 1
pkill -9 -f "${DJANGO_DIR}/venv/bin/python.*manage.py run_longpoll" 2>/dev/null || true

bash "${ROOT_DIR}/scripts/backend/collab-live-stop.sh" || true
_centrifugo_stop "${ROOT_DIR}"
echo "  ✅ 历史后端进程已清理"
echo ""

# 后端的启动顺序、迁移和健康检查继续由单一入口维护。
bash "${ROOT_DIR}/scripts/backend/start.sh"
