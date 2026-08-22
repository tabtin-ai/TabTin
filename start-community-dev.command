#!/bin/sh

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

pause_on_error() {
  if [ -t 0 ]; then
    printf 'Press Return to close this window...'
    read -r _tabtin_reply
  fi
}

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '[TabTin] Node.js 18 or newer is required.'
  printf '%s\n' 'Download it from https://nodejs.org/ and run this launcher again.'
  pause_on_error
  exit 1
fi

node "$SCRIPT_DIR/scripts/dev.mjs" community "$@"
tabtin_exit_code=$?

if [ "$tabtin_exit_code" -ne 0 ]; then
  printf '\n%s\n' '[TabTin] Startup failed. Review the messages above for details.'
  pause_on_error
fi

exit "$tabtin_exit_code"
