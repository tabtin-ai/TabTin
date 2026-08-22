#!/usr/bin/env bash

_SAFE_PORT_KILL_PROTECTED_PROCESS_PATTERN='^(Cursor|Code|Electron|OrbStack|Docker|com\.dock|vpnkit)'

_safe_kill_port() {
  local port="$1"
  local signal="${2:-9}"
  local pids=""

  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -i :"${port}" 2>/dev/null \
      | awk -v protected="${_SAFE_PORT_KILL_PROTECTED_PROCESS_PATTERN}" \
          'NR>1 && $1 !~ protected {print $2}' \
      | sort -un)"
  fi

  if [[ -n "${pids}" ]]; then
    echo "${pids}" | xargs kill -"${signal}" 2>/dev/null || true
  fi
}
