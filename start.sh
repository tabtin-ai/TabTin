#!/usr/bin/env bash
set -euo pipefail

repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
compose_file="${repo_root}/compose.yaml"
export COMPOSE_DISABLE_ENV_FILE=1

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail \
  "Docker is not installed. Install Docker Desktop and try again."
docker --version >/dev/null 2>&1 || fail \
  "Docker is not available. Install Docker Desktop and try again."
docker compose version >/dev/null 2>&1 || fail \
  "Docker Compose is not available. Update Docker Desktop and try again."
docker info >/dev/null 2>&1 || fail \
  "Docker Engine is not running. Start Docker Desktop and try again."
command -v curl >/dev/null 2>&1 || fail \
  "curl is required to check TabTin Server readiness."

printf 'Starting TabTin Community...\n'
docker compose \
  --project-directory "${repo_root}" \
  -f "${compose_file}" \
  up -d --build

timeout_seconds="${TABTIN_COMMUNITY_START_TIMEOUT_SECONDS:-600}"
poll_seconds="${TABTIN_COMMUNITY_START_POLL_SECONDS:-5}"
if ! [[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  fail "TABTIN_COMMUNITY_START_TIMEOUT_SECONDS must be a positive integer."
fi
if ! [[ "${poll_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  fail "TABTIN_COMMUNITY_START_POLL_SECONDS must be a positive integer."
fi

printf 'Waiting for TabTin Server readiness'
deadline=$((SECONDS + timeout_seconds))
until curl -fsS --max-time 3 \
  http://127.0.0.1:6060/health/ready >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then
    printf '\n'
    docker compose \
      --project-directory "${repo_root}" \
      -f "${compose_file}" \
      ps
    fail "TabTin Server did not become ready within ${timeout_seconds} seconds. Run ./status.sh or ./community logs for details."
  fi
  printf '.'
  sleep "${poll_seconds}"
done
printf '\n\n'

bash "${repo_root}/scripts/electron/runtime/_ensure-desktop-runtimes.sh" || true

cat <<'EOF'
========================================
TabTin Community is READY
========================================

1. Start TabTin Desktop Client

2. Register / Login

3. Configure your model:
   Settings
   -> Model Configuration
   -> BYOK

4. Start chatting

Backend:
http://127.0.0.1:6060

========================================
EOF
