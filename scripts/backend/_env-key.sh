#!/usr/bin/env bash
# 按键读取仓库 env 配置，不整包 source。
#
# 为什么不 `set -a; . .env`：
#   1) 主仓库 .env 是 Python 后端口径，布尔写成 True/False，整包带给 Go 服务
#      会直接撞 parseStrictBool（"must be true or false"）；
#   2) 整包 source 会让 env 里的任意值参与 shell 展开，风险大于收益。
#
# 用法（调用方需先定义 ROOT_DIR）：
#   # shellcheck disable=SC1091
#   source "$(dirname "${BASH_SOURCE[0]}")/_env-key.sh"
#   value="$(_tabtin_env_resolve DJANGO_BIND_PORT 6060)"
#
# 优先级：进程环境 > .env.local（个人覆盖）> .env（团队基线）> fallback。

_tabtin_env_read_key() {
  local file="$1" key="$2"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  grep -E "^${key}=" "${file}" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' || true
}

_tabtin_env_resolve() {
  local key="$1" fallback="${2:-}" value="" root="${ROOT_DIR:-.}"
  value="${!key:-}"
  if [[ -z "${value}" ]]; then
    value="$(_tabtin_env_read_key "${root}/.env.local" "${key}")"
  fi
  if [[ -z "${value}" ]]; then
    value="$(_tabtin_env_read_key "${root}/.env" "${key}")"
  fi
  if [[ -z "${value}" ]]; then
    value="${fallback}"
  fi
  printf '%s' "${value}"
}

# 小写归一，供开关类取值使用（macOS 自带 bash 3.2 没有 ${var,,}）。
_tabtin_env_resolve_lower() {
  _tabtin_env_resolve "$@" | tr '[:upper:]' '[:lower:]'
}
