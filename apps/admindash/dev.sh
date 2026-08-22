#!/bin/bash

# AdminDash 开发启动脚本

cd "$(dirname "$0")"

echo "🚀 启动 AdminDash 管理后台..."
echo ""

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
  echo "📦 检测到未安装依赖，正在安装..."
  pnpm install
  echo ""
fi

# 启动开发服务器
echo "✨ 启动开发服务器..."
echo "🌐 访问地址: http://localhost:5174"
echo ""

pnpm dev

