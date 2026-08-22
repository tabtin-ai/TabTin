#!/usr/bin/env bash
# 在新 session 里拉起守护进程，避免 Cursor Agent 短 shell 退出时整组 SIGKILL。
# nohup 只挡 SIGHUP，挡不住进程组清理；macOS 也没有 setsid。
#
# Usage:
#   # shellcheck disable=SC1091
#   source "$(dirname "${BASH_SOURCE[0]}")/_detach-spawn.sh"
#   _detach_spawn <pid_file> <log_file> <cwd_or_empty> -- <cmd> [args...]
#
# 日志文件会被截断；pidfile 写入新 session leader 的 PID。

_detach_spawn() {
  local pid_file="$1"
  local log_file="$2"
  local cwd="${3:-}"
  shift 3
  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  if [[ $# -lt 1 ]]; then
    echo "_detach_spawn: missing command" >&2
    return 1
  fi

  local py=""
  if command -v python3 >/dev/null 2>&1; then
    py=python3
  elif command -v python >/dev/null 2>&1; then
    py=python
  else
    echo "_detach_spawn: python3/python not found" >&2
    return 1
  fi

  DETACH_PID_FILE="${pid_file}" \
  DETACH_LOG_FILE="${log_file}" \
  DETACH_CWD="${cwd}" \
  "${py}" - "$@" <<'PY'
import os
import subprocess
import sys

pid_file = os.environ["DETACH_PID_FILE"]
log_file = os.environ["DETACH_LOG_FILE"]
cwd = os.environ.get("DETACH_CWD") or None
cmd = sys.argv[1:]

pid_dir = os.path.dirname(pid_file)
log_dir = os.path.dirname(log_file)
if pid_dir:
    os.makedirs(pid_dir, exist_ok=True)
if log_dir:
    os.makedirs(log_dir, exist_ok=True)

log_f = open(log_file, "w", encoding="utf-8")
proc = subprocess.Popen(
    cmd,
    cwd=cwd,
    stdin=subprocess.DEVNULL,
    stdout=log_f,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    env=os.environ.copy(),
)
with open(pid_file, "w", encoding="utf-8") as fh:
    fh.write(str(proc.pid))
PY
}
