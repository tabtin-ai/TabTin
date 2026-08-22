"""
TabSlide 统一后置保存操作（Single Entry Point）

所有保存路径（collab-persist、save_pages、save_pages_incremental 等）
在事务提交后都应调用此模块的 run_post_save_hooks()，确保：
  1. 每条路径获得相同的辅助操作
  2. 任何辅助操作的失败都不影响已提交的核心数据
  3. 新增辅助操作只需改一处

设计原则：
  - 所有操作都有 try-except 保护，失败仅记录日志
  - 调用方已完成 transaction.atomic 提交核心数据（SlidePage + version）
  - 此函数中的操作全部是 "尽力而为"（best-effort）
"""

from __future__ import annotations

import logging
from apps.services.common.db_router import postgres_app_db_alias
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from apps.tabslide.models import SlideProject

logger = logging.getLogger(__name__)


def run_post_save_hooks(
    project: SlideProject,
    *,
    version: int,
    pages_affected: list[str] | None = None,
    change_type: str,
    summary: str = "",
    editor_type: str = "",
    editor_id: str = "",
    create_history: bool = False,
    force_history: bool = False,
    agent_run_id: str = "",
) -> None:
    """
    统一的事务后辅助操作入口。

    参数：
        project:         已更新版本号的 SlideProject 实例
        version:         本次保存的版本号
        pages_affected:  受影响的 page_id 列表
        change_type:     变更类型（如 "save_pages", "collab_persist"）
        summary:         变更摘要
        editor_type:     编辑者类型（"user" / "agent" / "system"），collab 框架统一枚举
        editor_id:       编辑者 ID
        create_history:  是否创建历史快照（异步优先，同步降级）
        force_history:   是否强制创建（跳过时间间隔检查）
        agent_run_id:    Agent 运行 ID（用于 ChangeLog 关联，支持回滚）
    """

    # 全入口规范化 editor_type：确保 SlideChange / WS / EventBus 等
    # 所有下游分支都使用 collab 框架统一枚举 (user/agent/system)。
    if editor_type == "human":
        editor_type = "user"

    # ── 1. 页面级脏标记（增量 PPTX 缓存） ──
    if pages_affected:
        try:
            from apps.tabslide.services.pptx_cache import mark_pages_dirty
            mark_pages_dirty(project.id, pages_affected)
        except Exception:
            logger.warning(
                "post_save: mark_pages_dirty failed for project=%s (non-fatal)",
                project.id, exc_info=True,
            )
        _pregenerate_pptx_best_effort(project)

    # ── 2. 变更审计记录 ──
    try:
        from apps.tabslide.models import SlideChange
        SlideChange.objects.using(postgres_app_db_alias()).create(
            project=project,
            version=version,
            change_type=change_type,
            summary=summary,
            pages_affected=pages_affected,
            editor_type=editor_type,
            editor_id=editor_id,
            agent_run_id=agent_run_id,
        )
    except Exception:
        logger.warning(
            "post_save: _record_change failed for project=%s type=%s (non-fatal)",
            project.id, change_type, exc_info=True,
        )

    # ── 3. 同步 page_count 统计字段 ──
    _sync_page_count(project)

    # ── 4. 版本历史（统一走 VersionHistory，SlideHistory 已停止写入） ──

    # ── 4.5 统一版本历史 + 变更记录（VersionHistory + ChangeLog） ──
    # restore 路径由 VersionHistoryService.restore_to_version 负责写入，此处跳过避免重复
    _RESTORE_CHANGE_TYPES = ("undo_agent_edit", "restore_history")
    if create_history and change_type not in _RESTORE_CHANGE_TYPES:
        _write_unified_version_best_effort(
            project,
            editor_type=editor_type,
            editor_id=editor_id,
            change_type=change_type,
            summary=summary,
            agent_run_id=agent_run_id,
            force=force_history,
        )

    # ── 5. WebSocket 推送（DB-first 变更通知前端） ──
    _push_ws_change_notification(
        project,
        version=version,
        pages_affected=pages_affected,
        change_type=change_type,
        editor_type=editor_type,
        editor_id=editor_id,
    )

    # ── 6. EventBus 桥接（content.saved） ──
    _bridge_to_event_bus(
        project, change_type=change_type,
        editor_type=editor_type, editor_id=editor_id,
    )


def _pregenerate_pptx_best_effort(project: SlideProject) -> None:
    """尽力触发异步 PPTX 预生成，不影响主流程。"""
    try:
        from apps.tabslide.tasks import pregenerate_pptx
        pregenerate_pptx.delay(str(project.id))
    except Exception as exc:
        from apps.maintenance.celery_utils import is_broker_connection_error
        if not is_broker_connection_error(exc):
            logger.warning(
                "post_save: pregenerate_pptx enqueue failed for project=%s (non-fatal)",
                project.id, exc_info=True,
            )


def _push_ws_change_notification(
    project: SlideProject,
    *,
    version: int,
    pages_affected: list[str] | None = None,
    change_type: str = "",
    editor_type: str = "",
    editor_id: str = "",
) -> None:
    """Push a WebSocket notification so frontends learn about DB-first writes.

    When the Y.js-first path is unavailable (collab-live down, Agent
    fallback), data is written directly to DB.  Without this push,
    connected frontends stay stale until a manual refresh (XC-04/SP1-11).
    """
    try:
        from apps.services.common.ws.bus import publish_ws_event
        from apps.services.common.ws.protocol import build_envelope, new_event_id

        project_id = str(project.id)
        event_id = new_event_id()
        envelope = build_envelope(
            "slide.events.content_changed",
            event_id,
            {
                "project_id": project_id,
                "version": version,
                "pages_affected": pages_affected or [],
                "change_type": change_type,
                "editor_type": editor_type,
                "editor_id": editor_id,
            },
            event_id=event_id,
        )
        publish_ws_event(f"slide.events.{project_id}", envelope)
    except Exception:
        logger.warning(
            "post_save: WS push failed for project=%s (non-fatal)",
            project.id, exc_info=True,
        )


def _bridge_to_event_bus(
    project: SlideProject,
    *,
    change_type: str = "",
    editor_type: str = "",
    editor_id: str = "",
) -> None:
    """将幻灯片保存事件桥接到 EventBus，供 TabAgenda Goal 等自动化消费。"""
    try:
        from apps.extensions.event_bus import Event, EventBus
        event = Event(
            source="tabslide",
            event_type="tabslide.content.saved",
            organization_id=str(project.organization_id),
            space_id=str(project.space_id) if project.space_id else None,
            payload={
                "resource_id": str(project.id),
                "resource_type": "tabslide",
                "title": project.name or "",
                "action": "saved",
                "change_type": change_type,
                "editor_type": editor_type,
                "editor_id": editor_id,
            },
        )
        EventBus.emit(event)
    except Exception:
        logger.warning(
            "post_save: EventBus emit failed for project=%s (non-fatal)",
            project.id, exc_info=True,
        )


def _sync_page_count(project: SlideProject) -> None:
    """根据实际 SlidePage 行数同步 SlideProject.page_count。"""
    try:
        from apps.tabslide.models import SlidePage, SlideProject as SP
        actual = SlidePage.objects.using(postgres_app_db_alias()).filter(
            project_id=project.id,
        ).count()
        SP.objects.using(postgres_app_db_alias()).filter(
            id=project.id,
        ).exclude(
            page_count=actual,
        ).update(page_count=actual)
    except Exception:
        logger.warning(
            "post_save: sync_page_count failed for project=%s (non-fatal)",
            project.id, exc_info=True,
        )


def _write_unified_version_best_effort(
    project: SlideProject,
    *,
    editor_type: str = "",
    editor_id: str = "",
    change_type: str = "",
    summary: str = "",
    agent_run_id: str = "",
    force: bool = False,
) -> None:
    """
    将 DB-first 路径的编辑同步写入统一 collab 框架的 VersionHistory + ChangeLog，
    使其对前端版本历史 UI、空间检查点和 Agent 回滚可见。

    解决问题：
      TSV-002: 前端版本历史 UI 不可见
      TSV-004: restore 回退到更早的 collab 版本
      TSV-005: 空间检查点不完整
      TSV-006: rollback_agent_run 对 DB-first Agent 编辑无效

    TSV-006 修复：VH 和 CL 在同一个 transaction.atomic 事务中写入，
    确保要么都成功、要么都失败，消除以下两种不一致状态：
      - VH 成功但 CL 失败 → 孤立 VH，rollback_agent_run 找不到变更
      - CL 成功但 VH 失败 → 幽灵 CL（version_history=NULL），rollback 跳过

    CSC-013 对齐：Redis 锁在事务外申请/释放（与 collab_persist 路径共享锁），
    避免在 DB 事务内执行 Redis IO。

    E2E-003: Agent 路径强制 force_snapshot=True，避免 HISTORY_MIN_INTERVAL 限制
             导致短时间内多次 save_pages 无对应 VH，rollback 回滚到更早版本。
    """
    # CSC-019: 规范化 editor_type — 源头 _editor_info() 已改为 "user"，
    # 保留此防御性转换以兼容外部调用方仍传入旧值 "human" 的情况。
    if editor_type == "human":
        editor_type = "user"

    # E2E-003: Agent 路径必须强制创建快照，不受 HISTORY_MIN_INTERVAL 限制
    effective_force = force or (editor_type == "agent")

    # ── 阶段 1：准备数据（任何异常都记录告警后退出） ──
    try:
        from apps.collab.adapters.slide import SlideCollabAdapter
        from apps.collab.models import ChangeLog
        from apps.collab.service import VersionHistoryService, CREATE_HISTORY_LOCK_TTL

        adapter = SlideCollabAdapter()
        version_data = adapter.get_version_data(project)
        if version_data is None:
            return

        editor_info = {
            "editor_type": editor_type,
            "editor_id": editor_id,
            "editor_name": "",
        }

        svc = VersionHistoryService(adapter)
        organization_id = getattr(project, "organization_id", None)
    except Exception:
        logger.warning(
            "post_save: _write_unified_version_best_effort setup failed for project=%s (non-fatal)",
            project.id, exc_info=True,
        )
        return

    # ── 阶段 2：解析 agent_run_id / session_id ──
    effective_agent_run_id = agent_run_id
    if not effective_agent_run_id and editor_type == "agent":
        try:
            from apps.services.common.platform_context import get_current_run_id
            effective_agent_run_id = get_current_run_id() or ""
        except ImportError:
            pass

    # QC-05: session_id 从 ContextVar 兜底读取（与 agent_run_id 对称）
    effective_session_id = ""
    try:
        from apps.services.common.platform_context import get_current_session_id
        effective_session_id = get_current_session_id() or ""
    except ImportError:
        pass

    # ── 阶段 3：Redis 锁 + 恢复锁检查（在事务外执行，CSC-013 对齐） ──
    # CC-008: restore 进行中时跳过，防止 diff 指向 restore 前快照导致版本链断裂
    from django.core.cache import cache

    restore_lock_key = f"collab:restore_lock:slide:{project.id}"
    try:
        if cache.get(restore_lock_key) == 1:
            logger.info(
                "post_save: restore in progress for slide:%s, deferring VH+CL write",
                project.id,
            )
            return
    except Exception:
        pass

    # CSC-013: 与 collab_persist 路径共享同一把 create_history_lock，
    # 序列化两条路径对 VersionHistory 的写入，消除 base_history 指向竞争
    lock_key = f"collab:create_history_lock:slide:{project.id}"
    try:
        lock_acquired = cache.add(lock_key, 1, CREATE_HISTORY_LOCK_TTL)
    except Exception:
        logger.warning(
            "post_save: Redis unavailable for VH lock slide:%s, "
            "skipping VH+CL write to prevent sibling diffs (non-fatal)",
            project.id,
        )
        return

    if not lock_acquired:
        logger.warning(
            "post_save: VH lock contention for slide:%s, skipping VH+CL write (non-fatal)",
            project.id,
        )
        return

    # ── 阶段 4：VH + CL 在同一事务中写入（TSV-006 修复核心） ──
    try:
        from django.db import transaction as db_transaction

        with db_transaction.atomic(using=postgres_app_db_alias()):
            vh = svc._do_create_history(
                project.id,
                version_data,
                editor_info,
                force_snapshot=effective_force,
                organization_id=organization_id,
            )

            if vh is None:
                # 无变更或间隔过短，跳过 CL 写入（符合规范：VH 无记录时不写 CL）
                return

            ChangeLog.objects.using(postgres_app_db_alias()).create(
                resource_type="slide",
                resource_id=project.id,
                change_type=change_type or "update",
                summary=summary,
                editor_type=editor_type,
                editor_id=editor_id,
                agent_run_id=effective_agent_run_id,
                session_id=effective_session_id,
                version_history=vh,
            )
    except Exception:
        # TSV-006: 事务回滚后 VH 和 CL 都不会写入，不会产生不一致状态。
        # 使用 error 级别日志 + 结构化信息，便于监控和排查。
        logger.error(
            "post_save: VH+CL atomic write failed for project=%s agent_run_id=%s "
            "(transaction rolled back, rollback_agent_run will not see this change)",
            project.id, effective_agent_run_id or "(empty)", exc_info=True,
        )
    finally:
        try:
            cache.delete(lock_key)
        except Exception:
            logger.warning(
                "post_save: failed to release VH lock for slide:%s "
                "(will auto-expire in %ds)",
                project.id, CREATE_HISTORY_LOCK_TTL,
            )
