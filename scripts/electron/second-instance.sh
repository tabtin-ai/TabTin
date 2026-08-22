#!/usr/bin/env bash
set -euo pipefail

# 在已有的 Electron dev + Vite 服务上，再启动一个隔离登录态的 Electron。
# 它不再启动 electron-vite，因此不会抢 5175，也不会重复启动后端。
# --watch 仅监听 main / preload 编译产物；renderer 的 HMR 已会同步到两个窗口。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON_DIR="${ROOT_DIR}/apps/tabtin-electron"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
INSTANCE_ID="${TABTIN_SECOND_ELECTRON_INSTANCE:-im-2}"
PID_FILE="${LOG_DIR}/electron-dev-${INSTANCE_ID}.pid"
WATCH_FOR_UPDATES=0
case "${1:-}" in
  '') ;;
  --watch) WATCH_FOR_UPDATES=1 ;;
  *)
    echo "用法: electron-second-instance.sh [--watch]"
    exit 1
    ;;
esac
LOG_FILE="${LOG_DIR}/electron-dev-${INSTANCE_ID}.log"
ELECTRON_DEV_PORT="${VITE_DEV_SERVER_PORT:-5173}"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  port_line="$(grep -E '^VITE_DEV_SERVER_PORT=' "${ROOT_DIR}/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' "' || true)"
  [[ -n "${port_line}" ]] && ELECTRON_DEV_PORT="${port_line}"
fi

if [[ ! "${INSTANCE_ID}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "❌ 第二个 Electron 实例名只能包含小写字母、数字和连字符，最长 32 位"
  exit 1
fi

if [[ ! -f "${ELECTRON_DIR}/out/main/index.mjs" ]]; then
  echo "❌ Electron 主进程尚未编译；请先通过菜单 32 启动主 Electron"
  exit 1
fi

if ! curl -fsS --max-time 2 "http://127.0.0.1:${ELECTRON_DEV_PORT}" >/dev/null; then
  echo "❌ Vite 开发服务未运行（http://127.0.0.1:${ELECTRON_DEV_PORT}）；请先通过菜单 32 启动主 Electron"
  exit 1
fi

mkdir -p "${LOG_DIR}"
if [[ -f "${PID_FILE}" ]]; then
  pid="$(cat "${PID_FILE}")"
  if kill -0 "${pid}" 2>/dev/null; then
    echo "⚠️ 第二个 Electron 已在运行（实例 ${INSTANCE_ID}，PID ${pid}）"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

ELECTRON_BINARY="$(cd "${ELECTRON_DIR}" && node -p "require('electron')")"
if [[ ! -x "${ELECTRON_BINARY}" ]]; then
  echo "❌ 未找到 Electron 可执行文件；请先运行 pnpm install"
  exit 1
fi

: > "${LOG_FILE}"
(
  cd "${ELECTRON_DIR}"
  # userData 会由 TABTIN_DEV_INSTANCE 派生为 TabTin Dev-im-2，登录态、缓存、
  # IndexedDB、Electron 单实例锁和大部分本地文件均不会与主端共用。
  unset ELECTRON_RUN_AS_NODE
  if [[ "${WATCH_FOR_UPDATES}" -eq 1 ]]; then
    # main / preload 更新需要重新拉起 Electron；renderer 更新仍由共享 Vite HMR 处理。
    nohup env \
      TABTIN_DEV_INSTANCE="${INSTANCE_ID}" \
      ELECTRON_RENDERER_URL="http://127.0.0.1:${ELECTRON_DEV_PORT}" \
      node "${ROOT_DIR}/scripts/electron/second-instance-supervisor.mjs" \
        "${ELECTRON_BINARY}" . "${ELECTRON_DIR}/out" >> "${LOG_FILE}" 2>&1 &
  else
    # 不能直接 nohup Electron：其父进程会变成 launchd，开发态 watchdog 会立即退出。
    # 用常驻 Node 父进程托管它，退出信号也会转发给 Electron。
    nohup env \
      TABTIN_DEV_INSTANCE="${INSTANCE_ID}" \
      ELECTRON_RENDERER_URL="http://127.0.0.1:${ELECTRON_DEV_PORT}" \
      node "${ROOT_DIR}/scripts/electron/instance-launcher.mjs" "${ELECTRON_BINARY}" . >> "${LOG_FILE}" 2>&1 &
  fi
  echo $! > "${PID_FILE}"
)

echo "✅ 已启动第二个 Electron（实例 ${INSTANCE_ID}，PID $(cat "${PID_FILE}")）"
echo "   与主端共用后端和 Vite；本地资料隔离在 userData: TabTin Dev-${INSTANCE_ID}"
if [[ "${WATCH_FOR_UPDATES}" -eq 1 ]]; then
  echo "   已监听 main/preload 更新，更新后会自动重启第二端"
fi
echo "   日志: tail -f ${LOG_FILE}"
