#!/usr/bin/env bash
set -u

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
compose_file="${repo_root}/compose.yaml"
export COMPOSE_DISABLE_ENV_FILE=1

print_unavailable() {
  printf '%s\n' \
    'Docker: NOT RUNNING' \
    'TabTin Server: NOT READY' \
    'Backend: http://127.0.0.1:6060' \
    'Realtime: NOT READY'
}

if ! command -v docker >/dev/null 2>&1 || \
   ! docker compose version >/dev/null 2>&1 || \
   ! docker info >/dev/null 2>&1; then
  print_unavailable
  exit 0
fi

printf 'Docker: RUNNING\n'

if command -v curl >/dev/null 2>&1 && \
   curl -fsS --max-time 3 \
     http://127.0.0.1:6060/health/ready >/dev/null 2>&1; then
  printf 'TabTin Server: READY\n'
elif docker compose \
     --project-directory "${repo_root}" \
     -f "${compose_file}" \
     ps --status running --services 2>/dev/null | grep -qx 'django'; then
  printf 'TabTin Server: STARTING\n'
else
  printf 'TabTin Server: NOT READY\n'
fi

printf 'Backend: http://127.0.0.1:6060\n'

if command -v curl >/dev/null 2>&1 && \
   curl -fsS --max-time 3 \
     http://127.0.0.1:8100/health >/dev/null 2>&1; then
  printf 'Realtime: READY\n'
else
  printf 'Realtime: NOT READY\n'
fi
