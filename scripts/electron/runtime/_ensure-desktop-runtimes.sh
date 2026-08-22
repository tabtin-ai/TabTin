#!/usr/bin/env bash
# 启动脚本共用入口：默认只准备启动所需的 Python runtime，避免开发冷启动
# 被体积较大的可选 Office runtime 阻塞。显式设置
# TABTIN_FETCH_OFFICE_RUNTIME_ON_START=1 时恢复全量准备。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${TABTIN_FETCH_OFFICE_RUNTIME_ON_START:-0}" = "1" ]; then
  exec bash "$SCRIPT_DIR/fetch-desktop-runtimes.sh" "$@"
fi
exec bash "$SCRIPT_DIR/fetch-desktop-runtimes.sh" --only python "$@"
