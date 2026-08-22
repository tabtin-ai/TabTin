#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UPLOAD_SCRIPT="$SCRIPT_DIR/upload-sentry-sourcemaps.sh"
TMP_DIR="$(mktemp -d -t tabtin-sentry-retry.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/counts"
cat >"$TMP_DIR/bin/sentry-cli" <<'EOF'
#!/bin/bash
set -euo pipefail

key="${1//[^a-zA-Z0-9]/_}"
if [ "${1:-}" = "sourcemaps" ]; then
  key="${key}_${2//[^a-zA-Z0-9]/_}"
elif [ "${1:-}" = "releases" ]; then
  key="${key}_${2//[^a-zA-Z0-9]/_}"
fi

count_file="$SENTRY_TEST_COUNTS/$key"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
count=$((count + 1))
printf '%s' "$count" >"$count_file"

if [ "$key" = "${SENTRY_TEST_FAIL_KEY:-}" ] && [ "$count" -le "${SENTRY_TEST_FAIL_COUNT:-0}" ]; then
  exit 1
fi
EOF
chmod +x "$TMP_DIR/bin/sentry-cli"

run_upload() {
  PATH="$TMP_DIR/bin:$PATH" \
    SENTRY_CLI_BIN="$TMP_DIR/bin/sentry-cli" \
    SENTRY_URL="https://sentry.invalid" \
    SENTRY_AUTH_TOKEN="test-token" \
    SENTRY_ORG="test-org" \
    SENTRY_APP_VERSION="0.0.0-test" \
    SENTRY_CLI_MAX_ATTEMPTS=3 \
    SENTRY_CLI_RETRY_DELAY_SECONDS=0 \
    SENTRY_TEST_COUNTS="$TMP_DIR/counts" \
    SENTRY_TEST_FAIL_KEY="$1" \
    SENTRY_TEST_FAIL_COUNT="$2" \
    bash "$UPLOAD_SCRIPT"
}

run_upload info 2 >/dev/null
[ "$(cat "$TMP_DIR/counts/info")" = "3" ]
[ "$(cat "$TMP_DIR/counts/sourcemaps_inject")" = "1" ]
[ "$(cat "$TMP_DIR/counts/sourcemaps_upload")" = "1" ]
[ "$(cat "$TMP_DIR/counts/releases_finalize")" = "1" ]

rm -rf "$TMP_DIR/counts"
mkdir -p "$TMP_DIR/counts"
run_upload sourcemaps_upload 2 >/dev/null
[ "$(cat "$TMP_DIR/counts/info")" = "1" ]
[ "$(cat "$TMP_DIR/counts/sourcemaps_upload")" = "3" ]
[ "$(cat "$TMP_DIR/counts/releases_finalize")" = "1" ]

rm -rf "$TMP_DIR/counts"
mkdir -p "$TMP_DIR/counts"
if run_upload info 3 >/dev/null 2>&1; then
  echo "expected upload script to fail after exhausting retries" >&2
  exit 1
fi
[ "$(cat "$TMP_DIR/counts/info")" = "3" ]
[ ! -e "$TMP_DIR/counts/sourcemaps_inject" ]

echo "Sentry CLI retry tests passed"
