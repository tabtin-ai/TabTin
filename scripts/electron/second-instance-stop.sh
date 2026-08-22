#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
INSTANCE_ID="${TABTIN_SECOND_ELECTRON_INSTANCE:-im-2}"
PID_FILE="${LOG_DIR}/electron-dev-${INSTANCE_ID}.pid"

if [[ ! "${INSTANCE_ID}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
  echo "❌ 第二个 Electron 实例名只能包含小写字母、数字和连字符，最长 32 位"
  exit 1
fi

if [[ ! -f "${PID_FILE}" ]]; then
  echo "⚠️ 第二个 Electron 未运行（实例 ${INSTANCE_ID}）"
  exit 0
fi

pid="$(cat "${PID_FILE}")"
if ! kill -0 "${pid}" 2>/dev/null; then
  rm -f "${PID_FILE}"
  echo "⚠️ 第二个 Electron 进程已不存在（PID ${pid}）"
  exit 0
fi

echo "🛑 停止第二个 Electron（实例 ${INSTANCE_ID}，PID ${pid}）..."
kill -TERM "${pid}" 2>/dev/null || true
for _ in 1 2 3 4 5; do
  kill -0 "${pid}" 2>/dev/null || break
  sleep 1
done
if kill -0 "${pid}" 2>/dev/null; then
  echo "⚠️ 正常退出超时，强制停止第二个 Electron"
  kill -KILL "${pid}" 2>/dev/null || true
fi
rm -f "${PID_FILE}"
echo "✅ 第二个 Electron 已停止"
