#!/usr/bin/env bash
# Shared arch helpers for tabtin-filegen packaging .
# PyInstaller cannot cross-compile; callers must stamp and select per-OS/arch artifacts.

filegen_detect_host_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT) echo win32 ;;
    *) echo unknown ;;
  esac
}

filegen_detect_host_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo arm64 ;;
    x86_64|amd64) echo x64 ;;
    *) echo x64 ;;
  esac
}

filegen_generic_bin_name() {
  local os="${1:?}"
  if [ "$os" = "win32" ]; then
    echo "tabtin-filegen.exe"
  else
    echo "tabtin-filegen"
  fi
}

filegen_arch_bin_name() {
  local os="${1:?}"
  local arch="${2:?}"
  if [ "$os" = "win32" ]; then
    echo "tabtin-filegen-${os}-${arch}.exe"
  else
    echo "tabtin-filegen-${os}-${arch}"
  fi
}

# Return 0 if a darwin Mach-O matches target arch (arm64|x64) or is universal.
filegen_darwin_matches_arch() {
  local bin="${1:?}"
  local want="${2:?}"
  local info
  if [ ! -f "$bin" ]; then
    return 1
  fi
  info="$(file -b "$bin" 2>/dev/null || true)"
  case "$info" in
    *universal*) return 0 ;;
  esac
  case "$want" in
    arm64)
      case "$info" in *arm64*) return 0 ;; esac
      ;;
    x64)
      case "$info" in *x86_64*) return 0 ;; esac
      ;;
  esac
  return 1
}

# Darwin: Mach-O must match $arch (or universal).
# Other OS: existence only — this helper does not parse PE/ELF ( is macOS).
filegen_matches_target() {
  local bin="${1:?}"
  local os="${2:?}"
  local arch="${3:?}"
  if [ ! -f "$bin" ]; then
    return 1
  fi
  if [ "$os" = "darwin" ]; then
    filegen_darwin_matches_arch "$bin" "$arch"
    return $?
  fi
  return 0
}
