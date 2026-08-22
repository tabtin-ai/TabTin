#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"

# ── systemd 模式：单元已安装时优先使用（INFRA-13） ──
_systemd_available() {
  command -v systemctl &>/dev/null \
    && systemctl is-enabled tabtin-celery.target &>/dev/null 2>&1
}

if _systemd_available; then
  echo "🛑 通过 systemctl 停止 Celery..."
  sudo systemctl stop tabtin-celery.target
  echo "✅ Celery 全部进程已通过 systemd 停止"
  exit 0
fi

# ── 回退：PID 文件模式（开发环境） ──
CRITICAL_PID_FILE="${LOG_DIR}/celery-critical.pid"
DEFAULT_PID_FILE="${LOG_DIR}/celery-default.pid"
REALTIME_PID_FILE="${LOG_DIR}/celery-realtime.pid"
DATA_AI_PID_FILE="${LOG_DIR}/celery-data-ai.pid"
HEAVY_PID_FILE="${LOG_DIR}/celery-heavy.pid"
AI_BACKGROUND_PID_FILE="${LOG_DIR}/celery-ai-background.pid"
BEAT_PID_FILE="${LOG_DIR}/celery-beat.pid"
SCHEDULER_PID_FILE="${LOG_DIR}/celery-scheduler.pid"

echo "🛑 停止 Celery..."

# INFRA-7 修复：从 8s 提升为 120s。
# 原值 8s 后直接 kill -9：acks_late 任务未 ack，消息重入 visibility_timeout 排队（最长 3600s），
# 等价于 critical 队列（含支付回调）任务消失最长 1 小时。
# 120s 给正在执行的 critical 任务（time_limit=120s）足够时间完成并 ack。
# 本地快速重启可：CELERY_STOP_GRACEFUL_TIMEOUT=20 bash scripts/backend/celery-stop.sh
GRACEFUL_TIMEOUT="${CELERY_STOP_GRACEFUL_TIMEOUT:-120}"

stop_pid() {
  local pid_file="$1"
  local name="$2"

  if [[ -f "${pid_file}" ]]; then
    local pid
    pid="$(cat "${pid_file}")"
    if kill -0 "${pid}" >/dev/null 2>&1; then
      echo "  停止 ${name} (PID: ${pid})，等待最多 ${GRACEFUL_TIMEOUT}s 优雅退出..."
      kill -TERM "${pid}" 2>/dev/null || true

      local waited=0
      while kill -0 "${pid}" >/dev/null 2>&1 && [[ $waited -lt $GRACEFUL_TIMEOUT ]]; do
        sleep 1
        waited=$((waited + 1))
      done

      if kill -0 "${pid}" >/dev/null 2>&1; then
        echo "  进程未响应，强制杀死..."
        kill -9 "${pid}" 2>/dev/null || true
      fi
      echo "  ✅ ${name} 已停止"
    else
      echo "  ⚠️  ${name} PID 文件中的进程已不存在 (${pid})"
    fi
    rm -f "${pid_file}"
  fi
}

FTS_PID_FILE="${LOG_DIR}/celery-fts.pid"

stop_pid "${CRITICAL_PID_FILE}" "Celery critical worker"
stop_pid "${DEFAULT_PID_FILE}" "Celery default worker"
stop_pid "${REALTIME_PID_FILE}" "Celery realtime worker"
stop_pid "${DATA_AI_PID_FILE}" "Celery data-ai worker"
stop_pid "${HEAVY_PID_FILE}" "Celery heavy worker"
stop_pid "${AI_BACKGROUND_PID_FILE}" "Celery ai-background worker"
stop_pid "${BEAT_PID_FILE}" "Celery beat"
stop_pid "${SCHEDULER_PID_FILE}" "Celery scheduler worker"
stop_pid "${FTS_PID_FILE}" "Celery fts worker"

# 清理残留进程（prefork 子进程等）：先 SIGTERM，等待 ${GRACEFUL_TIMEOUT}s，再 SIGKILL 兜底
# 注意：此段等待时间与每个 PID 文件的 GRACEFUL_TIMEOUT 保持一致，
# 避免绕过上方逐进程优雅退出的保护。
set +e
REMAINING=$(pgrep -f "celery" 2>/dev/null | wc -l | tr -d ' ')
set -e
if [[ -n "$REMAINING" && $REMAINING -gt 0 ]]; then
  echo "  🔍 发现 ${REMAINING} 个残留 Celery 进程，发送 SIGTERM，等待最多 ${GRACEFUL_TIMEOUT}s..."
  pkill -TERM -f "celery" 2>/dev/null || true
  local_waited=0
  while true; do
    sleep 5
    local_waited=$((local_waited + 5))
    set +e
    REMAINING=$(pgrep -f "celery" 2>/dev/null | wc -l | tr -d ' ')
    set -e
    if [[ -z "$REMAINING" || $REMAINING -eq 0 ]]; then
      break
    fi
    if [[ $local_waited -ge $GRACEFUL_TIMEOUT ]]; then
      echo "  ⚠️  仍有 ${REMAINING} 个残留（等待 ${local_waited}s），强制清理..."
      pkill -9 -f "celery" 2>/dev/null || true
      break
    fi
  done
fi

echo "  ✅ Celery 已完全停止"

# Windows / Git Bash：pkill 经常杀不掉 venv\Scripts\python.exe / 系统 python 子进程，
# 残留 worker 会与下次启动抢同一 -n 节点名，导致「exited immediately」。
case "$(uname -s 2>/dev/null):${OS:-}" in
  MINGW*|MSYS*|CYGWIN*|*:Windows_NT)
    echo "  🔍 Windows 兜底：清理残留 celery -A tabtin 进程..."
    powershell.exe -NoProfile -Command \
      "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -and \$_.CommandLine -match 'celery -A tabtin' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" \
      >/dev/null 2>&1 || true
    ;;
esac

exit 0
