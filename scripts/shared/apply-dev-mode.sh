#!/usr/bin/env bash
# 根据 .env.local 里的 TABTIN_LOCAL_DEV_MODE，把模式一/模式二预设 URL
# 映射到 TABTIN_API_BASE_URL / VITE_* 等运行时变量。
#
# 用法（脚本顶部 source）：
#   source "$(dirname "${BASH_SOURCE[0]}")/_apply-dev-mode.sh"
#   tabtin_apply_dev_mode "${ROOT_DIR}/.env.local"

tabtin_apply_dev_mode() {
  local env_file="${1:-}"
  if [[ ! -f "${env_file}" ]]; then
    return 0
  fi

  local mode=""
  mode="$(grep -E '^TABTIN_LOCAL_DEV_MODE=' "${env_file}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' | xargs || true)"
  if [[ -z "${mode}" || "${mode}" == "native" ]]; then
    return 0
  fi

  local prefix=""
  case "${mode}" in
    lite) prefix="TABTIN_LITE_" ;;
    docker) prefix="TABTIN_DOCKER_" ;;
    *)
      echo "⚠️  未知 TABTIN_LOCAL_DEV_MODE=${mode}（允许 lite / docker / native）" >&2
      return 0
      ;;
  esac

  _tabtin_apply_mode_preset() {
    local suffix="$1"
    local target="$2"
    local source="${prefix}${suffix}"
    local value=""
    value="$(grep -E "^${source}=" "${env_file}" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)"
    if [[ -n "${value}" ]]; then
      export "${target}=${value}"
    fi
  }

  _tabtin_apply_mode_preset "API_BASE_URL" "TABTIN_API_BASE_URL"
  _tabtin_apply_mode_preset "API_BASE_URL" "VITE_API_BASE_URL"
  _tabtin_apply_mode_preset "COLLAB_WS_BASE" "VITE_COLLAB_WS_BASE"
  _tabtin_apply_mode_preset "CENTRIFUGO_WS_URL" "VITE_CENTRIFUGO_WS_URL"
  _tabtin_apply_mode_preset "PUBLIC_WEB_BASE_URL" "VITE_PUBLIC_WEB_BASE_URL"
  _tabtin_apply_mode_preset "PUBLIC_WEB_BASE_URL" "TABTIN_PUBLIC_WEB_BASE_URL"
}
