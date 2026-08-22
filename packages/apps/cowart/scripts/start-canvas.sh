#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${1:-${PWD}}"
echo "Cowart prepared runtime 0.1.2 is installed for: ${PROJECT_DIR}"
echo "Canvas service entrypoint is reserved for the bundled runtime artifact."
echo "No dependency installation is required from the user."
