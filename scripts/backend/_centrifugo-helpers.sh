#!/usr/bin/env bash
# Centrifugo 启停/校验辅助（restart-all / start-all / start-centrifugo 共用）
#
# 背景：macOS 上 ps comm 可能截断；nohup 重试会 rm pid 但旧进程仍占 8100，
# 导致「第一次其实已启动 → 校验失败 → 重试报端口占用 → 孤儿进程」。

_centrifugo_port_pids() {
    local port="${1:-${CENTRIFUGO_PORT:-8100}}"
    local pids=""
    if command -v lsof >/dev/null 2>&1; then
        pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null \
            | awk 'NR>1 && $1 !~ /^(Cursor|Code|Electron)/{print $2}' \
            | sort -un)"
    fi
    if [[ -n "${pids}" ]]; then
        echo "${pids}"
        return 0
    fi

    local ps_cmd=""
    if command -v powershell.exe >/dev/null 2>&1; then
        ps_cmd="powershell.exe"
    elif command -v powershell >/dev/null 2>&1; then
        ps_cmd="powershell"
    fi
    if [[ -n "${ps_cmd}" ]]; then
        CENTRIFUGO_PORT_QUERY="${port}" "${ps_cmd}" -NoProfile -Command \
            '$port = [int]$env:CENTRIFUGO_PORT_QUERY; Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique' \
            2>/dev/null | tr -d '\r' | sort -un
    fi
}

_centrifugo_normalize_path() {
    local path="$1"
    path="${path//\\//}"
    printf '%s' "${path%/}"
}

_centrifugo_lowercase() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

_centrifugo_repo_root_paths() {
    local script_dir root_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    root_dir="$(cd "${script_dir}/../.." && pwd)"

    _centrifugo_normalize_path "${root_dir}"
    printf '\n'

    if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "${root_dir}" 2>/dev/null | tr '\\' '/'
    fi
}

_centrifugo_command_matches() {
    local cmd="$1"
    local normalized_cmd normalized_cmd_lower
    normalized_cmd="${cmd//\\//}"
    normalized_cmd_lower="$(_centrifugo_lowercase "${normalized_cmd}")"
    local root_path normalized_root
    while IFS= read -r root_path; do
        [[ -n "${root_path}" ]] || continue
        normalized_root="$(_centrifugo_normalize_path "${root_path}")"
        normalized_root="$(_centrifugo_lowercase "${normalized_root}")"
        case " ${normalized_cmd_lower} " in
            *"${normalized_root}/scripts/backend/bin/centrifugo "* | *"${normalized_root}/scripts/backend/bin/centrifugo.exe "* | \
            *"${normalized_root}/scripts/bin/centrifugo "* | *"${normalized_root}/scripts/bin/centrifugo.exe "*)
                return 0
                ;;
        esac
    done < <(_centrifugo_repo_root_paths)
    return 1
}

_centrifugo_is_our_pid() {
    local pid="$1"
    [[ -n "${pid}" ]] || return 1
    [[ "${pid}" =~ ^[0-9]+$ ]] || return 1

    local cmd
    if kill -0 "${pid}" 2>/dev/null; then
        cmd="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
        if _centrifugo_command_matches "${cmd}"; then
            return 0
        fi
    fi

    local ps_cmd=""
    if command -v powershell.exe >/dev/null 2>&1; then
        ps_cmd="powershell.exe"
    elif command -v powershell >/dev/null 2>&1; then
        ps_cmd="powershell"
    fi
    if [[ -n "${ps_cmd}" ]]; then
        cmd="$(CENTRIFUGO_PID_QUERY="${pid}" "${ps_cmd}" -NoProfile -Command \
            '$targetPid = [int]$env:CENTRIFUGO_PID_QUERY; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue; if ($p) { $p.CommandLine }' \
            2>/dev/null | tr -d '\r')"
        _centrifugo_command_matches "${cmd}" && return 0
    fi

    return 1
}

_centrifugo_verify_started() {
    local pid_file="$1"
    local port="${CENTRIFUGO_PORT:-8100}"

    if [[ -f "${pid_file}" ]]; then
        local pid
        pid="$(cat "${pid_file}")"
        if _centrifugo_is_our_pid "${pid}"; then
            return 0
        fi
    fi

    local port_pid
    for port_pid in $(_centrifugo_port_pids "${port}"); do
        if _centrifugo_is_our_pid "${port_pid}"; then
            mkdir -p "$(dirname "${pid_file}")"
            echo "${port_pid}" > "${pid_file}"
            return 0
        fi
    done
    return 1
}

_centrifugo_stop() {
    local root_dir="${1:?root_dir required}"
    # shellcheck disable=SC1091
    source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"

    local log_dir="${root_dir}/apps/tabtin_django/logs"
    local pid_file="${log_dir}/centrifugo.pid"
    local port="${CENTRIFUGO_PORT:-8100}"
    local bin_path="${root_dir}/scripts/backend/bin/centrifugo"
    local legacy_bin_path="${root_dir}/scripts/bin/centrifugo"

    if [[ -f "${pid_file}" ]]; then
        local saved_pid
        saved_pid="$(cat "${pid_file}")"
        if kill -0 "${saved_pid}" 2>/dev/null; then
            kill "${saved_pid}" 2>/dev/null || true
            sleep 0.3
            kill -9 "${saved_pid}" 2>/dev/null || true
        fi
        rm -f "${pid_file}"
    fi

    local pid
    for pid in $(pgrep -f "${bin_path}.*-p ${port}" 2>/dev/null || true); do
        kill "${pid}" 2>/dev/null || true
        sleep 0.2
        kill -9 "${pid}" 2>/dev/null || true
    done
    for pid in $(pgrep -f "${legacy_bin_path}.*-p ${port}" 2>/dev/null || true); do
        kill "${pid}" 2>/dev/null || true
        sleep 0.2
        kill -9 "${pid}" 2>/dev/null || true
    done

    # shellcheck disable=SC1091
    source "$(dirname "${BASH_SOURCE[0]}")/_safe-port-kill.sh"
    if [[ -n "$(_centrifugo_port_pids "${port}")" ]]; then
        _safe_kill_port "${port}"
    fi
}
