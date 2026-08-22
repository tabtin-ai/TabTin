#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
VENV_DIR="${DJANGO_DIR}/venv"

_django_setup_is_windows() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*|Windows*) return 0 ;;
  esac
  case "${OS:-}" in
    Windows_NT) return 0 ;;
  esac
  return 1
}

_django_setup_venv_python() {
  if [[ -x "${VENV_DIR}/Scripts/python.exe" ]]; then
    printf '%s\n' "${VENV_DIR}/Scripts/python.exe"
    return 0
  fi
  if [[ -x "${VENV_DIR}/bin/python" ]]; then
    printf '%s\n' "${VENV_DIR}/bin/python"
    return 0
  fi
  return 1
}

_django_setup_find_python311() {
  local candidate=""
  local resolved=""

  for candidate in \
    /opt/homebrew/bin/python3.11 \
    /usr/local/bin/python3.11 \
    python3.11
  do
    if command -v "${candidate}" >/dev/null 2>&1 || [[ -x "${candidate}" ]]; then
      if [[ -x "${candidate}" ]]; then
        resolved="${candidate}"
      else
        resolved="$(command -v "${candidate}")"
      fi
      if [[ "$("${resolved}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)" == "3.11" ]]; then
        printf '%s\n' "${resolved}"
        return 0
      fi
    fi
  done

  # Windows: py launcher / 常见安装路径 / PATH 上的 python.exe
  if _django_setup_is_windows; then
    if command -v py >/dev/null 2>&1; then
      resolved="$(py -3.11 -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
      if [[ -n "${resolved}" && -x "${resolved}" ]]; then
        printf '%s\n' "${resolved}"
        return 0
      fi
    fi
    for candidate in \
      "${LOCALAPPDATA:-}/Programs/Python/Python311/python.exe" \
      "/c/Python311/python.exe" \
      python
    do
      [[ -n "${candidate}" ]] || continue
      if [[ -x "${candidate}" ]] || command -v "${candidate}" >/dev/null 2>&1; then
        if [[ -x "${candidate}" ]]; then
          resolved="${candidate}"
        else
          resolved="$(command -v "${candidate}")"
        fi
        if [[ "$("${resolved}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)" == "3.11" ]]; then
          printf '%s\n' "${resolved}"
          return 0
        fi
      fi
    done
  fi

  return 1
}

PYTHON_BIN="$(_django_setup_find_python311 || true)"

if [[ -z "${PYTHON_BIN}" ]]; then
  echo "❌ 未找到 Python 3.11。Django 依赖要求 Python 3.11，不能回退到系统 python3。"
  echo "   macOS 推荐安装: brew install python@3.11"
  echo "   Windows 推荐安装: https://www.python.org/downloads/release/python-3119/"
  echo "   安装后请确认: python3.11 --version 或 py -3.11 --version"
  exit 1
fi

PYTHON_MINOR_VERSION="$("${PYTHON_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "${PYTHON_MINOR_VERSION}" != "3.11" ]]; then
  echo "❌ ${PYTHON_BIN} 不是 Python 3.11（实际 ${PYTHON_MINOR_VERSION}）。"
  echo "   请修正 Python 3.11 指向，或重新安装 Python 3.11"
  exit 1
fi

cd "${DJANGO_DIR}"

if [[ -d "${VENV_DIR}" ]]; then
  VENV_VERSION=$(grep '^version' "${VENV_DIR}/pyvenv.cfg" 2>/dev/null | cut -d= -f2 | tr -d ' ')
  VENV_MINOR_VERSION=$(printf '%s\n' "${VENV_VERSION}" | cut -d. -f1,2)
  VENV_PYTHON="$(_django_setup_venv_python || true)"
  if [[ "${VENV_MINOR_VERSION}" != "${PYTHON_MINOR_VERSION}" ]]; then
    echo "⚠️  venv Python 版本 (${VENV_VERSION:-unknown}) 与要求 ${PYTHON_MINOR_VERSION} 不匹配，重建 venv..."
    rm -rf "${VENV_DIR}"
  elif [[ -z "${VENV_PYTHON}" ]]; then
    echo "⚠️  venv Python 不可执行，重建 venv..."
    rm -rf "${VENV_DIR}"
  else
    VENV_RUNTIME_MINOR_VERSION="$("${VENV_PYTHON}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)"
    if [[ "${VENV_RUNTIME_MINOR_VERSION}" != "${PYTHON_MINOR_VERSION}" ]]; then
      echo "⚠️  venv Python 运行时版本 (${VENV_RUNTIME_MINOR_VERSION:-unknown}) 与要求 ${PYTHON_MINOR_VERSION} 不匹配，重建 venv..."
      rm -rf "${VENV_DIR}"
    fi
  fi
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "🔨 使用 ${PYTHON_BIN} 创建 venv..."
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

VENV_PYTHON="$(_django_setup_venv_python)"
if [[ -z "${VENV_PYTHON}" ]]; then
  echo "❌ 创建 venv 后仍找不到可执行 Python（期望 Scripts/python.exe 或 bin/python）"
  exit 1
fi

# shellcheck disable=SC1091
if [[ -f "${VENV_DIR}/Scripts/activate" ]]; then
  # Git Bash on Windows: activate 脚本可用
  source "${VENV_DIR}/Scripts/activate"
elif [[ -f "${VENV_DIR}/bin/activate" ]]; then
  source "${VENV_DIR}/bin/activate"
else
  echo "❌ 找不到 venv activate 脚本"
  exit 1
fi

# 升级 pip 到最新版本
"${VENV_PYTHON}" -m pip install --upgrade pip

# 使用清华镜像源加速安装
"${VENV_PYTHON}" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --timeout 300 -r requirements.txt

# 注意: 如果遇到 MySQL 连接问题，请确保:
# 1. MySQL 服务已启动
# 2. 数据库凭据正确
# 3. 本地 MySQL 客户端库版本与服务器兼容
echo "依赖安装完成!"
echo "注意: migrate 步骤因 MySQL 认证插件问题暂时跳过"
echo "请手动连接数据库或使用兼容的 MySQL 客户端版本"
exit 0

python manage.py migrate
python manage.py migrate --database=postgresql

if [[ "${SKIP_COLLECTSTATIC:-0}" != "1" ]]; then
  python manage.py collectstatic --noinput
fi
