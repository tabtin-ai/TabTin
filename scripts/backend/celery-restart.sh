#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── systemd 模式：单元已安装时优先使用（INFRA-13） ──
_systemd_available() {
  command -v systemctl &>/dev/null \
    && systemctl is-enabled tabtin-celery.target &>/dev/null 2>&1
}

if _systemd_available; then
  echo "🔄 通过 systemctl 重启 Celery..."
  sudo systemctl restart tabtin-celery.target
  echo "✅ Celery 全部进程已通过 systemd 重启"
  systemctl --no-pager status tabtin-celery-worker tabtin-celery-critical tabtin-celery-beat tabtin-celery-scheduler 2>/dev/null || true
  exit 0
fi

# ── 回退：stop + start（开发环境） ──
bash "${ROOT_DIR}/scripts/backend/celery-stop.sh"
bash "${ROOT_DIR}/scripts/backend/celery-start.sh"
