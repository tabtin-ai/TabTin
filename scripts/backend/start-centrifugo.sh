#!/bin/bash
# 启动 Centrifugo 开发服务器（TabChat 实时传输层）
# 标准本地开发端口为 8100；需要临时改端口时显式设置 CENTRIFUGO_PORT。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_load-scheme.sh"

CENTRIFUGO_VERSION="${CENTRIFUGO_VERSION:-6.6.2}"
CENTRIFUGO_REGION="${TABTIN_DEV_REGION:-global}"
CONFIG_FILE="$SCRIPT_DIR/centrifugo-dev.json"
PORT="${CENTRIFUGO_PORT}"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"
PID_FILE="${LOG_DIR}/centrifugo.pid"
LOG_FILE="${LOG_DIR}/centrifugo.log"

mkdir -p "${LOG_DIR}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --region)
            CENTRIFUGO_REGION="${2:-}"
            shift 2
            ;;
        --region=*)
            CENTRIFUGO_REGION="${1#*=}"
            shift
            ;;
        *)
            echo "Unsupported argument: $1" >&2
            exit 2
            ;;
    esac
done
if [[ "${CENTRIFUGO_REGION}" != "global" && "${CENTRIFUGO_REGION}" != "cn" ]]; then
    echo "Unsupported region \"${CENTRIFUGO_REGION}\"; expected global or cn." >&2
    exit 2
fi

_centrifugo_is_windows() {
    case "$(uname -s 2>/dev/null)" in
        MINGW*|MSYS*|CYGWIN*|Windows_NT) return 0 ;;
    esac
    case "${OS:-}" in
        Windows_NT) return 0 ;;
    esac
    return 1
}

# Windows 包解出 centrifugo.exe；Unix 为无后缀 centrifugo。
if _centrifugo_is_windows; then
    CENTRIFUGO_BIN="$SCRIPT_DIR/bin/centrifugo.exe"
else
    CENTRIFUGO_BIN="$SCRIPT_DIR/bin/centrifugo"
fi

# 按当前平台解析 Centrifugo release asset（os/arch/后缀）。
# 返回：全局变量 CENTRIFUGO_ASSET / CENTRIFUGO_ASSET_EXT
_centrifugo_resolve_asset() {
    local uname_s uname_m os arch ext
    uname_s="$(uname -s)"
    uname_m="$(uname -m)"

    case "${uname_s}" in
        Darwin) os="darwin"; ext="tar.gz" ;;
        Linux)  os="linux";  ext="tar.gz" ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT) os="windows"; ext="zip" ;;
        *) echo "❌ 不支持的操作系统: ${uname_s}"; return 1 ;;
    esac

    case "${uname_m}" in
        x86_64|amd64)        arch="amd64" ;;
        arm64|aarch64)       arch="arm64" ;;
        *) echo "❌ 不支持的 CPU 架构: ${uname_m}"; return 1 ;;
    esac

    CENTRIFUGO_ASSET="centrifugo_${CENTRIFUGO_VERSION}_${os}_${arch}.${ext}"
    CENTRIFUGO_ASSET_EXT="${ext}"
}

# 用文件头判断 binary 是否属于当前平台（避免已有错误 ELF/PE 时永不重下）。
_centrifugo_bin_platform_ok() {
    local bin="$1"
    local magic
    [ -f "${bin}" ] || return 1

    magic="$(od -An -tx1 -N4 "${bin}" 2>/dev/null | tr -d '[:space:]')"
    if _centrifugo_is_windows; then
        # PE: MZ
        [[ "${magic}" == 4d5a* ]]
        return $?
    fi

    case "$(uname -s 2>/dev/null)" in
        Darwin)
            # Mach-O / fat：fe ed fa ce / cf fa ed fe / ca fe ba be 等
            [[ "${magic}" == feedface || "${magic}" == feedfacf \
                || "${magic}" == cefaedfe || "${magic}" == cffaedfe \
                || "${magic}" == cafebabe ]]
            return $?
            ;;
        *)
            # ELF: 7f 45 4c 46
            [[ "${magic}" == 7f454c46 ]]
            return $?
            ;;
    esac
}

# 平台头正确且能跑 version 子命令，才视为可用。
_centrifugo_bin_usable() {
    local bin="$1"
    _centrifugo_bin_platform_ok "${bin}" || return 1
    "${bin}" version >/dev/null 2>&1
}

# 下载并解压 Centrifugo 到 scripts/bin。失败返回非 0。
_centrifugo_download() {
    _centrifugo_resolve_asset || return 1

    local bin_dir="$SCRIPT_DIR/bin"
    local archive="${bin_dir}/${CENTRIFUGO_ASSET}"
    local github_url="https://github.com/centrifugal/centrifugo/releases/download/v${CENTRIFUGO_VERSION}/${CENTRIFUGO_ASSET}"
    local mirror_base="${CENTRIFUGO_CN_MIRROR_BASE_URL:-https://gh-proxy.com/https://github.com}"
    local mirror_url="${mirror_base%/}/centrifugal/centrifugo/releases/download/v${CENTRIFUGO_VERSION}/${CENTRIFUGO_ASSET}"
    local url="${github_url}"
    if [[ "${CENTRIFUGO_REGION}" == "cn" ]]; then
        url="${mirror_url}"
        echo "Centrifugo region=cn: trying China mirror before GitHub fallback"
    fi

    mkdir -p "${bin_dir}"
    echo "⬇️  正在下载 Centrifugo v${CENTRIFUGO_VERSION} (${CENTRIFUGO_ASSET})..."
    local connect_timeout="${CENTRIFUGO_DOWNLOAD_CONNECT_TIMEOUT_SECONDS:-10}"
    local max_time="${CENTRIFUGO_DOWNLOAD_MAX_SECONDS:-120}"
    if ! curl -fSL \
        --connect-timeout "${connect_timeout}" \
        --max-time "${max_time}" \
        --retry 2 \
        --retry-max-time "${max_time}" \
        --retry-all-errors \
        -o "${archive}" "${url}"; then
        echo "❌ 下载失败: ${url}"
        rm -f "${archive}"
        return 1
    fi

    echo "📦 解压中..."
    if [ "${CENTRIFUGO_ASSET_EXT}" = "zip" ]; then
        if command -v unzip >/dev/null 2>&1; then
            unzip -o "${archive}" -d "${bin_dir}" >/dev/null || return 1
        elif command -v tar.exe >/dev/null 2>&1; then
            tar.exe -xf "${archive}" -C "${bin_dir}" || return 1
        elif command -v tar >/dev/null 2>&1; then
            tar -xf "${archive}" -C "${bin_dir}" || return 1
        elif command -v powershell.exe >/dev/null 2>&1; then
            powershell.exe -NoProfile -Command \
                "Expand-Archive -Path '$(cygpath -w "${archive}" 2>/dev/null || echo "${archive}")' -DestinationPath '$(cygpath -w "${bin_dir}" 2>/dev/null || echo "${bin_dir}")' -Force" || return 1
        else
            echo "❌ 缺少解压工具（unzip / tar / powershell）"
            return 1
        fi
    else
        tar -xzf "${archive}" -C "${bin_dir}" || return 1
        chmod +x "${bin_dir}/centrifugo" 2>/dev/null || true
    fi

    rm -f "${archive}"

    if [ ! -f "${CENTRIFUGO_BIN}" ]; then
        echo "❌ 解压后未找到目标 binary: ${CENTRIFUGO_BIN}"
        return 1
    fi
    return 0
}

_centrifugo_install_from_legacy_path() {
    local suffix=""
    _centrifugo_is_windows && suffix=".exe"
    local legacy_bin="${ROOT_DIR}/scripts/bin/centrifugo${suffix}"

    _centrifugo_bin_usable "${legacy_bin}" || return 1
    mkdir -p "$(dirname "${CENTRIFUGO_BIN}")"
    cp "${legacy_bin}" "${CENTRIFUGO_BIN}"
    chmod +x "${CENTRIFUGO_BIN}" 2>/dev/null || true
    echo "✅ 已复用脚本分层前的 Centrifugo binary: ${legacy_bin}"
}

_centrifugo_install_from_cache() {
    _centrifugo_resolve_asset || return 1

    local cache_root="${TABTIN_DEV_CACHE_ROOT:-/Volumes/Share/TabTin/dev-cache}"
    local archive="${cache_root}/centrifugo/${CENTRIFUGO_ASSET}"
    local bin_dir="$SCRIPT_DIR/bin"

    [[ -f "${archive}" ]] || return 1
    mkdir -p "${bin_dir}"
    echo "📦 从本地开发缓存安装 Centrifugo: ${archive}"
    if [ "${CENTRIFUGO_ASSET_EXT}" = "zip" ]; then
        if command -v unzip >/dev/null 2>&1; then
            unzip -o "${archive}" -d "${bin_dir}" >/dev/null || return 1
        elif command -v tar.exe >/dev/null 2>&1; then
            tar.exe -xf "${archive}" -C "${bin_dir}" || return 1
        else
            tar -xf "${archive}" -C "${bin_dir}" || return 1
        fi
    else
        tar -xzf "${archive}" -C "${bin_dir}" || return 1
        chmod +x "${bin_dir}/centrifugo" 2>/dev/null || true
    fi

    if [ ! -f "${CENTRIFUGO_BIN}" ]; then
        echo "❌ 缓存解压后未找到目标 binary: ${CENTRIFUGO_BIN}"
        return 1
    fi
    return 0
}

_centrifugo_ensure_bin() {
    if [ -f "${CENTRIFUGO_BIN}" ] && _centrifugo_bin_usable "${CENTRIFUGO_BIN}"; then
        return 0
    fi

    if [ -f "${CENTRIFUGO_BIN}" ]; then
        echo "⚠️  Centrifugo binary 与当前平台不匹配或无法执行，将重新下载: ${CENTRIFUGO_BIN}"
        rm -f "${CENTRIFUGO_BIN}"
    else
        echo "ℹ️  未找到 Centrifugo binary: ${CENTRIFUGO_BIN}"
    fi

    # Windows 上常残留 Linux ELF（无后缀 centrifugo），一并清掉以免误导排查。
    if _centrifugo_is_windows && [ -f "${SCRIPT_DIR}/bin/centrifugo" ]; then
        if ! _centrifugo_bin_platform_ok "${SCRIPT_DIR}/bin/centrifugo"; then
            echo "ℹ️  移除错误平台的残留 binary: ${SCRIPT_DIR}/bin/centrifugo"
            rm -f "${SCRIPT_DIR}/bin/centrifugo"
        fi
    fi

    if _centrifugo_install_from_legacy_path && _centrifugo_bin_usable "${CENTRIFUGO_BIN}"; then
        return 0
    fi

    if _centrifugo_install_from_cache && _centrifugo_bin_usable "${CENTRIFUGO_BIN}"; then
        echo "✅ Centrifugo 已从缓存就绪: ${CENTRIFUGO_BIN}"
        return 0
    fi

    # 缓存缺失、解出坏文件、或 version 探测失败 → 清掉再走 GitHub 下载
    if [ -f "${CENTRIFUGO_BIN}" ] && ! _centrifugo_bin_usable "${CENTRIFUGO_BIN}"; then
        echo "⚠️  缓存 binary 不可用，改从 GitHub 下载: ${CENTRIFUGO_BIN}"
        rm -f "${CENTRIFUGO_BIN}"
    fi

    if _centrifugo_download && _centrifugo_bin_usable "${CENTRIFUGO_BIN}"; then
        echo "✅ Centrifugo 已就绪: ${CENTRIFUGO_BIN}"
        return 0
    fi

    if [[ "${CENTRIFUGO_REGION}" == "cn" ]]; then
        echo "China mirror failed; falling back to GitHub"
        CENTRIFUGO_REGION="global"
        if _centrifugo_download && _centrifugo_bin_usable "${CENTRIFUGO_BIN}"; then
            return 0
        fi
    fi

    echo ""
    echo "❌ 自动下载失败，请手动下载对应平台的 v${CENTRIFUGO_VERSION} 二进制到 $SCRIPT_DIR/bin/"
    echo "   Releases: https://github.com/centrifugal/centrifugo/releases/tag/v${CENTRIFUGO_VERSION}"
    return 1
}

if ! _centrifugo_ensure_bin; then
    exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config file not found at $CONFIG_FILE"
    exit 1
fi

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_centrifugo-helpers.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_detach-spawn.sh"

# 通过 PID 文件 / 端口上的 dev binary 判断是否已在运行（排除 Cursor 端口转发误判）
if _centrifugo_verify_started "${PID_FILE}"; then
    echo "⚠️  Centrifugo 已在运行 (PID: $(cat "${PID_FILE}"), 端口: ${PORT})"
    exit 0
fi
rm -f "${PID_FILE}"

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_redis-ready.sh"
source "${SCRIPT_DIR}/_dev-env-file.sh"
_redis_load_endpoint "$(_dev_env_file "${ROOT_DIR}")"
if ! _host_redis_pong "${REDIS_HOST:-127.0.0.1}" "${REDIS_PORT:-6379}"; then
    echo "❌ 宿主机 Redis (${REDIS_HOST:-127.0.0.1}:${REDIS_PORT:-6379}) 不可达，Centrifugo 无法启动"
    echo "   请先：docker compose -f docker-compose.dev.yml up -d redis"
    exit 1
fi

if [[ -n "$(_centrifugo_port_pids "${PORT}")" ]]; then
    echo "❌ 端口 ${PORT} 已被占用（常部署栈 tabtin-full/tabtin-deploy，或上次重启遗留的 centrifugo）"
    echo "   释放：停止占用该端口的本地进程后重试"
    echo "   或：  docker rm -f \$(docker ps -aq --filter name=tabtin-full) \$(docker ps -aq --filter name=tabtin-deploy)"
    exit 1
fi

# 按 .env / .env.local 的 DJANGO_BIND_PORT 改写 proxy endpoint（模板默认 6060），
# 并将模板中的开发密钥替换为 Django 实际读取的 Centrifugo 密钥。
# 否则本地生成的 `.env` 密钥与模板固定密钥不一致，代理请求会被 Django 以 403 拒绝。
# Vite 非标端口（5185/5195）依赖 centrifugo-dev.json 的 allowed_origins。
RUNTIME_CONFIG_FILE="${LOG_DIR}/centrifugo.runtime.json"
DJANGO_PORT="${DJANGO_BIND_PORT:-6060}"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/_dev-env-file.sh"
for _envf in $(_dev_env_files "${ROOT_DIR}"); do
    # shellcheck disable=SC1090
    set -a; source "${_envf}" 2>/dev/null || true; set +a
done
DJANGO_PORT="${DJANGO_BIND_PORT:-${DJANGO_PORT}}"
if command -v node >/dev/null 2>&1; then
    CONFIG_FILE_SRC="${CONFIG_FILE}" DJANGO_PORT="${DJANGO_PORT}" RUNTIME_CONFIG_FILE="${RUNTIME_CONFIG_FILE}" \
    node <<'EOF'
const fs = require('fs');
const src = process.env.CONFIG_FILE_SRC;
const port = process.env.DJANGO_PORT || '6060';
const outPath = process.env.RUNTIME_CONFIG_FILE;
const secretReplacements = new Map([
  ['tabtin-centrifugo-token-dev-secret', process.env.CENTRIFUGO_TOKEN_SECRET],
  ['tabtin-centrifugo-proxy-dev-secret', process.env.CENTRIFUGO_PROXY_SECRET],
  ['tabtin-centrifugo-dev-api-key', process.env.CENTRIFUGO_API_KEY],
].filter(([, value]) => typeof value === 'string' && value.length > 0));
const walk = (o) => {
  if (typeof o === 'string') {
    let value = o.replace(/127\.0\.0\.1:6060/g, `127.0.0.1:${port}`)
      .replace(/localhost:6060/g, `localhost:${port}`);
    for (const [templateValue, runtimeValue] of secretReplacements) {
      if (value === templateValue) value = runtimeValue;
    }
    return value;
  }
  if (Array.isArray(o)) return o.map(walk);
  if (o && typeof o === 'object') {
    const n = {};
    for (const [k, v] of Object.entries(o)) n[k] = walk(v);
    return n;
  }
  return o;
};
const cfg = walk(JSON.parse(fs.readFileSync(src, 'utf8')));
fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2));
EOF
    CONFIG_FILE="${RUNTIME_CONFIG_FILE}"
fi

echo "🚀 Starting Centrifugo on port $PORT..."
echo "   Admin UI: http://localhost:$PORT"
echo "   WebSocket: ws://localhost:$PORT/connection/websocket"
echo "   Config: $CONFIG_FILE (Django proxy → ${DJANGO_PORT})"
echo "   Binary: $CENTRIFUGO_BIN"
echo "   Log: $LOG_FILE"
echo ""

# 同 django-start：新 session 拉起后脚本立即返回（不再前台 wait）。
_detach_spawn "${PID_FILE}" "${LOG_FILE}" "" -- \
    "${CENTRIFUGO_BIN}" \
    -c "${CONFIG_FILE}" \
    -p "${PORT}" \
    --log.level info

sleep 1
if ! _centrifugo_verify_started "${PID_FILE}"; then
    echo "❌ Centrifugo 启动失败，详见: ${LOG_FILE}" >&2
    tail -20 "${LOG_FILE}" 2>/dev/null || true
    exit 1
fi

echo "✅ Centrifugo started (pid $(cat "${PID_FILE}"), port ${PORT})"
