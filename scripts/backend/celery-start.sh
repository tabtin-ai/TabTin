#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_celery-platform.sh"

# CELERY_PROFILE=lite：强制 solo（未显式指定时）+ 每队列 concurrency=1 + 抬 max-memory。
# 与平台默认独立：Linux 全量仍是 prefork，lite 仍用 solo 减进程；macOS 全量默认已是 solo。
if [[ "${CELERY_PROFILE:-}" == "lite" ]]; then
  : "${CELERY_WORKER_POOL:=solo}"
  : "${CELERY_TRACKER_POOL:=solo}"
  : "${CELERY_CRITICAL_CONCURRENCY:=1}"
  : "${CELERY_DEFAULT_CONCURRENCY:=1}"
  : "${CELERY_REALTIME_CONCURRENCY:=1}"
  : "${CELERY_DATA_AI_CONCURRENCY:=1}"
  : "${CELERY_HEAVY_CONCURRENCY:=1}"
  : "${CELERY_AI_BACKGROUND_CONCURRENCY:=1}"
  : "${CELERY_TRACKER_CONCURRENCY:=1}"
  : "${CELERY_FTS_CONCURRENCY:=1}"
  # 384MB 不够 Django boot RSS；保留显式上限避免本地进程被系统提前终止。
  : "${CELERY_MAX_MEMORY:=1024000}"
  : "${CELERY_SCHEDULER_MAX_MEMORY:=1024000}"
  : "${CELERY_FTS_MAX_MEMORY:=1024000}"
  echo "ℹ️  CELERY_PROFILE=lite — pool=${CELERY_WORKER_POOL} / concurrency=1 / max_memory=${CELERY_MAX_MEMORY}"
fi

CELERY_POOL_ARGS="$(_celery_pool_args)"
CELERY_TRACKER_POOL_ARGS="$(_celery_tracker_pool_args)"
# solo 实际 max-concurrency=1；未显式指定时钉成 1，避免日志出现「concurrency: 4 (solo)」。
if [[ "${CELERY_POOL_ARGS}" == *"--pool=solo"* ]]; then
  : "${CELERY_CRITICAL_CONCURRENCY:=1}"
  : "${CELERY_DEFAULT_CONCURRENCY:=1}"
  : "${CELERY_REALTIME_CONCURRENCY:=1}"
  : "${CELERY_DATA_AI_CONCURRENCY:=1}"
  : "${CELERY_HEAVY_CONCURRENCY:=1}"
  : "${CELERY_FTS_CONCURRENCY:=1}"
fi
if [[ "${CELERY_TRACKER_POOL_ARGS}" == *"--pool=solo"* ]]; then
  : "${CELERY_TRACKER_CONCURRENCY:=1}"
fi
TRACKER_AGENT_QUEUE="$(_celery_tracker_agent_queue "${ROOT_DIR}")"
export TRACKER_AGENT_QUEUE
DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
VENV_DIR="${DJANGO_DIR}/venv"
LOG_DIR="${DJANGO_DIR}/logs"
# Maximum seconds to wait for the first log output after spawn. A cold worker
# imports the full Django URL graph and can take well over eight seconds.
CELERY_START_HEALTH_WAIT="${CELERY_START_HEALTH_WAIT:-45}"

CRITICAL_PID_FILE="${LOG_DIR}/celery-critical.pid"
DEFAULT_PID_FILE="${LOG_DIR}/celery-default.pid"
REALTIME_PID_FILE="${LOG_DIR}/celery-realtime.pid"
DATA_AI_PID_FILE="${LOG_DIR}/celery-data-ai.pid"
HEAVY_PID_FILE="${LOG_DIR}/celery-heavy.pid"
AI_BACKGROUND_PID_FILE="${LOG_DIR}/celery-ai-background.pid"
BEAT_PID_FILE="${LOG_DIR}/celery-beat.pid"
SCHEDULER_PID_FILE="${LOG_DIR}/celery-scheduler.pid"
FTS_PID_FILE="${LOG_DIR}/celery-fts.pid"
CRITICAL_LOG_FILE="${LOG_DIR}/celery-critical.log"
DEFAULT_LOG_FILE="${LOG_DIR}/celery-default.log"
REALTIME_LOG_FILE="${LOG_DIR}/celery-realtime.log"
DATA_AI_LOG_FILE="${LOG_DIR}/celery-data-ai.log"
HEAVY_LOG_FILE="${LOG_DIR}/celery-heavy.log"
AI_BACKGROUND_LOG_FILE="${LOG_DIR}/celery-ai-background.log"
BEAT_LOG_FILE="${LOG_DIR}/celery-beat.log"
SCHEDULER_LOG_FILE="${LOG_DIR}/celery-scheduler.log"
FTS_LOG_FILE="${LOG_DIR}/celery-fts.log"

cd "${DJANGO_DIR}"

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Missing venv. Run: bash scripts/backend/django-setup.sh"
  exit 1
fi

if ! PYTHON_BIN="$(_celery_venv_python "${VENV_DIR}")"; then
  echo "Missing venv Python under ${VENV_DIR} (expected Scripts/python.exe or bin/python)."
  echo "Run: bash scripts/backend/django-setup.sh"
  exit 1
fi

# Prefer explicit venv python over PATH after activate. On Windows Git Bash,
# VIRTUAL_ENV may be a Windows path and break PATH colon-splitting; console-script
# launchers (celery.exe) can also embed a broken shebang. Always use:
#   python -m celery
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

export DJANGO_SETTINGS_MODULE=tabtin.settings
# Windows / Git Bash：stdout 重定向到文件时默认块缓冲，beat 启动横幅几秒内写不进
# log，_assert_process_healthy 会误判「silent failure」并杀掉进程。
export PYTHONUNBUFFERED=1
# Windows 控制台默认 GBK：日志里的 ✓ 等字符会触发 UnicodeEncodeError（Logging error）。
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

NODE_CRITICAL="$(_celery_node_name critical "${ROOT_DIR}")"
NODE_DEFAULT="$(_celery_node_name default "${ROOT_DIR}")"
NODE_REALTIME="$(_celery_node_name realtime "${ROOT_DIR}")"
NODE_DATA_AI="$(_celery_node_name data_ai "${ROOT_DIR}")"
NODE_HEAVY="$(_celery_node_name heavy "${ROOT_DIR}")"
NODE_AI_BACKGROUND="$(_celery_node_name ai_background "${ROOT_DIR}")"
NODE_SCHEDULER="$(_celery_node_name scheduler "${ROOT_DIR}")"
NODE_FTS="$(_celery_node_name fts "${ROOT_DIR}")"

# 设置 libpq 环境变量（用于 psycopg）
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export DYLD_LIBRARY_PATH="/opt/homebrew/opt/libpq/lib:${DYLD_LIBRARY_PATH:-}"

# ⚠️ 修复 macOS fork() 崩溃问题
# 禁用 Objective-C fork 安全检查（仅在必要时使用）
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES

mkdir -p "${LOG_DIR}"

_assert_process_healthy() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  local pid
  pid="$(cat "${pid_file}")"

  for ((waited = 0; waited < CELERY_START_HEALTH_WAIT; waited++)); do
    if ! _celery_pid_alive "${pid}"; then
      echo "ERROR: Celery ${name} exited during startup (pid ${pid})."
      echo "---- last 40 lines of ${log_file} ----"
      if [[ -f "${log_file}" ]]; then
        tail -n 40 "${log_file}" || true
      else
        echo "(log file missing)"
      fi
      rm -f "${pid_file}"
      return 1
    fi
    [[ -s "${log_file}" ]] && return 0
    sleep 1
  done

  if [[ ! -s "${log_file}" ]]; then
    echo "ERROR: Celery ${name} produced no log output within ${CELERY_START_HEALTH_WAIT}s: ${log_file}"
    echo "This usually means the process never wrote a banner (silent failure)."
    if _celery_platform_is_windows; then
      powershell.exe -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
    else
      kill -TERM "${pid}" 2>/dev/null || true
      sleep 1
      kill -9 "${pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
    return 1
  fi

  return 0
}

start_worker() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  shift 3
  if [[ -f "${pid_file}" ]] && _celery_pid_alive "$(cat "${pid_file}")"; then
    echo "Celery ${name} worker already running (pid $(cat "${pid_file}"))"
  else
    # Truncate so a previous empty/stale log cannot pass the non-empty check.
    : > "${log_file}"
    # 同 django-start：脱离 Cursor 短 shell 的进程组，避免脚本退出后被整组杀掉。
    CELERY_DETACH_PID_FILE="${pid_file}" \
    CELERY_DETACH_LOG_FILE="${log_file}" \
    python - "$@" <<'PY'
import os
import subprocess
import sys

pid_file = os.environ["CELERY_DETACH_PID_FILE"]
log_file = os.environ["CELERY_DETACH_LOG_FILE"]
cmd = sys.argv[1:]
log_f = open(log_file, "w", encoding="utf-8")
proc = subprocess.Popen(
    cmd,
    stdin=subprocess.DEVNULL,
    stdout=log_f,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    env=os.environ.copy(),
)
with open(pid_file, "w", encoding="utf-8") as fh:
    fh.write(str(proc.pid))
PY
    echo "Celery ${name} worker started (pid $(cat "${pid_file}"))"
    _assert_process_healthy "${name} worker" "${pid_file}" "${log_file}"
  fi
}

# worker-critical
# 用途：关键业务任务，billing/payment/wallet/sms/membership
# 队列：critical
# 并发：${CELERY_CRITICAL_CONCURRENCY:-2}
# 禁止：heavy/media/docparse/cleanup
start_worker "critical" "${CRITICAL_PID_FILE}" "${CRITICAL_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_POOL_ARGS} \
  -Q critical -c "${CELERY_CRITICAL_CONCURRENCY:-2}" \
  --max-memory-per-child="${CELERY_MAX_MEMORY:-512000}" \
  -n "${NODE_CRITICAL}"

# worker-default
# 用途：普通轻量任务和低优先级任务
# 队列：default,low_priority
# 并发：${CELERY_DEFAULT_CONCURRENCY:-4}
# 禁止：realtime/RAG/TabData compute/DocMerge/media/docparse
start_worker "default" "${DEFAULT_PID_FILE}" "${DEFAULT_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_POOL_ARGS} \
  -Q default,low_priority -c "${CELERY_DEFAULT_CONCURRENCY:-4}" \
  --max-memory-per-child="${CELERY_MAX_MEMORY:-512000}" \
  -n "${NODE_DEFAULT}"

# worker-realtime
# 用途：Channel Gateway 实时投递、polling、retry
# 队列：realtime_delivery
# 并发：${CELERY_REALTIME_CONCURRENCY:-4}
# Prefetch：1
start_worker "realtime" "${REALTIME_PID_FILE}" "${REALTIME_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_POOL_ARGS} \
  -Q realtime_delivery -c "${CELERY_REALTIME_CONCURRENCY:-4}" \
  --prefetch-multiplier=1 \
  --max-memory-per-child="${CELERY_MAX_MEMORY:-512000}" \
  -n "${NODE_REALTIME}"

# worker-data-ai
# 用途：RAG / TabData compute / DocMerge
# 队列：rag_indexing,tabdata_compute,doc_merge
# 并发：${CELERY_DATA_AI_CONCURRENCY:-4}
# Prefetch：1
start_worker "data-ai" "${DATA_AI_PID_FILE}" "${DATA_AI_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_POOL_ARGS} \
  -Q rag_indexing,tabdata_compute,doc_merge -c "${CELERY_DATA_AI_CONCURRENCY:-4}" \
  --prefetch-multiplier=1 \
  --max-memory-per-child="${CELERY_MAX_MEMORY:-512000}" \
  -n "${NODE_DATA_AI}"

# worker-heavy
# 用途：media/docparse/OCR/OSS heavy/文件转换
# 队列：heavy,media,docparse,tabdata_conversion,pptx_import_oss
# 并发：${CELERY_HEAVY_CONCURRENCY:-2}
# Prefetch：1
start_worker "heavy" "${HEAVY_PID_FILE}" "${HEAVY_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_POOL_ARGS} \
  -Q heavy,media,docparse,tabdata_conversion,pptx_import_oss -c "${CELERY_HEAVY_CONCURRENCY:-2}" \
  --prefetch-multiplier=1 \
  --max-memory-per-child="${CELERY_MAX_MEMORY:-512000}" \
  -n "${NODE_HEAVY}"

# worker-ai-background
# 用途：Memory LLM / 任务摘要 / 日记蒸馏（P0 从 heavy 隔离）
# 队列：ai_background
# 并发：${CELERY_AI_BACKGROUND_CONCURRENCY:-1}
# Prefetch：1
start_worker "ai-background" "${AI_BACKGROUND_PID_FILE}" "${AI_BACKGROUND_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_POOL_ARGS} \
  -Q ai_background -c "${CELERY_AI_BACKGROUND_CONCURRENCY:-1}" \
  --prefetch-multiplier=1 \
  --max-memory-per-child="${CELERY_MAX_MEMORY:-512000}" \
  -n "${NODE_AI_BACKGROUND}"

if [[ -f "${BEAT_PID_FILE}" ]] && _celery_pid_alive "$(cat "${BEAT_PID_FILE}")"; then
  echo "Celery beat already running (pid $(cat "${BEAT_PID_FILE}"))"
else
  : > "${BEAT_LOG_FILE}"
  CELERY_DETACH_PID_FILE="${BEAT_PID_FILE}" \
  CELERY_DETACH_LOG_FILE="${BEAT_LOG_FILE}" \
  python - "${PYTHON_BIN}" -m celery -A tabtin beat -l info \
    --scheduler django_celery_beat.schedulers:DatabaseScheduler <<'PY'
import os
import subprocess
import sys

pid_file = os.environ["CELERY_DETACH_PID_FILE"]
log_file = os.environ["CELERY_DETACH_LOG_FILE"]
cmd = sys.argv[1:]
log_f = open(log_file, "w", encoding="utf-8")
proc = subprocess.Popen(
    cmd,
    stdin=subprocess.DEVNULL,
    stdout=log_f,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    env=os.environ.copy(),
)
with open(pid_file, "w", encoding="utf-8") as fh:
    fh.write(str(proc.pid))
PY
  echo "Celery beat started (pid $(cat "${BEAT_PID_FILE}"))"
  _assert_process_healthy "beat" "${BEAT_PID_FILE}" "${BEAT_LOG_FILE}"
fi

# worker-tracker
# 用途：Tracker / Agent scheduler
# 队列：${TRACKER_AGENT_QUEUE:-tracker_agent}
# 并发：${CELERY_TRACKER_CONCURRENCY:-2}
start_worker "tracker" "${SCHEDULER_PID_FILE}" "${SCHEDULER_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_TRACKER_POOL_ARGS} \
  -Q "${TRACKER_AGENT_QUEUE}" -c "${CELERY_TRACKER_CONCURRENCY:-2}" \
  --prefetch-multiplier="${CELERY_TRACKER_PREFETCH_MULTIPLIER:-1}" \
  --max-memory-per-child="${CELERY_SCHEDULER_MAX_MEMORY:-512000}" \
  -n "${NODE_SCHEDULER}"

# worker-search
# 用途：FTS / ES indexing / health probe
# 队列：search_indexing
# 并发：${CELERY_FTS_CONCURRENCY:-4}
start_worker "search" "${FTS_PID_FILE}" "${FTS_LOG_FILE}" \
  "${PYTHON_BIN}" -m celery -A tabtin worker -l info ${CELERY_POOL_ARGS} \
  -Q search_indexing -c "${CELERY_FTS_CONCURRENCY:-4}" \
  --max-tasks-per-child="${CELERY_FTS_MAX_TASKS_PER_CHILD:-1000}" \
  --max-memory-per-child="${CELERY_FTS_MAX_MEMORY:-512000}" \
  -n "${NODE_FTS}"

echo "✅ Celery workers + beat started (python -m celery via ${PYTHON_BIN})"
