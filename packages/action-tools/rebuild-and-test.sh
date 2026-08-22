#!/bin/bash

# 重新构建并启动前端测试脚本
#
# 使用方法：
# chmod +x rebuild-and-test.sh
# ./rebuild-and-test.sh

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "🔧 重新构建 @tabtin/action-tools..."
cd "$ROOT/packages/action-tools"
pnpm build

if [ $? -ne 0 ]; then
  echo "❌ 构建失败"
  exit 1
fi

echo ""
echo "✅ 构建完成"
echo ""
echo "📝 接下来："
echo "1. 重启 Electron 应用（如果正在运行）"
echo "2. 打开开发者工具控制台"
echo "3. 复制 scripts/test-action-tools-integration.js 内容到控制台运行"
echo ""
