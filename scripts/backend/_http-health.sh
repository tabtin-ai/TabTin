#!/usr/bin/env bash
# HTTP 健康探测（带超时 + 重试），供 start-all / restart-all 收尾自检。
# 冷启动 Daphne/Collab 常需数秒才 listen；单次 curl 易假失败。

# Usage: _wait_http_health <url> <grep_needle> [attempts=20] [sleep_s=0.5]
# Returns 0 if body matches needle within attempts.
_wait_http_health() {
  local url="${1:?url required}"
  local needle="${2:?needle required}"
  local attempts="${3:-20}"
  local sleep_s="${4:-0.5}"
  local i body

  for ((i = 1; i <= attempts; i++)); do
    body="$(curl -sf --connect-timeout 2 --max-time 3 "${url}" 2>/dev/null || true)"
    if [[ -n "${body}" ]] && grep -q "${needle}" <<<"${body}"; then
      return 0
    fi
    sleep "${sleep_s}"
  done
  return 1
}
