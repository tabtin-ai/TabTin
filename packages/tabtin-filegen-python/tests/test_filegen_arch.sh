#!/usr/bin/env bash
# Naming + Mach-O match checks for filegen-arch.sh .
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source ./filegen-arch.sh

[ "$(filegen_generic_bin_name darwin)" = "tabtin-filegen" ]
[ "$(filegen_generic_bin_name win32)" = "tabtin-filegen.exe" ]
[ "$(filegen_arch_bin_name darwin arm64)" = "tabtin-filegen-darwin-arm64" ]
[ "$(filegen_arch_bin_name darwin x64)" = "tabtin-filegen-darwin-x64" ]
[ "$(filegen_arch_bin_name win32 x64)" = "tabtin-filegen-win32-x64.exe" ]

tmp="$(mktemp)"
printf 'not-macho' >"$tmp"
if filegen_darwin_matches_arch "$tmp" x64; then
  echo "expected non-Mach-O to fail arch match" >&2
  rm -f "$tmp"
  exit 1
fi
rm -f "$tmp"

write_thin_macho() {
  local dest="$1"
  local cputype="$2"
  python3 - "$dest" "$cputype" <<'PY'
import sys
dest, cputype = sys.argv[1], int(sys.argv[2], 0)
buf = bytearray(32)
buf[0:4] = (0xFEEDFACF).to_bytes(4, "little")
buf[4:8] = cputype.to_bytes(4, "little")
open(dest, "wb").write(buf)
PY
}

arm64_bin="$(mktemp)"
x64_bin="$(mktemp)"
write_thin_macho "$arm64_bin" 0x0100000C
write_thin_macho "$x64_bin" 0x01000007

if filegen_darwin_matches_arch "$arm64_bin" x64; then
  echo "expected arm64 Mach-O to fail x64 match" >&2
  rm -f "$arm64_bin" "$x64_bin"
  exit 1
fi
if ! filegen_darwin_matches_arch "$x64_bin" x64; then
  echo "expected x86_64 Mach-O to match x64 (file said: $(file -b "$x64_bin"))" >&2
  rm -f "$arm64_bin" "$x64_bin"
  exit 1
fi
if ! filegen_darwin_matches_arch "$arm64_bin" arm64; then
  echo "expected arm64 Mach-O to match arm64 (file said: $(file -b "$arm64_bin"))" >&2
  rm -f "$arm64_bin" "$x64_bin"
  exit 1
fi
rm -f "$arm64_bin" "$x64_bin"

echo "test_filegen_arch.sh ok"
