#!/usr/bin/env bash
set -u

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
"${script_dir}/stop.sh"
exit_code=$?

printf '\nPress Enter to close this window...'
read -r _ || true
exit "${exit_code}"
