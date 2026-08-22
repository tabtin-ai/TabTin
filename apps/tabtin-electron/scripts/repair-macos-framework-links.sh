#!/bin/bash
set -euo pipefail

app_bundle="${1:?Usage: repair-macos-framework-links.sh <app-bundle>}"
frameworks_dir="$app_bundle/Contents/Frameworks"

[ -d "$frameworks_dir" ] || exit 0

while IFS= read -r -d '' framework; do
  versions_dir="$framework/Versions"
  [ -d "$versions_dir" ] || continue

  version_dir="$(find "$versions_dir" -mindepth 1 -maxdepth 1 -type d ! -name Current -print -quit)"
  [ -n "$version_dir" ] || continue
  version="$(basename "$version_dir")"

  current="$versions_dir/Current"
  if [ ! -L "$current" ]; then
    rm -rf -- "$current"
    ln -s "$version" "$current"
  fi

  framework_name="$(basename "$framework" .framework)"
  for alias in "$framework_name" Resources Libraries Helpers; do
    [ -e "$version_dir/$alias" ] || continue
    link="$framework/$alias"
    if [ ! -L "$link" ]; then
      if [ "$alias" = "$framework_name" ] && [ -f "$link" ]; then
        cp -p -- "$link" "$version_dir/$alias"
      fi
      rm -rf -- "$link"
      ln -s "Versions/Current/$alias" "$link"
    fi
  done
done < <(find "$frameworks_dir" -type d -name '*.framework' -prune -print0)
