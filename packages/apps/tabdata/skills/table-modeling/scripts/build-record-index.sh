#!/usr/bin/env bash
# build-record-index.sh —— 重建 TabData 表的「业务键 → record_id」索引。
#
# 用途（形态 C 写 link 字段的固定中间步）：
#   `record upsert` 只返回计数、不返回 record_id 映射，所以写主表 link 之前
#   必须把子表分页重拉一遍、按业务键建索引。本脚本封装的就是
#   examples/form-c-douban-walkthrough.md §5.5 的「分页重拉 + jq 建图」序列，
#   未改语义，只是把 table-id / 业务键字段参数化，省得每次手敲易错的分页循环。
#
# 用法：
#   build-record-index.sh --table-id <id> --key-field <字段名> [--page-size <n>] [--output <file>]
#
#   --table-id    子表（被 link 指向的那张）table_id。必填。
#   --key-field   作为业务键去重 / 反查的字段名（如 "豆瓣ID"）。必填。
#   --page-size   每页大小，默认 1000（= MAX_PAGE_SIZE 上限）。
#   --output      把索引写到文件；省略则打印到 stdout。
#
# 输出：JSON 对象 {"<业务键值>":"<record_id>", ...}，可直接
#   jq -r '."<某业务键>"' 取到对应 record_id，再拼进主表 link 字段
#   （格式 [{"id":"<record_id>"}]）。
#
# 依赖：tabtin CLI（已登录的 Organization 上下文）、jq。
set -euo pipefail

usage() {
  sed -n '2,30p' "$0"
  exit "${1:-0}"
}

TABLE_ID=""
KEY_FIELD=""
PAGE_SIZE=1000
OUTPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --table-id)  TABLE_ID="${2:-}"; shift 2 ;;
    --key-field) KEY_FIELD="${2:-}"; shift 2 ;;
    --page-size) PAGE_SIZE="${2:-}"; shift 2 ;;
    --output)    OUTPUT="${2:-}"; shift 2 ;;
    -h|--help)   usage 0 ;;
    *) echo "未知参数：$1" >&2; usage 1 ;;
  esac
done

[ -n "$TABLE_ID" ]  || { echo "错误：缺少 --table-id" >&2; usage 1; }
[ -n "$KEY_FIELD" ] || { echo "错误：缺少 --key-field" >&2; usage 1; }
command -v tabtin >/dev/null 2>&1 || { echo "错误：未找到 tabtin CLI" >&2; exit 1; }
command -v jq     >/dev/null 2>&1 || { echo "错误：本脚本需要 jq" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

page=1
while :; do
  resp="$(tabtin table record list --table-id "$TABLE_ID" \
    --page "$page" --page-size "$PAGE_SIZE" --format json)"
  count="$(printf '%s' "$resp" | jq '.data.records | length')"
  [ "$count" = "0" ] && break
  # {业务键: record_id}；跳过业务键为空的行（不能作为 link 目标），
  # tostring 兼容数字型业务键（否则 jq 对象键非字符串会报错）。
  printf '%s' "$resp" | jq -c --arg k "$KEY_FIELD" \
    '.data.records[] | {key: .fields[$k], rid: .id} | select(.key != null and .key != "")' \
    >> "$tmp"
  [ "$count" -lt "$PAGE_SIZE" ] && break
  page=$((page + 1))
  if [ "$page" -gt 10000 ]; then
    echo "警告：已超过 10000 页，提前停止（请确认分页是否正常）" >&2
    break
  fi
done

result="$(jq -s 'map({(.key|tostring): .rid}) | add // {}' "$tmp")"

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$result" > "$OUTPUT"
  echo "已写入 $OUTPUT（$(printf '%s' "$result" | jq 'length') 条索引）" >&2
else
  printf '%s\n' "$result"
fi
