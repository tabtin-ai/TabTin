#!/bin/bash
# Kotlin round-trip 实测：用 kotlinc + 内置 serialization plugin + gradle cache jars。
#
# 验证点（W0-L1 / W0-L2 / W0-L3 / W0-L5 / W0-L6）：
#   - Kotlin sealed class + @JsonClassDiscriminator 能 compile
#   - 22 case ContentBlock + 6 envelope round-trip
#   - W0-L3 实证：_seq Long 直接 encode 不需要 Klaxon 那种 normalize wrapper
#   - W0-L6 关键证据：when (block) is sealed class 编译期穷尽
#   - 浮点 / 未知 type 拒收

set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATED_KT_DIR="$PKG_ROOT/generated/kotlin"
TEST_KT_DIR="$PKG_ROOT/tests/kotlin"
FIXTURES_SAMPLES_DIR="$PKG_ROOT/fixtures/samples"
LOG_DIR="$PKG_ROOT/logs"
mkdir -p "$LOG_DIR"

# 工具路径
KOTLINC=/tmp/kotlinc/bin/kotlinc
KSERIALIZATION_VER=1.7.3
KCORE_JAR="$HOME/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlinx/kotlinx-serialization-core-jvm/$KSERIALIZATION_VER/1f226780b845ff9206474c05159245d861556249/kotlinx-serialization-core-jvm-$KSERIALIZATION_VER.jar"
KJSON_JAR="$HOME/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlinx/kotlinx-serialization-json-jvm/$KSERIALIZATION_VER/6701e8c68d9e82387ce72ee96e8ddf058208d58f/kotlinx-serialization-json-jvm-$KSERIALIZATION_VER.jar"

if [[ ! -x "$KOTLINC" ]]; then
  echo "✘ kotlinc 不存在: $KOTLINC"
  exit 1
fi
if [[ ! -f "$KCORE_JAR" ]]; then
  echo "✘ kotlinx-serialization-core jar 不存在: $KCORE_JAR"
  echo "  请先在仓库内跑过一次 ./gradlew assembleDebug 下载依赖"
  exit 1
fi
if [[ ! -f "$KJSON_JAR" ]]; then
  echo "✘ kotlinx-serialization-json jar 不存在: $KJSON_JAR"
  exit 1
fi

# JDK
export PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH

echo "═══════════════════════════════════════════════════════════════"
echo "  Kotlin round-trip 测试 (sealed class + kotlinx-serialization)"
echo "═══════════════════════════════════════════════════════════════"
echo "kotlinc: $($KOTLINC -version 2>&1 | head -1)"
echo "kotlinx-serialization: $KSERIALIZATION_VER"
echo

OUT_JAR="$LOG_DIR/wire-roundtrip.jar"
CP="$KCORE_JAR:$KJSON_JAR"

# 把 generated/kotlin/*.kt + tests/kotlin/RoundTrip.kt 一起编译
# -Xplugin 启用 kotlinx-serialization 编译器插件（生成 @Serializable 的伴随 serializer）
SERIALIZATION_PLUGIN=/tmp/kotlinc/lib/kotlinx-serialization-compiler-plugin.jar
if [[ ! -f "$SERIALIZATION_PLUGIN" ]]; then
  echo "✘ kotlinx-serialization compiler plugin 不存在: $SERIALIZATION_PLUGIN"
  exit 1
fi

"$KOTLINC" \
  -cp "$CP" \
  -Xplugin="$SERIALIZATION_PLUGIN" \
  -include-runtime \
  -d "$OUT_JAR" \
  "$GENERATED_KT_DIR"/*.kt "$TEST_KT_DIR"/RoundTrip.kt 2>&1 | tail -40

if [[ ! -f "$OUT_JAR" ]]; then
  echo "✘ kotlinc 编译失败"
  exit 1
fi

echo
java -cp "$OUT_JAR:$CP" com.tabtin.wire.test.RoundTripKt "$FIXTURES_SAMPLES_DIR"
