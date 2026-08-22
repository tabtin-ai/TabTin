#!/usr/bin/env bash
# TabTin 统一搜索引擎本地 ES 管理脚本
# 对应 docker-compose.search.yml；供直接命令行使用。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.search.yml"

cd "${ROOT_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[fts-dev] ❌ 未找到 docker，请先安装 Docker Desktop" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[fts-dev] ❌ 未找到 docker compose v2，请升级 Docker Desktop" >&2
  exit 1
fi

DC=(docker compose -f "${COMPOSE_FILE}")

cmd="${1:-help}"
case "${cmd}" in
  up|start)
    echo "[fts-dev] ➜ 构建并启动 Elasticsearch 8.x (含 analysis-icu)"
    "${DC[@]}" up -d --build
    echo "[fts-dev] ➜ 等待 ES 健康检查通过..."
    for i in $(seq 1 60); do
      status=$(curl -s http://localhost:9200/_cluster/health 2>/dev/null | grep -oE '"status":"[a-z]+"' | head -1 || true)
      if [[ "${status}" == *"green"* ]] || [[ "${status}" == *"yellow"* ]]; then
        echo "[fts-dev] ✅ ES 就绪: ${status}"
        curl -s http://localhost:9200 | head -20
        exit 0
      fi
      sleep 2
    done
    echo "[fts-dev] ⚠️  ES 等待超时，请用 'bash scripts/backend/fts-dev.sh logs' 查看日志"
    exit 1
    ;;
  down|stop)
    echo "[fts-dev] ➜ 停止 ES 容器（保留 volume）"
    "${DC[@]}" down
    ;;
  restart)
    "$0" down
    "$0" up
    ;;
  logs)
    "${DC[@]}" logs -f --tail=100 elasticsearch
    ;;
  status)
    echo "[fts-dev] 仅检查本地 docker 栈；生产 / 阿里云 ES 请用："
    echo "         curl \$SEARCH_ES_HOSTS/_cluster/health"
    echo "---"
    "${DC[@]}" ps
    echo "---"
    if curl -s http://localhost:9200/_cluster/health >/dev/null 2>&1; then
      echo "✅ ES health:"
      curl -s http://localhost:9200/_cluster/health
      echo ""
      echo "✅ Plugins:"
      curl -s 'http://localhost:9200/_cat/plugins?v'
    else
      echo "❌ 本地 ES 未运行或不可达（先 bash scripts/backend/fts-dev.sh up）"
    fi
    ;;
  purge)
    echo "[fts-dev] ⚠️  将删除 ES 容器 + volume，所有索引数据丢失"
    read -p "确认？输入 yes 继续: " confirm
    if [[ "${confirm}" == "yes" ]]; then
      "${DC[@]}" down -v
      echo "[fts-dev] ✅ 已清理"
    else
      echo "[fts-dev] 取消"
    fi
    ;;
  help|*)
    cat <<EOF
TabTin FTS 本地 Elasticsearch 管理

用法: bash scripts/backend/fts-dev.sh <command>

命令:
  up        构建（首次会安装 analysis-icu）+ 启动 ES 并等待就绪
  down      停止 ES 容器（保留 volume）
  restart   停止后重启
  logs      实时日志
  status    显示运行状态 + 集群健康 + 插件列表（仅本地，生产看 SEARCH_ES_HOSTS）
  purge     停止并删除 volume（清空所有索引，小心！）

常见问题排查：
  - client 抛 SearchEngineDisabledError  -> 设 SEARCH_ENGINE_ENABLED=true
  - ES 端口 9200 被占用                 -> bash scripts/backend/fts-dev.sh down；或改 ports 映射
  - unknown tokenizer type [icu_...]    -> 镜像缺 analysis-icu；bash scripts/backend/fts-dev.sh purge 后重新 up
  - 401 Unauthorized                     -> SEARCH_ES_USER / SEARCH_ES_PASSWORD 只配了一半
  - breaker 一直 open                   -> 查 Redis 是否可达；本地开发设 FTS_BREAKER_REQUIRE_REDIS=false

相关：
  - 后端 Python 连接：apps/tabtin_django/apps/fts/client.py
  - 索引 mapping：   apps/tabtin_django/apps/fts/index_definitions.py
  - 配置：          apps/tabtin_django/tabtin/settings.py SEARCH_ES_* 系列
  - 生产部署指南：   deployment/search/README.md
  - 环境变量示例：   deployment/search/fts.env.example
  - 本地 ES 地址：   http://localhost:9200
EOF
    ;;
esac
