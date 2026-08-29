#!/usr/bin/env bash
# Celery worker pool 平台适配（供 celery-start.sh / celery-worker-local.sh source）
#
# Windows（Git Bash / MSYS）：默认 prefork/spawn 会因 billiard 句柄 PermissionError
# 导致子进程反复崩溃。
# macOS（Darwin）：多线程父进程 prefork 后子进程在 getaddrinfo/Network.framework
# 上 SIGSEGV；OBJC_DISABLE_INITIALIZE_FORK_SAFETY 不够。
# 本地 dev 的普通 worker 在 Windows/macOS 默认 solo、Linux 保持 prefork；
# Tracker 专属 worker 因长时间等待设备结果，Windows/macOS 默认 threads。
# 任意平台可用 CELERY_WORKER_POOL / CELERY_TRACKER_POOL 显式覆盖。

# bash 3.2（macOS 自带）不支持 ${var,,} 小写展开，用 tr 兼容。
# 本脚本非热路径（启动时调几次），fork tr 可接受。
_to_lower() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

_celery_platform_is_windows() {
  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN* | Windows*) return 0 ;;
  esac
  # Git Bash on Windows often reports uname as MINGW64_NT; fallback on OS env.
  case "${OS:-}" in
    Windows_NT) return 0 ;;
  esac
  return 1
}

_celery_platform_is_darwin() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) return 0 ;;
  esac
  return 1
}

_celery_default_pool() {
  # Windows / macOS：本地默认 solo，避开平台不安全的 prefork。
  if _celery_platform_is_windows || _celery_platform_is_darwin; then
    echo "${CELERY_WORKER_POOL:-solo}"
    return 0
  fi
  echo "${CELERY_WORKER_POOL:-prefork}"
}

_celery_pool_args() {
  local pool
  pool="$(_celery_default_pool)"
  echo "--pool=${pool}"
}

_celery_tracker_pool_args() {
  local pool
  if [[ -n "${CELERY_TRACKER_POOL:-}" ]]; then
    pool="${CELERY_TRACKER_POOL}"
  elif [[ -n "${CELERY_WORKER_POOL:-}" ]]; then
    # 全局显式覆盖优先于平台默认，便于故障复现和紧急降级。
    pool="${CELERY_WORKER_POOL}"
  elif _celery_platform_is_windows || _celery_platform_is_darwin; then
    # Tracker 的 Agent forward 是长时间同步等待；solo 会让一个 Run 独占整条
    # tracker_agent 队列。threads 避免 macOS/Windows 的 prefork 崩溃，同时让
    # 多个独立 Run 能按 CELERY_TRACKER_CONCURRENCY 并发等待设备结果。
    pool="threads"
  else
    pool="prefork"
  fi
  echo "--pool=${pool}"
}

_celery_queue_list_contains() {
  local queues="$1" expected="$2" part
  local IFS=','
  for part in ${queues}; do
    part="$(echo "${part}" | xargs 2>/dev/null || true)"
    [[ "${part}" == "${expected}" ]] && return 0
  done
  return 1
}

_celery_env_value() {
  local key="$1" env_file="$2"
  [[ -f "${env_file}" ]] || return 0
  grep -E "^${key}=" "${env_file}" 2>/dev/null | tail -1 | cut -d= -f2- \
    | tr -d '"' | tr -d "'" | xargs 2>/dev/null || true
}

_celery_env_value_any() {
  local key="$1" root_dir="${2:-.}" value=""
  for file in "${root_dir}/.env" "${root_dir}/.env.local"; do
    local next_value
    next_value="$(_celery_env_value "${key}" "${file}")"
    [[ -n "${next_value}" ]] && value="${next_value}"
  done
  echo "${value}"
}

_celery_safe_queue_suffix() {
  local raw="${1:-local}"
  local safe
  safe="$(echo "${raw}" | sed -E 's/[^A-Za-z0-9_]+/_/g; s/^_+|_+$//g' | tr '[:upper:]' '[:lower:]')"
  echo "${safe:-local}"
}

_celery_tracker_agent_queue() {
  local root_dir="${1:-.}"
  local explicit explicit_isolation mode should_isolate suffix

  explicit="${TRACKER_AGENT_QUEUE:-$(_celery_env_value_any TRACKER_AGENT_QUEUE "${root_dir}")}"
  if [[ -n "${explicit}" ]]; then
    echo "${explicit}"
    return 0
  fi

  explicit_isolation="${TRACKER_AGENT_ISOLATE_LOCAL_QUEUE:-$(_celery_env_value_any TRACKER_AGENT_ISOLATE_LOCAL_QUEUE "${root_dir}")}"
  case "$(_to_lower "${explicit_isolation}")" in
    1 | true | yes | on) should_isolate=1 ;;
    0 | false | no | off) should_isolate=0 ;;
    *)
      mode="${TABTIN_INFRA_MODE:-$(_celery_env_value_any TABTIN_INFRA_MODE "${root_dir}")}"
      # A local worker backed by the shared test Redis must never compete with
      # the ACK tracker worker.  Kubernetes workloads intentionally share the
      # canonical queue; local macOS, Windows, and Docker workers do not.
      if [[ "$(_to_lower "${mode}")" == "remote" && -z "${KUBERNETES_SERVICE_HOST:-}" ]]; then
        should_isolate=1
      else
        should_isolate=0
      fi
      ;;
  esac

  if [[ "${should_isolate}" == "1" ]]; then
    suffix="${TABTIN_QUEUE_SUFFIX:-$(_celery_env_value_any TABTIN_QUEUE_SUFFIX "${root_dir}")}"
    suffix="${suffix:-${COMPUTERNAME:-${HOSTNAME:-${USERNAME:-local}}}}"
    echo "tracker_agent_$(_celery_safe_queue_suffix "${suffix}")"
    return 0
  fi

  echo "tracker_agent"
}

# CELERY_PROFILE：
#   unset / community / lite → 社区默认只起 critical + default + realtime（beat 另起）
#   full → 8 个 worker 全起
# lite 仍只负责降并发（见 celery-start.sh），不另开一套 worker 名单。
_celery_resolved_profile() {
  local raw
  raw="$(_to_lower "${CELERY_PROFILE:-community}")"
  case "${raw}" in
    full) echo "full" ;;
    *) echo "community" ;;
  esac
}

_celery_should_start_worker() {
  local name="$1"
  if [[ "$(_celery_resolved_profile)" == "full" ]]; then
    return 0
  fi
  case "${name}" in
    critical | default | realtime) return 0 ;;
    *) return 1 ;;
  esac
}

_celery_map_tracker_agent_queue_arg() {
  local queues="$1" tracker_queue="$2"
  local IFS=',' part out=""
  for part in ${queues}; do
    part="$(echo "${part}" | xargs 2>/dev/null || true)"
    [[ "${part}" == "tracker_agent" ]] && part="${tracker_queue}"
    if [[ -z "${out}" ]]; then
      out="${part}"
    else
      out="${out},${part}"
    fi
  done
  echo "${out}"
}

# Git Bash 的 kill -0 只能探测 MSYS/Cygwin 进程；Celery 经 Python subprocess
# 写入的是 Windows PID，直接 kill -0 会误判「已退出」并中断后续 worker 启动。
_celery_pid_alive() {
  local pid="$1"
  [[ -n "${pid}" && "${pid}" =~ ^[0-9]+$ ]] || return 1
  if _celery_platform_is_windows; then
    powershell.exe -NoProfile -Command \
      "if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" \
      >/dev/null 2>&1
    return $?
  fi
  kill -0 "${pid}" >/dev/null 2>&1
}

# Resolve the venv Python executable without relying on PATH after activate.
# On Windows, console-script launchers (celery.exe / pip.exe) may embed a broken
# shebang pointing at venv/bin/python; always prefer `python -m celery` instead.
#
# Use -f (not -x): Git Bash on Windows often reports non-.exe files as
# non-executable even when they are valid Python hardlinks/shims.
_celery_venv_python() {
  local venv_dir="$1"
  local candidate
  for candidate in \
    "${venv_dir}/Scripts/python.exe" \
    "${venv_dir}/bin/python.exe" \
    "${venv_dir}/bin/python" \
    "${venv_dir}/Scripts/python"
  do
    if [[ -f "${candidate}" ]]; then
      echo "${candidate}"
      return 0
    fi
  done
  return 1
}

# Celery `-n name@host`：同机多 worktree 若都用 critical@%h 会撞名，后起的 worker
# 常在 boot 中途退出。Windows 上用仓库路径短哈希区分节点名。
_celery_node_name() {
  local role="$1"
  local root_dir="${2:-.}"
  local digest
  if ! _celery_platform_is_windows; then
    echo "${role}@%h"
    return 0
  fi
  digest="$(printf '%s' "${root_dir}" | cksum 2>/dev/null | awk '{print $1}')"
  digest="${digest:-local}"
  echo "${role}-${digest}@%h"
}
