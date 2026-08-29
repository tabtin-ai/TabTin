#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
# Git Bash exposes repository paths as /c/... while native Windows Node expects
# a Windows/UNC path when a path is embedded in a JavaScript expression.
node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}
PROFILE="${2:-${TABTIN_BUILD_PROFILE:-local}}"
case "$PROFILE" in
  local|community) ;;
  *)
    echo "Unsupported profile: $PROFILE (允许 local / community)" >&2
    exit 1
    ;;
esac
# Open-source snapshots may omit the internal timing helper. Packaging remains
# functional; only optional timing output is disabled in that case.
PACK_TIMING_SCRIPT="${REPO_ROOT}/scripts/_pack-timing.sh"
if [ -f "$PACK_TIMING_SCRIPT" ]; then
  # shellcheck disable=SC1091
  source "$PACK_TIMING_SCRIPT"
else
  pack_time_begin() { :; }
  pack_time_step_begin() { :; }
  pack_time_step_end() { :; }
  pack_time_summary() { :; }
fi
TARGET="${1:-mac}"
# 第二个参数 / 环境变量都可指定 profile（local / community，缺省 local）。
TABTIN_DISTRIBUTION_KIND="official"
COMMUNITY_API_BASE_URL=""
COMMUNITY_COLLAB_WS_BASE=""
COMMUNITY_CENTRIFUGO_WS_URL=""
COMMUNITY_PUBLIC_WEB_BASE_URL=""
COMMUNITY_UPDATE_FEED_URL=""
COMMUNITY_WS_BASE_URL=""
COMMUNITY_IM_API_BASE_URL=""
if [ "$PROFILE" = "community" ]; then
  COMMUNITY_API_BASE_URL="${TABTIN_COMMUNITY_API_BASE_URL:-http://127.0.0.1:6060/api}"
  COMMUNITY_COLLAB_WS_BASE="${TABTIN_COMMUNITY_COLLAB_WS_BASE:-ws://127.0.0.1:4100}"
  COMMUNITY_CENTRIFUGO_WS_URL="${TABTIN_COMMUNITY_CENTRIFUGO_WS_URL:-ws://127.0.0.1:8100/connection/websocket}"
  COMMUNITY_PUBLIC_WEB_BASE_URL="${TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL:-http://127.0.0.1:5176}"
  COMMUNITY_UPDATE_FEED_URL="${TABTIN_COMMUNITY_UPDATE_FEED_URL:-}"
  COMMUNITY_IM_API_BASE_URL="$COMMUNITY_API_BASE_URL"
  COMMUNITY_WS_BASE_URL="$(node -e '
    const parsed = new URL(process.argv[1])
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:"
    parsed.pathname = "/"
    parsed.search = ""
    parsed.hash = ""
    process.stdout.write(parsed.origin)
  ' "$COMMUNITY_API_BASE_URL")"

  validate_community_endpoint() {
    local name="$1"
    local value="$2"
    local protocols="$3"
    node -e '
      const [value, protocols] = process.argv.slice(1)
      const parsed = new URL(value)
      const allowed = protocols.split(",")
      const blockedHosts = ["169.254.169.254", "metadata.google.internal", "metadata.internal"]
      const blockedSuffixes = ["example.com", "example.com", "xmov.ai"]
      const hostname = parsed.hostname.toLowerCase()
      const isCompany = blockedSuffixes.some(
        suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)
      )
      if (!allowed.includes(parsed.protocol) || parsed.username || parsed.password || !hostname ||
          blockedHosts.includes(hostname) || isCompany) {
        process.exit(1)
      }
    ' "$value" "$protocols" || {
      echo "Invalid ${name}: expected a safe public endpoint" >&2
      exit 1
    }
  }

  validate_community_endpoint TABTIN_COMMUNITY_API_BASE_URL "$COMMUNITY_API_BASE_URL" "http:,https:"
  validate_community_endpoint TABTIN_COMMUNITY_IM_API_BASE_URL "$COMMUNITY_IM_API_BASE_URL" "http:,https:"
  validate_community_endpoint TABTIN_COMMUNITY_COLLAB_WS_BASE "$COMMUNITY_COLLAB_WS_BASE" "ws:,wss:"
  validate_community_endpoint TABTIN_COMMUNITY_CENTRIFUGO_WS_URL "$COMMUNITY_CENTRIFUGO_WS_URL" "ws:,wss:"
  validate_community_endpoint TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL "$COMMUNITY_PUBLIC_WEB_BASE_URL" "http:,https:"
  if [ -n "$COMMUNITY_UPDATE_FEED_URL" ]; then
    node -e '
      const parsed = new URL(process.argv[1])
      const hostname = parsed.hostname.toLowerCase()
      const companySuffixes = ["example.com", "example.com", "xmov.ai"]
      const isCompany = companySuffixes.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
      if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
          ["169.254.169.254", "metadata.google.internal", "metadata.internal"].includes(hostname) || isCompany) {
        process.exit(1)
      }
    ' "$COMMUNITY_UPDATE_FEED_URL" || {
      echo "Invalid TABTIN_COMMUNITY_UPDATE_FEED_URL: expected an HTTPS URL without credentials" >&2
      exit 1
    }
  fi
  TABTIN_DISTRIBUTION_KIND="community"
  export TABTIN_API_BASE_URL="$COMMUNITY_API_BASE_URL"
  export VITE_API_BASE_URL="$COMMUNITY_API_BASE_URL"
  export TABTIN_WS_BASE_URL="$COMMUNITY_WS_BASE_URL"
  export VITE_WS_BASE_URL="$COMMUNITY_WS_BASE_URL"
  # Community TabChat uses Django /api/im and therefore shares the API origin.
  export VITE_IM_API_BASE_URL="$COMMUNITY_API_BASE_URL"
  export VITE_COLLAB_WS_BASE="$COMMUNITY_COLLAB_WS_BASE"
  export VITE_CENTRIFUGO_WS_URL="$COMMUNITY_CENTRIFUGO_WS_URL"
  export TABTIN_PUBLIC_WEB_BASE_URL="$COMMUNITY_PUBLIC_WEB_BASE_URL"
  export VITE_PUBLIC_WEB_BASE_URL="$COMMUNITY_PUBLIC_WEB_BASE_URL"
  export VITE_WEBSITE_BASE_URL="${TABTIN_COMMUNITY_WEBSITE_BASE_URL:-http://127.0.0.1:6060}"
  export VITE_SENTRY_DSN=""
  export SENTRY_URL=""
  export SOURCEMAP_API_URL=""
  export VITE_DISTRIBUTION_KIND="community"
  export SOURCEMAP_UPLOAD_SKIP=1
  export SENTRY_SYMBOL_UPLOAD_SKIP=1
  if [ "${TABTIN_COMMUNITY_PROFILE_VALIDATE_ONLY:-0}" = "1" ]; then
    echo "Community build profile validation passed API=${COMMUNITY_API_BASE_URL} WS=${COMMUNITY_WS_BASE_URL} IM=${COMMUNITY_IM_API_BASE_URL} Centrifugo=${COMMUNITY_CENTRIFUGO_WS_URL}"
    exit 0
  fi
fi
# 第三个参数 / 环境变量都可指定目标 CPU 架构（arm64 / x64；缺省 host arch）。
# 仅 mac 和 win 关心；linux 默认 x64。
HOST_ARCH_RAW="$(uname -m)"
case "$HOST_ARCH_RAW" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|amd64)  HOST_ARCH="x64" ;;
  *)             HOST_ARCH="x64" ;;
esac
ARCH="${3:-${TABTIN_BUILD_ARCH:-$HOST_ARCH}}"

TARGET_NAME=""
BUILD_TITLE=""
BUILDER_FLAG=""
TARGET_RUNTIME=""
HOST_RUNTIME=""
EXTRA_BUILDER_ARGS=()

case "$ARCH" in
  arm64) ARCH_FLAG="--arm64" ;;
  x64)   ARCH_FLAG="--x64" ;;
  *)
    echo "Unsupported arch: $ARCH (允许 arm64 / x64)" >&2
    exit 1
    ;;
esac

case "$TARGET" in
  mac|darwin)
    TARGET_NAME="mac"
    BUILD_TITLE="DMG ($ARCH)"
    BUILDER_FLAG=("--mac" "$ARCH_FLAG")
    TARGET_RUNTIME="darwin"
    ;;
  linux)
    TARGET_NAME="linux"
    BUILD_TITLE="Linux Package ($ARCH)"
    BUILDER_FLAG=("--linux" "$ARCH_FLAG")
    TARGET_RUNTIME="linux"
    ;;
  win|windows|win32)
    TARGET_NAME="win"
    BUILD_TITLE="Windows Package ($ARCH)"
    BUILDER_FLAG=("--win" "$ARCH_FLAG")
    TARGET_RUNTIME="win32"
    ;;
  *)
    echo "Unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

case "$(uname -s)" in
  Darwin)
    HOST_RUNTIME="darwin"
    ;;
  Linux)
    HOST_RUNTIME="linux"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    HOST_RUNTIME="win32"
    ;;
  *)
    HOST_RUNTIME="unknown"
    ;;
esac

# TABTIN_PACK_QUICK=1：高频发包快路径（对齐 build-mac-dmg-quick）
#   - Windows 复用按依赖契约校验的 deploy；每次命中后刷新当前 workspace 包产物
#   - local quick 跳过 sourcemap
#   - Windows NSIS 默认 compression=normal（对齐 Mac DMG zlib 量级体积；可用 TABTIN_WIN_NSIS_COMPRESSION 覆盖）
#   - 清理只做正确性 prune
#   - 仍跑完整资源 staging + packaged artifact audit
PACK_QUICK=0
if [ "${TABTIN_PACK_QUICK:-0}" = "1" ]; then
  PACK_QUICK=1
fi

pack_may_skip_sentry_symbols() {
  [ "$1" = "1" ] && [ "$2" = "local" ]
}

PACK_SKIP_SENTRY_SYMBOLS=0
if pack_may_skip_sentry_symbols "$PACK_QUICK" "$PROFILE"; then
  PACK_SKIP_SENTRY_SYMBOLS=1
fi

PACKAGED_RUN_ID="${TABTIN_PACKAGED_DEPLOY_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"

allocate_packaged_deploy_dir() {
  local packaged_run_id="${PACKAGED_RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
  if [ -n "${TABTIN_PACKAGED_DEPLOY_DIR:-}" ]; then
    printf '%s\n' "$TABTIN_PACKAGED_DEPLOY_DIR"
    return 0
  fi

  if [ "$PACK_QUICK" = "1" ] && [ "$TARGET_RUNTIME" = "win32" ]; then
    local quick_cache_root="$APP_DIR/.deploy-quick-win-${PROFILE}-${ARCH}"
    node "$SCRIPT_DIR/quick-deploy-cache.mjs" path "$REPO_ROOT" "$quick_cache_root" "$packaged_run_id"
    return 0
  fi

  # Deploy dir 必须在仓库内：electron-builder 跑 flip-electron-fuses.cjs 等
  # 脚本时通过 Node 模块解析向上找 @electron/fuses 等 devDependency；放到
  # /tmp 之类仓库外位置会因为找不到 dev deps 直接报错。
  # 所有策略每次使用独立 run 目录，避免旧 workspace 副本或被占用的
  # win-unpacked/app.asar 污染本次产物。可信缓存必须经过内容指纹验证后再单独引入。
  # pnpm deploy resolves its target from the workspace root. Keep the default
  # staging root there as well so pnpm, resource staging, and cleanup share the
  # same absolute directory.
  local deploy_root="${TABTIN_PACKAGED_DEPLOY_ROOT:-$REPO_ROOT/.deploy-runs}"
  printf '%s/%s-%s-%s-%s\n' "$deploy_root" "$PROFILE" "$TARGET_NAME" "$ARCH" "$packaged_run_id"
}

# 把旧 deploy 挪走后后台删，避免 Windows/NTFS 上 rm -rf 大目录阻塞 pnpm deploy。
retire_packaged_deploy_dir() {
  local target="$1"
  [ -e "$target" ] || return 0
  local stale="${target}.stale.$$"
  if mv "$target" "$stale" 2>/dev/null; then
    echo "  · retiring old deploy in background: $stale"
    (
      chmod -R u+w "$stale" 2>/dev/null || true
      rm -rf "$stale"
    ) >/dev/null 2>&1 &
    return 0
  fi
  if [ "$TARGET_RUNTIME" = "win32" ]; then
    echo "  ⚠ deploy directory is still in use; leaving it for later cleanup: $target" >&2
    return 1
  fi
  echo "  · rename deploy failed, falling back to foreground rm: $target"
  chmod -R u+w "$target" 2>/dev/null || true
  if ! rm -rf "$target"; then
    echo "  ⚠ deploy 目录仍被占用，无法清理: $target" >&2
    return 1
  fi
}

run_pnpm_deploy() {
  local deploy_dir="$1"
  local pnpm_command="pnpm"
  # In Git Bash, the POSIX pnpm shim resolves its own /c/... path through
  # Windows Node. With MSYS path conversion disabled below, that becomes
  # C:\\c\\...; use the Windows cmd shim when it is available.
  if [ "$HOST_RUNTIME" = "win32" ] && [ "$TARGET_RUNTIME" = "win32" ] && command -v pnpm.CMD >/dev/null 2>&1; then
    pnpm_command="pnpm.CMD"
  fi
  # pnpm deploy resolves its target from the workspace root. Passing an
  # absolute path makes pnpm 9 append the package root again; keep DEPLOY_DIR
  # absolute for the rest of this script, but pass a workspace-relative target.
  local deploy_target="$deploy_dir"
  case "$deploy_dir" in
    "$REPO_ROOT"/*) deploy_target=".${deploy_dir#"$REPO_ROOT"}" ;;
  esac
  if [ "$TARGET_RUNTIME" = "win32" ]; then
    GIT_CONFIG_COUNT=3 \
    GIT_CONFIG_KEY_0="url.https://github.com/.insteadOf" \
    GIT_CONFIG_VALUE_0="git+ssh://git@github.com/" \
    GIT_CONFIG_KEY_1="url.https://github.com/.insteadOf" \
    GIT_CONFIG_VALUE_1="ssh://git@github.com/" \
    GIT_CONFIG_KEY_2="url.https://github.com/.insteadOf" \
    GIT_CONFIG_VALUE_2="git@github.com:" \
    MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" \
      "$pnpm_command" --config.virtual-store-dir-max-length=40 \
        --filter tabtin-electron deploy "$deploy_target" --prod --ignore-scripts
  else
    # postinstall electron-rebuild 在仓库根 deploy 目录会撞 node_modules/node_modules ELOOP。
    # 打包链路随后自己 prune / 用 NODE_PATH 解析 @electron/fuses，不依赖 deploy 期 rebuild。
    "$pnpm_command" --filter tabtin-electron deploy "$deploy_target" --prod --ignore-scripts
  fi
}

remove_tree_with_windows_retry() {
  local target="$1"
  local attempt
  for attempt in 1 2 3 4 5 6; do
    chmod -R u+w "$target" 2>/dev/null || true
    rm -rf "$target" 2>/dev/null || true
    [ ! -e "$target" ] && return 0
    if [ "$HOST_RUNTIME" != "win32" ]; then
      break
    fi
    echo "  · Windows still holds files in $target; retrying removal ($attempt/6)"
    sleep 2
  done
  echo "  ⚠ unable to replace final dist directory: $target" >&2
  return 1
}

prepare_packaged_deploy_dir() {
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  if [ -e "$DEPLOY_DIR" ]; then
    retire_packaged_deploy_dir "$DEPLOY_DIR"
  fi
  mkdir -p "$DEPLOY_DIR"
}

cleanup_packaged_deploy_dir() {
  if [ "$PACK_QUICK_DEPLOY_CACHE" = "1" ]; then
    echo "  · preserving validated Windows quick deploy cache: $DEPLOY_DIR"
    return 0
  fi
  if [ -e "$DEPLOY_DIR" ]; then
    if ! retire_packaged_deploy_dir "$DEPLOY_DIR"; then
      echo "  ⚠ 安装包已生成；临时 deploy 目录已保留供后续人工清理: $DEPLOY_DIR" >&2
    fi
  fi
}

electron_dependency_resolves() {
  local spec="$1"

  (
    cd "$APP_DIR"
    node -e "require('node:module').createRequire(process.cwd() + '/package.json').resolve(process.argv[1])" "$spec" >/dev/null 2>&1
  )
}

ensure_electron_dependency_resolves() {
  local spec="$1"

  if electron_dependency_resolves "$spec"; then
    return 0
  fi

  echo "  · Electron 依赖 ${spec} 未安装，执行 pnpm install --frozen-lockfile 同步 node_modules"
  (
    cd "$REPO_ROOT"
    pnpm install --frozen-lockfile --ignore-scripts --prefer-offline
  )

  if ! electron_dependency_resolves "$spec"; then
    echo "❌ pnpm install 后仍无法解析 ${spec}；请检查 package.json / pnpm-lock.yaml 与 node_modules" >&2
    exit 1
  fi
}

DEPLOY_DIR="$(allocate_packaged_deploy_dir)"
ARTIFACT_DIR_RELATIVE="dist-app"
if [ "$TARGET_RUNTIME" = "win32" ]; then
  ARTIFACT_DIR_RELATIVE="dist-app-runs/$PACKAGED_RUN_ID"
  artifact_attempt=0
  while [ -e "$DEPLOY_DIR/$ARTIFACT_DIR_RELATIVE" ]; do
    artifact_attempt=$((artifact_attempt + 1))
    ARTIFACT_DIR_RELATIVE="dist-app-runs/${PACKAGED_RUN_ID}-${artifact_attempt}"
  done
fi
ARTIFACT_DIR="$DEPLOY_DIR/$ARTIFACT_DIR_RELATIVE"
PACK_QUICK_DEPLOY_CACHE=0
QUICK_DEPLOY_CACHE_HIT=0
if [ "$PACK_QUICK" = "1" ] && [ "$TARGET_RUNTIME" = "win32" ] && \
   [ -z "${TABTIN_PACKAGED_DEPLOY_DIR:-}" ]; then
  PACK_QUICK_DEPLOY_CACHE=1
fi
BUILD_COMPLETED=0

cleanup_packaged_deploy_on_exit() {
  local exit_code=$?
  trap - EXIT
  set +e
  if [ "$BUILD_COMPLETED" != "1" ] && [ "$QUICK_DEPLOY_CACHE_HIT" = "1" ]; then
    echo "  · preserving validated quick dependency cache after failed build: $DEPLOY_DIR" >&2
  elif [ "$BUILD_COMPLETED" != "1" ] && [ -e "$DEPLOY_DIR" ]; then
    echo "  ⚠ 构建未完成，正在回收本次临时 deploy: $DEPLOY_DIR" >&2
    if ! retire_packaged_deploy_dir "$DEPLOY_DIR"; then
      echo "  ⚠ 临时 deploy 仍被占用，已保留供人工清理: $DEPLOY_DIR" >&2
    fi
  fi
  exit "$exit_code"
}

trap cleanup_packaged_deploy_on_exit EXIT

pack_time_begin "${BUILD_TITLE} (profile=${PROFILE})"
echo "=== TabTin ${BUILD_TITLE} Build (profile=${PROFILE}) ==="
if [ "$PACK_QUICK" = "1" ]; then
  if [ "$PACK_SKIP_SENTRY_SYMBOLS" = "1" ]; then
    echo "  · mode: QUICK LOCAL (skip sourcemaps; Windows deep prune/cache; keep staging + audit)"
  else
    echo "  · mode: QUICK (Sentry symbols enabled; Windows deep prune/cache; keep staging + audit)"
  fi
fi

if [ "$HOST_RUNTIME" != "$TARGET_RUNTIME" ]; then
  echo "  ⚠ 当前在 ${HOST_RUNTIME} 上交叉打包 ${TARGET_RUNTIME}。"
  echo "  ⚠ node-pty 等原生模块仍可能保留宿主平台二进制，产物更适合做结构验证，正式发布请在目标平台 CI 或真机环境构建。"
fi

# 注入 build profile 让 electron.vite.config.ts 能切换 .env.* 文件
export TABTIN_BUILD_PROFILE="$PROFILE"
if [ "$PROFILE" = "local" ]; then
  export VITE_BUILD_PROFILE="$PROFILE"
fi
export TABTIN_BUILD_TARGET="$TARGET_RUNTIME"
export TABTIN_BUILD_ARCH="$ARCH"
export NODE_ENV="production"
PROFILE_VERSION="${VITE_APP_VERSION:-$(node -p "require('$(node_path "$APP_DIR/package.json")').version")}" 
export VITE_APP_VERSION="$PROFILE_VERSION"
echo "  · app 版本号: $PROFILE_VERSION"

# Office preview runtime：PPT / Word 高保真预览依赖 LibreOffice headless + Poppler。
office_runtime_has_soffice() {
  local root="$1"
  [ -x "$root/bin/soffice" ] || \
    [ -x "$root/bin/soffice.exe" ] || \
    [ -x "$root/native/libreoffice-headless/bin/soffice" ] || \
    [ -x "$root/native/libreoffice-headless/bin/soffice.exe" ] || \
    [ -x "$root/native/libreoffice-headless/program/soffice.exe" ] || \
    [ -x "$root/native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice" ] || \
    [ -x "$root/native/libreoffice-headless/libreoffice/LibreOffice.app/Contents/MacOS/soffice" ]
}

office_runtime_has_pdftoppm() {
  local root="$1"
  [ -x "$root/bin/pdftoppm" ] || \
    [ -x "$root/bin/pdftoppm.exe" ] || \
    [ -x "$root/native/poppler/bin/pdftoppm" ] || \
    [ -x "$root/native/poppler/bin/pdftoppm.exe" ]
}

resolve_office_preview_runtime_source() {
  local candidate
  local candidates=()
  if [ -n "${TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE:-}" ]; then
    candidates+=("$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE")
  fi
  candidates+=(
    "$REPO_ROOT/packages/office-preview-runtime/runtime"
    "$HOME/.cache/tabtin-office-runtime/dependencies"
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
  )
  if [ "$TARGET_RUNTIME" = "win32" ]; then
    candidates+=(
      "C:/tabtin/office-preview-runtime/dependencies"
      "/c/tabtin/office-preview-runtime/dependencies"
    )
  fi

  for candidate in "${candidates[@]}"; do
    [ -d "$candidate" ] || continue
    if office_runtime_has_soffice "$candidate" && office_runtime_has_pdftoppm "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

print_missing_office_runtime_help() {
  echo "   可先跑 scripts/electron/runtime/fetch-desktop-runtimes.sh，从官方源准备 LibreOffice + Poppler + Python。" >&2
  echo "   或设置 TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE 指向包含 bin/ 和 native/ 的 dependencies 目录。" >&2
  if [ -n "${TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE:-}" ]; then
    echo "   当前 TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE=${TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE}" >&2
    if [ ! -d "$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE" ]; then
      echo "   该目录不存在，Windows Git Bash 下建议使用 C:/... 或 /c/... 路径。" >&2
    else
      office_runtime_has_soffice "$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE" || echo "   该目录缺少 soffice 入口。" >&2
      office_runtime_has_pdftoppm "$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE" || echo "   该目录缺少 pdftoppm 入口。" >&2
    fi
  fi
  if [ "$TARGET_RUNTIME" = "win32" ]; then
    echo "   Windows 打包机可先运行：" >&2
    echo "     powershell.exe -ExecutionPolicy Bypass -File scripts\\prepare-office-preview-runtime-windows.ps1 -Force -SetUserEnvironment" >&2
    echo "   Windows x64 runtime 推荐形态：" >&2
    echo "     dependencies/native/libreoffice-headless/program/soffice.exe" >&2
    echo "     dependencies/native/poppler/bin/pdftoppm.exe" >&2
    echo "   注意：不要只把 exe 单独复制到 dependencies/bin；Windows DLL 查找依赖 exe 所在目录。" >&2
    echo "   dependencies/bin/soffice.exe / pdftoppm.exe 只适合做能设置好 PATH 的 wrapper。" >&2
    echo "   预检示例：" >&2
    echo "     test -f \"\$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE/bin/soffice.exe\" || test -f \"\$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE/native/libreoffice-headless/program/soffice.exe\"" >&2
    echo "     test -f \"\$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE/bin/pdftoppm.exe\" || test -f \"\$TABTIN_OFFICE_PREVIEW_RUNTIME_SOURCE/native/poppler/bin/pdftoppm.exe\"" >&2
  fi
  echo "   默认也会尝试以下目录：" >&2
  echo "     $REPO_ROOT/packages/office-preview-runtime/runtime" >&2
  echo "     $HOME/.cache/tabtin-office-runtime/dependencies" >&2
  echo "     $HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies" >&2
  if [ "$TARGET_RUNTIME" = "win32" ]; then
    echo "     C:/tabtin/office-preview-runtime/dependencies" >&2
    echo "     /c/tabtin/office-preview-runtime/dependencies" >&2
  fi
}

create_office_preview_runtime_archive() {
  local source_root="$1"
  local target_dir="$2"
  local prebuilt_archive
  prebuilt_archive="$(resolve_office_preview_runtime_archive "$source_root" || true)"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  if [ -n "$prebuilt_archive" ]; then
    cp "$prebuilt_archive" "$target_dir/office-preview-runtime.tar.gz"
    echo "  · Office preview runtime archive: $(du -sh "$target_dir/office-preview-runtime.tar.gz" | awk '{print $1}') (cached)"
    return 0
  fi

  local payload_root
  payload_root="$(mktemp -d "$DEPLOY_DIR/office-runtime-payload.XXXXXX")"
  mkdir -p "$target_dir" "$payload_root/bin" "$payload_root/native"

  for tool in soffice soffice.exe pdftoppm pdftoppm.exe; do
    [ -f "$source_root/bin/$tool" ] && cp "$source_root/bin/$tool" "$payload_root/bin/$tool"
  done
  if [ -d "$source_root/native/libreoffice-headless" ]; then
    cp -R "$source_root/native/libreoffice-headless" "$payload_root/native/libreoffice-headless"
  fi
  if [ -d "$source_root/native/poppler" ]; then
    cp -R "$source_root/native/poppler" "$payload_root/native/poppler"
  fi
  chmod +x "$payload_root/bin/soffice" "$payload_root/bin/soffice.exe" "$payload_root/bin/pdftoppm" "$payload_root/bin/pdftoppm.exe" 2>/dev/null || true
  prune_packaged_resource_tree "$payload_root"
  prune_office_preview_runtime_tree "$payload_root"
  # Git Bash tar treats "C:/..." archive paths as remote specs because of the
  # colon. Create from the target dir with a relative archive name instead.
  ( cd "$target_dir" && tar -czf "office-preview-runtime.tar.gz" -C "$payload_root" . )
  rm -rf "$payload_root"
  write_office_preview_runtime_archive_cache "$source_root" "$target_dir/office-preview-runtime.tar.gz"
  echo "  · Office preview runtime archive: $(du -sh "$target_dir/office-preview-runtime.tar.gz" | awk '{print $1}')"
}

resolve_office_preview_runtime_archive() {
  local source_root="$1"
  local candidate
  local candidates=()
  if [ -n "${TABTIN_OFFICE_PREVIEW_RUNTIME_ARCHIVE:-}" ]; then
    candidates+=("$TABTIN_OFFICE_PREVIEW_RUNTIME_ARCHIVE")
  fi
  candidates+=(
    "$source_root/office-preview-runtime.tar.gz"
    "$(dirname "$source_root")/office-preview-runtime.tar.gz"
  )

  for candidate in "${candidates[@]}"; do
    [ -s "$candidate" ] || continue
    if [ "${TABTIN_SKIP_OFFICE_RUNTIME_ARCHIVE_VALIDATION:-0}" != "1" ]; then
      if ! office_preview_runtime_archive_has_tools "$candidate"; then
        echo "  ⚠ 忽略缺少 soffice/pdftoppm 的 Office preview runtime archive: $candidate" >&2
        continue
      fi
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}

office_preview_runtime_archive_has_tools() {
  local archive="$1"
  local archive_dir
  local archive_name
  # Git Bash tar treats "C:/..." as a remote host because of the colon.
  # Validate via a relative path from the archive directory instead.
  archive_dir="$(cd "$(dirname "$archive")" 2>/dev/null && pwd -P || true)"
  archive_name="$(basename "$archive")"
  if [ -n "$archive_dir" ] && [ -f "$archive_dir/$archive_name" ]; then
    ( cd "$archive_dir" && tar -tzf "$archive_name" 2>/dev/null )
  else
    tar -tzf "$archive" 2>/dev/null
  fi | awk '
    {
      path = $0
      sub(/^\.\//, "", path)
      if (path == "bin/soffice" || path == "bin/soffice.exe" || path == "native/libreoffice-headless/bin/soffice" || path == "native/libreoffice-headless/bin/soffice.exe" || path == "native/libreoffice-headless/program/soffice.exe" || path == "native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice" || path == "native/libreoffice-headless/libreoffice/LibreOffice.app/Contents/MacOS/soffice") {
        hasSoffice = 1
      }
      if (path == "bin/pdftoppm" || path == "bin/pdftoppm.exe" || path == "native/poppler/bin/pdftoppm" || path == "native/poppler/bin/pdftoppm.exe") {
        hasPdfToPpm = 1
      }
    }
    END { exit (hasSoffice && hasPdfToPpm) ? 0 : 1 }
  '
}

write_office_preview_runtime_archive_cache() {
  local source_root="$1"
  local archive="$2"
  [ "${TABTIN_WRITE_OFFICE_RUNTIME_ARCHIVE_CACHE:-1}" = "1" ] || return 0
  [ -s "$archive" ] || return 0

  local source_real
  source_real="$(cd "$source_root" 2>/dev/null && pwd -P || true)"
  local repo_real
  repo_real="$(cd "$REPO_ROOT" 2>/dev/null && pwd -P || printf '%s' "$REPO_ROOT")"
  if [ -n "$source_real" ]; then
    case "$source_real" in
      "$repo_real"|"$repo_real"/*)
        return 0
        ;;
    esac
  fi

  local cache_archive
  cache_archive="$(dirname "$source_root")/office-preview-runtime.tar.gz"
  cp "$archive" "$cache_archive" 2>/dev/null || {
    echo "  ⚠ 无法写入 Office preview runtime archive cache: $cache_archive" >&2
    return 0
  }
  echo "  · Office preview runtime archive cache: $cache_archive"
}

prune_office_preview_runtime_tree() {
  local root="$1"
  [ -d "$root" ] || return 0

  # Administrative MSI extraction leaves installer payloads and developer
  # headers beside the runtime. They are not needed for headless conversion.
  find "$root" -type f \( -iname "*.msi" -o -iname "*.pdb" -o -iname "*.ilk" \) -delete 2>/dev/null || true
  find "$root/native/libreoffice-headless" -type d \( -iname "help" -o -iname "readmes" \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$root/native/poppler" -type d -iname "include" -prune -exec rm -rf {} + 2>/dev/null || true
}

stage_office_preview_runtime_manifest_from_archive() {
  local target_dir="$1"
  local archive="$target_dir/office-preview-runtime.tar.gz"
  if [ ! -f "$archive" ]; then
    echo "❌ Office preview runtime archive missing after staging: $archive" >&2
    return 1
  fi
  write_office_preview_runtime_manifest "$archive" "$target_dir/manifest.json"
  if ! validate_office_preview_runtime_manifest "$target_dir/manifest.json"; then
    echo "❌ staged Office preview runtime manifest is invalid: $target_dir/manifest.json" >&2
    return 1
  fi
  echo "  · Office preview runtime manifest generated from staged archive"
}

stage_office_preview_runtime_bundle() {
  local source_root="$1"
  local target_dir="$2"
  create_office_preview_runtime_archive "$source_root" "$target_dir"
  stage_office_preview_runtime_manifest_from_archive "$target_dir"
}

stage_office_preview_runtime_download_manifest() {
  local target_dir="$1"
  local config_path="$REPO_ROOT/packages/office-preview-runtime/runtime.config.json"
  local runtime_platform
  runtime_platform="$(office_preview_runtime_platform)"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"

  node - "$config_path" "$target_dir/manifest.json" "$runtime_platform" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [configPath, manifestPath, platform] = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const runtime = config.platforms?.[platform]
if (!runtime?.url || !runtime?.sha256 || !runtime?.size || !runtime?.tools) {
  throw new Error(`Office preview runtime download is not configured for ${platform}`)
}
const manifest = {
  schemaVersion: 1,
  version: config.version,
  platform,
  archiveName: config.archiveName,
  url: runtime.url,
  sha256: runtime.sha256,
  size: runtime.size,
  tools: runtime.tools,
}
fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
  validate_office_preview_runtime_manifest "$target_dir/manifest.json"
}

office_preview_runtime_platform() {
  printf '%s-%s\n' "$TARGET_RUNTIME" "$ARCH"
}

office_preview_runtime_version() {
  if [ -n "${TABTIN_OFFICE_PREVIEW_RUNTIME_VERSION:-}" ]; then
    printf '%s\n' "$TABTIN_OFFICE_PREVIEW_RUNTIME_VERSION"
    return 0
  fi
  printf '%s-%s\n' "$(date +%Y.%m.%d)" "$(office_preview_runtime_platform)"
}

office_preview_runtime_archive_name() {
  local config_path="$REPO_ROOT/packages/office-preview-runtime/runtime.config.json"
  if [ -f "$config_path" ]; then
    local name
    name="$(
      node - "$config_path" <<'NODE'
const fs = require('node:fs')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const name = typeof cfg.archiveName === 'string' ? cfg.archiveName : ''
if (name) process.stdout.write(name)
NODE
    )"
    if [ -n "$name" ]; then
      printf '%s\n' "$name"
      return 0
    fi
  fi
  printf '%s\n' "office-preview-runtime.tar.gz"
}

write_office_preview_runtime_manifest() {
  local archive="$1"
  local manifest="$2"
  local runtime_version
  local runtime_platform
  runtime_version="$(office_preview_runtime_version)"
  runtime_platform="$(office_preview_runtime_platform)"

  node - "$archive" "$manifest" "$runtime_version" "$runtime_platform" <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const [archivePath, manifestPath, version, platform] = process.argv.slice(2)
const archive = fs.readFileSync(archivePath)
const manifest = {
  schemaVersion: 1,
  version,
  platform,
  archiveName: path.basename(archivePath),
  sha256: crypto.createHash('sha256').update(archive).digest('hex'),
  size: archive.length,
  tools: {
    soffice: platform.startsWith('win32') ? 'native/libreoffice-headless/program/soffice.exe' : 'bin/soffice',
    pdftoppm: platform.startsWith('win32') ? 'native/poppler/bin/pdftoppm.exe' : 'bin/pdftoppm',
  },
}
fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
NODE
}

validate_office_preview_runtime_manifest() {
  local manifest_path="$1"
  local expected_platform="${TARGET_RUNTIME}-${ARCH}"
  node - "$manifest_path" "$expected_platform" <<'NODE'
const fs = require('node:fs')

const [manifestPath, expectedPlatform] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const safeRelativePath = (value) => {
  if (typeof value !== 'string' || !value || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    return false
  }
  return !value.replace(/\\/g, '/').split('/').includes('..')
}

if (manifest.schemaVersion !== 1) {
  throw new Error(`schemaVersion must be 1, got ${manifest.schemaVersion}`)
}
if (manifest.platform !== expectedPlatform) {
  throw new Error(`platform must be ${expectedPlatform}, got ${manifest.platform}`)
}
if (typeof manifest.version !== 'string' || !manifest.version) {
  throw new Error('version is required')
}
if (!safeRelativePath(manifest.archiveName)) {
  throw new Error('archiveName must be a safe relative path')
}
if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ''))) {
  throw new Error('sha256 must be a 64-character hex digest')
}
if (!manifest.tools || !safeRelativePath(manifest.tools.soffice) || !safeRelativePath(manifest.tools.pdftoppm)) {
  throw new Error('tools.soffice and tools.pdftoppm must be safe relative paths')
}
if (manifest.url !== undefined) {
  const url = new URL(manifest.url)
  if (url.protocol !== 'https:') throw new Error('url must use HTTPS')
}
NODE
}

bash "$REPO_ROOT/scripts/electron/runtime/fetch-desktop-runtimes.sh" --only python
OFFICE_RUNTIME_SRC="$(resolve_office_preview_runtime_source || true)"
OFFICE_RUNTIME_DEPLOY_SRC="$DEPLOY_DIR/office-preview-runtime-src"
if [ -n "$OFFICE_RUNTIME_SRC" ]; then
  echo "  · Office preview runtime source: $OFFICE_RUNTIME_SRC"
fi

PROFILE_PRODUCT_NAME=""
PROFILE_APP_ID=""
PROFILE_EXECUTABLE_NAME=""
PROFILE_SHORTCUT_NAME=""
case "$PROFILE" in
  local)
    PROFILE_PRODUCT_NAME="TabTin Local"
    PROFILE_APP_ID="com.tabtin.app.local"
    PROFILE_EXECUTABLE_NAME="tabtin-local"
    PROFILE_SHORTCUT_NAME="TabTin Local"
    ;;
  community)
    PROFILE_PRODUCT_NAME="TabTin Community"
    PROFILE_APP_ID="com.tabtin.community"
    PROFILE_EXECUTABLE_NAME="tabtin-community"
    PROFILE_SHORTCUT_NAME="TabTin Community"
    ;;
esac

if [ "$PROFILE" = "local" ]; then
  UPDATE_PUBLISH_URL="${TABTIN_UPDATE_PUBLISH_URL:-http://127.0.0.1:6060/desktop-updates}"
else
  UPDATE_PUBLISH_URL="$COMMUNITY_UPDATE_FEED_URL"
fi
if [ -n "$UPDATE_PUBLISH_URL" ]; then
  echo "  · updater publish url: $UPDATE_PUBLISH_URL"
else
  echo "  · updater: disabled"
fi

# 本地测试包使用独立 productName/appId。
# 用途：把 packaged Electron 全程指向本地 Django/Centrifugo，用来：
#   1) 在 minify 后的代码里复现 React/JS 错误（dev 下不一定能复现）
#   2) 验证 client_errors 监控全链路：errorReporter → /report → admindash 反混淆
# 实际开发日常更推荐 `pnpm preview:packaged`（绕过 packaging + Gatekeeper，5 秒启动）。
if [ "$PROFILE" = "local" ]; then
  echo "  · 本地测试模式：productName=${PROFILE_PRODUCT_NAME}, appId=${PROFILE_APP_ID}，所有 API/WS 指向本地后端"
else
  echo "  · 社区发行：productName=${PROFILE_PRODUCT_NAME}, appId=${PROFILE_APP_ID}, API=${COMMUNITY_API_BASE_URL}"
fi
EXTRA_BUILDER_ARGS+=(
  "--config.productName=$PROFILE_PRODUCT_NAME"
  "--config.appId=$PROFILE_APP_ID"
  "--config.extraMetadata.version=$PROFILE_VERSION"
  "--config.${TARGET_NAME}.executableName=$PROFILE_EXECUTABLE_NAME"
  "--publish=never"
)
if [ "$TARGET_RUNTIME" = "win32" ]; then
  EXTRA_BUILDER_ARGS+=("--config.nsis.shortcutName=$PROFILE_SHORTCUT_NAME")
fi

ARTIFACT_UPDATE_CHANNEL="stable"
ARTIFACT_VERSION_LABEL="$(node -e '
  const version = String(process.argv[1] || "").trim()
  const channel = String(process.argv[2] || "stable").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const match = /^([0-9]+\.[0-9]+\.[0-9]+)-[A-Za-z]+[.-]([0-9]+)$/.exec(version)
  if (match && channel && channel !== "stable") {
    process.stdout.write(`${match[1]}-${channel}-${match[2]}`)
  } else {
    process.stdout.write(version)
  }
' "$PROFILE_VERSION" "$ARTIFACT_UPDATE_CHANNEL")"
if [ -n "$ARTIFACT_VERSION_LABEL" ] && [ "$ARTIFACT_VERSION_LABEL" != "$PROFILE_VERSION" ]; then
  echo "  · artifact version label: $ARTIFACT_VERSION_LABEL (channel=$ARTIFACT_UPDATE_CHANNEL, app_version=$PROFILE_VERSION)"
fi

configure_windows_nsis_blockmap() {
  [ "$TARGET_RUNTIME" = "win32" ] || return 0
  case "$PROFILE" in
    local|community)
      if [ "${TABTIN_WIN_NSIS_BLOCKMAP:-0}" = "1" ]; then
        echo "  · Windows NSIS blockmap: enabled by TABTIN_WIN_NSIS_BLOCKMAP=1"
        return 0
      fi
      echo "  · Windows NSIS blockmap: disabled for ${PROFILE} manual installer"
      EXTRA_BUILDER_ARGS+=("--config.nsis.differentialPackage=false")
      ;;
  esac
}
configure_windows_nsis_blockmap

# quick：NSIS 默认 normal（约 mx=5）。
# 对照 Mac quick DMG（UDZO/zlib）~440MB / 十几分钟——不要用 store 把 Win 包撑到 1GB+。
# 完整链路保持 electron-builder 默认 maximum。
# 覆盖：TABTIN_WIN_NSIS_COMPRESSION=store|normal|maximum
configure_windows_quick_compression() {
  [ "$TARGET_RUNTIME" = "win32" ] || return 0
  [ "$PACK_QUICK" = "1" ] || return 0
  local level="${TABTIN_WIN_NSIS_COMPRESSION:-normal}"
  case "$level" in
    store|normal|maximum) ;;
    *)
      echo "  ⚠ unknown TABTIN_WIN_NSIS_COMPRESSION=$level，回退 normal" >&2
      level="normal"
      ;;
  esac
  echo "  · Windows NSIS compression: ${level} (quick; override with TABTIN_WIN_NSIS_COMPRESSION)"
  EXTRA_BUILDER_ARGS+=("--config.compression=${level}")
}
configure_windows_quick_compression

if [ "$TARGET_RUNTIME" = "darwin" ]; then
  echo "  · ${PROFILE} profile：跳过官方 notarize"
  if [ "$PROFILE" = "local" ]; then
    # local 仅用于本机安装验证。禁止 electron-builder 从 Keychain 或环境变量
    # 读取 Developer ID；构建后统一 ad-hoc 签名，不需要证书、时间戳网络或公证。
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME CSC_KEYCHAIN
    echo "  · local macOS signing: ad-hoc（无需证书/联网）"
  fi
  EXTRA_BUILDER_ARGS+=(
    "--config.mac.gatekeeperAssess=false"
  )
fi

if [ "$TARGET_RUNTIME" = "win32" ]; then
  unset WIN_CODESIGN_REQUIRED WIN_CODESIGN_THUMBPRINT WIN_CODESIGN_PIN WIN_CODESIGN_TIMESTAMP_URL
  echo "  · ${PROFILE} profile：跳过 Windows 代码签名"
fi

remove_platform_dirs() {
  local pattern="$1"
  shift
  local keep_prefixes=("$@")

  while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    local base
    base="$(basename "$dir")"
    local should_keep=0
    local prefix
    for prefix in "${keep_prefixes[@]}"; do
      if [[ "$base" == "$prefix"* ]]; then
        should_keep=1
        break
      fi
    done
    if [ "$should_keep" -eq 0 ]; then
      rm -rf "$dir"
    fi
  done < <(find "$NM" -path "$pattern" -type d 2>/dev/null)
}

# onnxruntime-node 1.24.x 的磁盘布局是 bin/napi-vN/<platform>/<arch>/（platform 与
# arch 分成两层，例如 napi-v6/darwin/arm64、napi-v6/linux/x64）。老版本是
# napi-v3/<platform>-<arch> 单层三元组，因此原先用 remove_platform_dirs + triplet
# (darwin-x64) 前缀去删非目标目录。升级后 basename 变成了 platform 名（darwin）或裸
# arch 名（arm64），永远匹配不上 triplet 前缀 → 连目标 arch 一起被误删 → macOS 包里
# onnx 二进制被整个抹掉，语义召回静默降级。见 GitHub  / 。
#
# 这里按新布局精确保留「目标 platform/arch」这一段，其余 platform 与 arch 全部删除。
# 用完整两段路径 <platform>/<arch> 比对（而非 basename），避免 linux/arm64 在 darwin
# 构建里因 basename=arm64 被误留。napi 版本号用通配匹配，对未来 napi-vN 变化鲁棒。
prune_onnxruntime_binaries() {
  local keep_suffix="${TARGET_RUNTIME}/${ARCH}"
  local dir
  while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    # dir 形如 .../onnxruntime-node/bin/napi-v6/darwin/arm64；取最后两段做 platform/arch
    local platform_arch
    platform_arch="$(basename "$(dirname "$dir")")/$(basename "$dir")"
    if [ "$platform_arch" != "$keep_suffix" ]; then
      rm -rf "$dir"
    fi
  done < <(find "$NM" -path "*/onnxruntime-node/bin/napi-*/*/*" -type d 2>/dev/null)
  # 删空 arch 目录后，非目标 platform 目录（napi-vN/linux、napi-vN/win32）已空，一并清掉，
  # 免得残留空目录干扰 codesign 资源封存。
  find "$NM" -path "*/onnxruntime-node/bin/napi-*/*" -type d -empty -delete 2>/dev/null || true
}

remove_pnpm_package() {
  local package_scope="$1"
  local package_name="$2"
  local encoded_scope="${package_scope#@}"
  local encoded_name="${encoded_scope}+${package_name}@*"

  rm -rf "$NM/$package_scope/$package_name" 2>/dev/null || true
  find "$NM/.pnpm" -maxdepth 1 -type d -name "$encoded_name" -prune -exec rm -rf {} + 2>/dev/null || true
  find "$NM" -path "*/node_modules/$package_scope/$package_name" -type d -prune -exec rm -rf {} + 2>/dev/null || true
}

prune_cross_platform_native_packages() {
  case "$TARGET_RUNTIME" in
    darwin)
      remove_pnpm_package "@nut-tree-fork" "libnut-linux"
      remove_pnpm_package "@nut-tree-fork" "libnut-win32"
      ;;
    linux)
      remove_pnpm_package "@nut-tree-fork" "libnut-darwin"
      remove_pnpm_package "@nut-tree-fork" "libnut-win32"
      ;;
    win32)
      remove_pnpm_package "@nut-tree-fork" "libnut-darwin"
      remove_pnpm_package "@nut-tree-fork" "libnut-linux"
      ;;
  esac
}

configure_platform_cleanup() {
  # 精确保留 "<runtime>-<arch>" 这一组——例如 darwin-x64 build 时把 darwin-arm64 的
  # prebuilt 全部删除，避免 Intel 用户拿到 arm64 二进制（运行时崩）或 codesign 时发现
  # 多余资源（sealed resource missing/invalid）。
  local triplet="${TARGET_RUNTIME}-${ARCH}"
  case "$TARGET_RUNTIME" in
    darwin)
      prune_onnxruntime_binaries
      # 已知 gap：onnxruntime-node 自 1.23.x 起不再随 npm 分发 macOS x86_64
      # 二进制（官方 1.24.1 release note 明确「x86_64 binaries for macOS/iOS are no
      # longer provided」），tarball 里只有 darwin/arm64，postinstall 对 darwin 也不下载
      # 任何东西。因此 x64 mac 包里根本没有 onnx darwin/x64 二进制可保留——prune 修复无法
      # 补上它。x64 包的语义召回会静默降级到词法单路。留待后续用 1.23.2 兜底二进制或
      # 官方恢复分发后处理。
      if [ "$ARCH" = "x64" ]; then
        echo "  ⚠ onnxruntime-node 1.24.x 不提供 macOS x64 二进制（上游自 1.23.x 停发）；" >&2
        echo "    此 x64 包不含 onnx darwin/x64，语义召回将降级到词法单路（已知 gap ）。" >&2
      fi
      remove_platform_dirs "*/node-pty/prebuilds/*" "$triplet"
      remove_platform_dirs "*/@napi-rs/canvas-*" "canvas-${triplet}"
      remove_platform_dirs "*/@img/sharp-*" "sharp-${triplet}"
      remove_platform_dirs "*/@img/sharp-libvips-*" "sharp-libvips-${triplet}"
      # @anush008/tokenizers 的 darwin 预编译是 universal 单包（arm64+x64 通吃）
      remove_platform_dirs "*/@anush008/tokenizers-*" "tokenizers-darwin-universal"
      ;;
    linux)
      prune_onnxruntime_binaries
      remove_platform_dirs "*/node-pty/prebuilds/*" "$triplet"
      remove_platform_dirs "*/@napi-rs/canvas-*" "canvas-${triplet}"
      remove_platform_dirs "*/@img/sharp-*" "sharp-${triplet}"
      remove_platform_dirs "*/@img/sharp-libvips-*" "sharp-libvips-${triplet}"
      remove_platform_dirs "*/@anush008/tokenizers-*" "tokenizers-${triplet}"
      ;;
    win32)
      prune_onnxruntime_binaries
      remove_platform_dirs "*/node-pty/prebuilds/*" "$triplet"
      remove_platform_dirs "*/@napi-rs/canvas-*" "canvas-${triplet}"
      remove_platform_dirs "*/@img/sharp-*" "sharp-${triplet}"
      remove_platform_dirs "*/@img/sharp-libvips-*" "sharp-libvips-${triplet}"
      remove_platform_dirs "*/@anush008/tokenizers-*" "tokenizers-${triplet}"
      ;;
  esac
  prune_cross_platform_native_packages
}

prune_packaged_resource_tree() {
  local root="$1"
  [ -d "$root" ] || return 0

  find "$root" -type d \( \
    -name "__tests__" -o \
    -name "test" -o \
    -name "tests" -o \
    -name "example" -o \
    -name "examples" -o \
    -name "benchmark" -o \
    -name "benchmarks" -o \
    -name "browser-test" -o \
    -name "system-test" -o \
    -name "fixture" -o \
    -name "fixtures" -o \
    -name ".pytest_cache" -o \
    -name ".github" \
  \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$root" -type f \( \
    -name "*.ts" -o \
    -name "*.tsx" -o \
    -name "*.map" -o \
    -name "*.tsbuildinfo" -o \
    -name "*.test.*" -o \
    -name "*.spec.*" -o \
    -name "playwright.config.*" -o \
    -name "*.pyc" -o \
    -name "*.pyo" -o \
    -name ".DS_Store" \
  \) -delete 2>/dev/null || true
}

prune_tabsite_template_sources() {
  local root="$1"
  [ -d "$root" ] || return 0

  find "$root" -type d \( -name "src" -o -name "docs" \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$root" -type f \( \
    -name "vite.config.*" -o \
    -name "tsconfig*.json" \
  \) -delete 2>/dev/null || true
}

strip_public_sourcemap_references() {
  node - "$@" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const roots = process.argv.slice(2)
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.css', '.html'])

function walk(dir, onFile) {
  let st
  try {
    st = fs.lstatSync(dir)
  } catch {
    return
  }
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      walk(path.join(dir, entry), onFile)
    }
  } else if (st.isFile() && textExtensions.has(path.extname(dir).toLowerCase())) {
    onFile(dir)
  }
}

function findFilesWithSourcemapReferences(root) {
  const rg = spawnSync('rg', [
    '--files-with-matches',
    '--fixed-strings',
    '--no-ignore',
    '--no-messages',
    '--hidden',
    '--glob', '*.js',
    '--glob', '*.mjs',
    '--glob', '*.cjs',
    '--glob', '*.css',
    '--glob', '*.html',
    'sourceMappingURL=',
    root,
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  const stdout = typeof rg.stdout === 'string' ? rg.stdout : ''
  if (stdout.trim()) {
    return stdout.split('\n').filter(Boolean)
  }
  if (rg.status === 1) {
    return []
  }
  const files = []
  walk(root, (file) => {
    let before
    try {
      before = fs.readFileSync(file, 'utf8')
    } catch {
      return
    }
    if (before.includes('sourceMappingURL=')) files.push(file)
  })
  return files
}

let changed = 0
for (const root of roots) {
  for (const file of findFilesWithSourcemapReferences(root)) {
    let before
    try {
      before = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const after = before
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:\/\/[#@]\s*sourceMappingURL=|\/\*[#@]\s*sourceMappingURL=.*\*\/\s*$)/.test(line))
      .join('\n')
    if (after !== before) {
      const tmp = `${file}.tabtin-strip-${process.pid}.tmp`
      fs.writeFileSync(tmp, after)
      fs.renameSync(tmp, file)
      changed += 1
    }
  }
}
if (changed > 0) {
  console.log(`  · stripped sourceMappingURL references from ${changed} files`)
}
NODE
}

print_log_tail() {
  local file="$1"
  local lines="${2:-120}"
  node - "$file" "$lines" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const limit = Number(process.argv[3] || 120)
let text = ''
try {
  text = fs.readFileSync(file, 'utf8')
} catch {
  process.exit(0)
}
const rows = text.split(/\r?\n/)
for (const line of rows.slice(-limit)) {
  if (line.trim()) console.log(line)
}
NODE
}

read_env_value() {
  local file="$1"
  local key="$2"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" | head -n1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true
}

normalize_sourcemap_api_url() {
  local url="$1"
  url="${url%/}"
  url="${url%/api}"
  printf '%s' "$url"
}

# Step 1: Build renderer/main/preload with electron-vite
pack_time_step_begin "electron-vite"
echo "[1/5] Building electron-vite..."
if pgrep -f 'electron-vite.js (dev|build)' >/dev/null 2>&1; then
  echo "❌ 检测到正在运行的 electron-vite（pnpm dev 或另一路打包）。先停掉再打包装包，避免 SIGKILL/OOM。" >&2
  pgrep -lf 'electron-vite.js (dev|build)' >&2 || true
  exit 1
fi
ensure_electron_dependency_resolves "@sentry/electron/renderer"
cd "$APP_DIR"
if [ "$PACK_SKIP_SENTRY_SYMBOLS" = "1" ]; then
  # Quick builds never upload sourcemaps and delete them before deploy. Avoid
  # generating the large main/preload/renderer maps only to discard them.
  export TABTIN_PACKAGED_BUILD_SKIP_SOURCEMAPS=1
  echo "  · local quick pack: 跳过 sourcemap 生成"
else
  unset TABTIN_PACKAGED_BUILD_SKIP_SOURCEMAPS
fi
# 先把 out/ 整个删掉再让 vite 写。vite 自己的 emptyDir 在 macOS 26 + Spotlight
# 索引大量小文件时偶发 ENOTEMPTY。手动清干净 + sync + sleep 1s 让 fs 真正落盘。
rm -rf "$APP_DIR/out"
sync
sleep 1
if [ "$TARGET_RUNTIME" = "win32" ] && [ "${PACK_RUN_TYPECHECK:-0}" != "1" ]; then
  echo "  · Windows packaged build: 跳过 npm prebuild / vite checker typecheck"
  echo "  · Windows packaged build: 先构建 workspace dist，避免 stale workspace package 进入安装包"
  pnpm run build:workspace
  echo "  · 如需强制检查：直接跑脚本设置 PACK_RUN_TYPECHECK=1；经 scripts/pack/windows.bat 还需 PACK_ALLOW_TYPECHECK_BLOCK=1"
  export TABTIN_PACKAGED_BUILD_SKIP_TYPECHECK=1
  node "$SCRIPT_DIR/run-electron-vite.mjs" build
elif [ "${TABTIN_PACK_SKIP_PREBUILD:-0}" = "1" ]; then
  echo "  · TABTIN_PACK_SKIP_PREBUILD=1：跳过 npm prebuild（typecheck / i18n），只跑 electron-vite"
  pnpm run build:workspace
  export TABTIN_PACKAGED_BUILD_SKIP_TYPECHECK=1
  node "$SCRIPT_DIR/run-electron-vite.mjs" build
else
  unset TABTIN_PACKAGED_BUILD_SKIP_TYPECHECK
  # Packaged builds keep type checking as a hard gate, but do not inherit the
  # repository-wide prebuild hook. The i18n completeness check covers every
  # locale in the monorepo and is run independently from desktop packaging.
  pnpm run typecheck
  node "$SCRIPT_DIR/run-electron-vite.mjs" build
fi
pack_time_step_end "electron-vite"

# Step 1.5: Upload sourcemaps (if config available, before stripping)
pack_time_step_begin "sourcemap upload"
#
# 配置来源优先级：
#   1. SOURCEMAP_UPLOAD_KEY 只接受当前 shell / CI 进程环境注入
#   2. 公开的 SOURCEMAP_API_URL 可从 profile 专属 .env 读取
#   3. SOURCEMAP_API_URL 找不到时，可从公开 API 地址推导
#
# Profile-specific 严格策略：
#   - local：必须上传成功，否则报错退出。
#       本地包的整个意义就是验证 sourcemap → admindash 反混淆链路；
#       静默跳过等于回到原来的 minified 黑盒，违背使用本 profile 的初衷。
#   - community：缺配置仅警告，不阻断。
PROFILE_ENV="$APP_DIR/.env.${PROFILE}"
if [ -z "${SOURCEMAP_API_URL:-}" ]; then
  SOURCEMAP_API_URL=$(read_env_value "$PROFILE_ENV" "SOURCEMAP_API_URL")
fi
if [ -z "${SOURCEMAP_API_URL:-}" ]; then
  SOURCEMAP_API_URL=$(read_env_value "$REPO_ROOT/.env" "SOURCEMAP_API_URL")
fi
if [ -z "${SOURCEMAP_API_URL:-}" ]; then
  SOURCEMAP_API_URL=$(read_env_value "$REPO_ROOT/.env" "API_BASE_URL")
fi
if [ -z "${SOURCEMAP_API_URL:-}" ]; then
  # 最后兜底：从 .env.<profile> 推 VITE_API_BASE_URL（去掉 /api 后缀）
  VITE_API=$(read_env_value "$PROFILE_ENV" "VITE_API_BASE_URL")
  if [ -n "$VITE_API" ]; then
    SOURCEMAP_API_URL="$VITE_API"
  fi
fi
if [ -n "${SOURCEMAP_API_URL:-}" ]; then
  SOURCEMAP_API_URL="$(normalize_sourcemap_api_url "$SOURCEMAP_API_URL")"
  export SOURCEMAP_API_URL
fi
if [ -n "${SOURCEMAP_UPLOAD_KEY:-}" ]; then
  export SOURCEMAP_UPLOAD_KEY
fi
# sourcemap 版本使用构建开头解析的统一应用版本号。
# 这个版本号需要三方对齐才能让 admindash 反混淆链路工作：
#   - errorReporter 上报的 app_version（来自 vite 注入的 VITE_APP_VERSION）
#   - sourcemap 入库的 app_version（本变量传给 upload-sourcemaps.sh）
#   - electron-builder 打 packaged app 的 version（下面 patch package.json 用同一个）
# 任何一处不一致 → admindash 上看到 minified 堆栈反混淆失败。
SOURCEMAP_APP_VERSION="$PROFILE_VERSION"

if [ "$PACK_QUICK" = "1" ] || [ "${SOURCEMAP_UPLOAD_SKIP:-0}" = "1" ]; then
  echo "[1.5/5] Skipping sourcemap upload (quick build or SOURCEMAP_UPLOAD_SKIP=1)"
elif [ -n "${SOURCEMAP_UPLOAD_KEY:-}" ] && [ -n "${SOURCEMAP_API_URL:-}" ]; then
  echo "[1.5/5] Uploading sourcemaps to ${SOURCEMAP_API_URL}..."
  # SOURCEMAP_APP_VERSION 是上面按 profile 算的；通过环境变量传更稳，避免 macOS bash 3.2
  # 下 set -u + 空数组展开的兼容问题。
  SOURCEMAP_APP_VERSION="$SOURCEMAP_APP_VERSION" bash "$SCRIPT_DIR/upload-sourcemaps.sh" || echo "  ⚠ Sourcemap upload failed (non-fatal)"
else
  if [ -z "${SOURCEMAP_UPLOAD_KEY:-}" ]; then
    echo "[1.5/5] Skipping sourcemap upload (SOURCEMAP_UPLOAD_KEY not set)"
  else
    echo "[1.5/5] Skipping sourcemap upload (SOURCEMAP_API_URL not set)"
  fi
fi

# Step 1.6: Upload sourcemaps to self-hosted Sentry (optional).
# When credentials are available, upload symbols for all profiles. Missing
# credentials or an upload failure must not block packaging.
if [ "$PACK_SKIP_SENTRY_SYMBOLS" = "1" ] || [ "${SENTRY_SYMBOL_UPLOAD_SKIP:-0}" = "1" ]; then
  echo "[1.6/5] Skipping Sentry sourcemap upload (SENTRY_SYMBOL_UPLOAD_SKIP=1)"
else
  echo "[1.6/5] Sentry sourcemap upload..."
  SENTRY_SYMBOL_UPLOAD_REQUIRED=0 SENTRY_APP_VERSION="$PROFILE_VERSION" bash "$SCRIPT_DIR/upload-sentry-sourcemaps.sh" || echo "  ⚠ Sentry sourcemap upload failed (non-fatal)"
fi

find "$APP_DIR/out" -name "*.map" -type f -delete 2>/dev/null || true
pack_time_step_end "sourcemap upload"

# Step 2: pnpm deploy creates a self-contained directory with workspace packages copied.
pack_time_step_begin "deploy dependencies"
echo "[2/5] Creating deploy directory..."
echo "  · deploy dir: $DEPLOY_DIR"
if [ "$PACK_QUICK" = "1" ]; then
  if [ "$PACK_SKIP_SENTRY_SYMBOLS" = "1" ]; then
    echo "  · local quick pack: 跳过 sourcemap 上传；保留资源 staging + artifact audit"
  else
    echo "  · quick pack: 保留 Sentry 符号上传；跳过旧 sourcemap 上传"
  fi
fi
if [ "$PACK_QUICK_DEPLOY_CACHE" = "1" ] && \
   node "$SCRIPT_DIR/quick-deploy-cache.mjs" check "$REPO_ROOT" "$DEPLOY_DIR"; then
  QUICK_DEPLOY_CACHE_HIT=1
  echo "  · reusing validated Windows quick deploy dependencies"
  node "$SCRIPT_DIR/quick-deploy-cache.mjs" refresh "$REPO_ROOT" "$DEPLOY_DIR"
else
  prepare_packaged_deploy_dir
  cd "$REPO_ROOT"
  PNPM_DEPLOY_DIR="$DEPLOY_DIR"
  if [ "$TARGET_RUNTIME" = "win32" ]; then
  # Git Bash / MSYS 会把看起来像 POSIX 的参数改写成盘符路径，曾导致：
  #   - bin 目标变成 *.js.EXE
  #   - 路径叠成 C:\workspace\...\c\workspace\... 或 apps\tabtin-electron\apps\tabtin-electron\...
  # deploy 目标显式变成 Windows 路径。MSYS 变量只作用于下面一次 pnpm，
  # 不能全局 export，否则后续 Windows node 会把 /c/... 误解为 C:\c\...。
    if command -v cygpath >/dev/null 2>&1; then
      PNPM_DEPLOY_DIR="$(cygpath -w "$DEPLOY_DIR")"
    fi
  # 上次失败若留下 pnpm 重复 .bin 树，复用同一严格清理器；绝不盲删 APP_DIR/apps。
    if [ -d "$APP_DIR/apps" ]; then
      node "$SCRIPT_DIR/cleanup-pnpm-deploy-debris.mjs" \
        "$APP_DIR" "$DEPLOY_DIR" --previous-runs
    fi
    echo "  · pnpm deploy dest (win): $PNPM_DEPLOY_DIR"
    echo "  · pnpm deploy scoped env: MSYS path conversion off; GitHub dependencies use HTTPS"
  fi
# 用包名 filter，避免 ./apps/tabtin-electron 相对路径在 MSYS/cmd 边界再被改写叠路径。
# Windows 还要缩短虚拟存储目录名；Node process.chdir 无法进入超过 MAX_PATH 的目录。
  run_pnpm_deploy "$PNPM_DEPLOY_DIR"

# pnpm 9 legacy deploy 已知会把 workspace-relative modulesDir 再拼到被筛选包目录，
# 留下 APP_DIR/apps/tabtin-electron/.../node_modules/.bin（上游 /#8875）。
# 只清理当前 run 的这棵已知重复树；若出现其他内容，脚本会 fail closed。
  if [ "$TARGET_RUNTIME" = "win32" ]; then
    node "$SCRIPT_DIR/cleanup-pnpm-deploy-debris.mjs" "$APP_DIR" "$DEPLOY_DIR"
  fi
fi
pack_time_step_end "deploy dependencies"

# Step 3: Copy build output + static assets into deploy directory
pack_time_step_begin "resource staging"
# 与 Mac quick 一致：staging 目录先 rm 再 cp，避免 REUSE 时 prune 后的树与源树类型冲突导致 cp 失败。
echo "[3/5] Copying build output..."
rm -rf "$DEPLOY_DIR/out"
mkdir -p "$DEPLOY_DIR/out"
cp -R "$APP_DIR/out/." "$DEPLOY_DIR/out/"
if [ -d "$APP_DIR/static" ]; then
  rm -rf "$DEPLOY_DIR/static"
  cp -R "$APP_DIR/static" "$DEPLOY_DIR/static"
fi
mkdir -p "$DEPLOY_DIR/scripts"
cp "$APP_DIR/scripts/flip-electron-fuses.cjs" "$DEPLOY_DIR/scripts/flip-electron-fuses.cjs"
[ -f "$APP_DIR/scripts/audit-packaged-artifact.mjs" ] && cp "$APP_DIR/scripts/audit-packaged-artifact.mjs" "$DEPLOY_DIR/scripts/audit-packaged-artifact.mjs"
[ -f "$APP_DIR/scripts/after-sign-notarize.cjs" ] && cp "$APP_DIR/scripts/after-sign-notarize.cjs" "$DEPLOY_DIR/scripts/after-sign-notarize.cjs"
[ -f "$APP_DIR/scripts/win-wosign-sign.cjs" ] && cp "$APP_DIR/scripts/win-wosign-sign.cjs" "$DEPLOY_DIR/scripts/win-wosign-sign.cjs"
# afterPack runs from the isolated deploy tree, so its build-time dependency
# cannot resolve through APP_DIR's pnpm symlink. Stage a real copy explicitly;
# electron-builder still excludes it from the app because it is a devDependency.
ELECTRON_FUSES_SOURCE="$APP_DIR/node_modules/@electron/fuses"
if [ ! -e "$ELECTRON_FUSES_SOURCE" ]; then
  echo "Missing packaging dependency: $ELECTRON_FUSES_SOURCE" >&2
  exit 1
fi
mkdir -p "$DEPLOY_DIR/node_modules/@electron"
rm -rf "$DEPLOY_DIR/node_modules/@electron/fuses"
cp -RL "$ELECTRON_FUSES_SOURCE" "$DEPLOY_DIR/node_modules/@electron/fuses"
cp "$APP_DIR/package.json" "$DEPLOY_DIR/package.json"
if [ -d "$APP_DIR/build" ]; then
  rm -rf "$DEPLOY_DIR/build"
  cp -R "$APP_DIR/build" "$DEPLOY_DIR/build"
fi
if [ -d "$REPO_ROOT/packages/tabsite-templates" ]; then
  rm -rf "$DEPLOY_DIR/tabsite-templates-src"
  cp -R "$REPO_ROOT/packages/tabsite-templates" "$DEPLOY_DIR/tabsite-templates-src"
  prune_packaged_resource_tree "$DEPLOY_DIR/tabsite-templates-src"
  prune_tabsite_template_sources "$DEPLOY_DIR/tabsite-templates-src"
fi
if [ -d "$REPO_ROOT/packages/skills/bundled" ]; then
  rm -rf "$DEPLOY_DIR/bundled-skills-src"
  cp -R "$REPO_ROOT/packages/skills/bundled" "$DEPLOY_DIR/bundled-skills-src"
  prune_packaged_resource_tree "$DEPLOY_DIR/bundled-skills-src"
fi
if [ -d "$REPO_ROOT/packages/skills/tabtracker" ]; then
  rm -rf "$DEPLOY_DIR/package-skills-tabtracker-src"
  cp -R "$REPO_ROOT/packages/skills/tabtracker" "$DEPLOY_DIR/package-skills-tabtracker-src"
  prune_packaged_resource_tree "$DEPLOY_DIR/package-skills-tabtracker-src"
fi
if [ -d "$REPO_ROOT/packages/apps" ]; then
  rm -rf "$DEPLOY_DIR/packages-apps-src"
  cp -R "$REPO_ROOT/packages/apps" "$DEPLOY_DIR/packages-apps-src"
  find "$DEPLOY_DIR/packages-apps-src" -type d \( -name "node_modules" -o -name "dist" -o -name ".git" \) -exec rm -rf {} + 2>/dev/null || true
  prune_packaged_resource_tree "$DEPLOY_DIR/packages-apps-src"
fi
# tabtin CLI (Go binary)：运行期被 cli-server.ts 加进 Agent shell PATH 的 `tabtin` 命令。
# prepare-deploy-package.mjs 会把 extraResources 的 from 重写成 ./tabtin-cli-go-dist-src，
# 这里直接从当前 checkout 构建到本次 deploy staging；禁止复用共享 dist，避免
# 同架构但旧提交的 CLI 混入新版 Electron 安装包。
CLI_GO_DIR="$REPO_ROOT/packages/tabtin-cli-go"
CLI_GO_BIN_NAME="tabtin"
if [ "$TARGET_RUNTIME" = "win32" ]; then
  CLI_GO_BIN_NAME="tabtin.exe"
fi
CLI_GO_STAGE_DIR="$DEPLOY_DIR/tabtin-cli-go-dist-src"
CLI_GO_BIN="$CLI_GO_STAGE_DIR/$CLI_GO_BIN_NAME"
CLI_GOOS="$TARGET_RUNTIME"
CLI_GOARCH="$ARCH"
EXPECTED_GIT_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
case "$CLI_GOOS" in
  win32) CLI_GOOS="windows" ;;
esac
case "$CLI_GOARCH" in
  x64) CLI_GOARCH="amd64" ;;
esac

# Read go buildinfo with short retries. Fresh Windows PE files can briefly fail
# go version -m / appear non-executable under Git Bash while Defender scans them
# ; do not use [ -x ] as the existence gate.
go_cli_read_buildinfo() {
  local binary="$1"
  local attempt meta
  [ -f "$binary" ] || return 1
  command -v go >/dev/null 2>&1 || return 1
  for attempt in 1 2 3 4 5; do
    meta="$(go version -m "$binary" 2>/dev/null)" || meta=""
    if [ -n "$meta" ]; then
      printf '%s\n' "$meta"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

go_cli_matches_target() {
  local binary="$1"
  local meta
  meta="$(go_cli_read_buildinfo "$binary")" || return 1
  printf '%s\n' "$meta" | grep -q $'\tbuild\tGOOS='"$CLI_GOOS" || return 1
  printf '%s\n' "$meta" | grep -q $'\tbuild\tGOARCH='"$CLI_GOARCH" || return 1
}

build_go_cli_for_target() {
  echo "  · 从当前 release 构建 tabtin CLI (target=${CLI_GOOS}/${CLI_GOARCH}, revision=${EXPECTED_GIT_REVISION})"
  rm -rf "$CLI_GO_STAGE_DIR"
  mkdir -p "$CLI_GO_STAGE_DIR"
  (
    cd "$CLI_GO_DIR"
    # Atomic replace: avoid readers inspecting a half-written PE.
    tmp_out="${CLI_GO_BIN}.building.$$"
    GOOS="$CLI_GOOS" GOARCH="$CLI_GOARCH" go build -o "$tmp_out" .
    mv -f "$tmp_out" "$CLI_GO_BIN"
  )
}

go_cli_matches_source_revision() {
  local binary="$1"
  local meta
  meta="$(go_cli_read_buildinfo "$binary")" || return 1
  printf '%s\n' "$meta" | grep -Fq $'\tbuild\tvcs.revision='"$EXPECTED_GIT_REVISION"
}

smoke_go_cli_contract_if_runnable() {
  local binary="$1"
  local host_goos host_goarch output attempt
  host_goos="$(go env GOOS)"
  host_goarch="$(go env GOARCH)"
  if [ "$host_goos" != "$CLI_GOOS" ] || [ "$host_goarch" != "$CLI_GOARCH" ]; then
    echo "  · 跳过跨平台 CLI 执行烟测（host=${host_goos}/${host_goarch}）"
    return 0
  fi
  output="${CLI_GO_STAGE_DIR}/commands-contract.json"
  for attempt in 1 2 3 4 5; do
    if "$binary" commands --format json --include-hidden > "$output"; then
      break
    fi
    if [ "$attempt" = "5" ]; then
      echo "❌ CLI 契约烟测执行失败：commands --format json --include-hidden" >&2
      return 1
    fi
    sleep 0.2
  done
  node -e '
const fs = require("node:fs")
const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const commands = payload?.data?.commands
if (!Array.isArray(commands)) throw new Error("commands contract missing data.commands")
if (!commands.some((command) => command?.hidden === true)) {
  throw new Error("commands --include-hidden returned no hidden command")
}
' "$output"
  rm -f "$output"
  echo "  · CLI 契约烟测通过：commands --format json --include-hidden"
}

report_go_cli_mismatch() {
  echo "❌ tabtin CLI 二进制架构不匹配：期望 ${CLI_GOOS}/${CLI_GOARCH}，文件 $CLI_GO_BIN" >&2
  if [ ! -f "$CLI_GO_BIN" ]; then
    echo "  · 文件不存在" >&2
    return 0
  fi
  echo "  · go version -m:" >&2
  if ! go version -m "$CLI_GO_BIN" >&2; then
    echo "  · go version -m 无法读取该文件（可能仍被占用；见 ）" >&2
  fi
}

if [ -d "$CLI_GO_DIR" ]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "❌ 打包必须安装 go：内置 CLI 必须由当前 release 源码现场构建" >&2
    exit 1
  fi
  build_go_cli_for_target
  if ! go_cli_matches_target "$CLI_GO_BIN"; then
    report_go_cli_mismatch
    exit 1
  fi
  if ! go_cli_matches_source_revision "$CLI_GO_BIN"; then
    echo "❌ tabtin CLI 不是由当前 release 提交构建：期望 $EXPECTED_GIT_REVISION" >&2
    go version -m "$CLI_GO_BIN" >&2 || true
    exit 1
  fi
  smoke_go_cli_contract_if_runnable "$CLI_GO_BIN"
fi

# tabtin-filegen（PyInstaller 自包含二进制）：文件生成能力（xlsx/docx/pptx/pdf），
# 运行期被 cli-server.ts 加进 Agent shell PATH。与 Go CLI 同：不是 npm 包、pnpm
# deploy 不含它，这里手动拷进 deploy-src（prepare-deploy-package.mjs 会把
# extraResources 的 from 重写成 ./tabtin-filegen-python-dist-src）。
# local/community 包均按 best-effort 置入目标架构二进制。
FILEGEN_DIR="$REPO_ROOT/packages/tabtin-filegen-python"
# shellcheck disable=SC1091
source "$FILEGEN_DIR/filegen-arch.sh"
FILEGEN_BIN_NAME="$(filegen_generic_bin_name "$TARGET_RUNTIME")"
FILEGEN_ARCH_NAME="$(filegen_arch_bin_name "$TARGET_RUNTIME" "$ARCH")"
FILEGEN_BIN="$FILEGEN_DIR/dist/$FILEGEN_BIN_NAME"
FILEGEN_ARCH_BIN="$FILEGEN_DIR/dist/$FILEGEN_ARCH_NAME"
resolve_filegen_python() {
  local candidate
  can_run_python() {
    "$1" -c 'import sys; sys.exit(0)' >/dev/null 2>&1
  }
  if [ -n "${PYTHON:-}" ]; then
    if command -v "$PYTHON" >/dev/null 2>&1 && can_run_python "$PYTHON"; then
      printf '%s\n' "$PYTHON"
      return 0
    fi
    return 1
  fi
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1 && can_run_python "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
resolve_filegen_source() {
  if filegen_matches_target "$FILEGEN_ARCH_BIN" "$TARGET_RUNTIME" "$ARCH"; then
    printf '%s\n' "$FILEGEN_ARCH_BIN"
    return 0
  fi
  if filegen_matches_target "$FILEGEN_BIN" "$TARGET_RUNTIME" "$ARCH"; then
    printf '%s\n' "$FILEGEN_BIN"
    return 0
  fi
  return 1
}
can_build_filegen_on_host() {
  [ "$HOST_RUNTIME" = "$TARGET_RUNTIME" ] && [ "$HOST_ARCH" = "$ARCH" ]
}
if [ -d "$FILEGEN_DIR" ]; then
  FILEGEN_SOURCE="$(resolve_filegen_source || true)"
  if [ -z "$FILEGEN_SOURCE" ]; then
    if can_build_filegen_on_host; then
      FILEGEN_PYTHON="$(resolve_filegen_python || true)"
      if [ -n "$FILEGEN_PYTHON" ]; then
        echo "  · 构建 tabtin-filegen 二进制 (packages/tabtin-filegen-python/dist/$FILEGEN_ARCH_NAME)"
        if ! ( cd "$FILEGEN_DIR" && PYTHON="$FILEGEN_PYTHON" bash build.sh ); then
          echo "  ⚠ tabtin-filegen 构建失败：包内将缺少文件生成能力（非致命）" >&2
        fi
        FILEGEN_SOURCE="$(resolve_filegen_source || true)"
      else
        echo "  ⚠ 无法现场构建 tabtin-filegen（无 python3/python）：包内将缺少文件生成能力（非致命）" >&2
      fi
    else
      echo "  ⚠ 无法现场构建目标架构 tabtin-filegen（host=${HOST_RUNTIME}/${HOST_ARCH} target=${TARGET_RUNTIME}/${ARCH}）：包内将缺少文件生成能力（非致命）" >&2
    fi
  fi
  rm -rf "$DEPLOY_DIR/tabtin-filegen-python-dist-src"
  mkdir -p "$DEPLOY_DIR/tabtin-filegen-python-dist-src"
  if [ -n "${FILEGEN_SOURCE:-}" ] && filegen_matches_target "$FILEGEN_SOURCE" "$TARGET_RUNTIME" "$ARCH"; then
    cp "$FILEGEN_SOURCE" "$DEPLOY_DIR/tabtin-filegen-python-dist-src/$FILEGEN_BIN_NAME"
    if [ "$FILEGEN_SOURCE" = "$FILEGEN_BIN" ]; then
      cp -f "$FILEGEN_SOURCE" "$FILEGEN_ARCH_BIN"
    fi
    echo "  · staged tabtin-filegen from $FILEGEN_SOURCE → $FILEGEN_BIN_NAME (${TARGET_RUNTIME}/${ARCH})"
  fi
fi

if [ "${TABTIN_ENABLE_PACKAGED_OFFICE_PREVIEW_RUNTIME:-0}" = "1" ] && [ -n "$OFFICE_RUNTIME_SRC" ]; then
  echo "  · 打包 Office preview runtime: $OFFICE_RUNTIME_SRC"
  stage_office_preview_runtime_bundle "$OFFICE_RUNTIME_SRC" "$OFFICE_RUNTIME_DEPLOY_SRC"
elif stage_office_preview_runtime_download_manifest "$OFFICE_RUNTIME_DEPLOY_SRC"; then
  echo "  · 打包 Office preview runtime 下载清单（首次预览时下载）"
else
  echo "  ⚠ 当前平台没有 Office preview runtime 下载清单：安装包将缺少 PPT/Word 高保真预览引擎" >&2
  rm -rf "$OFFICE_RUNTIME_DEPLOY_SRC"
  mkdir -p "$OFFICE_RUNTIME_DEPLOY_SRC"
fi

# ---- 自管 Python 运行时 staging（逻辑在 scripts/electron/package/prepare-python-runtime.sh）----
PY_RUNTIME_DEPLOY_SRC="$DEPLOY_DIR/tabtin-python-runtime-src"
bash "$REPO_ROOT/scripts/electron/package/prepare-python-runtime.sh" \
  --platform "${TARGET_RUNTIME}-${ARCH}" \
  --profile "$PROFILE" \
  --deploy-dir "$PY_RUNTIME_DEPLOY_SRC" \
  || true

# ---- 语义召回本地模型 staging（：生产零下载）----
# 运行时代码无下载能力，模型必须在构建期置入。fetch 脚本钉版本 + sha256 校验、
# 支持 HF_ENDPOINT 镜像；先落 APP_DIR/resources/models（gitignored 持久缓存，
# 本机首次下载后离线可打包），再拷进 deploy-src（prepare-deploy-package.mjs
# 会把 extraResources 的 from 重写成 ./embedding-models-src）。
EMBEDDING_MODEL_CACHE="$APP_DIR/resources/models"
EMBEDDING_MODEL_DEPLOY_SRC="$DEPLOY_DIR/embedding-models-src"
EMBEDDING_MODEL_FETCH_SCRIPT="$REPO_ROOT/scripts/electron/runtime/fetch-embedding-model.mjs"
echo "  · 置入语义召回模型（sha256 校验，已缓存则跳过下载）..."
if [ ! -f "$EMBEDDING_MODEL_FETCH_SCRIPT" ]; then
  echo "  ⚠ 开源快照未包含 fetch-embedding-model.mjs：安装包使用词法召回兜底" >&2
elif node "$EMBEDDING_MODEL_FETCH_SCRIPT" --out "$EMBEDDING_MODEL_CACHE"; then
  rm -rf "$EMBEDDING_MODEL_DEPLOY_SRC"
  mkdir -p "$EMBEDDING_MODEL_DEPLOY_SRC"
  cp -R "$EMBEDDING_MODEL_CACHE/." "$EMBEDDING_MODEL_DEPLOY_SRC/"
else
  MODEL_REGION="${TABTIN_RUNTIME_REGION:-auto}"
  MODEL_REGION="$(node "$REPO_ROOT/scripts/electron/runtime/resolve-office-runtime-region.mjs" --region "$MODEL_REGION" 2>/dev/null || printf '%s' global)"
  if [ -z "${HF_ENDPOINT:-}" ] && [ "$MODEL_REGION" = "cn" ] && [ "${TABTIN_DISABLE_HF_MIRROR_FALLBACK:-0}" != "1" ]; then
    echo "  ↪ 官方模型源失败，使用已校验的国内镜像重试（HF_ENDPOINT 可显式覆盖）..."
    if HF_ENDPOINT="https://hf-mirror.com" node "$EMBEDDING_MODEL_FETCH_SCRIPT" --out "$EMBEDDING_MODEL_CACHE"; then
      rm -rf "$EMBEDDING_MODEL_DEPLOY_SRC"
      mkdir -p "$EMBEDDING_MODEL_DEPLOY_SRC"
      cp -R "$EMBEDDING_MODEL_CACHE/." "$EMBEDDING_MODEL_DEPLOY_SRC/"
    else
      echo "  ⚠ 语义召回模型置入失败：安装包将缺少语义召回（词法单路兜底）" >&2
      rm -rf "$EMBEDDING_MODEL_DEPLOY_SRC"
      mkdir -p "$EMBEDDING_MODEL_DEPLOY_SRC"
    fi
  else
    echo "  ⚠ 语义召回模型置入失败：安装包将缺少语义召回（词法单路兜底）" >&2
    # 始终建 deploy-src 目录，避免 electron-builder 因 extraResources from 不存在而失败。
    rm -rf "$EMBEDDING_MODEL_DEPLOY_SRC"
    mkdir -p "$EMBEDDING_MODEL_DEPLOY_SRC"
  fi
fi

PREPARE_DEPLOY_ARGS=(
  --package-json "$DEPLOY_DIR/package.json"
  --update-channel "${TABTIN_UPDATE_CHANNEL:-stable}"
  --distribution-kind "$TABTIN_DISTRIBUTION_KIND"
  --api-base-url "${COMMUNITY_API_BASE_URL:-${VITE_API_BASE_URL:-}}"
)
[ -n "$UPDATE_PUBLISH_URL" ] && PREPARE_DEPLOY_ARGS+=(--publish-url "$UPDATE_PUBLISH_URL")
[ -n "$COMMUNITY_UPDATE_FEED_URL" ] && PREPARE_DEPLOY_ARGS+=(--update-feed-url "$COMMUNITY_UPDATE_FEED_URL")
node "$SCRIPT_DIR/prepare-deploy-package.mjs" "${PREPARE_DEPLOY_ARGS[@]}"

PACKAGED_ELECTRON_VERSION="$(
  cd "$APP_DIR" && node -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const { createRequire } = require("node:module")
    const packageJsonPath = path.join(process.cwd(), "package.json")
    const req = createRequire(packageJsonPath)
    try {
      console.log(req("electron/package.json").version)
    } catch {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"))
      const version = pkg.dependencies?.electron || pkg.devDependencies?.electron || ""
      console.log(String(version).replace(/^[~^]/, ""))
    }
  ' 2>/dev/null || true
)"
if [ -z "$PACKAGED_ELECTRON_VERSION" ]; then
  echo "  ✗ 找不到 electron 版本，无法生成不含 devDependencies 的 deploy package" >&2
  exit 1
fi
node -e '
  const fs = require("node:fs")
  const p = process.argv[1]
  const electronVersion = process.argv[2]
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"))
  pkg.build = pkg.build || {}
  if (electronVersion) {
    pkg.build.electronVersion = String(electronVersion).replace(/^[~^]/, "")
  }
  delete pkg.devDependencies
  delete pkg.optionalDevDependencies
  fs.writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`)
' "$DEPLOY_DIR/package.json" "$PACKAGED_ELECTRON_VERSION"

if [ "$PROFILE" = "local" ] || [ "$PROFILE" = "community" ]; then
  # 把 deploy 后 package.json 的 version 也 patch 成 SSoT 推导出的 PROFILE_VERSION。
  # 必须跟前面 EXTRA_BUILDER_ARGS 的 --config.extraMetadata.version 完全一致——
  # 这条 patch 走 deploy_dir 内的 package.json，那条 args 走 electron-builder
  # CLI override，两条任一漂移都会让 packaged app version 跟 sourcemap 入库版本
  # 对不上 → admindash 反混淆失效。
  # 两种 profile 使用独立 productName/appId，避免系统应用身份互相覆盖。
  node -e '
    const fs = require("node:fs")
    const p = process.argv[1]
    const archArg = process.argv[2]
    const profileVersion = process.argv[3]
    const productName = process.argv[4]
    const appId = process.argv[5]
    const profile = process.argv[6]
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"))
    pkg.version = profileVersion
    pkg.build = pkg.build || {}
    pkg.build.productName = productName
    pkg.build.appId = appId
    pkg.build.extraMetadata = {
      ...(pkg.build.extraMetadata || {}),
      version: profileVersion,
      tabtinDesktop: {
        ...((pkg.build.extraMetadata || {}).tabtinDesktop || {}),
        buildProfile: profile,
      },
    }
    // 把 mac.target 写成对象数组形态，显式锁定 arch；
    // 否则 electron-builder 默认会同时打 host arch + universal x64，
    // 多生成 240MB 浪费带宽。
    pkg.build.mac = {
      ...(pkg.build.mac || {}),
      target: [
        { target: "dmg", arch: [archArg] },
        { target: "zip", arch: [archArg] },
      ],
    }
    fs.writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`)
  ' "$DEPLOY_DIR/package.json" "$ARCH" "$PROFILE_VERSION" "$PROFILE_PRODUCT_NAME" "$PROFILE_APP_ID" "$PROFILE"
fi

if [ "$TARGET_RUNTIME" = "darwin" ]; then
  # 显式锁定当前 arch；否则 package.json 里的 mac.target
  # 默认同时包含 arm64/x64，`--arm64` 仍会在 ARM 后继续打 x64，浪费构建与签名时间。
  node -e '
    const fs = require("node:fs")
    const p = process.argv[1]
    const archArg = process.argv[2]
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"))
    pkg.build = pkg.build || {}
    pkg.build.mac = {
      ...(pkg.build.mac || {}),
      target: [
        { target: "dmg", arch: [archArg] },
        { target: "zip", arch: [archArg] },
      ],
    }
    fs.writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`)
  ' "$DEPLOY_DIR/package.json" "$ARCH"
fi
pack_time_step_end "resource staging"

# Step 3.5: 修复 pnpm deploy 漏 hoist / 外逃 workspace symlink。
pack_time_step_begin "dependency cleanup"
#
# Windows：ensure-deploy-self-contained.mjs 补齐顶层 hoist，并把逃出 deploy 的链接物化为真实副本
#         （：asar "must be under"）。仅 win32 启用，不改动 mac/linux 既有逻辑。
# 非 Windows：沿用原 shell hoist 修正。
if [ "$QUICK_DEPLOY_CACHE_HIT" = "1" ]; then
  echo "[3.5/5] Reusing self-contained deploy dependencies (validated cache)"
elif [ "$TARGET_RUNTIME" = "win32" ]; then
  echo "[3.5/5] Ensuring deploy dependencies are self-contained (Windows)..."
  node "$SCRIPT_DIR/ensure-deploy-self-contained.mjs" "$DEPLOY_DIR"
else
  echo "[3.5/5] Patching missing workspace package hoist..."
  DEPLOY_AT_DIR="$DEPLOY_DIR/node_modules/@tabtin"
  mkdir -p "$DEPLOY_AT_DIR"
  DEPLOY_REAL="$(cd "$DEPLOY_DIR" && pwd -P)"

  is_under_deploy() {
    local resolved="$1"
    case "$resolved" in
      "$DEPLOY_REAL"|"$DEPLOY_REAL"/*)
        return 0
        ;;
      *)
        return 1
        ;;
    esac
  }

  for pnpm_inner in "$DEPLOY_DIR"/node_modules/.pnpm/@tabtin+*/node_modules/@tabtin/*; do
    [ -d "$pnpm_inner" ] || continue
    pkg_name=$(basename "$pnpm_inner")
    top_link="$DEPLOY_AT_DIR/$pkg_name"
    pnpm_dir=$(basename "$(dirname "$(dirname "$(dirname "$pnpm_inner")")")")
    desired_target="../.pnpm/$pnpm_dir/node_modules/@tabtin/$pkg_name"

    if [ -L "$top_link" ]; then
      resolved_target="$(realpath "$top_link" 2>/dev/null || true)"
      if [ -n "$resolved_target" ] && is_under_deploy "$resolved_target"; then
        continue
      fi
      rm "$top_link"
    elif [ -e "$top_link" ]; then
      resolved_target="$(realpath "$top_link" 2>/dev/null || true)"
      if [ -n "$resolved_target" ] && is_under_deploy "$resolved_target"; then
        continue
      fi
      rm -rf "$top_link"
    fi

    ln -s "$desired_target" "$top_link"
    echo "  · hoist 修正: @tabtin/$pkg_name"
  done
fi

# Step 3.6: 修复 jsdom 嵌套 whatwg-url。
#
# 现象：jsdom 内部用 require('whatwg-url/webidl2js-wrapper') 这种子路径写法。
#       但 pnpm 把另一个 transitive 拉的 whatwg-url@5.0.0 hoist 到了顶层
#       node_modules/whatwg-url/，jsdom@29 自己需要的 whatwg-url@16.x 反而没有
#       嵌套到 jsdom/node_modules/。asar 里只剩 5.0.0，jsdom 一加载就 ENOENT。
# 后果：LocalAgentHost / Phase2 ActionBridge 启动时同步 import 链路里有 jsdom，
#       packaged app 里相关高级功能不可用（虽然不阻塞主进程启动，但是个 bug）。
# 修复：扫描 deploy 里所有 jsdom 副本（按 package.json#dependencies 读到它期望的
#       whatwg-url range），从 .pnpm 找最匹配的版本，复制到 <jsdom>/node_modules/。
if [ "$QUICK_DEPLOY_CACHE_HIT" = "1" ]; then
  echo "[3.6/5] Reusing cached jsdom dependency patch"
else
  echo "[3.6/5] Patching jsdom nested whatwg-url..."
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const deployDir = process.argv[1];
const pnpmDir = path.join(deployDir, "node_modules/.pnpm");

function listJsdomInstances() {
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === "jsdom") {
        const pkg = path.join(full, "package.json");
        if (fs.existsSync(pkg)) out.push(full);
      } else if (ent.name === "node_modules" || ent.name.startsWith("@") || ent.name.startsWith(".pnpm")) {
        walk(full);
      } else if (dir.endsWith("node_modules")) {
        walk(path.join(full, "node_modules"));
      }
    }
  }
  walk(path.join(deployDir, "node_modules"));
  return out;
}

function listWhatwgUrlVersions() {
  if (!fs.existsSync(pnpmDir)) return [];
  return fs.readdirSync(pnpmDir)
    .filter(d => d.startsWith("whatwg-url@"))
    .map(d => {
      // d: whatwg-url@16.0.1_@noble+hashes@1.8.0  →  16.0.1
      const ver = d.slice("whatwg-url@".length).split("_")[0];
      return { dir: path.join(pnpmDir, d, "node_modules/whatwg-url"), version: ver };
    })
    .filter(({ dir }) => fs.existsSync(dir));
}

function semverMajor(v) { return parseInt(String(v).match(/\d+/)?.[0] ?? "0", 10); }
function pickBestMatch(range, available) {
  // 极简兼容选择：按 range 的 major 找匹配 major 的最高版本。
  // jsdom 期望形如 "^16.0.1" / "^14.2.0"。
  const wantedMajor = semverMajor(range);
  const candidates = available
    .filter(({ version }) => semverMajor(version) === wantedMajor)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return candidates.at(-1) || null;
}

function copyDir(src, dst) {
  cp.execFileSync("cp", ["-R", src + "/", dst + "/"], { stdio: "inherit" });
}

const jsdomInstances = listJsdomInstances();
const whatwgVersions = listWhatwgUrlVersions();
let patched = 0;
for (const jsdomDir of jsdomInstances) {
  const pkg = JSON.parse(fs.readFileSync(path.join(jsdomDir, "package.json"), "utf8"));
  const range = pkg.dependencies?.["whatwg-url"];
  if (!range) continue;

  // 已经有嵌套副本就跳过
  const nestedDir = path.join(jsdomDir, "node_modules/whatwg-url");
  if (fs.existsSync(nestedDir)) {
    try {
      const nestedPkg = JSON.parse(fs.readFileSync(path.join(nestedDir, "package.json"), "utf8"));
      if (semverMajor(nestedPkg.version) === semverMajor(range)) continue;
    } catch { /* 损坏，重补 */ }
  }

  const match = pickBestMatch(range, whatwgVersions);
  if (!match) {
    console.warn(`  ⚠ ${jsdomDir} 期望 whatwg-url ${range}，但 .pnpm 里没找到匹配版本`);
    continue;
  }

  fs.mkdirSync(path.join(jsdomDir, "node_modules"), { recursive: true });
  if (fs.existsSync(nestedDir)) {
    fs.rmSync(nestedDir, { recursive: true, force: true });
  }
  copyDir(match.dir, nestedDir);
  patched++;
  const rel = path.relative(deployDir, jsdomDir);
  console.log(`  · jsdom@${pkg.version} (${rel}) ← whatwg-url@${match.version}`);
}
if (patched === 0 && jsdomInstances.length > 0) {
  console.log(`  · 未补任何 jsdom（${jsdomInstances.length} 个实例已自带嵌套 whatwg-url）`);
}
' "$DEPLOY_DIR"
fi

# Step 4: Clean up node_modules（：单次 Node prune，避免 Windows 上 20+ 次 find）
echo "[4/5] Cleaning up node_modules..."
NM="$DEPLOY_DIR/node_modules"
PRUNE_ARGS=("$DEPLOY_DIR" --runtime "$TARGET_RUNTIME" --arch "$ARCH")
# quick 在 electron-builder 前物理删除 build.files 已排除的文件，避免 Windows
# 对数万份 map/types/tests/docs 做无效的 NTFS 枚举与实时扫描。
# 完整构建默认只做 correctness prune；需要额外缩盘时显式设 PACK_DEEP_PRUNE=1。
if [ "$QUICK_DEPLOY_CACHE_HIT" = "1" ]; then
  echo "  · reusing deep-pruned node_modules from validated cache"
elif { [ "$PACK_QUICK" = "1" ] && [ "$TARGET_RUNTIME" = "win32" ]; } || \
   [ "${PACK_DEEP_PRUNE:-0}" = "1" ]; then
  PRUNE_ARGS+=(--deep)
  if [ "$PACK_QUICK" = "1" ] && [ "$TARGET_RUNTIME" = "win32" ]; then
    echo "  · quick deep prune：预先删除 package files 已排除的 map/types/tests/docs"
  else
    echo "  · PACK_DEEP_PRUNE=1：额外删除 map/types/tests/docs"
  fi
else
  echo "  · correctness-only prune（跨平台 native / node-pty junk / stamps；体积排除交给 build.files）"
fi
if [ "$QUICK_DEPLOY_CACHE_HIT" != "1" ]; then
  node "$SCRIPT_DIR/prune-deploy-node-modules.mjs" "${PRUNE_ARGS[@]}"
fi

strip_public_sourcemap_references \
  "$DEPLOY_DIR/out" \
  "$DEPLOY_DIR/tabsite-templates-src" \
  "$DEPLOY_DIR/bundled-skills-src" \
  "$DEPLOY_DIR/package-skills-tabtracker-src" \
  "$DEPLOY_DIR/packages-apps-src"

# Windows 上对巨大 node_modules 做 du 本身可能数分钟且易 Abort；默认跳过。
if [ "${PACK_SKIP_NM_DU:-}" != "1" ] && [ "$TARGET_RUNTIME" != "win32" ]; then
  BEFORE_OR_AFTER=$(du -sm "$NM" 2>/dev/null | cut -f1 || echo 0)
  echo "  node_modules: ${BEFORE_OR_AFTER}M (after prune)"
fi

# Step 4.5: cross-build 时补齐 darwin-${ARCH} prebuilt 包
#
# pnpm 按 host CPU 选可选包（@napi-rs/canvas-darwin-x64、@img/sharp-darwin-x64、
# @img/sharp-libvips-darwin-x64），所以 Apple Silicon host 上不会装 darwin-x64
# 那一组。cross-build x64 时若不补，运行时 module not found。
# 我们刻意不在 root pnpm-workspace.yaml 加 supportedArchitectures——那会触发整个
# monorepo 重装，影响并行 dev。改成只往 deploy_dir 顶层 hoist 这几个包。
#
# 这些 prebuilt 包都是纯 native 资源 + 一份 JS 入口，无 runtime deps，
# npm pack 下载 .tgz 解压即可，不用走 .pnpm 链接层。
if [ "$TARGET_RUNTIME" = "darwin" ] && [ "$ARCH" != "$HOST_ARCH" ]; then
  echo "[4.5/5] Cross-arch prebuilt setup (darwin-${ARCH})..."

  declare -a PREBUILT_PKGS=()
  for prefix in \
    "@napi-rs+canvas-darwin-${HOST_ARCH}@" \
    "@img+sharp-darwin-${HOST_ARCH}@" \
    "@img+sharp-libvips-darwin-${HOST_ARCH}@" \
    "@vscode+ripgrep-darwin-${HOST_ARCH}@"; do
    found="$(ls -d "$REPO_ROOT/node_modules/.pnpm/${prefix}"* 2>/dev/null | head -1)"
    [ -z "$found" ] && continue
    base="$(basename "$found")"
    pkg="${base%@*}"
    pkg="${pkg//+//}"
    pkg="${pkg/darwin-${HOST_ARCH}/darwin-${ARCH}}"
    ver="${base##*@}"
    PREBUILT_PKGS+=("${pkg}@${ver}")
  done

  if [ "${#PREBUILT_PKGS[@]}" -gt 0 ]; then
    TMP_PACK_DIR="$(mktemp -d)"
    for spec in "${PREBUILT_PKGS[@]}"; do
      echo "  · npm pack ${spec}"
      pkg_name="${spec%@*}"
      target_dir="$DEPLOY_DIR/node_modules/${pkg_name}"
      if [ -d "$target_dir" ] && [ -f "$target_dir/package.json" ]; then
        echo "    （已存在，跳过）"
        continue
      fi
      (
        cd "$TMP_PACK_DIR"
        rm -f ./*.tgz 2>/dev/null || true
        npm pack "$spec" --silent >/dev/null
      )
      tarball="$(ls "$TMP_PACK_DIR"/*.tgz 2>/dev/null | head -1)"
      if [ -z "$tarball" ]; then
        echo "  ✗ npm pack ${spec} 失败" >&2
        rm -rf "$TMP_PACK_DIR"
        exit 1
      fi
      mkdir -p "$target_dir"
      tar -xzf "$tarball" -C "$target_dir" --strip-components=1
      rm -f "$tarball"
    done
    rm -rf "$TMP_PACK_DIR"
    echo "  ✓ 已补装 ${#PREBUILT_PKGS[@]} 个 darwin-${ARCH} prebuilt 包"
  else
    echo "  ⚠ 未在 root 找到 darwin-${HOST_ARCH} 参照包，跳过补装" >&2
  fi
fi

find_developer_id_identity() {
  if [ -n "${CSC_NAME:-}" ]; then
    printf '%s\n' "$CSC_NAME"
    return 0
  fi

  if ! command -v security >/dev/null 2>&1; then
    return 1
  fi

  security find-identity -v -p codesigning 2>/dev/null \
    | awk -F '"' '/Developer ID Application/ { print $2; exit }'

  return 1
}

assert_windows_installer_artifact() {
  local artifact_dir="$1"
  if find "$artifact_dir" -maxdepth 1 -type f -iname '*.exe' -print -quit | grep -q .; then
    return 0
  fi

  echo "  ✗ Windows installer missing under $artifact_dir" >&2
  echo "  ✗ win-unpacked alone is not a deliverable installer; inspect the electron-builder log" >&2
  return 1
}

pack_time_step_end "dependency cleanup"

# Step 5: Run electron-builder from deploy directory
if [ "$TARGET_RUNTIME" = "win32" ]; then
  echo "[4.9/5] Checking Windows installer shortcut contract"
  node "$SCRIPT_DIR/installer-shortcut-contract.test.cjs"
fi

echo "[5/5] Building ${BUILD_TITLE}..."
EXPECTED_ELECTRON_BUILDER_VERSION="25.1.8"
ELECTRON_BUILDER_PACKAGE_JSON="$APP_DIR/node_modules/electron-builder/package.json"
ELECTRON_BUILDER_CLI="$APP_DIR/node_modules/electron-builder/cli.js"
if [ ! -f "$ELECTRON_BUILDER_PACKAGE_JSON" ] || [ ! -f "$ELECTRON_BUILDER_CLI" ]; then
  echo "  ✗ 找不到项目锁定的 electron-builder；请先在主 worktree 准备依赖" >&2
  exit 1
fi
ACTUAL_ELECTRON_BUILDER_VERSION="$(node -p "require('$ELECTRON_BUILDER_PACKAGE_JSON').version")"
if [ "$ACTUAL_ELECTRON_BUILDER_VERSION" != "$EXPECTED_ELECTRON_BUILDER_VERSION" ]; then
  echo "  ✗ electron-builder 版本不匹配：期望 ${EXPECTED_ELECTRON_BUILDER_VERSION}，实际 ${ACTUAL_ELECTRON_BUILDER_VERSION}" >&2
  exit 1
fi
echo "  · electron-builder: ${ACTUAL_ELECTRON_BUILDER_VERSION} (${ELECTRON_BUILDER_CLI})"
cd "$DEPLOY_DIR"
ALL_BUILDER_ARGS=("${BUILDER_FLAG[@]}")
if [ "${#EXTRA_BUILDER_ARGS[@]}" -gt 0 ]; then
  ALL_BUILDER_ARGS+=("${EXTRA_BUILDER_ARGS[@]}")
fi
INSTALLED_ELECTRON_PACKAGE_JSON="$APP_DIR/node_modules/electron/package.json"
INSTALLED_ELECTRON_DIST="$APP_DIR/node_modules/electron/dist"
if [ "$HOST_RUNTIME" = "$TARGET_RUNTIME" ] && [ "$HOST_ARCH" = "$ARCH" ] && \
   [ -f "$INSTALLED_ELECTRON_PACKAGE_JSON" ] && [ -d "$INSTALLED_ELECTRON_DIST" ]; then
  INSTALLED_ELECTRON_VERSION="$(node -p "require('$INSTALLED_ELECTRON_PACKAGE_JSON').version")"
  ALL_BUILDER_ARGS+=(
    "--config.electronVersion=$INSTALLED_ELECTRON_VERSION"
    "--config.electronDist=$INSTALLED_ELECTRON_DIST"
  )
  echo "  · electron runtime: ${INSTALLED_ELECTRON_VERSION} (${INSTALLED_ELECTRON_DIST})"
fi
if [ "$TARGET_RUNTIME" = "win32" ]; then
  ALL_BUILDER_ARGS+=("--config.directories.output=$ARTIFACT_DIR_RELATIVE")
fi
echo "  · electron-builder args: ${ALL_BUILDER_ARGS[*]}"
mkdir -p "$(dirname "$ARTIFACT_DIR")"
BUILDER_LOG="$DEPLOY_DIR/electron-builder-${PROFILE}-${TARGET_NAME}-${ARCH}.log"
rm -f "$BUILDER_LOG"
pack_time_step_begin "electron-builder"
BUILDER_STARTED_AT=$SECONDS
set +e
node "$ELECTRON_BUILDER_CLI" "${ALL_BUILDER_ARGS[@]}" 2>&1 | tee "$BUILDER_LOG"
BUILDER_CODE=${PIPESTATUS[0]}
set -e
BUILDER_ELAPSED_SECONDS=$((SECONDS - BUILDER_STARTED_AT))
pack_time_step_end "electron-builder"
if [ "$BUILDER_CODE" -ne 0 ]; then
  echo "  · electron-builder failed after ${BUILDER_ELAPSED_SECONDS}s" >&2
  echo "  ✗ electron-builder failed with exit code $BUILDER_CODE" >&2
  echo "  · full log: $BUILDER_LOG" >&2
  echo "  · electron-builder log tail:" >&2
  print_log_tail "$BUILDER_LOG" 120 >&2
  exit "$BUILDER_CODE"
fi
echo "  · electron-builder completed in ${BUILDER_ELAPSED_SECONDS}s"
[ -d "$ARTIFACT_DIR" ] && cp "$BUILDER_LOG" "$ARTIFACT_DIR/electron-builder.log" 2>/dev/null || true
if [ "$TARGET_RUNTIME" = "win32" ]; then
  assert_windows_installer_artifact "$ARTIFACT_DIR"
fi
pack_time_step_begin "artifact audit and delivery"

# Windows Electron 在进入 main JS 前会强校验 app.asar。跨平台打包时必须
# 确认 PE 内记录使用 Windows 路径分隔符，避免安装成功但点击无响应。
if [ "$TARGET_RUNTIME" = "win32" ]; then
  echo "[5.05/5] Asserting Windows embedded ASAR integrity"
  node "$SCRIPT_DIR/assert-windows-asar-integrity.mjs" \
    --app-dir "$ARTIFACT_DIR/win-unpacked" \
    --exe-name "${PROFILE_EXECUTABLE_NAME}.exe"
fi

# Windows：标签（文件名/任务 version）必须与 PE ProductVersion 对齐，防止交出去旧包。
if [ "$TARGET_RUNTIME" = "win32" ] && [ -n "${PROFILE_VERSION:-}" ]; then
  echo "[5.1/5] Asserting Windows installer PE version == ${PROFILE_VERSION}"
  node "$SCRIPT_DIR/assert-windows-exe-version.mjs" \
    --dist "$ARTIFACT_DIR" \
    --expect "$PROFILE_VERSION" \
    --exe-name "${PROFILE_EXECUTABLE_NAME}.exe"
fi

# flip-electron-fuses 在 afterPack 改 Electron 二进制，必须重签。
# local 始终 ad-hoc；community 无 Developer ID 时也用 ad-hoc 兜底。
if [ "$TARGET_RUNTIME" = "darwin" ]; then
  NEED_ADHOC_SIGN=0
  if [ "$PROFILE" = "local" ] || [ "${CSC_IDENTITY_AUTO_DISCOVERY:-}" = "false" ]; then
    NEED_ADHOC_SIGN=1
  else
    DEV_ID="$(find_developer_id_identity 2>/dev/null || true)"
    [ -z "$DEV_ID" ] && NEED_ADHOC_SIGN=1
  fi
  if [ "$NEED_ADHOC_SIGN" = "1" ]; then
    APP_COUNT=0
    for app_bundle in "$ARTIFACT_DIR"/*.app "$ARTIFACT_DIR"/mac/*.app "$ARTIFACT_DIR"/mac-*/*.app; do
      [ -d "$app_bundle" ] || continue
      APP_COUNT=$((APP_COUNT + 1))
      echo "[5.25/5] ad-hoc 重签: $(basename "$app_bundle")"
      "$SCRIPT_DIR/repair-macos-framework-links.sh" "$app_bundle"
      codesign --force --deep --sign - "$app_bundle"
      codesign --verify --verbose=2 "$app_bundle"
    done
    if [ "$APP_COUNT" -eq 0 ]; then
      echo "❌ 未找到待 ad-hoc 签名的 macOS .app（产物目录: ${ARTIFACT_DIR}）" >&2
      exit 1
    fi
    # electron-builder 在 flip fuses 后、重签前已打出 DMG/ZIP；用重签后的 .app 重建分发包。
    for app_bundle in "$ARTIFACT_DIR"/*.app "$ARTIFACT_DIR"/mac/*.app "$ARTIFACT_DIR"/mac-*/*.app; do
      [ -d "$app_bundle" ] || continue
      app_base="$(basename "$app_bundle" .app)"
      dmg_path="$ARTIFACT_DIR/${app_base}-${ARTIFACT_VERSION_LABEL}-${ARCH}.dmg"
      zip_path="$ARTIFACT_DIR/${app_base}-${ARTIFACT_VERSION_LABEL}-${ARCH}-mac.zip"
      echo "[5.3/5] 从已重签 .app 重建 DMG: $(basename "$dmg_path")"
      rm -f "$dmg_path" "$zip_path"
      bash "$SCRIPT_DIR/create-styled-dmg.sh" "$app_bundle" "$dmg_path"
      echo "[5.35/5] 从已重签 .app 重建 ZIP: $(basename "$zip_path")"
      (cd "$(dirname "$app_bundle")" && ditto -c -k --sequesterRsrc --keepParent "$(basename "$app_bundle")" "$zip_path")
      rm -f "$ARTIFACT_DIR/"*.blockmap
    done
  fi
fi

echo "[5.5/5] ${PROFILE} profile：跳过 DMG 签名/公证"

echo "[5.8/5] Auditing packaged artifact..."
node "$SCRIPT_DIR/audit-packaged-artifact.mjs" \
  --artifact "$ARTIFACT_DIR" \
  --profile "$PROFILE" \
  --target "$TARGET_NAME" \
  --arch "$ARCH" \
  --expected-cli-revision "$EXPECTED_GIT_REVISION"

if [ "$TARGET_RUNTIME" = "win32" ]; then
  # The isolated run artifact above is the audited package. Only copy its
  # top-level delivery files into the stable output directory. Mirroring
  # win-unpacked here lets editor file watchers lock app.asar and can make
  # post-upload cleanup (or the next build) fail with EBUSY on Windows.
  mkdir -p "$APP_DIR/dist-app"
  find "$ARTIFACT_DIR" -maxdepth 1 -type f -exec cp {} "$APP_DIR/dist-app/" \;
else
  remove_tree_with_windows_retry "$APP_DIR/dist-app"
  mkdir -p "$APP_DIR/dist-app"
  cp -R "$ARTIFACT_DIR/." "$APP_DIR/dist-app/"

  echo "[5.9/5] Auditing final dist-app artifact..."
  node "$SCRIPT_DIR/audit-packaged-artifact.mjs" \
    --artifact "$APP_DIR/dist-app" \
    --profile "$PROFILE" \
    --target "$TARGET_NAME" \
    --arch "$ARCH" \
    --expected-cli-revision "$EXPECTED_GIT_REVISION"
fi

cd "$APP_DIR"
if [ "$PACK_QUICK_DEPLOY_CACHE" = "1" ]; then
  node "$SCRIPT_DIR/quick-deploy-cache.mjs" write "$REPO_ROOT" "$DEPLOY_DIR"
fi
if [ "$TARGET_RUNTIME" = "win32" ] && [ -e "$ARTIFACT_DIR" ]; then
  artifact_stale="${ARTIFACT_DIR}.stale.$$"
  if mv "$ARTIFACT_DIR" "$artifact_stale" 2>/dev/null; then
    (
      chmod -R u+w "$artifact_stale" 2>/dev/null || true
      rm -rf "$artifact_stale"
    ) >/dev/null 2>&1 &
  else
    echo "  ⚠ Windows artifact remains locked; leaving it for later cleanup: $ARTIFACT_DIR" >&2
  fi
fi
cleanup_packaged_deploy_dir
pack_time_step_end "artifact audit and delivery"
BUILD_COMPLETED=1
trap - EXIT

pack_time_summary
echo ""
echo "=== Build complete ==="
find "$APP_DIR/dist-app" -maxdepth 1 -type f | sort
