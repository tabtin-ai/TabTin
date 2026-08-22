#!/usr/bin/env bash
# 薄封装：调 gen-python-runtime-manifest.mjs 生成 combined manifest（详见该 .mjs 顶部说明）。
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec node "$REPO_ROOT/scripts/electron/package/gen-python-runtime-manifest.mjs" "$@"
