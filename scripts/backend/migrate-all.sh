#!/usr/bin/env bash
# migrate-all.sh —— 一键跨库 migrate（封装 safe_migrate management 命令）
#
# 作用：按固定顺序 default → postgresql 执行 migrate，避免漏跑 --database。
# 兼容所有 `migrate` 的常见参数：
#     bash scripts/backend/migrate-all.sh
#     bash scripts/backend/migrate-all.sh --plan

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
VENV_ACTIVATE="${DJANGO_DIR}/venv/bin/activate"

if [[ ! -f "${VENV_ACTIVATE}" ]]; then
  echo "❌ 未找到 Python 虚拟环境: ${VENV_ACTIVATE}"
  echo "   请先执行: bash scripts/backend/django-setup.sh"
  exit 1
fi

# shellcheck disable=SC1090
source "${VENV_ACTIVATE}"
cd "${DJANGO_DIR}"

python manage.py safe_migrate "$@"
