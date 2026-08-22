#!/usr/bin/env bash
# create-tracker-table.sh —— 创建标准「🤖 任务跟踪表」。
#
# 封装 SKILL「How to Create」一节的标准建表命令：9 个固定字段 + 状态 select
# 的 5 个固定选项，并强制 🤖 前缀（SKILL 硬规则：表名 MUST start with 🤖）。
# 未改语义，只是把这套固定且易敲错（emoji 选项 / 字段集）的 schema 固化下来。
# 建完表的「插入初始任务行」仍由 Agent 自行 record bulk-insert（内容随任务变）。
#
# 用法：
#   create-tracker-table.sh "<任务简述>"
#
# 输出：成功时把新表的 table_id 打到 stdout（供后续 record bulk-insert 用）。
#
# 依赖：tabtin CLI（已登录的 Organization 上下文）、jq。
set -euo pipefail

usage() {
  sed -n '2,17p' "$0"
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
  "") echo "错误：缺少任务简述参数" >&2; usage 1 ;;
esac

command -v tabtin >/dev/null 2>&1 || { echo "错误：未找到 tabtin CLI" >&2; exit 1; }
command -v jq     >/dev/null 2>&1 || { echo "错误：本脚本需要 jq" >&2; exit 1; }

NAME="$1"
# 已带 🤖 前缀就不重复加。
case "$NAME" in
  "🤖"*) FULL_NAME="$NAME" ;;
  *)     FULL_NAME="🤖 $NAME" ;;
esac

FIELDS='[
  {"name":"任务","field_type":"text"},
  {"name":"状态","field_type":"select","options":{"choices":["⬜ 待做","🟡 进行中","✅ 完成","🔴 阻塞","❌ 取消"]}},
  {"name":"阶段","field_type":"text"},
  {"name":"摘要","field_type":"text"},
  {"name":"决策","field_type":"text"},
  {"name":"问题","field_type":"text"},
  {"name":"负责人","field_type":"text"},
  {"name":"开始时间","field_type":"date","options":{"formatting":{"date":"YYYY/MM/DD","time":"HH:mm","timeZone":"Asia/Shanghai"}}},
  {"name":"更新时间","field_type":"date","options":{"formatting":{"date":"YYYY/MM/DD","time":"HH:mm","timeZone":"Asia/Shanghai"}}}
]'

resp="$(tabtin table create --name "$FULL_NAME" --fields "$FIELDS" --format json)"
tid="$(printf '%s' "$resp" \
  | jq -r '.data.table.id // .data.table_id // .data.id // .table_id // .id // empty')"

if [ -n "$tid" ]; then
  echo "$tid"
else
  echo "建表命令已调用，但未能从返回里解析 table_id，原始返回如下：" >&2
  printf '%s\n' "$resp" >&2
  exit 1
fi
