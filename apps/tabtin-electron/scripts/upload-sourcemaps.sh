#!/bin/bash
#
# 上传 SourceMap 文件到后端服务器
# 使用静态 API Key 鉴权（不依赖 JWT）
#
# 用法: ./scripts/upload-sourcemaps.sh [--api-url URL] [--key KEY]
#
# 环境变量:
#   SOURCEMAP_API_URL  - 后端 API 地址 (默认从 .env 读取)
#   SOURCEMAP_UPLOAD_KEY - SourceMap 上传密钥
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$APP_DIR/out/renderer"

read_env_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | head -n1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true
}

normalize_api_url() {
  local url="$1"
  url="${url%/}"
  url="${url%/api}"
  printf '%s' "$url"
}

# 解析参数
API_URL="${SOURCEMAP_API_URL:-}"
UPLOAD_KEY="${SOURCEMAP_UPLOAD_KEY:-}"
APP_VERSION_OVERRIDE="${SOURCEMAP_APP_VERSION:-}"
PROFILE_ARG="${TABTIN_BUILD_PROFILE:-}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --api-url) API_URL="$2"; shift 2 ;;
    --key)     UPLOAD_KEY="$2"; shift 2 ;;
    --version) APP_VERSION_OVERRIDE="$2"; shift 2 ;;
    --profile) PROFILE_ARG="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# 从 profile 专属 env / 根 .env 获取缺失的配置。
# 优先级：显式参数/环境变量 > .env.<profile> > 根 .env 的 SOURCEMAP_API_URL >
# 根 .env 的 API_BASE_URL 兜底。
if [ -n "$PROFILE_ARG" ]; then
  PROFILE_ENV_FILE="$APP_DIR/.env.${PROFILE_ARG}"
  [ -z "$API_URL" ] && API_URL=$(read_env_value "$PROFILE_ENV_FILE" "SOURCEMAP_API_URL")
  [ -z "$UPLOAD_KEY" ] && UPLOAD_KEY=$(read_env_value "$PROFILE_ENV_FILE" "SOURCEMAP_UPLOAD_KEY")
fi

ENV_FILE="$APP_DIR/../../.env"
if [ -f "$ENV_FILE" ]; then
  [ -z "$API_URL" ] && API_URL=$(read_env_value "$ENV_FILE" "SOURCEMAP_API_URL")
  [ -z "$API_URL" ] && API_URL=$(read_env_value "$ENV_FILE" "API_BASE_URL")
  [ -z "$UPLOAD_KEY" ] && UPLOAD_KEY=$(read_env_value "$ENV_FILE" "SOURCEMAP_UPLOAD_KEY")
fi

if [ -z "$API_URL" ]; then
  echo "Error: API URL not set. Use --api-url or SOURCEMAP_API_URL env var."
  exit 1
fi
API_URL="$(normalize_api_url "$API_URL")"

if [ -z "$UPLOAD_KEY" ]; then
  echo "Error: Upload key not set. Use --key or SOURCEMAP_UPLOAD_KEY env var."
  exit 1
fi

# 版本号优先级（必须与 packaged app 实际 version 一致，否则 admindash
# 反混淆查不到对应 sourcemap）：
#   1. --version / SOURCEMAP_APP_VERSION（CI / build-packaged-app.sh 显式传入）
#   2. VITE_APP_VERSION（CI / packaged build 显式注入）
#   3. apps/tabtin-electron/package.json 的 version 字段（默认）
if [ -n "$APP_VERSION_OVERRIDE" ]; then
  APP_VERSION="$APP_VERSION_OVERRIDE"
elif [ -n "${VITE_APP_VERSION:-}" ]; then
  APP_VERSION="$VITE_APP_VERSION"
else
  APP_VERSION=$(node -p "require('$APP_DIR/package.json').version")
fi
echo "=== Uploading SourceMaps for v${APP_VERSION} ==="

UPLOAD_ENDPOINT="${API_URL}/api/client-errors/upload-sourcemap"
UPLOADED=0
FAILED=0

# 临时文件存放 JSON body —— 关键：不能用 -d "$BODY" 直接传，
# vendor-monaco / vendor-pdf 等大 .map 文件 JSON 化后能到 16MB+，
# 系统 ARG_MAX (~256KB on macOS) 会让 curl 直接 "Argument list too long"。
# 改用 -d @<file> 走文件，可传任意大小。
TMP_BODY="$(mktemp -t tabtin-sourcemap-body.XXXXXX.json)"
trap 'rm -f "$TMP_BODY"' EXIT

# 查找所有 .map 文件
for MAP_FILE in $(find "$OUT_DIR" -name "*.js.map" -type f 2>/dev/null); do
  # 文件路径：相对于 out/renderer，加 / 前缀
  REL_PATH="/${MAP_FILE#$OUT_DIR/}"
  # 对应的 JS 文件路径（去掉 .map 后缀）
  JS_PATH="${REL_PATH%.map}"

  MAP_SIZE=$(stat -f%z "$MAP_FILE" 2>/dev/null || stat -c%s "$MAP_FILE" 2>/dev/null || echo 0)
  printf "  Uploading: %s (%s bytes)\n" "$JS_PATH" "$MAP_SIZE"

  # 构建请求体到临时文件（python3 安全处理 JSON 转义 + 流式写入）
  python3 -c "
import json, sys
with open(sys.argv[1], 'r') as f:
    map_data = f.read()
with open(sys.argv[4], 'w') as out:
    json.dump({
        'app_version': sys.argv[2],
        'file_path': sys.argv[3],
        'map_data': map_data,
    }, out)
" "$MAP_FILE" "$APP_VERSION" "$JS_PATH" "$TMP_BODY"

  # 429 退避重试 —— sourcemap 上传是批量调用，即使后端把 client-errors
  # 模块配额加到 2000/min，少数情况（共用 IP 多人并发打包、middleware 改回保守值
  # 等）仍可能限流。读 Retry-After 头按指示退避，最多 3 次。
  ATTEMPT=0
  MAX_ATTEMPTS=3
  HTTP_CODE=""
  while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
    HEADERS_TMP="$(mktemp -t tabtin-sourcemap-headers.XXXXXX)"
    HTTP_CODE=$(curl -s -o /dev/null -D "$HEADERS_TMP" -w "%{http_code}" \
      -X POST "$UPLOAD_ENDPOINT" \
      -H "X-Sourcemap-Key: $UPLOAD_KEY" \
      -H "Content-Type: application/json" \
      --data-binary "@${TMP_BODY}" \
      --max-time 60)
    if [ "$HTTP_CODE" = "200" ]; then
      rm -f "$HEADERS_TMP"
      break
    fi
    if [ "$HTTP_CODE" = "429" ]; then
      RETRY_AFTER=$(grep -i "^Retry-After:" "$HEADERS_TMP" | tr -d '\r' | awk -F': ' '{print $2}' | head -n1)
      rm -f "$HEADERS_TMP"
      RETRY_AFTER=${RETRY_AFTER:-2}
      ATTEMPT=$((ATTEMPT + 1))
      if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
        echo "    ⏳ Rate limited (429), retry ${ATTEMPT}/${MAX_ATTEMPTS} after ${RETRY_AFTER}s"
        sleep "$RETRY_AFTER"
        continue
      fi
    fi
    rm -f "$HEADERS_TMP"
    break
  done

  if [ "$HTTP_CODE" = "200" ]; then
    UPLOADED=$((UPLOADED + 1))
  else
    echo "    ⚠ Failed (HTTP $HTTP_CODE)"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "=== Done: ${UPLOADED} uploaded, ${FAILED} failed ==="

# 失败也要返回非零，让 build-packaged-app.sh 的 local profile 强校验生效
if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
