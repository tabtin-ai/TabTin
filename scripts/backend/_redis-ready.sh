#!/usr/bin/env bash
# Redis / 本地基础设施就绪检测与启动辅助。
#
# 检测顺序：
#   1. 本机 redis-cli ping
#   2. Docker 容器 tabtin-redis-dev 内 redis-cli ping（无本机 CLI 时的常见 dev 场景）
#   3. TCP 端口探测（nc / bash /dev/tcp）
#
# 开发基础设施统一由 docker-compose.dev.yml 管理。

_dev_compose_file() {
  local root_dir="${1:-.}"
  echo "${root_dir}/docker-compose.dev.yml"
}

# ── 数据库模式（与 apps/tabtin_django/tabtin/settings.py 对齐）──
# 单库架构：业务库只走 PostgreSQL，本地基础设施只需 PostgreSQL + Redis。
# 读取优先级：进程 env > 仓库根 .env.local > 仓库根 .env > 默认 single_pg。
_tabtin_env_value() {
  local key="$1" env_file="$2"
  [[ -f "${env_file}" ]] || return 0
  grep -E "^${key}=" "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- \
    | tr -d '"' | tr -d "'" | tr '[:upper:]' '[:lower:]' | xargs 2>/dev/null || true
}

_tabtin_dev_env_file() {
  local root_dir="${1:-.}"
  # shellcheck disable=SC1091
  source "$(dirname "${BASH_SOURCE[0]}")/_dev-env-file.sh"
  _dev_env_file "${root_dir}"
}

_tabtin_env_value_any() {
  local key="$1" root_dir="${2:-.}" value="" file
  # shellcheck disable=SC1091
  source "$(dirname "${BASH_SOURCE[0]}")/_dev-env-file.sh"
  while IFS= read -r file; do
    value="$(_tabtin_env_value "${key}" "${file}")"
    [[ -n "${value}" ]] && break
  done < <(_dev_env_files "${root_dir}" | awk '{ lines[NR]=$0 } END { for (i=NR; i>=1; i--) print lines[i] }')
  echo "${value}"
}

_tabtin_db_mode() {
  local root_dir="${1:-.}"
  local mode="${TABTIN_DATABASE_MODE:-}"
  [[ -z "${mode}" ]] && mode="$(_tabtin_env_value_any TABTIN_DATABASE_MODE "${root_dir}")"
  echo "${mode:-single_pg}" | tr '[:upper:]' '[:lower:]'
}

# 基础设施的人类可读标签（用于启动文案）。单库架构下恒为 PostgreSQL + Redis。
_tabtin_infra_label() {
  echo "PostgreSQL + Redis"
}

_dev_compose_available() {
  local root_dir="${1:-.}"
  [[ -f "$(_dev_compose_file "${root_dir}")" ]] && command -v docker >/dev/null 2>&1
}

_redis_compose_container_id() {
  docker ps -a --filter name=^tabtin-redis-dev$ --format '{{.ID}}' 2>/dev/null | head -1
}

_redis_managed_by_compose() {
  [[ -n "$(_redis_compose_container_id)" ]]
}

_redis_url_decode() {
  local value="${1:-}"
  printf '%b' "${value//%/\\x}"
}

_redis_load_endpoint() {
  local env_file="${1:-}"
  local process_redis_host="${REDIS_HOST:-}"
  local process_redis_port="${REDIS_PORT:-}"
  REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
  REDIS_PORT="${REDIS_PORT:-6379}"
  REDIS_PASSWORD="${REDIS_PASSWORD:-}"

  if [[ -z "${env_file}" || ! -f "${env_file}" ]]; then
    return 0
  fi

  local url local_env env_password env_host env_port url_from_local local_password_override
  url_from_local=0
  local_password_override=0
  url="$(grep -E '^REDIS_URL=' "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  env_host="$(grep -E '^REDIS_HOST=' "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  env_port="$(grep -E '^REDIS_PORT=' "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  env_password="$(grep -E '^REDIS_PASSWORD=' "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
  [[ -z "${process_redis_host}" && -n "${env_host}" ]] && REDIS_HOST="${env_host}"
  [[ -z "${process_redis_port}" && -n "${env_port}" ]] && REDIS_PORT="${env_port}"
  [[ -z "${REDIS_PASSWORD:-}" && -n "${env_password}" ]] && REDIS_PASSWORD="${env_password}"
  local_env="$(dirname "${env_file}")/.env.local"
  if [[ -f "${local_env}" ]]; then
    url="$(grep -E '^REDIS_URL=' "${local_env}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    [[ -n "${url}" ]] && url_from_local=1
    [[ -z "${url}" ]] && url="$(grep -E '^REDIS_URL=' "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    local host_override port_override
    host_override="$(grep -E '^REDIS_HOST=' "${local_env}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    port_override="$(grep -E '^REDIS_PORT=' "${local_env}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    [[ -z "${process_redis_host}" && -n "${host_override}" ]] && REDIS_HOST="${host_override}"
    [[ -z "${process_redis_port}" && -n "${port_override}" ]] && REDIS_PORT="${port_override}"
    if [[ "${url_from_local}" -eq 0 && ( -n "${host_override}" || -n "${port_override}" ) ]]; then
      url=""
    fi
    local pwd_override
    pwd_override="$(grep -E '^REDIS_PASSWORD=' "${local_env}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
    if [[ -n "${pwd_override}" ]]; then
      REDIS_PASSWORD="${pwd_override}"
      local_password_override=1
    fi
  fi
  [[ -z "${url}" ]] && return 0

  # redis://[:password@]host[:port][/db] — 带密码 URL 也要解析出 host/port
  local rest="${url#redis://}"
  if [[ "${rest}" == *"@"* && ( -z "${REDIS_PASSWORD:-}" || ( "${url_from_local}" -eq 1 && "${local_password_override}" -eq 0 ) ) ]]; then
    local auth_part password_part
    auth_part="${rest%%@*}"
    password_part="${auth_part#*:}"
    [[ -n "${password_part}" && "${password_part}" != "${auth_part}" ]] \
      && REDIS_PASSWORD="$(_redis_url_decode "${password_part}")"
  fi
  rest="${rest#*@}"
  if [[ "${rest}" =~ ^([^:/]+):([0-9]+) ]]; then
    REDIS_HOST="${BASH_REMATCH[1]}"
    REDIS_PORT="${BASH_REMATCH[2]}"
  elif [[ "${rest}" =~ ^([^:/]+)/ ]]; then
    REDIS_HOST="${BASH_REMATCH[1]}"
  elif [[ -n "${rest}" ]]; then
    REDIS_HOST="${rest%%/*}"
  fi
}

# 宿主机视角的 Redis PONG（Centrifugo / Django / Celery 都连 host:port，不能只验容器内 exec）。
_host_redis_pong() {
  local host="${1:-127.0.0.1}"
  local port="${2:-6379}"

  if command -v redis-cli >/dev/null 2>&1; then
    if [[ -n "${REDIS_PASSWORD:-}" ]]; then
      redis-cli -h "${host}" -p "${port}" -a "${REDIS_PASSWORD}" --no-auth-warning ping 2>/dev/null \
        | grep -q PONG && return 0
    else
      redis-cli -h "${host}" -p "${port}" ping 2>/dev/null | grep -q PONG && return 0
    fi
  fi

  # 无本机 redis-cli 时，用一次性容器从宿主机网络探活（与 Centrifugo 连 127.0.0.1:6379 等价）。
  if _docker_daemon_ready 2>/dev/null; then
    local docker_redis_cli_args=(redis-cli -p "${port}")
    if [[ -n "${REDIS_PASSWORD:-}" ]]; then
      docker_redis_cli_args+=(-a "${REDIS_PASSWORD}" --no-auth-warning)
    fi
    if [[ "${host}" == "127.0.0.1" || "${host}" == "localhost" ]]; then
      docker run --rm --network host redis:8-alpine "${docker_redis_cli_args[@]}" -h 127.0.0.1 ping 2>/dev/null \
        | grep -q PONG && return 0
    fi
    docker run --rm redis:8-alpine \
      "${docker_redis_cli_args[@]}" -h "${host}" ping 2>/dev/null \
      | grep -q PONG && return 0
  fi

  return 1
}

_redis_ping() {
  local host="${REDIS_HOST:-127.0.0.1}"
  local port="${REDIS_PORT:-6379}"
  _host_redis_pong "${host}" "${port}"
}

# Docker daemon 是否真的可用（不只是 CLI 装了）。
# 旧 _dev_compose_available 只看 `command -v docker`，daemon 没起也返回真，
# 于是 `docker compose up -d` 必然连不上 socket 而失败。
_docker_daemon_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1
}

_redis_try_start() {
  local root_dir="${1:-.}"
  _docker_daemon_ready || return 1
  docker compose -f "$(_dev_compose_file "${root_dir}")" up -d redis
}

# TCP 端口连通性（优先 nc，回退 bash /dev/tcp）。
_tcp_open() {
  local host="$1" port="$2"
  if command -v nc >/dev/null 2>&1; then
    nc -z "${host}" "${port}" >/dev/null 2>&1 && return 0
    return 1
  fi
  (echo >/dev/tcp/"${host}"/"${port}") >/dev/null 2>&1
}

# 本地基础设施是否都已可连。不区分 brew 原生还是已起的 docker 容器——「能连上就不必再起」。
# 单库架构只 gate PostgreSQL + Redis。PG host/port 默认 127.0.0.1:5432（与
# docker-compose.dev.yml + brew 默认一致），可用 TABTIN_PG_HOST/PORT 覆盖。
_infra_reachable() {
  local root_dir="${1:-.}"
  local env_file
  env_file="$(_tabtin_dev_env_file "${root_dir}")"
  _redis_load_endpoint "${env_file}"
  _redis_ping || return 1
  local pg_host pg_port
  pg_host="${TABTIN_PG_HOST:-$(_tabtin_env_value_any PG_DB_HOST "${root_dir}")}"
  pg_port="${TABTIN_PG_PORT:-$(_tabtin_env_value_any PG_DB_PORT "${root_dir}")}"
  _tcp_open "${pg_host:-127.0.0.1}" "${pg_port:-5432}" || return 1
  return 0
}

# 开发基础设施统一由 Docker Compose 启动；daemon 不可用时立即失败，避免误用宿主服务。
_infra_try_start() {
  local root_dir="${1:-.}"
  local compose_file
  compose_file="$(_dev_compose_file "${root_dir}")"
  if [[ ! -f "${compose_file}" ]]; then
    echo "  ❌ 未找到 docker-compose.dev.yml" >&2
    return 1
  fi
  if ! _docker_daemon_ready; then
    echo "  ❌ Docker daemon 未就绪，请启动 Docker Desktop 或其他 Docker daemon。" >&2
    return 1
  fi
  echo "  ⏳ 通过 docker compose 拉起基础设施（$(_tabtin_infra_label "${root_dir}")）..."
  docker compose -f "${compose_file}" up -d postgres redis
  echo "  ✅ docker compose 基础设施已就绪（或已在运行）"
}

# 轮询等待 Docker Compose 基础设施可达。
# 用法：_infra_wait_ready <root_dir> [max_seconds=30]
_infra_wait_ready() {
  local root_dir="${1:-.}"
  local max="${2:-30}"
  local i
  for ((i = 1; i <= max; i++)); do
    _infra_reachable "${root_dir}" && return 0
    sleep 1
  done
  return 1
}

_ensure_redis_ready() {
  local root_dir="${1:-.}"
  local env_file
  env_file="$(_tabtin_dev_env_file "${root_dir}")"
  local max_attempts="${2:-10}"
  local attempt

  _redis_load_endpoint "${env_file}"

  for attempt in $(seq 1 "${max_attempts}"); do
    if _redis_ping; then
      return 0
    fi
    if [[ ${attempt} -eq 1 ]]; then
      _redis_try_start "${root_dir}"
    fi
    sleep 1
  done

  return 1
}

_redis_stop() {
  local root_dir="${1:-.}"

  if _dev_compose_available "${root_dir}" && _redis_managed_by_compose; then
    docker compose -f "$(_dev_compose_file "${root_dir}")" stop redis
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    brew services stop redis >/dev/null 2>&1 || true
  elif command -v systemctl >/dev/null 2>&1; then
    sudo systemctl stop redis 2>/dev/null || true
  fi
}

_redis_restart() {
  local root_dir="${1:-.}"

  if _dev_compose_available "${root_dir}" && _redis_managed_by_compose; then
    docker compose -f "$(_dev_compose_file "${root_dir}")" restart redis
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    brew services restart redis >/dev/null 2>&1 || true
  elif command -v systemctl >/dev/null 2>&1; then
    sudo systemctl restart redis 2>/dev/null || true
  else
    _redis_stop "${root_dir}"
    sleep 1
    _redis_try_start "${root_dir}"
  fi
}

_infra_container_running() {
  local name="${1}"
  docker ps --filter "name=^${name}$" --filter status=running -q 2>/dev/null | grep -q .
}

# 部署栈（旧 tabtin-full-* / 新 tabtin-deploy-*）与原生 dev 争用 8080/8100/4100。
_warn_deploy_stack_conflicts() {
  local root_dir="${1:-.}"
  local full_names deploy_names
  _docker_daemon_ready 2>/dev/null || return 1
  full_names="$(docker ps --filter name=tabtin-full --format '{{.Names}}' 2>/dev/null || true)"
  deploy_names="$(docker ps --filter name=tabtin-deploy --format '{{.Names}}' 2>/dev/null || true)"
  if [[ -n "${full_names}${deploy_names}" ]]; then
    echo "  ⚠️  检测到部署栈 tabtin-full-* / tabtin-deploy-* 仍在运行，会占用 8080/8100/4100。"
    echo "      日常 dev 建议先停掉：docker rm -f \$(docker ps -aq --filter name=tabtin-full) \$(docker ps -aq --filter name=tabtin-deploy)"
    return 0
  fi
  return 1
}
