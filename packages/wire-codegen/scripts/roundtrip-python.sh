#!/bin/bash
# Python round-trip 实测：用 generated Pydantic 模型 parse 22 + 7 + 6 fixture，
# 然后 model_dump_json → re-parse → 字段比对。
#
# 验证点（W0-L1 / W0-L2 / W0-L5）：
#   - 22 case ContentBlock 全部 parse 成功
#   - 6 envelope 全部 parse 成功
#   - extra="ignore" 真的吃掉未知字段（forward-compat 文件）
#   - 浮点 / 大整数 / emoji / 空数组 / 大 base64 round-trip 不失真
#   - 未知 type 字面量被 Pydantic discriminator 拒绝（fail-fast）

set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$PKG_ROOT/.venv"

if [[ ! -x "$VENV/bin/python" ]]; then
  echo "✘ Python venv 不存在: $VENV/bin/python"
  echo "  请先在 packages/wire-codegen/ 下建好 .venv"
  exit 1
fi

cd "$PKG_ROOT"

echo "═══════════════════════════════════════════════════════════════"
echo "  Python round-trip 测试 (Pydantic v2 + extra=ignore)"
echo "═══════════════════════════════════════════════════════════════"
echo "venv: $VENV"
echo

"$VENV/bin/python" "$PKG_ROOT/tests/python/run_roundtrip.py"
