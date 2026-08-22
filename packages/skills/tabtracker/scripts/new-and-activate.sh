#!/usr/bin/env bash
# new-and-activate.sh —— 旧版兼容入口（当前 new 已直接进入活动状态）。
#
# 保留文件名避免旧 Agent / 自动化引用失效。当前 `tabtin tracker new` 已由后端
# 原子完成创建和启用；脚本仅在检测到旧版 CLI 返回非 active 时补一次 activate。
#
# 用法（参数与 `tabtin tracker new` 完全一致，原样透传；不要自己加 --format）：
#   new-and-activate.sh "<名称>" --schedule daily --at 09:00 --agent <id> --skill <key>
#   new-and-activate.sh "<名称>" --on-table <tid> --on-events record_created --agent <id> --skill <key>
#
# 输出：成功时把 tracker-id 打到 stdout。
#
# 依赖：tabtin CLI（已登录的 Space 上下文）、jq。
set -euo pipefail

usage() {
  sed -n '2,20p' "$0"
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
  "") echo "错误：至少要给 Tracker 名称（其余参数同 tabtin tracker new）" >&2; usage 1 ;;
esac

command -v tabtin >/dev/null 2>&1 || { echo "错误：未找到 tabtin CLI" >&2; exit 1; }
command -v jq     >/dev/null 2>&1 || { echo "错误：本脚本需要 jq" >&2; exit 1; }

resp="$(tabtin tracker new "$@" --format json)"
tid="$(printf '%s' "$resp" | jq -r '.data.id // .data.tracker_id // .id // empty')"
status="$(printf '%s' "$resp" | jq -r '.data.status // .status // empty')"

if [ -z "$tid" ]; then
  echo "tracker new 已调用，但未能从返回里解析 tracker id，原始返回如下：" >&2
  printf '%s\n' "$resp" >&2
  exit 1
fi

if [ "$status" != "active" ]; then
  echo "检测到旧版创建结果，正在兼容启用自动化 $tid ..." >&2
  tabtin tracker activate "$tid"
fi
echo "自动化 $tid 已创建并进入活动状态，开始按计划调度。" >&2
echo "$tid"
