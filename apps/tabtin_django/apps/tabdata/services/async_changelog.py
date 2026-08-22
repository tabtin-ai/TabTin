"""W3.0 / D27：bulk_update on_commit 异步化。

把 ChangeLogSubscriber 在 on_commit 后的 VersionHistory + ChangeLog 写入剥离到
Celery 任务，让 ``RecordService.bulk_update_records`` 函数返回时不再被 ~2s
的 collab snapshot + VH 写入阻塞（W2.perf 实测 A2 500 行 warm 3.4s 中
on_commit 占 ~2s）。

设计要点
--------

1. **Feature flag**：``settings.TABDATA_BULK_UPDATE_ASYNC_COLLAB`` 默认 ``True``。
   关闭时回退到原同步路径（``ChangeLogSubscriber._write_change_log`` 内嵌实现），
   保留灰度退路。

2. **ContextVar 透传**：用 :func:`apps.services.agent_engine.context.celery_signals._setup_run_id_for_celery_task`
   既有的 ``task_prerun`` 机制，task kwargs 携带 ``agent_run_id`` /
   ``session_id`` / ``api_key_organization_id`` / ``user_id`` 即可在 worker 端恢复
   ContextVar，与 W1.2 已对齐。

3. **Checkpoint 协调（D2 承诺）**：``TableResourceContributor`` 通过反查
   ``ChangeLog WHERE agent_run_id IN (...)`` 收集 ``version_refs``——若 Celery
   任务还没完成，:func:`apps.collab.services.contributors.collect_contributed_resources`
   会漏掉本次 turn 的 table，导致 Checkpoint rollback 时无法回滚 tabdata 写入。

   解决：在 ``_create_space_checkpoint`` 创建 Checkpoint 之前调
   :func:`wait_for_pending_changelogs(agent_run_id)`，spin-wait Redis 计数器
   到 0（或 timeout）。计数器在主线程 ``incr_pending_changelog`` 后由 Celery
   任务在 ``finally`` 块内 ``decr_pending_changelog``，保证异常路径也释放。

4. **EAGER 模式正确性**：当 ``CELERY_TASK_ALWAYS_EAGER=True``（pytest-django
   测试）时，``apply_async`` 同步执行任务，``incr → task → decr`` 在同一线程
   内顺序完成，``wait_for_pending_changelogs`` 看到的计数器永远是 0 → 立即返回，
   行为与同步路径等价。

5. **Redis 不可用降级**：counter 调用全部 try/except，Redis 不可用时
   wait_for_pending_changelogs 立即返回（只 warn 一行），主链路不阻塞——
   代价是该极端场景下 Checkpoint version_refs 可能漏收（与异步化的 race
   等价），与"counter 同步路径不变"原则对齐。
"""
from __future__ import annotations

import logging
import time
from typing import List, Optional

from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

# ── Feature flag ─────────────────────────────────────────────

_FLAG_NAME = "TABDATA_BULK_UPDATE_ASYNC_COLLAB"


def is_async_changelog_enabled() -> bool:
    """运行时读 settings flag，默认 ``True``（启用异步）。"""
    return bool(getattr(settings, _FLAG_NAME, True))


# ── Pending counter（Checkpoint 协调用）──────────────────────

_COUNTER_KEY_PREFIX = "tabdata:pending_cl:"
_COUNTER_TTL_SECONDS = 600  # 兜底：极端 worker 崩溃场景 10 分钟自动清理
_DEFAULT_WAIT_TIMEOUT_MS = int(
    getattr(settings, "TABDATA_PENDING_CHANGELOG_WAIT_TIMEOUT_MS", 5000)
    if hasattr(settings, "TABDATA_PENDING_CHANGELOG_WAIT_TIMEOUT_MS")
    else 5000
)
_DEFAULT_WAIT_INTERVAL_MS = 25  # 25ms 间隔轮询，~200 次到 5s timeout


def _counter_key(agent_run_id: str) -> str:
    return f"{_COUNTER_KEY_PREFIX}{agent_run_id}"


def incr_pending_changelog(agent_run_id: str) -> None:
    """主线程 dispatch Celery 任务前调用，标记 1 个 pending changelog 写入。

    Redis 不可用时静默吞异常（D2 承诺降级：宁可漏收 version_refs 也不阻塞主链路）。
    """
    if not agent_run_id:
        return
    try:
        key = _counter_key(agent_run_id)
        try:
            new_val = cache.incr(key)
        except ValueError:
            cache.set(key, 0, _COUNTER_TTL_SECONDS)
            new_val = cache.incr(key)
        cache.expire(key, _COUNTER_TTL_SECONDS)
        logger.debug("[async_changelog] incr pending=%s for run=%s", new_val, agent_run_id)
    except Exception:
        logger.warning(
            "[async_changelog] incr_pending failed for run=%s (continuing without counter)",
            agent_run_id, exc_info=True,
        )


def decr_pending_changelog(agent_run_id: str) -> None:
    """Celery 任务 finally 块内调用，释放 1 个 pending changelog 写入。

    - 必须放在 ``finally`` 内：异常路径也要 decr，否则计数器永久卡住，导致
      后续 Checkpoint 创建 spin-wait 直到 timeout。
    - 计数若被错误 reset 到 0 导致 decr 抛 ValueError，静默吞掉（不存在的 key
      decrement 在 LocMem cache 会报错）。
    """
    if not agent_run_id:
        return
    try:
        key = _counter_key(agent_run_id)
        try:
            new_val = cache.decr(key)
        except ValueError:
            new_val = 0
        if isinstance(new_val, int) and new_val < 0:
            cache.set(key, 0, _COUNTER_TTL_SECONDS)
        logger.debug("[async_changelog] decr pending=%s for run=%s", new_val, agent_run_id)
    except Exception:
        logger.warning(
            "[async_changelog] decr_pending failed for run=%s",
            agent_run_id, exc_info=True,
        )


def get_pending_count(agent_run_id: str) -> int:
    if not agent_run_id:
        return 0
    try:
        val = cache.get(_counter_key(agent_run_id))
        if val is None:
            return 0
        return int(val)
    except Exception:
        logger.debug("[async_changelog] get_pending_count failed", exc_info=True)
        return 0


def wait_for_pending_changelogs(
    agent_run_id: str,
    *,
    timeout_ms: Optional[int] = None,
    interval_ms: Optional[int] = None,
) -> bool:
    """Spin-wait 该 ``agent_run_id`` 的 pending 计数到 0。

    :returns: ``True`` 表示成功等到 0（含 ``agent_run_id`` 为空的快路径），
              ``False`` 表示超时 / Redis 不可用（caller 可决定是否打 warning
              并继续，本任务的策略是"打 warning 但继续创建 Checkpoint"）。
    """
    if not agent_run_id:
        return True
    timeout_ms = timeout_ms if timeout_ms is not None else _DEFAULT_WAIT_TIMEOUT_MS
    interval_ms = interval_ms if interval_ms is not None else _DEFAULT_WAIT_INTERVAL_MS

    deadline = time.monotonic() + (timeout_ms / 1000.0)
    interval_s = max(interval_ms, 1) / 1000.0

    while True:
        pending = get_pending_count(agent_run_id)
        if pending <= 0:
            return True
        if time.monotonic() >= deadline:
            logger.warning(
                "[async_changelog] wait_for_pending timed out: run=%s pending=%s "
                "(Checkpoint version_refs may miss this turn)",
                agent_run_id, pending,
            )
            return False
        time.sleep(interval_s)


def reset_pending_changelog(agent_run_id: str) -> None:
    """单元测试 / 兜底场景手动清零。"""
    if not agent_run_id:
        return
    try:
        cache.delete(_counter_key(agent_run_id))
    except Exception:
        pass


# ── ChangeLog 写入实现（被同步 / 异步路径共享）────────────────

def perform_changelog_write(
    *,
    table_id: str,
    change_type: str,
    record_ids: List[str],
    record_count: int,
    user_id: Optional[str],
    agent_run_id: str = "",
    session_id: str = "",
) -> None:
    """W2.perf-fix2 抽出的 ChangeLog + VersionHistory 写入实现。

    与原 ``ChangeLogSubscriber._write_change_log`` 内嵌的 ``_write`` 闭包行为
    保持完全一致，仅做以下调整：

    - 把闭包变量 ``agent_run_id`` / ``session_id`` 改为显式参数（Celery 任务
      路径下，ContextVar 由 ``task_prerun`` 恢复，但本函数依然用显式参数避免
      隐式依赖）。
    - 异常吞掉只 warn，与原行为一致（写 ChangeLog 失败不应阻塞主链路）。

    必须在 PG 事务外调用——内部自带 ``with db_tx.atomic(using="postgresql")``。
    """
    try:
        from apps.collab.registry import get_adapter
        from apps.collab.service import VersionHistoryService
        from apps.collab.models import ChangeLog

        adapter = get_adapter("table")
        if not adapter:
            return

        resource = adapter.get_resource(table_id)
        if not resource:
            return

        version_data = adapter.get_version_data(resource)
        if version_data is None:
            return

        if agent_run_id:
            cl_editor_type = "agent"
        elif user_id:
            cl_editor_type = "user"
        else:
            cl_editor_type = "system"

        editor_info = {
            "editor_type": cl_editor_type,
            "editor_id": user_id or "",
            "editor_name": "",
        }

        is_truncated = (
            isinstance(version_data, dict)
            and version_data.get("is_truncated", False)
        )
        is_agent_context = bool(agent_run_id)

        svc = VersionHistoryService(adapter)
        organization_id = getattr(resource, "organization_id", None)

        from django.db import transaction as db_tx
        with db_tx.atomic(using="postgresql"):
            vh = svc.create_history(
                resource.id,
                version_data,
                editor_info,
                force_snapshot=is_truncated,
                skip_throttle=is_agent_context,
                organization_id=organization_id,
            )
            ChangeLog.objects.using("postgresql").create(
                resource_type="table",
                resource_id=resource.id,
                change_type=change_type,
                summary="",
                changes={
                    "record_ids": record_ids[:50],
                    "record_count": record_count,
                },
                editor_type=cl_editor_type,
                editor_id=user_id or "",
                version_history=vh,
                agent_run_id=agent_run_id,
                session_id=session_id,
            )
    except Exception as exc:
        logger.warning(
            "[async_changelog] perform_changelog_write failed: table=%s type=%s err=%s",
            table_id, change_type, exc,
        )


# ── 主线程入口：根据 flag 选择 sync / async 路径 ─────────────

def dispatch_collab_changelog(
    *,
    table_id: str,
    change_type: str,
    record_ids: List[str],
    record_count: int,
    user_id: Optional[str],
    agent_run_id: str = "",
    session_id: str = "",
) -> None:
    """根据 ``TABDATA_BULK_UPDATE_ASYNC_COLLAB`` flag 决定同步 / 异步执行。

    - flag 为 ``True``（默认）：``incr pending`` → ``Celery delay``（worker
      内 ``perform_changelog_write`` → ``decr pending``）。
    - flag 为 ``False``：直接 inline 调用 ``perform_changelog_write``，与
      W2 之前行为完全一致。
    - EAGER 模式：``apply_async`` 同步跑任务，counter 立即归零。

    本函数被 ``ChangeLogSubscriber._write_change_log`` 在 ``run_after_commit``
    回调中调用，调用时已经在 PG 事务**之外**——``perform_changelog_write``
    内部再开自己的 atomic 块写 PG。
    """
    if not is_async_changelog_enabled():
        perform_changelog_write(
            table_id=table_id,
            change_type=change_type,
            record_ids=record_ids,
            record_count=record_count,
            user_id=user_id,
            agent_run_id=agent_run_id,
            session_id=session_id,
        )
        return

    # 透传 ContextVar：从主线程读 api_key_organization_id 等附加约束
    api_key_organization_id = ""
    try:
        from apps.users.auth.api_key_context import get_api_key_organization_constraint
        api_key_organization_id = get_api_key_organization_constraint() or ""
    except Exception:
        pass

    incr_pending_changelog(agent_run_id)

    try:
        from apps.tabdata.tasks.collab_changelog_tasks import (
            async_collab_changelog_after_records,
        )
        async_collab_changelog_after_records.apply_async(
            kwargs={
                "table_id": str(table_id),
                "change_type": change_type,
                "record_ids": [str(r) for r in record_ids],
                "record_count": int(record_count),
                "user_id": str(user_id) if user_id else "",
                "agent_run_id": agent_run_id or "",
                "session_id": session_id or "",
                "api_key_organization_id": api_key_organization_id,
            },
        )
    except Exception:
        # apply_async 异常（broker 不可用）→ 立即降级到同步执行 + 立刻 decr
        # counter，保证不留 phantom pending 拖累后续 Checkpoint。
        decr_pending_changelog(agent_run_id)
        logger.warning(
            "[async_changelog] apply_async failed, falling back to sync write: "
            "table=%s type=%s",
            table_id, change_type, exc_info=True,
        )
        perform_changelog_write(
            table_id=table_id,
            change_type=change_type,
            record_ids=record_ids,
            record_count=record_count,
            user_id=user_id,
            agent_run_id=agent_run_id,
            session_id=session_id,
        )


__all__ = [
    "is_async_changelog_enabled",
    "incr_pending_changelog",
    "decr_pending_changelog",
    "get_pending_count",
    "wait_for_pending_changelogs",
    "reset_pending_changelog",
    "perform_changelog_write",
    "dispatch_collab_changelog",
]
