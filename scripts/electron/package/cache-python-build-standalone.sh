#!/usr/bin/env bash
# Persist and validate python-build-standalone archives across package runs.
set -euo pipefail

PBS_URL="${1:?python-build-standalone URL is required}"
PBS_ASSET="${2:?python-build-standalone asset name is required}"

default_cache_dir() {
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '%s\n' "${HOME}/Library/Caches/TabTin/python-build-standalone"
    return
  fi
  printf '%s\n' "${XDG_CACHE_HOME:-${HOME}/.cache}/tabtin/python-build-standalone"
}

CACHE_DIR="${TABTIN_PBS_CACHE_DIR:-$(default_cache_dir)}"
CACHE_PATH="$CACHE_DIR/$PBS_ASSET"
PARTIAL_PATH="${CACHE_PATH}.part"
mkdir -p "$CACHE_DIR"

archive_is_valid() {
  [ -s "$1" ] && tar -tzf "$1" >/dev/null 2>&1
}

if archive_is_valid "$CACHE_PATH"; then
  echo "→ 复用 python-build-standalone 本地缓存: $CACHE_PATH" >&2
  printf '%s\n' "$CACHE_PATH"
  exit 0
fi

if [ -e "$CACHE_PATH" ]; then
  echo "⚠ python-build-standalone 缓存损坏，重新下载: $CACHE_PATH" >&2
  rm -f "$CACHE_PATH"
fi

download_with_resume_retries() {
  local attempt=1
  while [ "$attempt" -le 4 ]; do
    if [ -s "$PARTIAL_PATH" ]; then
      echo "→ 续传 python-build-standalone（第 ${attempt}/4 次）: $PARTIAL_PATH" >&2
      if curl -fL -C - "$PBS_URL" -o "$PARTIAL_PATH"; then
        return 0
      fi
    else
      echo "→ 下载 python-build-standalone（第 ${attempt}/4 次）: $CACHE_PATH" >&2
      if curl -fL "$PBS_URL" -o "$PARTIAL_PATH"; then
        return 0
      fi
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -le 4 ] && sleep 2
  done
  return 1
}

if [ -s "$PARTIAL_PATH" ]; then
  echo "→ 发现未完成的 python-build-standalone 下载: $PARTIAL_PATH" >&2
fi
download_with_resume_retries

if ! archive_is_valid "$PARTIAL_PATH"; then
  rm -f "$PARTIAL_PATH"
  echo "❌ python-build-standalone 下载文件不是有效的 tar.gz: $PBS_URL" >&2
  exit 1
fi

mv -f "$PARTIAL_PATH" "$CACHE_PATH"
echo "✓ python-build-standalone 已缓存: $CACHE_PATH" >&2
printf '%s\n' "$CACHE_PATH"
