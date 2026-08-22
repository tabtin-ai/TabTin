#!/bin/bash
set -euo pipefail

APP_BUNDLE="${1:?Usage: create-styled-dmg.sh <app-bundle> <dmg-path>}"
DMG_PATH="${2:?Usage: create-styled-dmg.sh <app-bundle> <dmg-path>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
BACKGROUND="$APP_DIR/build/dmg/background.png"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Styled DMG creation must run on macOS." >&2
  exit 1
fi

if [ ! -d "$APP_BUNDLE" ]; then
  echo "Missing app bundle: $APP_BUNDLE" >&2
  exit 1
fi

if [ ! -f "$BACKGROUND" ]; then
  echo "Missing DMG background: $BACKGROUND" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tabtin-dmg.XXXXXX")"
RW_DMG="$TMP_DIR/staging.dmg"
FINAL_DMG_BASE="$TMP_DIR/final"
MOUNT_DIR=""
VOLNAME="$(basename "$APP_BUNDLE" .app)"
APP_SIZE_MB="$(du -sm "$APP_BUNDLE" | awk '{print $1}')"
DMG_SIZE_MB="$((APP_SIZE_MB * 2 + 512))"

cleanup() {
  if [ -n "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

hdiutil create -quiet -volname "$VOLNAME" -size "${DMG_SIZE_MB}m" -fs HFS+ -ov "$RW_DMG"
MOUNT_DIR="$(
  hdiutil attach "$RW_DMG" -readwrite -noverify \
    | sed -n 's#^/dev/.*Apple_HFS[[:space:]]*##p' \
    | tail -n 1
)"
if [ -z "$MOUNT_DIR" ] || [ ! -d "$MOUNT_DIR" ]; then
  echo "Failed to mount writable DMG." >&2
  exit 1
fi

ditto "$APP_BUNDLE" "$MOUNT_DIR/$(basename "$APP_BUNDLE")"
mkdir -p "$MOUNT_DIR/.background"
cp "$BACKGROUND" "$MOUNT_DIR/.background/background.png"
ln -s /Applications "$MOUNT_DIR/Applications"

osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {100, 100, 820, 620}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 128
    set text size of theViewOptions to 14
    set background picture of theViewOptions to file ".background:background.png"
    set position of item "$VOLNAME.app" of container window to {205, 248}
    set position of item "Applications" of container window to {515, 248}
    close
    open
    update without registering applications
    delay 1
  end tell
end tell
APPLESCRIPT

hdiutil detach "$MOUNT_DIR" -quiet
hdiutil convert "$RW_DMG" -quiet -format UDZO -imagekey zlib-level=9 -o "$FINAL_DMG_BASE"
mkdir -p "$(dirname "$DMG_PATH")"
mv "${FINAL_DMG_BASE}.dmg" "$DMG_PATH"
