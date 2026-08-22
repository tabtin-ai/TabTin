#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_safe-port-kill.sh"

LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
PID_FILE="${LOG_DIR}/electron-dev.pid"
SECOND_INSTANCE_PID_FILE="${LOG_DIR}/electron-dev-im-2.pid"
ELECTRON_DEV_PORT="${VITE_DEV_SERVER_PORT:-5173}"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  _port_line="$(grep -E '^VITE_DEV_SERVER_PORT=' "${ROOT_DIR}/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "'\' || true)"
  if [[ -n "${_port_line}" ]]; then
    ELECTRON_DEV_PORT="${_port_line}"
  fi
fi

_electron_port_listening() {
  if lsof -i :"${ELECTRON_DEV_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    return 0
  fi

  local ps_cmd=""
  if command -v powershell.exe >/dev/null 2>&1; then
    ps_cmd="powershell.exe"
  elif command -v powershell >/dev/null 2>&1; then
    ps_cmd="powershell"
  fi

  if [[ -n "${ps_cmd}" ]]; then
    ELECTRON_DEV_PORT="${ELECTRON_DEV_PORT}" "${ps_cmd}" -NoProfile -Command \
      '$port = [int]$env:ELECTRON_DEV_PORT; if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { exit 0 }; exit 1' \
      >/dev/null 2>&1
    return $?
  fi

  return 1
}

echo "🛑 停止 Electron dev..."

if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}")"
  if kill -0 "${PID}" 2>/dev/null; then
    echo "  停止进程 (PID: ${PID})..."
    kill -TERM "${PID}" 2>/dev/null || true
    sleep 2
    if kill -0 "${PID}" 2>/dev/null; then
      kill -9 "${PID}" 2>/dev/null || true
    fi
    echo "  ✅ 已停止 (PID: ${PID})"
  else
    echo "  ⚠️  PID 文件中的进程已不存在 (${PID})"
  fi
  rm -f "${PID_FILE}"
fi

if _electron_port_listening; then
  echo "  🔍 清理占用 ${ELECTRON_DEV_PORT} 端口的进程..."
  _safe_kill_port "${ELECTRON_DEV_PORT}"
fi

# 第二端由常驻 supervisor 托管；先停它，避免后续清 Electron 子进程后 supervisor 又拉起新窗口。
bash "${ROOT_DIR}/scripts/electron/second-instance-stop.sh" || true
node "${ROOT_DIR}/scripts/electron/process-cleanup.mjs" --all --current-only --quiet || true
node "${ROOT_DIR}/scripts/electron/process-cleanup.mjs" --quiet || true
rm -f "${SECOND_INSTANCE_PID_FILE}"

echo "  ✅ Electron dev 已停止"
exit 0
