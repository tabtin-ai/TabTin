#!/usr/bin/env bash
# ─────────────────────────────────────────────────────
# 安全端口清理：kill 占用指定端口的进程，但排除 IDE 和容器端口转发进程
#
# 背景：Cursor / VS Code SSH Remote 会自动转发端口，
# 在目标端口上创建 LISTEN 套接字（进程名为 Cursor / Code / Electron）。
# 直接 `lsof -ti :PORT | xargs kill -9` 会误杀 IDE 主进程，
# 导致 SSH 面板断连重载。
# macOS 上 Docker 容器的发布端口由 OrbStack / Docker Desktop Host
# 进程监听；误杀它们会让整个 Docker daemon 与所有容器同时退出。
#
# 用法（source 后调用）:
#   source "$(dirname "${BASH_SOURCE[0]}")/_safe-port-kill.sh"
#   _safe_kill_port 4200        # SIGKILL (默认)
#   _safe_kill_port 4200 TERM   # SIGTERM
# ─────────────────────────────────────────────────────

_SAFE_PORT_KILL_PROTECTED_PROCESS_PATTERN='^(Cursor|Code|Electron|OrbStack|Docker|com\.dock|vpnkit)'

_safe_kill_port() {
    local port="$1"
    local signal="${2:-9}"

    local pids=""
    local kill_with_powershell=false
    local ps_cmd=""
    if lsof -i :"${port}" >/dev/null 2>&1; then
        pids=$(lsof -i :"${port}" \
            | awk -v protected="${_SAFE_PORT_KILL_PROTECTED_PROCESS_PATTERN}" \
                'NR>1 && $1 !~ protected {print $2}' \
            | sort -un)
    else
        # Windows Git Bash fallback: lsof often misses Node loopback listeners.
        # Keep the same safety boundary: never stop Cursor / Code / Electron IDE processes.
        if command -v powershell.exe >/dev/null 2>&1; then
            ps_cmd="powershell.exe"
        elif command -v powershell >/dev/null 2>&1; then
            ps_cmd="powershell"
        fi

        if [[ -n "${ps_cmd}" ]]; then
            pids=$(SAFE_KILL_PORT="${port}" "${ps_cmd}" -NoProfile -Command \
                '$port = [int]$env:SAFE_KILL_PORT; Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -notmatch "^(Cursor|Code|Electron|OrbStack|Docker|com\.dock|vpnkit)") { $_ } }' \
                2>/dev/null | tr -d '\r' | sort -un || true)
            kill_with_powershell=true
        fi
    fi

    if [[ -z "${pids}" ]]; then
        if [[ -z "${ps_cmd}" ]]; then
            if command -v powershell.exe >/dev/null 2>&1; then
                ps_cmd="powershell.exe"
            elif command -v powershell >/dev/null 2>&1; then
                ps_cmd="powershell"
            fi
        fi

        if [[ -n "${ps_cmd}" ]]; then
            pids=$(SAFE_KILL_PORT="${port}" "${ps_cmd}" -NoProfile -Command \
                '$port = [int]$env:SAFE_KILL_PORT; Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -notmatch "^(Cursor|Code|Electron|OrbStack|Docker|com\.dock|vpnkit)") { $_ } }' \
                2>/dev/null | tr -d '\r' | sort -un || true)
            kill_with_powershell=true
        fi
    fi

    if [[ -n "${pids}" ]]; then
        if [[ "${kill_with_powershell}" == true && -n "${ps_cmd}" ]]; then
            SAFE_KILL_PIDS="${pids}" "${ps_cmd}" -NoProfile -Command \
                '$env:SAFE_KILL_PIDS -split "`n" | Where-Object { $_.Trim() } | ForEach-Object { Stop-Process -Id ([int]$_.Trim()) -Force -ErrorAction SilentlyContinue }' \
                >/dev/null 2>&1 || true
        else
            echo "${pids}" | xargs kill -"${signal}" 2>/dev/null || true
        fi
    fi
}
