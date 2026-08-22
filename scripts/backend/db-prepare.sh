#!/usr/bin/env bash
# db-prepare.sh —— 启动前的数据库准备，start-all.sh / restart-all.sh 共用。
#
# 加锁补增量迁移：mkdir 原子锁串行化，防多实例/多启动路径并发 migrate；
#      失败即 exit 1，绝不让带着半迁移库的服务起来。
#
# 抽成独立脚本是为了让「启动」和「重启」两条路径行为完全一致——
# 历史上 restart-all.sh 不跑 migrate，切库后重启容易漏迁移。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="${ROOT_DIR}/apps/tabtin_django/logs"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🗄️  数据库就绪检查 + 迁移..."

# 加锁补增量迁移，失败即终止
MIGRATE_LOCK="${LOG_DIR}/.migrate.lock"
mkdir -p "${LOG_DIR}"
_lock_acquired=0
for _ in $(seq 1 60); do
  if mkdir "${MIGRATE_LOCK}" 2>/dev/null; then _lock_acquired=1; break; fi
  echo "  ⏳ 另一进程正在迁移，等待锁..."; sleep 2
done
if [[ "${_lock_acquired}" -ne 1 ]]; then
  echo "  ❌ 获取迁移锁超时（${MIGRATE_LOCK}）。确认无其他迁移在跑后手动删除该目录再重试。"
  exit 1
fi
trap 'rmdir "${MIGRATE_LOCK}" 2>/dev/null || true' EXIT
if ! bash "${ROOT_DIR}/scripts/backend/migrate-all.sh"; then
  echo "  ❌ 数据库迁移失败，已中止启动（避免半迁移状态下起服务）。"
  exit 1
fi
rmdir "${MIGRATE_LOCK}" 2>/dev/null || true
trap - EXIT

# 3) LLM 场景绑定脚手架兜底（幂等，仅空表时写）。
#    单库切换后若走 fresh migrate（而非 dump restore），LLMSceneBinding 会是空表，
#    Agent / RAG 一启动就刷 SceneBindingUnavailable（rag_index_tool 向量化失败等）。
#    这里 migrate 后补一次 `seed_scene_bindings --if-empty`：空库自动建占位绑定，
#    dump 恢复（已有绑定）的库一行跳过、不写。失败不阻塞启动——只是少了占位脚手架，
#    可手动补跑 `python manage.py seed_scene_bindings`。
DJANGO_DIR="${ROOT_DIR}/apps/tabtin_django"
VENV_ACTIVATE="${DJANGO_DIR}/venv/bin/activate"
if [[ -f "${VENV_ACTIVATE}" ]]; then
  if ! (
    # shellcheck disable=SC1090
    source "${VENV_ACTIVATE}"
    cd "${DJANGO_DIR}"
    python manage.py seed_scene_bindings --if-empty
  ); then
    echo "  ⚠ 场景绑定 seed 跳过/失败（不阻塞启动；可手动跑 python manage.py seed_scene_bindings）。"
  fi
  if ! (
    # shellcheck disable=SC1090
    source "${VENV_ACTIVATE}"
    cd "${DJANGO_DIR}"
    python manage.py provision_dev_agent_ready
  ); then
    echo "  ⚠ dev Agent Provider 开通跳过/失败（不阻塞启动；可手动跑 python manage.py provision_dev_agent_ready）。"
  fi
fi

echo "  ✅ 数据库就绪"
