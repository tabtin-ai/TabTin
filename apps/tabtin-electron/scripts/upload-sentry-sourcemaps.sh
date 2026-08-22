#!/bin/bash
#
# 上传 SourceMap 到自部署 Sentry
#
# 与 upload-sourcemaps.sh（自建 client_errors 反混淆链路）并行存在、互不替代：
# 前者服务 AdminDash 反混淆，本脚本服务 Sentry 事件符号化。
#
# 启用条件（三者齐备，否则静默跳过——环境未就绪时不阻塞打包）：
#   SENTRY_URL         - 自部署 Sentry 地址（如 https://sentry.example.com）
#   SENTRY_AUTH_TOKEN  - sentry-cli 鉴权 token
#   SENTRY_ORG         - 组织 slug
# 可选：
#   SENTRY_PROJECT     - 项目 slug（必填）
#   SENTRY_APP_VERSION - 版本号（默认从 VITE_APP_VERSION / package.json 推导）
#
# release 命名契约（docs/agent/error-context-schema.md）：
#   tabtin-electron@<version>——必须与主进程 SDK 上报的 release 完全一致
#   （主进程用 app.getVersion()，即打包时 patch 进 package.json 的 PROFILE_VERSION），
#   否则 Sentry 堆栈无法符号化。
#
# Debug ID 注入（符号化实测 2026-07-07，缺这步整条链路白搭）：
#   packaged 后 renderer 帧 URL 是 tabtin-file://app/assets/*.js、main 帧是
#   app.asar 内绝对路径，都无法与 artifact 的 ~/renderer/... ~/main/... 路径
#   匹配（Sentry 报 js_no_source）。`sourcemaps inject` 往 js/map 写入配对的
#   Debug ID，事件按 ID 找 sourcemap，路径彻底不参与匹配。inject 必须发生在
#   electron-builder 打 asar 之前（本脚本在 step 1.6 调用，满足），这样带
#   debugId 注释的 js 才会进安装包。
#
# 本脚本设计为本地可跑（当前 CI 关闭）：打包机配好 env 后由
# build-packaged-app.sh step 1.6 自动调用，也可手工执行。
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$APP_DIR/out"

SENTRY_PROJECT="${SENTRY_PROJECT:-}"
PROFILE_ARG="${TABTIN_BUILD_PROFILE:-}"

read_env_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | head -n1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true
}

# 公开的 URL / org / project 可从 profile 文件补全；鉴权 token 只接受进程环境。
if [ -n "$PROFILE_ARG" ]; then
  PROFILE_ENV_FILE="$APP_DIR/.env.${PROFILE_ARG}"
  [ -z "${SENTRY_URL:-}" ] && SENTRY_URL=$(read_env_value "$PROFILE_ENV_FILE" "SENTRY_URL")
  [ -z "${SENTRY_ORG:-}" ] && SENTRY_ORG=$(read_env_value "$PROFILE_ENV_FILE" "SENTRY_ORG")
  [ -z "$SENTRY_PROJECT" ] && {
    _p=$(read_env_value "$PROFILE_ENV_FILE" "SENTRY_PROJECT")
    [ -n "$_p" ] && SENTRY_PROJECT="$_p"
  }
fi

ENV_FILE="$APP_DIR/../../.env"
LOCAL_ENV_FILE="$APP_DIR/../../.env.local"
if [ -f "$ENV_FILE" ]; then
  [ -z "${SENTRY_URL:-}" ] && SENTRY_URL=$(read_env_value "$ENV_FILE" "SENTRY_URL")
  [ -z "${SENTRY_ORG:-}" ] && SENTRY_ORG=$(read_env_value "$ENV_FILE" "SENTRY_ORG")
  [ -z "$SENTRY_PROJECT" ] && {
    _p=$(read_env_value "$ENV_FILE" "SENTRY_PROJECT")
    [ -n "$_p" ] && SENTRY_PROJECT="$_p"
  }
fi

# .env.local 只允许补充公开的 endpoint / slug，不读取鉴权 token。
if [ -f "$LOCAL_ENV_FILE" ]; then
  [ -z "${SENTRY_URL:-}" ] && SENTRY_URL=$(read_env_value "$LOCAL_ENV_FILE" "SENTRY_URL")
  [ -z "${SENTRY_ORG:-}" ] && SENTRY_ORG=$(read_env_value "$LOCAL_ENV_FILE" "SENTRY_ORG")
  [ -z "$SENTRY_PROJECT" ] && {
    _p=$(read_env_value "$LOCAL_ENV_FILE" "SENTRY_PROJECT")
    [ -n "$_p" ] && SENTRY_PROJECT="$_p"
  }
fi

if [ -z "${SENTRY_URL:-}" ] || [ -z "${SENTRY_AUTH_TOKEN:-}" ] || [ -z "${SENTRY_ORG:-}" ] || [ -z "${SENTRY_PROJECT:-}" ]; then
  if [ "${SENTRY_SYMBOL_UPLOAD_REQUIRED:-0}" = "1" ]; then
    echo "  ERROR: Sentry sourcemap upload is required, but SENTRY_URL / SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT are not all set" >&2
    echo "  ERROR: SENTRY_AUTH_TOKEN must be injected through the build process environment; set SENTRY_SYMBOL_UPLOAD_SKIP=1 to disable this upload explicitly." >&2
    exit 2
  fi
  echo "  Skipping Sentry sourcemap upload (SENTRY_URL / SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT not all set)"
  exit 0
fi

APP_VERSION="${SENTRY_APP_VERSION:-${VITE_APP_VERSION:-}}"
if [ -z "$APP_VERSION" ]; then
  APP_VERSION=$(node -p "require('$APP_DIR/package.json').version")
fi
RELEASE="tabtin-electron@${APP_VERSION}"

echo "=== Uploading sourcemaps to Sentry: release=${RELEASE} project=${SENTRY_PROJECT} ==="

# sentry-cli：优先使用项目固定版本；发布关键路径不在线下载。
if [ -n "${SENTRY_CLI_BIN:-}" ]; then
  SENTRY_CLI=("$SENTRY_CLI_BIN")
elif [ -x "$APP_DIR/node_modules/.bin/sentry-cli" ]; then
  SENTRY_CLI=("$APP_DIR/node_modules/.bin/sentry-cli")
elif command -v sentry-cli >/dev/null 2>&1; then
  SENTRY_CLI=(sentry-cli)
else
  echo "  ERROR: sentry-cli is unavailable; run pnpm install before packaging" >&2
  exit 2
fi

SENTRY_CLI_MAX_ATTEMPTS="${SENTRY_CLI_MAX_ATTEMPTS:-3}"
SENTRY_CLI_RETRY_DELAY_SECONDS="${SENTRY_CLI_RETRY_DELAY_SECONDS:-2}"

run_sentry_network_command() {
  local attempt=1
  local exit_code

  while true; do
    if "${SENTRY_CLI[@]}" "$@"; then
      return 0
    else
      exit_code=$?
    fi

    if [ "$attempt" -ge "$SENTRY_CLI_MAX_ATTEMPTS" ]; then
      echo "  ERROR: sentry-cli $* failed after ${attempt} attempts" >&2
      return "$exit_code"
    fi

    echo "  WARN: sentry-cli $* failed (attempt ${attempt}/${SENTRY_CLI_MAX_ATTEMPTS}); retrying in ${SENTRY_CLI_RETRY_DELAY_SECONDS}s" >&2
    sleep "$SENTRY_CLI_RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
}

export SENTRY_URL SENTRY_AUTH_TOKEN SENTRY_ORG SENTRY_PROJECT

run_sentry_network_command info >/dev/null
if ! run_sentry_network_command releases info "$RELEASE" >/dev/null 2>&1; then
  run_sentry_network_command releases new "$RELEASE"
fi
# 先注入 Debug ID（改写 out/ 下的 js + map，见文件头注释），再上传。
inject_started_at=$SECONDS
"${SENTRY_CLI[@]}" sourcemaps inject "$OUT_DIR"
echo "  sentry-cli sourcemaps inject completed in $((SECONDS - inject_started_at))s"
# out/ 下 main / preload / renderer 三份产物的 hidden sourcemap 全部上传
run_sentry_network_command sourcemaps upload --release="$RELEASE" "$OUT_DIR"
run_sentry_network_command releases finalize "$RELEASE"

echo "=== Sentry sourcemap upload done ==="
