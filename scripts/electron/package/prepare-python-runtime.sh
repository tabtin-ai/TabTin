#!/usr/bin/env bash
# prepare-python-runtime-for-electron-packaging.sh —— Electron 打包前的 Python 运行时准备（构建 + manifest + deploy-src）。
#
# 用法：
#   bash scripts/electron/package/prepare-python-runtime.sh \
#     --platform darwin-arm64 --profile production --deploy-dir /path/to/tabtin-python-runtime-src
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PLATFORM=""
PROFILE="production"
DEPLOY_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --platform)
      PLATFORM="${2:-}"
      shift 2
      ;;
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --deploy-dir)
      DEPLOY_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$PLATFORM" ] || [ -z "$DEPLOY_DIR" ]; then
  echo "用法: $0 --platform <darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-x64|linux-arm64> --profile <local|preprod|production> --deploy-dir <dir>" >&2
  exit 2
fi

PY_RUNTIME_MANIFEST="$REPO_ROOT/packages/python-runtime/runtime/manifest.json"
REQUIRED=0
if [ "$PROFILE" = "preprod" ] || [ "$PROFILE" = "production" ]; then
  REQUIRED=1
fi

python_runtime_manifest_has_platform() {
  local manifest_path="$1"
  local platform="$2"
  (
    cd "$REPO_ROOT/scripts/electron/package"
    PYTHON_RUNTIME_MANIFEST_PATH="$manifest_path" PYTHON_RUNTIME_PLATFORM="$platform" \
      node --input-type=module -e "
        import fs from 'node:fs'
        import { isValidManifestPlatform } from './gen-python-runtime-manifest.mjs'
        const manifest = JSON.parse(fs.readFileSync(process.env.PYTHON_RUNTIME_MANIFEST_PATH, 'utf8'))
        process.exit(isValidManifestPlatform(manifest, process.env.PYTHON_RUNTIME_PLATFORM) ? 0 : 1)
      "
  )
}

if [ "${TABTIN_SKIP_PYTHON_RUNTIME_BUILD:-0}" != "1" ]; then
  TABTIN_PYTHON_RUNTIME_REQUIRED="$REQUIRED" \
    bash "$REPO_ROOT/scripts/electron/package/build-python-runtime-for-target.sh" "$PLATFORM" \
    || {
      if [ "$REQUIRED" -eq 1 ]; then
        exit 1
      fi
    }
fi

echo "  · 生成 Python 运行时 combined manifest（仅本地随包归档）..."
if ! bash "$REPO_ROOT/scripts/electron/package/gen-python-runtime-manifest.sh" \
  --required-platform "$PLATFORM"; then
  if [ "$REQUIRED" -eq 1 ]; then
    echo "❌ 生成 Python 运行时 manifest 失败：preprod/production 包必须内置有效归档。" >&2
    exit 1
  fi
  echo "  ⚠ 生成 manifest 失败（缺少本地归档）" >&2
fi

rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"
PY_RUNTIME_DIR="$REPO_ROOT/packages/python-runtime/runtime"
if [ -f "$PY_RUNTIME_MANIFEST" ]; then
  if [ "$REQUIRED" -eq 1 ] && ! python_runtime_manifest_has_platform "$PY_RUNTIME_MANIFEST" "$PLATFORM"; then
    echo "❌ Python 运行时 manifest 缺少目标平台条目: ${PLATFORM}" >&2
    echo "   请在对应 OS runner 现场构建该平台归档。" >&2
    exit 1
  fi
  echo "  · 内置 Python 运行时 manifest: ${PY_RUNTIME_MANIFEST}（含 ${PLATFORM}）"
  cp "$PY_RUNTIME_MANIFEST" "$DEPLOY_DIR/"
  ARCHIVE_NAME="$(
    node - "$PY_RUNTIME_MANIFEST" "$PLATFORM" <<'NODE'
const fs = require('node:fs')
const [manifestPath, platform] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const name = manifest?.platforms?.[platform]?.archiveName
if (typeof name === 'string' && name) process.stdout.write(name)
NODE
  )"
  if [ -n "$ARCHIVE_NAME" ] && [ -f "$PY_RUNTIME_DIR/$ARCHIVE_NAME" ]; then
    cp "$PY_RUNTIME_DIR/$ARCHIVE_NAME" "$DEPLOY_DIR/"
    echo "  · 内置 Python 运行时归档: $PY_RUNTIME_DIR/$ARCHIVE_NAME"
  elif [ "$REQUIRED" -eq 1 ]; then
    echo "❌ 缺少 Python 运行时归档：preprod/production 包必须随包分发 ${ARCHIVE_NAME:-<unknown>}。" >&2
    echo "   先在目标 OS 执行 scripts/electron/package/build-python-runtime-for-target.sh ${PLATFORM}，再重新打包。" >&2
    exit 1
  fi
elif [ "$REQUIRED" -eq 1 ]; then
  echo "❌ 缺少 Python 运行时 manifest：preprod/production 包必须内置随包归档。" >&2
  echo "   仓库不提交数百 MB 二进制。先执行 scripts/electron/package/build-python-runtime-for-target.sh ${PLATFORM}。" >&2
  exit 1
else
  echo "  ⚠ local 包缺 Python 运行时 manifest：跳过（无内建 python，agent 回落系统 python）。" >&2
fi
