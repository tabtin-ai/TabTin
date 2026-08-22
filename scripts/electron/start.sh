#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_safe-port-kill.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_detach-spawn.sh"

ELECTRON_DIR="${ROOT_DIR}/apps/tabtin-electron"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
PID_FILE="${LOG_DIR}/electron-dev.pid"
LOG_FILE="${LOG_DIR}/electron-dev.log"
ELECTRON_DEV_PORT="${VITE_DEV_SERVER_PORT:-5173}"
ELECTRON_START_TIMEOUT="${ELECTRON_START_TIMEOUT:-240}"
# 允许个人 .env.local 开启 IM 联调；shell 显式传值优先，便于临时关闭。
IM_MODE="${TABTIN_DEV_IM_MODE:-}"
if [[ -z "${IM_MODE}" && -f "${ROOT_DIR}/.env.local" ]]; then
  IM_MODE="$(grep -E '^TABTIN_DEV_IM_MODE=' "${ROOT_DIR}/.env.local" | tail -1 | cut -d= -f2- | tr -d ' \"' || true)"
fi
IM_MODE="${IM_MODE:-0}"
if [[ "${IM_MODE}" == "1" ]]; then
  export TABTIN_DEV_IM_MODE=1
fi

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

  # Windows Git Bash 上 lsof 经常看不到 Node 监听的 loopback 端口，
  # 导致启动脚本误等到 ELECTRON_START_TIMEOUT。用 PowerShell 兜底探活。
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

_electron_log_ready() {
  [[ -f "${LOG_FILE}" ]] || return 1
  grep -q "dev server running for the electron renderer" "${LOG_FILE}" 2>/dev/null \
    || grep -q "start electron app" "${LOG_FILE}" 2>/dev/null
}

_electron_log_failed() {
  [[ -f "${LOG_FILE}" ]] || return 1
  grep -qE "ELIFECYCLE|Command failed with exit code|Error: Cannot find module" "${LOG_FILE}" 2>/dev/null
}

_electron_launcher_alive() {
  local pid="${1:-}"
  [[ -n "${pid}" ]] || return 1
  kill -0 "${pid}" 2>/dev/null && return 0

  # pnpm 可能已退出，但 electron-vite / Electron 仍在跑
  if pgrep -f "${ELECTRON_DIR}.*electron-vite dev" >/dev/null 2>&1; then
    return 0
  fi
  if pgrep -f "${ELECTRON_DIR}.*Electron" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

_wait_for_electron_ready() {
  local pid="${1}"
  local elapsed=0
  local interval=2

  while [[ ${elapsed} -lt ${ELECTRON_START_TIMEOUT} ]]; do
    if _electron_port_listening; then
      return 0
    fi

    if _electron_log_failed; then
      return 1
    fi

    if ! _electron_launcher_alive "${pid}"; then
      return 1
    fi

    if [[ $((elapsed % 10)) -eq 0 && ${elapsed} -gt 0 ]]; then
      echo "  ⏳ Electron 仍在构建/启动中（${elapsed}s / ${ELECTRON_START_TIMEOUT}s）..."
    fi

    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done

  # 超时但进程还在：SSR 首次构建可能很慢，不算硬失败
  if _electron_launcher_alive "${pid}"; then
    echo "  ⚠️  Electron 仍在后台启动（超过 ${ELECTRON_START_TIMEOUT}s），请稍后查看窗口"
    echo "     日志: tail -f ${LOG_FILE}"
    return 0
  fi

  return 1
}

if [[ ! -d "${ELECTRON_DIR}" ]]; then
  echo "❌ 未找到 apps/tabtin-electron"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ 未找到 pnpm，请先安装 Node 依赖: pnpm install"
  exit 1
fi

mkdir -p "${LOG_DIR}"

node "${ROOT_DIR}/scripts/electron/process-cleanup.mjs" --quiet || true

if [[ -f "${PID_FILE}" ]]; then
  _existing_pid="$(cat "${PID_FILE}")"
  if _electron_launcher_alive "${_existing_pid}" && { _electron_port_listening || _electron_log_ready; }; then
    echo "Electron dev 已在运行，先停止再启动 (pid ${_existing_pid}, port ${ELECTRON_DEV_PORT})..."
    _safe_kill_port "${ELECTRON_DEV_PORT}"
    sleep 1
  fi
  rm -f "${PID_FILE}"
fi

if _electron_port_listening; then
  echo "⚠️  端口 ${ELECTRON_DEV_PORT} 已被占用，尝试清理..."
  _safe_kill_port "${ELECTRON_DEV_PORT}"
  sleep 1
fi

echo "🚀 启动 Electron 开发环境 (port ${ELECTRON_DEV_PORT})..."
bash "${ROOT_DIR}/scripts/electron/runtime/_ensure-desktop-runtimes.sh" || true
echo "   首次启动可能需要 1-3 分钟（predev + SSR 构建）"

# nohup 挡不住 Cursor Agent 短 shell 的进程组 SIGKILL；Electron main 的
# dev-watchdog 看到父进程消失会立刻退出，表现为「已启动」后窗口马上没了。
_detach_spawn "${PID_FILE}" "${LOG_FILE}" "${ELECTRON_DIR}" -- pnpm dev

_launch_pid="$(cat "${PID_FILE}")"
if ! _wait_for_electron_ready "${_launch_pid}"; then
  echo "❌ Electron dev 启动失败，最近日志:"
  tail -30 "${LOG_FILE}" 2>/dev/null || true
  exit 1
fi

if _electron_port_listening; then
  echo "✅ Electron dev 已启动 (pid ${_launch_pid}, http://localhost:${ELECTRON_DEV_PORT})"
else
  echo "✅ Electron dev 已在后台启动 (pid ${_launch_pid})"
fi
echo "   日志: tail -f ${LOG_FILE}"

if [[ "${IM_MODE}" == "1" ]]; then
  echo "💬 IM 联调模式：启动隔离的第二个 Electron，并在 main/preload 更新后自动重启"
  bash "${ROOT_DIR}/scripts/electron/second-instance.sh" --watch
fi

exit 0
