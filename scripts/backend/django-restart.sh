#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_load-scheme.sh"

# 日常 django-restart 也曾只 stop+start，不跑迁移，容易出现
# 「代码已拉到 0040、库仍停在 0039」这类漂移（计费结算写库失败被误报成余额/网络问题）。
# 与 start-all / restart-all 对齐：重启前先走 db-prepare 门禁。
bash "${ROOT_DIR}/scripts/backend/db-prepare.sh"

bash "${ROOT_DIR}/scripts/backend/django-stop.sh"
# 等待端口完全释放
sleep 2
bash "${ROOT_DIR}/scripts/backend/django-start.sh"
