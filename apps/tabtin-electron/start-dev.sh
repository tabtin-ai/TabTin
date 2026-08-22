#!/bin/bash

# TabTin Client 开发环境启动脚本

set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 获取项目根目录
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLIENT_DIR="$PROJECT_ROOT/apps/tabtin-electron"

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   TabTin 开发环境启动脚本             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# 存储后台进程 PID
PIDS=()

# 清理函数
cleanup() {
    echo ""
    echo -e "${YELLOW}🛑 正在停止所有服务...${NC}"
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            echo -e "${YELLOW}   停止进程: $pid${NC}"
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done

    # 等待进程结束
    sleep 2

    # 强制杀死残留进程
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            echo -e "${RED}   强制停止进程: $pid${NC}"
            kill -9 "$pid" 2>/dev/null || true
        fi
    done

    echo -e "${GREEN}✅ 所有服务已停止${NC}"
    exit 0
}

# 注册清理函数
trap cleanup SIGINT SIGTERM EXIT

# 检查目录是否存在
if [ ! -d "$CLIENT_DIR" ]; then
    echo -e "${RED}❌ 错误: tabtin-electron 目录不存在${NC}"
    exit 1
fi

# 检查 pnpm 是否安装
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}❌ 错误: pnpm 未安装${NC}"
    echo -e "${YELLOW}请运行: npm install -g pnpm${NC}"
    exit 1
fi

echo -e "${GREEN}📦 项目根目录: ${NC}$PROJECT_ROOT"
echo ""

# 启动 tabtin-electron 开发服务器
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🚀 启动 tabtin-electron 开发服务器...${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
cd "$CLIENT_DIR"
pnpm dev &
CLIENT_PID=$!
PIDS+=($CLIENT_PID)
echo -e "${GREEN}✓ tabtin-electron 已启动 (PID: $CLIENT_PID)${NC}"
echo -e "${YELLOW}  → http://localhost:5173${NC}"
echo ""

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ 服务已启动！${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${YELLOW}📝 服务:${NC}"
echo -e "  • tabtin-electron:     ${GREEN}http://localhost:5173${NC}"
echo ""
echo -e "${RED}按 Ctrl+C 停止服务${NC}"
echo ""

# 等待进程结束
wait
