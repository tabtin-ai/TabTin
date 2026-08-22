#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

bash "${ROOT_DIR}/scripts/electron/runtime/_ensure-desktop-runtimes.sh" || true
bash "${ROOT_DIR}/scripts/electron/stop.sh"
bash "${ROOT_DIR}/scripts/electron/start.sh"
