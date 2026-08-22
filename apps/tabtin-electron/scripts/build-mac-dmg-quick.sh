#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
DEPLOY_DIR="$APP_DIR/.deploy-quick"

PROFILE="${TABTIN_BUILD_PROFILE:-local}"
if [ "$PROFILE" != "local" ]; then
  echo "Unsupported profile for mac quick: $PROFILE (仅允许 local)" >&2
  exit 1
fi
HOST_ARCH_RAW="$(uname -m)"
case "$HOST_ARCH_RAW" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|amd64)  HOST_ARCH="x64" ;;
  *)             HOST_ARCH="x64" ;;
esac
ARCH="${1:-${TABTIN_BUILD_ARCH:-$HOST_ARCH}}"

case "$ARCH" in
  arm64) ARCH_FLAG="--arm64" ;;
  x64)   ARCH_FLAG="--x64" ;;
  *)
    echo "Unsupported arch: $ARCH (允许 arm64 / x64)" >&2
    exit 1
    ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Quick DMG build must run on macOS." >&2
  exit 1
fi

if [ "$ARCH" != "$HOST_ARCH" ]; then
  echo "Quick DMG 只支持当前宿主架构 (${HOST_ARCH})，不做 cross-arch native prebuild 补齐。" >&2
  echo "如需 ${ARCH} 包，请使用完整链路：pnpm build:mac:local:${ARCH}" >&2
  exit 1
fi

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

pack_time_begin "Quick DMG (profile=${PROFILE}, arch=${ARCH})"

echo "=== TabTin Quick DMG Build (profile=${PROFILE}, arch=${ARCH}) ==="
echo "  · 跳过 typecheck / sourcemap upload / zip / notarize"
echo "  · 复用 deploy 目录: $DEPLOY_DIR"

export TABTIN_BUILD_PROFILE="$PROFILE"
export TABTIN_BUILD_TARGET="darwin"
export TABTIN_BUILD_ARCH="$ARCH"
export NODE_ENV="production"
export TABTIN_UPDATE_CHANNEL="${TABTIN_UPDATE_CHANNEL:-stable}"
EXPECTED_GIT_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"

PROFILE_VERSION="${VITE_APP_VERSION:-}"
if [ -z "$PROFILE_VERSION" ]; then
  PROFILE_VERSION="$(node -p "require('$APP_DIR/package.json').version")"
fi
export VITE_APP_VERSION="$PROFILE_VERSION"
echo "  · app 版本号: $PROFILE_VERSION"

PROFILE_PRODUCT_NAME=""
PROFILE_APP_ID=""
PROFILE_PRODUCT_NAME="TabTin Local"
PROFILE_APP_ID="com.tabtin.app.local"
echo "  · app identity: productName=${PROFILE_PRODUCT_NAME}, appId=${PROFILE_APP_ID}"

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

UPDATE_PUBLISH_URL="${TABTIN_UPDATE_PUBLISH_URL:-http://127.0.0.1:6060/desktop-updates}"
echo "  · updater publish url: $UPDATE_PUBLISH_URL"

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

remove_pnpm_package_from_tree() {
  local root="$1"
  local package_scope="$2"
  local package_name="$3"
  local encoded_scope="${package_scope#@}"
  local encoded_name="${encoded_scope}+${package_name}@*"
  local scoped_encoded_name="${package_scope}+${package_name}@*"

  [ -d "$root" ] || return 0
  rm -rf "$root/$package_scope/$package_name" 2>/dev/null || true
  find "$root/.pnpm" -maxdepth 1 -type d \( -name "$encoded_name" -o -name "$scoped_encoded_name" \) -prune -exec rm -rf {} + 2>/dev/null || true
  find "$root" -path "*/node_modules/$package_scope/$package_name" -type d -prune -exec rm -rf {} + 2>/dev/null || true
}

prune_mac_cross_platform_native_packages() {
  local root="$1"

  remove_pnpm_package_from_tree "$root" "@nut-tree-fork" "libnut-linux"
  remove_pnpm_package_from_tree "$root" "@nut-tree-fork" "libnut-win32"
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
  if (!fs.existsSync(dir)) return
  const st = fs.statSync(dir)
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(dir)) {
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
  if (rg.stdout.trim()) {
    return rg.stdout.split('\n').filter(Boolean)
  }
  if (rg.status === 1) {
    return []
  }
  const files = []
  walk(root, (file) => {
    const before = fs.readFileSync(file, 'utf8')
    if (before.includes('sourceMappingURL=')) files.push(file)
  })
  return files
}

let changed = 0
for (const root of roots) {
  for (const file of findFilesWithSourcemapReferences(root)) {
    const before = fs.readFileSync(file, 'utf8')
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

echo "[0/4] Building workspace dependencies..."
pack_time_step_begin "[0/4] workspace 依赖"
cd "$APP_DIR"
pnpm run build:workspace
pack_time_step_end "[0/4] workspace 依赖"

echo "[1/4] Building electron-vite output..."
pack_time_step_begin "[1/4] electron-vite"
rm -rf "$APP_DIR/out"
node "$SCRIPT_DIR/run-electron-vite.mjs" build
find "$APP_DIR/out" -name "*.map" -type f -delete 2>/dev/null || true
pack_time_step_end "[1/4] electron-vite"

if [ "${TABTIN_QUICK_REUSE_DEPLOY:-0}" != "1" ] || [ "${TABTIN_QUICK_REDEPLOY:-0}" = "1" ] || [ ! -d "$DEPLOY_DIR/node_modules" ]; then
  echo "[2/4] Creating quick deploy directory..."
  pack_time_step_begin "[2/4] deploy 目录"
  rm -rf "$DEPLOY_DIR"
  cd "$REPO_ROOT"
  pnpm --filter ./apps/tabtin-electron deploy "$DEPLOY_DIR" --prod
  pack_time_step_end "[2/4] deploy 目录"
else
  echo "[2/4] Reusing quick deploy directory (TABTIN_QUICK_REUSE_DEPLOY=1)..."
fi

echo "[3/4] Refreshing app bundle inputs..."
pack_time_step_begin "[3/4] bundle 输入"
rm -rf "$DEPLOY_DIR/out" "$DEPLOY_DIR/static" "$DEPLOY_DIR/build" "$DEPLOY_DIR/scripts"
cp -R "$APP_DIR/out" "$DEPLOY_DIR/out"
[ -d "$APP_DIR/static" ] && cp -R "$APP_DIR/static" "$DEPLOY_DIR/static"
[ -d "$APP_DIR/build" ] && cp -R "$APP_DIR/build" "$DEPLOY_DIR/build"
mkdir -p "$DEPLOY_DIR/scripts"
cp "$APP_DIR/scripts/flip-electron-fuses.cjs" "$DEPLOY_DIR/scripts/flip-electron-fuses.cjs"
cp "$APP_DIR/scripts/audit-packaged-artifact.mjs" "$DEPLOY_DIR/scripts/audit-packaged-artifact.mjs"
cp "$APP_DIR/scripts/patch-deploy-node-modules.mjs" "$DEPLOY_DIR/scripts/patch-deploy-node-modules.mjs"
cp "$APP_DIR/scripts/prepare-deploy-package.mjs" "$DEPLOY_DIR/scripts/prepare-deploy-package.mjs"
cp "$APP_DIR/package.json" "$DEPLOY_DIR/package.json"

# tabtin CLI (Go binary)：运行期被 cli-server.ts 加进 Agent shell PATH 的 `tabtin` 命令。
# 不是 npm 产物。直接从当前 checkout 构建到本次 deploy staging，禁止复用共享 dist。
CLI_GO_DIR="$REPO_ROOT/packages/tabtin-cli-go"
CLI_GO_STAGE_DIR="$DEPLOY_DIR/tabtin-cli-go-dist-src"
CLI_GO_BIN="$CLI_GO_STAGE_DIR/tabtin"
CLI_GOOS="darwin"
CLI_GOARCH="$ARCH"
case "$CLI_GOARCH" in
  x64) CLI_GOARCH="amd64" ;;
esac

go_cli_matches_target() {
  local binary="$1"
  [ -x "$binary" ] || return 1
  command -v go >/dev/null 2>&1 || return 1
  go version -m "$binary" 2>/dev/null | grep -q $'\tbuild\tGOOS='"$CLI_GOOS" || return 1
  go version -m "$binary" 2>/dev/null | grep -q $'\tbuild\tGOARCH='"$CLI_GOARCH" || return 1
}

build_go_cli_for_target() {
  echo "  · 从当前 release 构建 tabtin CLI (target=${CLI_GOOS}/${CLI_GOARCH}, revision=${EXPECTED_GIT_REVISION})"
  rm -rf "$CLI_GO_STAGE_DIR"
  mkdir -p "$CLI_GO_STAGE_DIR"
  (
    cd "$CLI_GO_DIR"
    tmp_out="${CLI_GO_BIN}.building.$$"
    GOOS="$CLI_GOOS" GOARCH="$CLI_GOARCH" go build -o "$tmp_out" .
    mv -f "$tmp_out" "$CLI_GO_BIN"
  )
}

go_cli_matches_source_revision() {
  local binary="$1"
  go version -m "$binary" 2>/dev/null | grep -Fq $'\tbuild\tvcs.revision='"$EXPECTED_GIT_REVISION"
}

if [ -d "$CLI_GO_DIR" ]; then
  if ! command -v go >/dev/null 2>&1; then
    echo "❌ 打包必须安装 go：内置 CLI 必须由当前 release 源码现场构建" >&2
    exit 1
  fi
  build_go_cli_for_target
  if ! go_cli_matches_target "$CLI_GO_BIN"; then
    echo "❌ tabtin CLI 二进制架构不匹配：期望 ${CLI_GOOS}/${CLI_GOARCH}，文件 $CLI_GO_BIN" >&2
    go version -m "$CLI_GO_BIN" 2>/dev/null || true
    exit 1
  fi
  if ! go_cli_matches_source_revision "$CLI_GO_BIN"; then
    echo "❌ tabtin CLI 不是由当前 release 提交构建：期望 $EXPECTED_GIT_REVISION" >&2
    go version -m "$CLI_GO_BIN" >&2 || true
    exit 1
  fi
  CLI_CONTRACT_OUTPUT="$CLI_GO_STAGE_DIR/commands-contract.json"
  "$CLI_GO_BIN" commands --format json --include-hidden > "$CLI_CONTRACT_OUTPUT"
  node -e '
const fs = require("node:fs")
const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const commands = payload?.data?.commands
if (!Array.isArray(commands)) throw new Error("commands contract missing data.commands")
if (!commands.some((command) => command?.hidden === true)) {
  throw new Error("commands --include-hidden returned no hidden command")
}
' "$CLI_CONTRACT_OUTPUT"
  rm -f "$CLI_CONTRACT_OUTPUT"
  echo "  · CLI 契约烟测通过：commands --format json --include-hidden"
fi

# tabtin-filegen：quick 只打本机 arch，Mach-O 对上才 stage。缺失非致命。
FILEGEN_DIR="$REPO_ROOT/packages/tabtin-filegen-python"
# shellcheck disable=SC1091
source "$FILEGEN_DIR/filegen-arch.sh"
FILEGEN_BIN_NAME="$(filegen_generic_bin_name darwin)"
FILEGEN_BIN="$FILEGEN_DIR/dist/$FILEGEN_BIN_NAME"
FILEGEN_ARCH_BIN="$FILEGEN_DIR/dist/$(filegen_arch_bin_name darwin "$ARCH")"
if [ -d "$FILEGEN_DIR" ]; then
  filegen_quick_source=""
  if filegen_matches_target "$FILEGEN_ARCH_BIN" darwin "$ARCH"; then
    filegen_quick_source="$FILEGEN_ARCH_BIN"
  elif filegen_matches_target "$FILEGEN_BIN" darwin "$ARCH"; then
    filegen_quick_source="$FILEGEN_BIN"
  fi
  if [ -z "$filegen_quick_source" ] || [ -n "$(find "$FILEGEN_DIR/src" "$FILEGEN_DIR/pyproject.toml" "$FILEGEN_DIR/build.sh" -newer "$filegen_quick_source" -print -quit 2>/dev/null)" ]; then
    if command -v python3 >/dev/null 2>&1; then
      echo "  · 构建 tabtin-filegen 二进制 (packages/tabtin-filegen-python/dist/tabtin-filegen)"
      ( cd "$FILEGEN_DIR" && bash build.sh ) || echo "  ⚠ tabtin-filegen 构建失败：包内将缺少文件生成能力（非致命）" >&2
    elif [ -z "$filegen_quick_source" ]; then
      echo "  ⚠ 未安装 python3 且无匹配 ${ARCH} 的 tabtin-filegen：包内将缺少文件生成能力（非致命）" >&2
    fi
    filegen_quick_source=""
    if filegen_matches_target "$FILEGEN_ARCH_BIN" darwin "$ARCH"; then
      filegen_quick_source="$FILEGEN_ARCH_BIN"
    elif filegen_matches_target "$FILEGEN_BIN" darwin "$ARCH"; then
      filegen_quick_source="$FILEGEN_BIN"
    fi
  fi
  rm -rf "$DEPLOY_DIR/tabtin-filegen-python-dist-src"
  mkdir -p "$DEPLOY_DIR/tabtin-filegen-python-dist-src"
  if [ -n "$filegen_quick_source" ]; then
    cp "$filegen_quick_source" "$DEPLOY_DIR/tabtin-filegen-python-dist-src/$FILEGEN_BIN_NAME"
  fi
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

node "$DEPLOY_DIR/scripts/prepare-deploy-package.mjs" \
  --package-json "$DEPLOY_DIR/package.json" \
  --update-channel "$TABTIN_UPDATE_CHANNEL" \
  --publish-url "$UPDATE_PUBLISH_URL"

PACKAGED_ELECTRON_VERSION="$(node -p "require('$APP_DIR/node_modules/electron/package.json').version" 2>/dev/null || true)"
if [ -z "$PACKAGED_ELECTRON_VERSION" ]; then
  echo "  ✗ 找不到 electron 版本，无法生成不含 devDependencies 的 deploy package" >&2
  exit 1
fi
node -e '
  const fs = require("node:fs")
  const p = process.argv[1]
  const arch = process.argv[2]
  const version = process.argv[3]
  const profile = process.argv[4]
  const electronVersion = process.argv[7]
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"))
  delete pkg.devDependencies
  delete pkg.optionalDevDependencies
  pkg.version = version
  pkg.build = pkg.build || {}
  if (electronVersion) {
    pkg.build.electronVersion = String(electronVersion).replace(/^[~^]/, "")
  }
  pkg.build.productName = process.argv[5]
  pkg.build.appId = process.argv[6]
  pkg.build.extraMetadata = {
    ...(pkg.build.extraMetadata || {}),
    version,
    tabtinDesktop: {
      ...((pkg.build.extraMetadata || {}).tabtinDesktop || {}),
      buildProfile: profile,
    },
  }
  pkg.build.mac = {
    ...(pkg.build.mac || {}),
    executableName: "tabtin-local",
    target: [{ target: "dmg", arch: [arch] }],
    gatekeeperAssess: false,
  }
  delete pkg.build.afterSign
  fs.writeFileSync(p, `${JSON.stringify(pkg, null, 2)}\n`)
' "$DEPLOY_DIR/package.json" "$ARCH" "$PROFILE_VERSION" "$PROFILE" "$PROFILE_PRODUCT_NAME" "$PROFILE_APP_ID" "$PACKAGED_ELECTRON_VERSION"

echo "  · 修补 deploy node_modules"
node "$DEPLOY_DIR/scripts/patch-deploy-node-modules.mjs" "$DEPLOY_DIR"
prune_mac_cross_platform_native_packages "$DEPLOY_DIR/node_modules"
prune_packaged_resource_tree "$DEPLOY_DIR/node_modules"
strip_public_sourcemap_references \
  "$DEPLOY_DIR/out" \
  "$DEPLOY_DIR/node_modules" \
  "$DEPLOY_DIR/tabsite-templates-src" \
  "$DEPLOY_DIR/bundled-skills-src" \
  "$DEPLOY_DIR/package-skills-tabtracker-src" \
  "$DEPLOY_DIR/packages-apps-src" \
  "$REPO_ROOT/node_modules/.pnpm/@electron+get@"*/node_modules/@electron/get \
  "$REPO_ROOT/node_modules/.pnpm/global-agent@"*/node_modules/global-agent \
  "$REPO_ROOT/node_modules/.pnpm/roarr@"*/node_modules/roarr \
  "$REPO_ROOT/node_modules/.pnpm/sprintf-js@"*/node_modules/sprintf-js
pack_time_step_end "[3/4] bundle 输入"

echo "[4/4] Building DMG..."
pack_time_step_begin "[4/4] DMG 构建"
rm -rf "$DEPLOY_DIR/dist-app"
cd "$DEPLOY_DIR"
EXPECTED_ELECTRON_BUILDER_VERSION="25.1.8"
ELECTRON_BUILDER_PACKAGE_JSON="$APP_DIR/node_modules/electron-builder/package.json"
ELECTRON_BUILDER_CLI="$APP_DIR/node_modules/electron-builder/cli.js"
if [ ! -f "$ELECTRON_BUILDER_PACKAGE_JSON" ] || [ ! -f "$ELECTRON_BUILDER_CLI" ]; then
  echo "  ✗ 找不到项目锁定的 electron-builder；请先准备项目依赖" >&2
  exit 1
fi
ACTUAL_ELECTRON_BUILDER_VERSION="$(node -p "require('$ELECTRON_BUILDER_PACKAGE_JSON').version")"
if [ "$ACTUAL_ELECTRON_BUILDER_VERSION" != "$EXPECTED_ELECTRON_BUILDER_VERSION" ]; then
  echo "  ✗ electron-builder 版本不匹配：期望 ${EXPECTED_ELECTRON_BUILDER_VERSION}，实际 ${ACTUAL_ELECTRON_BUILDER_VERSION}" >&2
  exit 1
fi
echo "  · electron-builder: ${ACTUAL_ELECTRON_BUILDER_VERSION} (${ELECTRON_BUILDER_CLI})"
INSTALLED_ELECTRON_PACKAGE_JSON="$APP_DIR/node_modules/electron/package.json"
INSTALLED_ELECTRON_DIST="$APP_DIR/node_modules/electron/dist"
if [ ! -f "$INSTALLED_ELECTRON_PACKAGE_JSON" ] || [ ! -d "$INSTALLED_ELECTRON_DIST" ]; then
  echo "  ✗ 找不到项目安装的 Electron runtime；请先准备项目依赖" >&2
  exit 1
fi
INSTALLED_ELECTRON_VERSION="$(node -p "require('$INSTALLED_ELECTRON_PACKAGE_JSON').version")"
echo "  · electron runtime: ${INSTALLED_ELECTRON_VERSION} (${INSTALLED_ELECTRON_DIST})"
# quick 只构建 local 包：禁止读取 Developer ID，构建后统一 ad-hoc 签名。
export CSC_IDENTITY_AUTO_DISCOVERY=false
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME CSC_KEYCHAIN
echo "  · local macOS signing: ad-hoc（无需证书/联网）"
node "$ELECTRON_BUILDER_CLI" --mac "$ARCH_FLAG" --publish=never \
  "--config.electronVersion=$INSTALLED_ELECTRON_VERSION" \
  "--config.electronDist=$INSTALLED_ELECTRON_DIST"

APP_GLOB="$DEPLOY_DIR/dist-app/mac-${ARCH}"/*.app
for app_bundle in $APP_GLOB; do
  [ -d "$app_bundle" ] || continue
  echo "  · ad-hoc 重签: $(basename "$app_bundle")"
  "$SCRIPT_DIR/repair-macos-framework-links.sh" "$app_bundle"
  codesign --force --deep --sign - "$app_bundle"
  codesign --verify --verbose=2 "$app_bundle"

  app_base="$(basename "$app_bundle" .app)"
  dmg_path="$DEPLOY_DIR/dist-app/${app_base}-${ARTIFACT_VERSION_LABEL}-${ARCH}.dmg"
  echo "  · 用重签后的 .app 重建带安装引导的 DMG: $(basename "$dmg_path")"
  rm -f "$dmg_path"
  bash "$SCRIPT_DIR/create-styled-dmg.sh" "$app_bundle" "$dmg_path"
  rm -f "$DEPLOY_DIR/dist-app/"*.blockmap
done

rm -f "$DEPLOY_DIR/dist-app/"*.blockmap
rm -f "$DEPLOY_DIR/dist-app/"*.yml

echo "  · packaged artifact audit"
node "$SCRIPT_DIR/audit-packaged-artifact.mjs" \
  --artifact "$DEPLOY_DIR/dist-app" \
  --profile "$PROFILE" \
  --target mac \
  --arch "$ARCH" \
  --expected-cli-revision "$EXPECTED_GIT_REVISION"

mkdir -p "$APP_DIR/dist-app-quick"
rm -f "$APP_DIR/dist-app-quick/"*.dmg
cp "$DEPLOY_DIR/dist-app/"*.dmg "$APP_DIR/dist-app-quick/"
pack_time_step_end "[4/4] DMG 构建"

echo ""
echo "=== Quick DMG complete ==="
ls -lh "$APP_DIR/dist-app-quick/"*.dmg
pack_time_summary
