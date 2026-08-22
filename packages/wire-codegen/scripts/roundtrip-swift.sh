#!/bin/bash
# Swift round-trip 实测：用 SPM 编译 generated/swift/ 全部文件，
# 跑一个 main.swift 测试，对 fixture 做 type-safe enum + Codable round-trip。
#
# 验证点（W0-L1 / W0-L2 / W0-L5 / W0-L6）：
#   - Swift type-safe discriminated union 能 compile
#   - 22 case ContentBlock + 6 envelope round-trip
#   - W0-L6 关键证据：switch ContentBlock 编译期穷尽 22 case
#   - 浮点 / emoji / 大 base64 / 未知 type 拒收

set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_TEST_DIR="$PKG_ROOT/tests/swift"
GENERATED_SWIFT_DIR="$PKG_ROOT/generated/swift"
FIXTURES_SAMPLES_DIR="$PKG_ROOT/fixtures/samples"

if ! command -v swift >/dev/null 2>&1; then
  echo "✘ swift 未安装"
  exit 1
fi

cd "$SWIFT_TEST_DIR"

# 把 generated/swift/*.swift 同步到 Sources/Generated/（每次都重新同步，
# 跟 main.swift 一起 compile 进同一个 module）。
mkdir -p Sources/Generated
rm -f Sources/Generated/*.swift
cp "$GENERATED_SWIFT_DIR"/*.swift Sources/Generated/

# ContentBlock.swift 是空文件（所有内容已被合并到 AnyEvent.swift），
# SPM 会跳过空 .swift；保留以保证 vendor in 一致。

echo "═══════════════════════════════════════════════════════════════"
echo "  Swift round-trip 测试 (Type-safe enum + Codable)"
echo "═══════════════════════════════════════════════════════════════"
echo "swift: $(swift --version 2>&1 | head -1)"
echo

swift build --configuration release 2>&1 | tail -20
echo
swift run --configuration release WireRoundTrip "$FIXTURES_SAMPLES_DIR"
