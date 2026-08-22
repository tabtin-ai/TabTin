#!/usr/bin/env bash
set -euo pipefail

# 增量模式：本地异步任务 Worker
# -----------------------------------------------------------------------------
# 用途：
#   只启动一个本地 Celery worker，用于调试当前本地代码里的异步任务。
#   这是默认轻量模式的增量能力，不是替代方案。
#
# 本脚本会启动：
#   - 一个前台运行的 Celery worker，只消费指定队列。
#     示例：bash scripts/backend/celery-worker-local.sh default
#           bash scripts/backend/celery-worker-local.sh heavy
#
# 参数：
#   $1 / <queue>
#     要消费的队列列表。不传时默认消费 default。
#     多个队列用英文逗号分隔，不要加空格。
#
#     示例：
#       bash scripts/backend/celery-worker-local.sh
#       bash scripts/backend/celery-worker-local.sh default
#       bash scripts/backend/celery-worker-local.sh heavy
#       bash scripts/backend/celery-worker-local.sh critical
#       bash scripts/backend/celery-worker-local.sh tracker_agent
#       bash scripts/backend/celery-worker-local.sh search_indexing
#       bash scripts/backend/celery-worker-local.sh default,low_priority
#       bash scripts/backend/celery-worker-local.sh realtime_delivery
#       bash scripts/backend/celery-worker-local.sh rag_indexing,tabdata_compute,doc_merge
#       bash scripts/backend/celery-worker-local.sh pptx_import_oss
#
# 环境变量覆盖：
#   CELERY_QUEUES       不传 $1 时使用的默认队列列表。
#   CELERY_CONCURRENCY  Worker 并发数，默认 2。
#   CELERY_LOGLEVEL     Celery 日志级别，默认 info。
#   CELERY_MAX_MEMORY   max-memory-per-child，默认 512000。
#
# 常见队列：
#   critical             支付、认证、会员、钱包、短信等高优先级任务。
#   default              普通后台任务。
#   realtime_delivery    Channel Gateway 出站投递、入站 polling、失败重试。
#   rag_indexing         RAG / Embedding 索引任务。
#   tabdata_compute      TabData ComputedOutbox 计算任务。
#   doc_merge            TabDoc DocUpdate 合并任务。
#   heavy                仍未拆分的重任务。
#   media                图片、视频、音频等媒体生成任务。
#   docparse             文档解析、OCR、文件转换任务。
#   low_priority         低优先级维护任务。
#   tabdata_conversion   TabData 字段/类型转换任务。
#   pptx_import_oss      从临时 OSS 对象导入 PPTX 的隔离任务。
#   tracker_agent        Tracker / 自动化 Agent 任务。
#   search_indexing      FTS / 搜索索引同步任务。
#
# 本脚本不会启动：
#   - Electron/Web 客户端
#   - Django
#   - PostgreSQL / Redis
#   - Celery beat
#   - Collab-Live / Centrifugo
#
# 启动顺序：
#   - 和协同调试没有固定先后顺序。
#   - 可以先运行 collab-live-start.sh，再运行本 worker。
#   - 也可以先运行本 worker，再运行 collab-live-start.sh。
#   - 两者是互相独立的增量进程。
#
# 重要注意：
#   - 这是前台调试进程，建议单独开一个终端运行。
#   - 轻量/test 模式下不要启动本地 beat，否则定时任务可能重复触发。
#   - 如果 ACK test 里也有 worker 消费同一个队列，任务可能被远端镜像抢走，
#     而不是执行你的本地代码。必要时临时缩容 ACK 对应 worker，或使用专门
#     的调试队列。
# -----------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/_celery-platform.sh"
DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
VENV_DIR="${DJANGO_DIR}/venv"

TRACKER_AGENT_QUEUE="$(_celery_tracker_agent_queue "${ROOT_DIR}")"
export TRACKER_AGENT_QUEUE

QUEUES="${1:-${CELERY_QUEUES:-default}}"
QUEUES="$(_celery_map_tracker_agent_queue_arg "${QUEUES}" "${TRACKER_AGENT_QUEUE}")"
if _celery_queue_list_contains "${QUEUES}" "${TRACKER_AGENT_QUEUE}"; then
  CELERY_POOL_ARGS="$(_celery_tracker_pool_args)"
  CELERY_PREFETCH_ARGS="--prefetch-multiplier=${CELERY_TRACKER_PREFETCH_MULTIPLIER:-1}"
else
  CELERY_POOL_ARGS="$(_celery_pool_args)"
  CELERY_PREFETCH_ARGS=""
  if [[ -n "${CELERY_PREFETCH_MULTIPLIER:-}" ]]; then
    CELERY_PREFETCH_ARGS="--prefetch-multiplier=${CELERY_PREFETCH_MULTIPLIER}"
  fi
fi
CONCURRENCY="${CELERY_CONCURRENCY:-2}"
LOGLEVEL="${CELERY_LOGLEVEL:-info}"

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Missing venv. Run: bash scripts/backend/django-setup.sh"
  exit 1
fi

if ! PYTHON_BIN="$(_celery_venv_python "${VENV_DIR}")"; then
  echo "Missing venv Python under ${VENV_DIR} (expected Scripts/python.exe or bin/python)."
  echo "Run: bash scripts/backend/django-setup.sh"
  exit 1
fi

cd "${DJANGO_DIR}"
# Prefer explicit venv python over PATH after activate. On Windows, console-script
# launchers (celery.exe) can embed a broken shebang; always use python -m celery.
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

export DJANGO_SETTINGS_MODULE=tabtin.settings
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY="${OBJC_DISABLE_INITIALIZE_FORK_SAFETY:-YES}"

echo "🚀 启动本地 Celery worker（不启动 beat）"
echo "  python: ${PYTHON_BIN}"
echo "  queues: ${QUEUES}"
echo "  concurrency: ${CONCURRENCY}"
echo ""
echo "注意：如果 ACK test 中同队列 worker 也在运行，任务可能被远端旧代码抢走。"
echo "调试异步任务时，建议临时缩容 ACK 对应 worker，或使用专门的调试队列。"
echo ""

exec "${PYTHON_BIN}" -m celery -A tabtin worker \
  --loglevel="${LOGLEVEL}" \
  ${CELERY_POOL_ARGS} \
  --queues="${QUEUES}" \
  --concurrency="${CONCURRENCY}" \
  ${CELERY_PREFETCH_ARGS} \
  --max-memory-per-child="${CELERY_MAX_MEMORY:-512000}" \
  -n "local-${QUEUES//,/}-worker@%h"
