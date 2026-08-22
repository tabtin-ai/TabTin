#!/usr/bin/env bash
# update-tracker-task.sh —— 更新「🤖 任务跟踪表」里的某个任务行。
#
# 封装 SKILL「How to Update Progress」的 UPDATE 语句：按「任务」字段精确定位行，
# 置 状态 / 摘要 / 阶段 / 决策 / 问题 / 负责人，并把「更新时间」设为 NOW()。
# 未改语义，只是参数化 + 自动给字段值做 SQL 单引号转义 + 强制带 WHERE（符合
# table-query 的「UPDATE 必须带 WHERE」规则），省得每次手拼带中文标识符、
# 易漏引号的 SQL。
#
# 用法：
#   update-tracker-task.sh --table "🤖 xxx" --task "<任务文本>" \
#       [--status "<状态>"] [--summary <text>] [--stage <text>] \
#       [--decision <text>] [--problem <text>] [--owner <text>] [--start-now]
#
#   --table      跟踪表名（🤖 开头）。必填。
#   --task       要更新的任务行，精确匹配「任务」字段值。必填。
#   --status     新状态，如 "✅ 完成" / "🟡 进行中" / "🔴 阻塞"。
#   --summary / --stage / --decision / --problem / --owner   对应字段新值。
#   --start-now  把「开始时间」设为 NOW()（开始一个任务时用）。
#
#   「更新时间」总是被设为 NOW()；至少要给一个上面的可更新字段（或 --start-now）。
#
# 依赖：tabtin CLI（已登录的 Organization 上下文）。
set -euo pipefail

usage() {
  sed -n '2,24p' "$0"
  exit "${1:-0}"
}

TABLE=""
TASK=""
STATUS=""
SUMMARY=""
STAGE=""
DECISION=""
PROBLEM=""
OWNER=""
START_NOW=0
HAS_FIELD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --table)    TABLE="${2:-}"; shift 2 ;;
    --task)     TASK="${2:-}"; shift 2 ;;
    --status)   STATUS="${2:-}"; HAS_FIELD=1; shift 2 ;;
    --summary)  SUMMARY="${2:-}"; HAS_FIELD=1; shift 2 ;;
    --stage)    STAGE="${2:-}"; HAS_FIELD=1; shift 2 ;;
    --decision) DECISION="${2:-}"; HAS_FIELD=1; shift 2 ;;
    --problem)  PROBLEM="${2:-}"; HAS_FIELD=1; shift 2 ;;
    --owner)    OWNER="${2:-}"; HAS_FIELD=1; shift 2 ;;
    --start-now) START_NOW=1; HAS_FIELD=1; shift 1 ;;
    -h|--help)  usage 0 ;;
    *) echo "未知参数：$1" >&2; usage 1 ;;
  esac
done

[ -n "$TABLE" ] || { echo "错误：缺少 --table" >&2; usage 1; }
[ -n "$TASK" ]  || { echo "错误：缺少 --task" >&2; usage 1; }
[ "$HAS_FIELD" = "1" ] || { echo "错误：至少给一个可更新字段（如 --status / --summary / --start-now）" >&2; usage 1; }
command -v tabtin >/dev/null 2>&1 || { echo "错误：未找到 tabtin CLI" >&2; exit 1; }

# SQL 单引号转义：' -> ''
sql_escape() { local s="$1"; printf '%s' "${s//\'/\'\'}"; }
# SQL 标识符里的双引号转义：" -> ""
ident_escape() { local s="$1"; printf '%s' "${s//\"/\"\"}"; }

SET_PARTS=()
add_set() { SET_PARTS+=("\"$(ident_escape "$1")\" = '$(sql_escape "$2")'"); }

[ -n "$STATUS" ]   && add_set "状态"   "$STATUS"
[ -n "$SUMMARY" ]  && add_set "摘要"   "$SUMMARY"
[ -n "$STAGE" ]    && add_set "阶段"   "$STAGE"
[ -n "$DECISION" ] && add_set "决策"   "$DECISION"
[ -n "$PROBLEM" ]  && add_set "问题"   "$PROBLEM"
[ -n "$OWNER" ]    && add_set "负责人" "$OWNER"
[ "$START_NOW" = "1" ] && SET_PARTS+=("\"开始时间\" = NOW()")
SET_PARTS+=("\"更新时间\" = NOW()")

set_clause="$(printf '%s, ' "${SET_PARTS[@]}")"
set_clause="${set_clause%, }"

SQL="UPDATE \"$(ident_escape "$TABLE")\" SET ${set_clause} WHERE \"任务\" = '$(sql_escape "$TASK")';"

tabtin table execute "$SQL"
