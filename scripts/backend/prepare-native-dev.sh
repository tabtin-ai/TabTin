#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE="${ROOT_DIR}/.env.example"
DJANGO_SETUP="${ROOT_DIR}/scripts/backend/django-setup.sh"
VENV_DIR="${ROOT_DIR}/apps/tabtin_django/venv"
SECRET_GENERATOR="${ROOT_DIR}/scripts/backend/generate-local-env-secrets.py"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ ! -f "${ENV_EXAMPLE}" ]]; then
    echo "❌ 缺少 ${ENV_EXAMPLE}，无法初始化本地配置。"
    exit 1
  fi
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  echo "✅ 已从 .env.example 创建本地 .env（不会覆盖已有配置）"
fi

if [[ ! -x "${VENV_DIR}/bin/python" && ! -x "${VENV_DIR}/Scripts/python.exe" ]]; then
  echo "🔨 首次运行：初始化 Django Python 3.11 环境..."
  bash "${DJANGO_SETUP}"
fi

if [[ ! -x "${VENV_DIR}/bin/python" && ! -x "${VENV_DIR}/Scripts/python.exe" ]]; then
  echo "❌ Django Python 环境初始化后仍不可用：${VENV_DIR}"
  exit 1
fi

if [[ -x "${VENV_DIR}/bin/python" ]]; then
  "${VENV_DIR}/bin/python" "${SECRET_GENERATOR}" "${ENV_FILE}" "${ROOT_DIR}/.env.local"
else
  "${VENV_DIR}/Scripts/python.exe" "${SECRET_GENERATOR}" "${ENV_FILE}" "${ROOT_DIR}/.env.local"
fi
