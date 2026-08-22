"""W3.0 / D27：bulk_update on_commit 异步化的 Celery 任务。

把原本在 ``ChangeLogSubscriber._write_change_log`` 闭包内、由 ``on_commit``
触发的 VersionHistory + ChangeLog 写入剥离到这里执行，让
``RecordService.bulk_update_records`` 函数返回时不再被同步阻塞。

ContextVar 透传依赖 ``apps.services.agent_engine.context.celery_signals`` 的
``task_prerun`` 钩子（已存在）：``agent_run_id`` / ``session_id`` /
``api_key_organization_id`` 通过 task kwargs 传入，prerun 自动恢复到
ContextVar，因此 ``perform_changelog_write`` 内部的 ``editor_type``
判定 / RH TTL 解析等行为与同步路径完全一致。

本模块特意只依赖 ``perform_changelog_write``，避免 reimplement——
该函数同时被同步降级路径复用，保证两条路径行为单源。
"""
from __future__ import annotations

import logging
from typing import List, Optional

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    bind=True,
    name="tabdata.async_collab_changelog_after_records",
    # 不启用 Celery 自动重试：``perform_changelog_write`` 内部已 try/except
    # 把所有异常吞为 warning（与 W2 同步路径行为单源），因此本任务体几乎不会向
    # Celery 抛异常 → ``autoretry_for`` 形同虚设（Review 技术 P1）。
    # 真要重试，必须先让 ``perform_changelog_write`` 把"应重试"的异常向外抛，
    # 同时重新设计 counter 的 incr/decr 边界（重试期间 finally 已 decr →
    # wait 提前结束 → 重试漏等的 race）。当前选择：失败即丢失，与原 W2 同步
    # 路径"warning + 不阻塞主链路"的承诺一致；ChangeLog/VH 缺失对 D2 的影响
    # 已在主线程 ``wait_for_pending_changelogs`` 超时窗口内承诺为 best-effort。
    max_retries=0,
    ignore_result=True,
    soft_time_limit=60,
    time_limit=120,
    # 默认队列即可——本任务很轻（PG 一次写），不应抢占 critical/heavy 队列。
)
def async_collab_changelog_after_records(
    self,
    *,
    table_id: str,
    change_type: str,
    record_ids: List[str],
    record_count: int,
    user_id: str = "",
    agent_run_id: str = "",
    session_id: str = "",
    api_key_organization_id: str = "",
) -> None:
    """异步执行 VersionHistory + ChangeLog 写入。

    参数与 ``perform_changelog_write`` 对齐。``api_key_organization_id`` 由
    ``celery_signals.task_prerun`` 自动恢复到 ContextVar，不需要本任务显式
    使用——保留 kwargs 是因为 prerun 从 kwargs 读。

    Pending counter 由 ``finally`` 块释放，保证主线程
    ``wait_for_pending_changelogs`` 不会因任务异常永久卡住。
    """
    from apps.tabdata.services.async_changelog import (
        decr_pending_changelog, perform_changelog_write,
    )

    try:
        perform_changelog_write(
            table_id=table_id,
            change_type=change_type,
            record_ids=record_ids or [],
            record_count=record_count,
            user_id=user_id or None,
            agent_run_id=agent_run_id,
            session_id=session_id,
        )
    except Exception:
        # ``perform_changelog_write`` 内部已吞所有 PG/Redis 异常；这里只是
        # 防御层：即便未来内部改为向上抛错，我们也仍 finally decr counter，
        # 避免 phantom pending 拖累后续 Checkpoint barrier。把异常向上抛
        # 让 Celery worker 把任务标记为 FAILED（但 max_retries=0 不重试）。
        logger.error(
            "[async_collab_changelog] unexpected exception (perform was supposed "
            "to swallow internal errors): table=%s type=%s run=%s",
            table_id, change_type, agent_run_id, exc_info=True,
        )
        raise
    finally:
        if agent_run_id:
            decr_pending_changelog(agent_run_id)
