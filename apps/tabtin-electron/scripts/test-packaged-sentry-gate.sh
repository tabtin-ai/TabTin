#!/bin/bash
# 验证 quick 打包只有 local profile 可以跳过 Sentry 符号门禁。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_SCRIPT="$SCRIPT_DIR/build-packaged-app.sh"

FUNC_SRC="$(awk '
  /^pack_may_skip_sentry_symbols\(\) \{/ { capture = 1 }
  capture { print }
  capture && /^\}$/ { exit }
' "$BUILD_SCRIPT")"

if [ -z "$FUNC_SRC" ]; then
  echo "未能抽出 pack_may_skip_sentry_symbols 函数" >&2
  exit 1
fi
eval "$FUNC_SRC"

assert_skip() {
  local quick="$1" profile="$2" expected="$3"
  local actual="deny"
  if pack_may_skip_sentry_symbols "$quick" "$profile"; then
    actual="allow"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "断言失败: quick=$quick profile=$profile expected=$expected actual=$actual" >&2
    exit 1
  fi
}

assert_skip 1 local allow
assert_skip 1 preprod deny
assert_skip 1 production deny
assert_skip 0 local deny

echo "packaged Sentry gate policy tests passed"
