#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "${ROOT_DIR}/scripts/backend/collab-live-stop.sh"
sleep 1
bash "${ROOT_DIR}/scripts/backend/collab-live-start.sh"
