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
  "Docker is not installed."
docker compose version >/dev/null 2>&1 || fail \
  "Docker Compose is not available."
docker info >/dev/null 2>&1 || fail \
  "Docker Engine is not running. Start Docker Desktop and try again."

docker compose \
  --project-directory "${repo_root}" \
  -f "${compose_file}" \
  down

printf 'TabTin Community stopped. Your data and Docker volumes were preserved.\n'
