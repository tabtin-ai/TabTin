#!/usr/bin/env bash
set -euo pipefail

TABLE_NAME="问题跟踪"
TABLE_ID=""
PREVIEW=0

usage() {
  echo "usage: $0 [--name <table-name>] [--table-id <id>] [--preview]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      TABLE_NAME="$2"
      shift 2
      ;;
    --table-id)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      TABLE_ID="$2"
      shift 2
      ;;
    --preview)
      PREVIEW=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

FIELDS_JSON='[
  {"name":"问题描述","field_type":"text"},
  {"name":"证据附件","field_type":"attachment"},
  {"name":"环境信息","field_type":"long_text"},
  {"name":"状态","field_type":"select","options":{"choices":["新提交","待处理","处理中","开发自测","待部署","待验收","已完成","重复","无法复现","已取消","暂不处理","待产品确定","后续排期"]}},
  {"name":"负责人","field_type":"user"},
  {"name":"修复反馈","field_type":"long_text"},
  {"name":"验收附件","field_type":"attachment"},
  {"name":"验收日期","field_type":"date"},
  {"name":"提交人","field_type":"created_by"},
  {"name":"提交时间","field_type":"created_time"}
]'

command -v jq >/dev/null 2>&1 || {
  echo "jq 不可用，无法生成或解析问题跟踪表配置" >&2
  exit 4
}

if [[ "$PREVIEW" -eq 1 ]]; then
  jq -n --arg name "$TABLE_NAME" --argjson fields "$FIELDS_JSON" \
    '{ok:true, action:"preview", table_name:$name, fields:$fields}'
  exit 0
fi

command -v tabtin >/dev/null 2>&1 || {
  echo "tabtin CLI 不可用，无法初始化问题跟踪表" >&2
  exit 4
}

extract_table_id() {
  jq -r '
    .data.table.id // .data.table_id // .data.id //
    .table.id // .table_id // .id // empty
  '
}

find_table_by_name() {
  jq -r --arg name "$TABLE_NAME" '
    [
      .. | objects |
      select((.name? // .table_name? // .display_name? // .internal_name? // "") == $name) |
      (.id? // .table_id? // .tableId? // empty) |
      select(type == "string" and length > 0)
    ] | first // empty
  '
}

validate_table() {
  local id="$1"
  local fields
  fields="$(tabtin table field list --table-id "$id" --format json)"
  if jq -e '
    [
      .. | objects |
      select(
        ((.name? // .field_name? // "") | type) == "string" and
        ((.field_type? // .type? // "") | type) == "string"
      ) |
      {name:(.name? // .field_name?), type:(.field_type? // .type?)}
    ] as $f |
    any($f[]; ((.name == "问题描述" or .name == "Bug 描述") and .type == "text")) and
    any($f[]; ((.name == "证据附件" or .name == "操作录屏 / 截图") and .type == "attachment")) and
    any($f[]; (.name == "状态" and .type == "select")) and
    any($f[]; (.name == "修复反馈" and (.type == "text" or .type == "long_text"))) and
    any($f[]; ((.name == "验收附件" or .name == "验收截图") and .type == "attachment")) and
    any($f[]; (.name == "验收日期" and .type == "date"))
  ' >/dev/null <<<"$fields"; then
    return 0
  fi
  return 1
}

if [[ -n "$TABLE_ID" ]]; then
  if ! validate_table "$TABLE_ID"; then
    echo "指定表不符合问题跟踪工作流的必要字段结构：$TABLE_ID" >&2
    exit 3
  fi
  jq -n --arg id "$TABLE_ID" --arg name "$TABLE_NAME" \
    '{ok:true, action:"reuse", schema_version:1, table_id:$id, table_name:$name}'
  exit 0
fi

TABLES_JSON="$(tabtin table list --format json)"
EXISTING_ID="$(find_table_by_name <<<"$TABLES_JSON")"
if [[ -n "$EXISTING_ID" ]]; then
  if ! validate_table "$EXISTING_ID"; then
    echo "已存在同名表「${TABLE_NAME}」，但字段结构不兼容；未修改原表，也未创建重名表" >&2
    exit 3
  fi
  jq -n --arg id "$EXISTING_ID" --arg name "$TABLE_NAME" \
    '{ok:true, action:"reuse", schema_version:1, table_id:$id, table_name:$name}'
  exit 0
fi

CREATE_JSON="$(tabtin table create --name "$TABLE_NAME" --fields "$FIELDS_JSON" --format json)"
CREATED_ID="$(extract_table_id <<<"$CREATE_JSON")"
if [[ -z "$CREATED_ID" ]]; then
  echo "问题跟踪表已请求创建，但无法从响应解析 table_id" >&2
  exit 5
fi

jq -n --arg id "$CREATED_ID" --arg name "$TABLE_NAME" \
  '{ok:true, action:"created", schema_version:1, table_id:$id, table_name:$name}'
