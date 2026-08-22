#!/bin/bash
# 验证 build-packaged-app.sh 里 prune_onnxruntime_binaries 对 onnxruntime-node 1.24.x
# 新布局（bin/napi-vN/<platform>/<arch>/）的删除逻辑：只保留目标 platform/arch，
# 其余 platform 与 arch 全删，且不会把目标 platform 父目录整体误删。
#
# 关联 GitHub  / 。
#
# 用法：bash apps/tabtin-electron/scripts/test-onnx-prune.sh
# 通过时退出码 0，任一断言失败退出码 1。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_SCRIPT="$SCRIPT_DIR/build-packaged-app.sh"

if [ ! -f "$BUILD_SCRIPT" ]; then
  echo "找不到 build-packaged-app.sh: $BUILD_SCRIPT" >&2
  exit 1
fi

# 从真实脚本里抽出被测函数（从 `prune_onnxruntime_binaries() {` 到第一行顶格 `}`），
# 避免在测试里复制一份逻辑导致漂移。
FUNC_SRC="$(awk '
  /^prune_onnxruntime_binaries\(\) \{/ { capture = 1 }
  capture { print }
  capture && /^\}$/ { exit }
' "$BUILD_SCRIPT")"

if [ -z "$FUNC_SRC" ]; then
  echo "未能从 build-packaged-app.sh 抽出 prune_onnxruntime_binaries 函数" >&2
  exit 1
fi
eval "$FUNC_SRC"

FAILS=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1" >&2; FAILS=$((FAILS + 1)); }

# 构造一份模拟 onnx 布局（比真实 tarball 更全：darwin 也给 x64，用来验证 arch 选择）。
# 结构：<NM>/.pnpm/onnxruntime-node@1.24.3/node_modules/onnxruntime-node/bin/napi-v6/<platform>/<arch>/
make_fixture() {
  local root="$1"
  local base="$root/.pnpm/onnxruntime-node@1.24.3/node_modules/onnxruntime-node/bin/napi-v6"
  local combos=(darwin/arm64 darwin/x64 linux/arm64 linux/x64 win32/arm64 win32/x64)
  local c
  for c in "${combos[@]}"; do
    mkdir -p "$base/$c"
    echo "stub" > "$base/$c/onnxruntime_binding.node"
  done
}

ONNX_REL=".pnpm/onnxruntime-node@1.24.3/node_modules/onnxruntime-node/bin/napi-v6"

run_case() {
  local target_runtime="$1" arch="$2"
  local keep="$target_runtime/$arch"
  local tmp
  tmp="$(mktemp -d)"
  NM="$tmp"; TARGET_RUNTIME="$target_runtime"; ARCH="$arch"
  make_fixture "$tmp"
  prune_onnxruntime_binaries

  local base="$tmp/$ONNX_REL"
  echo "[case] TARGET_RUNTIME=$target_runtime ARCH=$arch (期望仅保留 $keep)"

  # 1) 目标 platform/arch 必须保留，且二进制文件仍在
  if [ -f "$base/$keep/onnxruntime_binding.node" ]; then
    pass "保留目标 $keep"
  else
    fail "目标 $keep 被误删"
  fi

  # 2) 目标 platform 父目录必须存活（原 bug：darwin 父目录被整体 rm）
  if [ -d "$base/$target_runtime" ]; then
    pass "目标 platform 目录 $target_runtime 存活"
  else
    fail "目标 platform 目录 $target_runtime 被整体误删"
  fi

  # 3) 其余所有 platform/arch 组合必须删除
  local all=(darwin/arm64 darwin/x64 linux/arm64 linux/x64 win32/arm64 win32/x64)
  local combo
  for combo in "${all[@]}"; do
    [ "$combo" = "$keep" ] && continue
    if [ -e "$base/$combo/onnxruntime_binding.node" ] || [ -d "$base/$combo" ]; then
      fail "非目标 $combo 未被删除"
    fi
  done
  # 汇总一句非目标删除情况
  local leftover
  leftover="$(find "$base" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sed "s#$base/##" | sort | tr '\n' ' ')"
  echo "    剩余 platform/arch 目录: [${leftover% }]"

  rm -rf "$tmp"
  echo
}

echo "=== prune_onnxruntime_binaries 验证 ==="
echo
run_case darwin arm64
run_case darwin x64
run_case linux x64
run_case linux arm64
run_case win32 x64
run_case win32 arm64

if [ "$FAILS" -eq 0 ]; then
  echo "全部断言通过 ✅"
  exit 0
else
  echo "有 $FAILS 条断言失败 ❌" >&2
  exit 1
fi
