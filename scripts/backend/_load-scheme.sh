#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# 统一加载开发端口配置
# 所有需要端口 / Redis DB 等配置的脚本都应在顶部 source 此文件：
#   source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"
#
# 配置来源（优先级从高到低）:
#   1. 已有的环境变量（调用者显式设置；非标准旧端口会被归一回标准端口）
#   2. 以下 fallback 默认值（标准方案: 6060 / Redis DB 0 / Live 4100）
# ─────────────────────────────────────────────────────

# 若调用方环境变量仍残留非标准旧端口，启动脚本统一回到标准端口，
# 避免 Electron 启动前的自动 env 同步又写回不可用端口。
if [[ "${DJANGO_BIND_PORT:-}" == "7070" || "${COLLAB_LIVE_PORT:-}" == "4200" || "${CENTRIFUGO_PORT:-}" == "8200" ]]; then
    DJANGO_BIND_PORT="6060"
    REDIS_DB="0"
    COLLAB_LIVE_PORT="4100"
    CENTRIFUGO_PORT="8100"
    CENTRIFUGO_API_URL="http://127.0.0.1:8100/api"
    CENTRIFUGO_REDIS_DB="3"
fi

# fallback 默认值 = 标准方案
export DJANGO_BIND_PORT="${DJANGO_BIND_PORT:-6060}"
export REDIS_DB="${REDIS_DB:-0}"
export COLLAB_LIVE_PORT="${COLLAB_LIVE_PORT:-4100}"
export CENTRIFUGO_PORT="${CENTRIFUGO_PORT:-8100}"
# Centrifugo HTTP API URL（Django/Celery publish 推送时用，必须跟 CENTRIFUGO_PORT 同步）。
# 子进程必须拿到这个值；否则 Celery/Django 可能回退到过期默认值，
# 推送到一个没人监听的实例 → 前端永远收不到实时消息（DB 落库 OK 但无推送）。
export CENTRIFUGO_API_URL="${CENTRIFUGO_API_URL:-http://127.0.0.1:${CENTRIFUGO_PORT}/api}"
