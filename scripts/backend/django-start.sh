#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_env-key.sh"

# 从根 .env / .env.local 读取绑定端口（.env.local 覆盖），便于本机第二套 API（如 6061）
_tabtin_load_django_bind_env() {
  local f key val
  for f in "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.local"; do
    [[ -f "$f" ]] || continue
    for key in DJANGO_BIND_PORT DJANGO_BIND_HOST; do
      val="$(grep -E "^${key}=" "$f" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \t"'\''\r' || true)"
      if [[ -n "${val}" ]]; then
        export "${key}=${val}"
      fi
    done
  done
}
_tabtin_load_django_bind_env

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_celery-platform.sh"

DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
VENV_DIR="${DJANGO_DIR}/venv"
LOG_DIR="${DJANGO_DIR}/logs"
PID_FILE="${LOG_DIR}/django-dev.pid"
LOG_FILE="${LOG_DIR}/django-dev.log"
BIND_HOST="${DJANGO_BIND_HOST:-0.0.0.0}"
BIND_PORT="${DJANGO_BIND_PORT}"

cd "${DJANGO_DIR}"

if [[ -f "${PID_FILE}" ]]; then
  if _celery_pid_alive "$(cat "${PID_FILE}")"; then
    echo "Django already running (pid $(cat "${PID_FILE}"))"
    exit 0
  fi
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Missing venv. Run: bash scripts/backend/django-setup.sh"
  exit 1
fi

# shellcheck disable=SC1091
if [[ -f "${VENV_DIR}/Scripts/activate" ]]; then
  source "${VENV_DIR}/Scripts/activate"
elif [[ -f "${VENV_DIR}/bin/activate" ]]; then
  source "${VENV_DIR}/bin/activate"
else
  echo "Missing venv activate script under ${VENV_DIR}"
  exit 1
fi

# 设置 libpq 环境变量（用于 psycopg）
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export DYLD_LIBRARY_PATH="/opt/homebrew/opt/libpq/lib:${DYLD_LIBRARY_PATH:-}"

mkdir -p "${LOG_DIR}"

can_bind() {
  python - << 'PY' "$1" "$2"
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind((host, port))
except OSError as exc:
    sys.exit(exc.errno or 1)
finally:
    s.close()
sys.exit(0)
PY
}

if can_bind "${BIND_HOST}" "${BIND_PORT}"; then
  bind_errno=0
else
  bind_errno=$?
fi
if [[ ${bind_errno} -ne 0 ]]; then
  if [[ "${BIND_HOST}" == "0.0.0.0" && "${bind_errno}" -eq 1 ]]; then
    echo "⚠️  无法绑定 ${BIND_HOST}:${BIND_PORT}（权限不足），回退到 127.0.0.1"
    BIND_HOST="127.0.0.1"
    if can_bind "${BIND_HOST}" "${BIND_PORT}"; then
      bind_errno=0
    else
      bind_errno=$?
    fi
    if [[ ${bind_errno} -ne 0 ]]; then
      echo "❌ 无法绑定 ${BIND_HOST}:${BIND_PORT} (errno ${bind_errno})"
      exit 1
    fi
  else
    echo "❌ 无法绑定 ${BIND_HOST}:${BIND_PORT} (errno ${bind_errno})"
    exit 1
  fi
fi

# 启动前清理 Redis WS 连接计数（防止上次异常退出导致计数泄漏）
if command -v redis-cli >/dev/null 2>&1; then
  WS_KEYS=$(redis-cli --no-auth-warning KEYS 'ws:conn:*' 2>/dev/null || true)
  if [[ -n "${WS_KEYS}" ]]; then
    echo "${WS_KEYS}" | xargs redis-cli --no-auth-warning DEL >/dev/null 2>&1 || true
    echo "🧹 已清理 Redis WS 连接计数"
  fi
fi

# Cursor / 短生命周期 shell 退出时会 SIGKILL 整个进程组。
# nohup 只忽略 SIGHUP，挡不住进程组清理；必须 start_new_session 脱离 shell pgid。
LOG_LEVEL="${LOG_LEVEL:-INFO}" \
DJANGO_BIND_HOST="${BIND_HOST}" \
DJANGO_BIND_PORT="${BIND_PORT}" \
DJANGO_LOG_FILE="${LOG_FILE}" \
DJANGO_PID_FILE="${PID_FILE}" \
python - <<'PY'
import os
import subprocess
import sys

bind_host = os.environ["DJANGO_BIND_HOST"]
bind_port = os.environ["DJANGO_BIND_PORT"]
log_file = os.environ["DJANGO_LOG_FILE"]
pid_file = os.environ["DJANGO_PID_FILE"]

log_f = open(log_file, "w", encoding="utf-8")
proc = subprocess.Popen(
    [
        sys.executable,
        "-m",
        "daphne",
        "--ping-interval",
        "45",
        "--ping-timeout",
        "60",
        "--websocket_timeout",
        "3600",
        "--application-close-timeout",
        "120",
        "-b",
        bind_host,
        "-p",
        bind_port,
        "tabtin.asgi:application",
    ],
    stdin=subprocess.DEVNULL,
    stdout=log_f,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    env=os.environ.copy(),
)
with open(pid_file, "w", encoding="utf-8") as fh:
    fh.write(str(proc.pid))
PY

echo "Django started (pid $(cat "${PID_FILE}"))"
