#!/usr/bin/env bash
# ??????????? make ? Node ???Windows / macOS / Linux ????
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/build-binaries.js" "$@"
