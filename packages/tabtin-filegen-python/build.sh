#!/usr/bin/env bash
# Build the self-contained `tabtin-filegen` binary with PyInstaller.
#
# Produces dist/tabtin-filegen (dist/tabtin-filegen.exe on Windows): a single
# executable bundling the Python interpreter + all libs + reportlab CID font
# data, so the client needs NO Python installed.
#
# PyInstaller does not cross-compile — run this once on each target OS+arch.
# Also stamps dist/tabtin-filegen-<os>-<arch> so dual-arch packaging cannot
# reuse the wrong Mach-O .
set -euo pipefail

cd "$(dirname "$0")"
# shellcheck disable=SC1091
source "$(pwd)/filegen-arch.sh"

python_can_run() {
  "$1" -c 'import sys; sys.exit(0)' >/dev/null 2>&1
}

if [ -z "${PYTHON:-}" ]; then
  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1 && python_can_run "$candidate"; then
      PYTHON="$candidate"
      break
    fi
  done
fi
if [ -z "${PYTHON:-}" ]; then
  echo "缺少可用 Python：请安装 python3，或设置 PYTHON=/path/to/python" >&2
  exit 1
fi
if ! python_can_run "$PYTHON"; then
  echo "PYTHON=$PYTHON 不可执行或不是有效 Python 解释器" >&2
  exit 1
fi
VENV_DIR="${VENV_DIR:-.venv}"

if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate" 2>/dev/null || source "$VENV_DIR/Scripts/activate"

python -m pip install --upgrade pip >/dev/null
python -m pip install -e ".[build]" >/dev/null

# --collect-all pulls each lib's bundled data (office default templates,
# reportlab CMaps / CID font metrics) into the frozen binary.
python -m PyInstaller --onefile --noconfirm --clean \
  --name tabtin-filegen \
  --collect-all reportlab \
  --collect-all docx \
  --collect-all pptx \
  --collect-all openpyxl \
  src/tabtin_filegen/__main__.py

HOST_OS="$(filegen_detect_host_os)"
HOST_ARCH="$(filegen_detect_host_arch)"
GENERIC_NAME="$(filegen_generic_bin_name "$HOST_OS")"
ARCH_NAME="$(filegen_arch_bin_name "$HOST_OS" "$HOST_ARCH")"
GENERIC_BIN="$(pwd)/dist/$GENERIC_NAME"
ARCH_BIN="$(pwd)/dist/$ARCH_NAME"

if [ ! -f "$GENERIC_BIN" ]; then
  echo "PyInstaller 未产出 $GENERIC_BIN" >&2
  exit 1
fi
if ! filegen_matches_target "$GENERIC_BIN" "$HOST_OS" "$HOST_ARCH"; then
  echo "tabtin-filegen 架构与本机不符：期望 ${HOST_OS}/${HOST_ARCH}，文件 $(file -b "$GENERIC_BIN" 2>/dev/null || echo unknown)" >&2
  exit 1
fi
cp -f "$GENERIC_BIN" "$ARCH_BIN"
echo "Built: $GENERIC_BIN"
echo "Stamped: $ARCH_BIN"
