#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_centrifugo-helpers.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_redis-ready.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_detach-spawn.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_http-health.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_env-key.sh"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
LONGPOLL_PID_FILE="${LOG_DIR}/channel-longpoll.pid"
LONGPOLL_LOG_FILE="${LOG_DIR}/channel-longpoll.log"
CENTRIFUGO_PID_FILE="${LOG_DIR}/centrifugo.pid"
CENTRIFUGO_LOG_FILE="${LOG_DIR}/centrifugo.log"
COLLAB_LIVE_DIR="${ROOT_DIR}/apps/collab-live"

echo "🚀 启动所有 TabTin 服务..."
echo ""
bash "${ROOT_DIR}/scripts/electron/runtime/_ensure-desktop-runtimes.sh" || true
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 检查本地开发配置与 Python 环境..."
bash "${ROOT_DIR}/scripts/backend/prepare-native-dev.sh"

# Community settings intentionally do not load repository env files directly:
# deployed processes must keep process-injected secrets authoritative. This
# native launcher is the trusted boundary that resolves only the required
# secret keys. Explicit non-empty process values still win over local files.
for secret_key in \
  SECRET_KEY \
  JWT_SECRET_KEY \
  CREDENTIAL_ENCRYPTION_KEY \
  PG_DB_PASSWORD \
  CENTRIFUGO_API_KEY \
  CENTRIFUGO_PROXY_SECRET \
  CENTRIFUGO_TOKEN_SECRET; do
  secret_value="$(_tabtin_env_resolve "${secret_key}")"
  if [[ -n "${secret_value}" ]]; then
    export "${secret_key}=${secret_value}"
  fi
done

# Community Django deliberately does not read repository env files. Resolve
# the non-secret local database settings at this trusted launcher boundary so
# an inherited SaaS shell cannot select the wrong edition or database.
export TABTIN_EDITION="${TABTIN_EDITION:-community}"
for local_key in \
  DEBUG \
  TABTIN_DATABASE_MODE \
  PG_DB_NAME \
  PG_DB_USER \
  PG_DB_HOST \
  PG_DB_PORT; do
  local_value="$(_tabtin_env_resolve "${local_key}")"
  if [[ -n "${local_value}" ]]; then
    export "${local_key}=${local_value}"
  fi
done
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 检查本地基础设施 ($(_tabtin_infra_label "${ROOT_DIR}"))..."
# 本地优先 / Docker 兜底：本机已就绪则跳过 docker；详见 _redis-ready.sh:_infra_try_start
# 单库架构：只需 PostgreSQL + Redis。
_infra_try_start "${ROOT_DIR}"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 检查 Redis 服务..."
if _ensure_redis_ready "${ROOT_DIR}"; then
  echo "  ✅ Redis 已就绪 (${REDIS_HOST}:${REDIS_PORT})"
else
  echo "  ❌ Redis 无法连接 (${REDIS_HOST}:${REDIS_PORT})，Django Channels / Celery 可能异常"
  echo "  手动启动: docker compose -f docker-compose.dev.yml up -d"
fi
echo ""

DJANGO_VENV_PYTHON="${ROOT_DIR}/apps/tabtin_django/venv/bin/python"
if [[ ! -x "${DJANGO_VENV_PYTHON}" ]]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📦 Django 虚拟环境不存在，开始安装本地后端依赖..."
  bash "${ROOT_DIR}/scripts/backend/django-setup.sh"
  echo ""
fi

# 数据库就绪门禁 + 加锁迁移（与 restart-all.sh 共用 db-prepare.sh，行为一致）
bash "${ROOT_DIR}/scripts/backend/db-prepare.sh"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 启动 Django..."
bash "${ROOT_DIR}/scripts/backend/django-start.sh"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 启动 Celery..."
bash "${ROOT_DIR}/scripts/backend/celery-start.sh"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 启动 Channel Longpoll Daemon..."
if [[ -f "${LONGPOLL_PID_FILE}" ]] && kill -0 "$(cat "${LONGPOLL_PID_FILE}")" 2>/dev/null; then
  echo "  Channel Longpoll 已在运行 (PID: $(cat "${LONGPOLL_PID_FILE}"))"
else
  DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
  LONGPOLL_PY="${DJANGO_DIR}/venv/bin/python"
  if [[ ! -x "${LONGPOLL_PY}" ]]; then
    LONGPOLL_PY="$(command -v python3 || command -v python)"
  fi
  _detach_spawn "${LONGPOLL_PID_FILE}" "${LONGPOLL_LOG_FILE}" "${DJANGO_DIR}" -- \
    "${LONGPOLL_PY}" manage.py run_longpoll
  echo "  Channel Longpoll 已启动 (PID: $(cat "${LONGPOLL_PID_FILE}"))"
fi
echo ""

if [[ -d "${COLLAB_LIVE_DIR}" ]]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🚀 启动 Collab Live (port ${COLLAB_LIVE_PORT})..."
  bash "${ROOT_DIR}/scripts/backend/collab-live-start.sh"
  echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 启动 Centrifugo..."
_warn_deploy_stack_conflicts "${ROOT_DIR}" || true
source "${ROOT_DIR}/scripts/backend/_dev-env-file.sh"
_redis_load_endpoint "$(_dev_env_file "${ROOT_DIR}")"
if ! _host_redis_pong "${REDIS_HOST}" "${REDIS_PORT}"; then
  echo "  ⏳ 宿主机 Redis (${REDIS_HOST}:${REDIS_PORT}) 未就绪，等待最多 15s..."
  _ensure_redis_ready "${ROOT_DIR}" 15 || true
fi
if ! _host_redis_pong "${REDIS_HOST}" "${REDIS_PORT}"; then
  echo "  ❌ 宿主机 Redis 仍不可达，Centrifugo 无法启动（见 ${CENTRIFUGO_LOG_FILE}）"
  echo "      请先：orbctl start && docker compose -f docker-compose.dev.yml up -d redis"
else
  centrifugo_started=false
  if _centrifugo_verify_started "${CENTRIFUGO_PID_FILE}"; then
    echo "  ✅ Centrifugo 已在运行 (PID: $(cat "${CENTRIFUGO_PID_FILE}"))"
    centrifugo_started=true
  fi
  if ! $centrifugo_started; then
    for attempt in 1 2 3; do
      if _centrifugo_verify_started "${CENTRIFUGO_PID_FILE}"; then
        centrifugo_started=true
        break
      fi
      if [[ ${attempt} -gt 1 ]]; then
        _centrifugo_stop "${ROOT_DIR}"
      fi
      # start-centrifugo.sh 自身已 start_new_session + 立即返回，无需再包 nohup/后台。
      if bash "${ROOT_DIR}/scripts/backend/start-centrifugo.sh"; then
        centrifugo_started=true
        break
      fi
      [[ ${attempt} -lt 3 ]] && sleep 1
    done
  fi
  if $centrifugo_started; then
    echo "  ✅ Centrifugo 已启动 (PID: $(cat "${CENTRIFUGO_PID_FILE}"))"
  else
    echo "  ❌ Centrifugo 启动失败，详见: ${CENTRIFUGO_LOG_FILE}"
    if grep -q 'address already in use' "${CENTRIFUGO_LOG_FILE}" 2>/dev/null; then
      echo "      常见原因：8100 被部署栈占用 → docker rm -f \$(docker ps -aq --filter name=tabtin-full) \$(docker ps -aq --filter name=tabtin-deploy)"
    elif grep -q 'connection refused' "${CENTRIFUGO_LOG_FILE}" 2>/dev/null; then
      echo "      常见原因：宿主机 Redis 未起 → docker compose -f docker-compose.dev.yml up -d redis"
    fi
    tail -3 "${CENTRIFUGO_LOG_FILE}" 2>/dev/null || true
  fi
fi
echo ""

# 收尾健康检查：超时 curl + 重试，避免冷启动慢一点就假失败；也避免服务卡住时永久挂起。
django_ok=false
collab_ok=false
centrifugo_ok=false
if _wait_http_health "http://127.0.0.1:${DJANGO_BIND_PORT}/health" healthy 20 0.5; then
  django_ok=true
fi
if [[ ! -d "${COLLAB_LIVE_DIR}" ]]; then
  collab_ok=true
elif _wait_http_health "http://127.0.0.1:${COLLAB_LIVE_PORT}/health" ok 20 0.5; then
  collab_ok=true
fi
# Centrifugo 用既有 pid/listen 校验，多试几次等 binary 绑口。
for _cfgo_try in $(seq 1 20); do
  if _centrifugo_verify_started "${CENTRIFUGO_PID_FILE}"; then
    centrifugo_ok=true
    break
  fi
  sleep 0.5
done
unset _cfgo_try

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if $django_ok && $collab_ok && $centrifugo_ok; then
  echo "✅ 所有服务已启动完成！"
else
  echo "⚠️  部分服务未通过健康检查（不要只看上面的「已启动」）"
  $django_ok || echo "  ❌ Django :${DJANGO_BIND_PORT}/health"
  $collab_ok || echo "  ❌ Collab Live :${COLLAB_LIVE_PORT}/health"
  $centrifugo_ok || echo "  ❌ Centrifugo :${CENTRIFUGO_PORT} (pid/listen)"
fi
echo ""
echo "服务状态:"
echo "  • Django Server       → http://0.0.0.0:${DJANGO_BIND_PORT}$($django_ok && echo '' || echo '  ❌')"
echo "  • Celery Worker       → 运行中"
echo "  • Celery Beat         → 运行中"
echo "  • Channel Longpoll    → 运行中"
echo "  • Collab Live         → ws://localhost:${COLLAB_LIVE_PORT}$($collab_ok && echo '' || echo '  ❌')"
echo "  • Centrifugo          → ws://localhost:${CENTRIFUGO_PORT}$($centrifugo_ok && echo '' || echo '  ❌')"
echo ""
echo "查看日志:"
echo "  tail -f apps/tabtin_django/logs/django-dev.log"
echo "  tail -f apps/tabtin_django/logs/celery-worker.log"
echo "  tail -f apps/tabtin_django/logs/celery-beat.log"
echo "  tail -f apps/tabtin_django/logs/centrifugo.log"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 下一步：Electron 客户端（请另开终端手动启动）"
_electron_port="$(grep -E '^VITE_DEV_SERVER_PORT=' "${ROOT_DIR}/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' "'\' || echo 5173)"
echo "  pnpm dev:frontend"
echo "  → http://localhost:${_electron_port}"
echo ""
  echo "  可选后台启动: pnpm dev:frontend"
echo ""

if ! $django_ok || ! $collab_ok || ! $centrifugo_ok; then
  exit 1
fi
