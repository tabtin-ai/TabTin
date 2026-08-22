"""
ChatMessage 定期清理 / 归档任务

CV-01: ChatMessage 在 MySQL 上无限增长，需要定期清理过早的消息
       保留 session 最近 N 条消息，超出部分软删除或物理删除。
"""

import logging
import time
import uuid
from datetime import timedelta

from celery import shared_task
from celery.schedules import crontab
from django.db import OperationalError
from django.utils import timezone

logger = logging.getLogger(__name__)

_DELETE_BATCH_SIZE = 1000
_MAX_BATCHES = 500
DEFAULT_RETENTION_DAYS = 90
_SESSION_SHARE_REFRESH_BATCH_SIZE = 100
_SESSION_SHARE_RESOURCE_SYNC_BATCH_SIZE = 100
_SESSION_SHARE_RESOURCE_SYNC_MAX_ATTEMPTS = 8
_SESSION_SHARE_RESOURCE_SYNC_STALE_MINUTES = 5


@shared_task(
    name="conversation.retry_session_share_card_refresh",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=110,
)
def retry_session_share_card_refresh(share_id: str | None = None) -> dict:
    """重试授权事实已提交、IM 卡片投影尚未确认的共享。"""
    from apps.chat.conversation.models import SessionShare
    from apps.chat.conversation.services import session_share_card_service

    share_ids = (
        [share_id]
        if share_id
        else list(
            SessionShare.objects.filter(
                status__in=("active", "revoked"),
                card_refresh_status="unconfirmed",
            )
            .order_by("created_at")
            .values_list("id", flat=True)[:_SESSION_SHARE_REFRESH_BATCH_SIZE]
        )
    )
    refreshed = 0
    failed = 0
    for candidate_id in share_ids:
        try:
            if session_share_card_service.retry_unconfirmed_card_refresh(
                share_id=str(candidate_id),
            ):
                refreshed += 1
        except Exception:
            failed += 1
            logger.exception(
                "[session-share] card refresh retry failed: share=%s",
                candidate_id,
            )
    return {"refreshed": refreshed, "failed": failed}


@shared_task(
    name="conversation.sync_session_share_resource_grants",
    ignore_result=True,
    time_limit=300,
    soft_time_limit=270,
)
def sync_session_share_resource_grants(job_id: str | None = None) -> dict:
    """消费持久化 ACL 同步任务；Beat 会补偿提交后 broker 不可用的情况。"""
    from django.db import transaction
    from django.db.models import Q
    from apps.chat.conversation.models import SessionShareResourceSyncJob
    from apps.chat.conversation.services.session_share_resource_permission_service import (
        sync_active_session_share_resource_grants_for_message,
    )

    now = timezone.now()
    stale_before = now - timedelta(minutes=_SESSION_SHARE_RESOURCE_SYNC_STALE_MINUTES)
    candidates = SessionShareResourceSyncJob.objects.filter(
        Q(status="pending")
        | Q(status="retry", next_retry_at__lte=now)
        | Q(status="processing", updated_at__lte=stale_before),
    )
    if job_id:
        candidates = candidates.filter(id=job_id)
    job_ids = list(
        candidates.order_by("created_at").values_list("id", flat=True)[
            :_SESSION_SHARE_RESOURCE_SYNC_BATCH_SIZE
        ],
    )
    completed = failed = 0
    for candidate_id in job_ids:
        with transaction.atomic():
            job = SessionShareResourceSyncJob.objects.select_for_update().filter(
                id=candidate_id,
            ).filter(
                Q(status__in=("pending", "retry"))
                | Q(status="processing", updated_at__lte=stale_before),
            ).first()
            if job is None:
                continue
            job.status = "processing"
            job.attempts += 1
            job.save(update_fields=["status", "attempts", "updated_at"])
        try:
            sync_active_session_share_resource_grants_for_message(message=job.message)
        except Exception as exc:
            failed += 1
            delay_minutes = min(2 ** max(job.attempts - 1, 0), 60)
            job.status = (
                "dead"
                if job.attempts >= _SESSION_SHARE_RESOURCE_SYNC_MAX_ATTEMPTS
                else "retry"
            )
            job.next_retry_at = now + timedelta(minutes=delay_minutes)
            job.last_error = str(exc)[:4000]
            job.save(update_fields=[
                "status", "next_retry_at", "last_error", "updated_at",
            ])
            logger.exception("[session-share] resource ACL sync failed: job=%s", job.id)
        else:
            completed += 1
            job.status = "done"
            job.next_retry_at = None
            job.last_error = ""
            job.save(update_fields=[
                "status", "next_retry_at", "last_error", "updated_at",
            ])
    return {"completed": completed, "failed": failed}


@shared_task(
    name='conversation.refresh_handoff_im_projection',
    bind=True,
    max_retries=5,
    ignore_result=True,
    queue='realtime_delivery',
    acks_late=True,
)
def refresh_handoff_im_projection(self, event_id: int) -> int:
    """把交接对象的新版本投影到原 IM 卡片消息。"""
    from apps.chat.conversation.services.im_business_projection_service import (
        PermanentIMBusinessProjectionError,
        TransientIMBusinessProjectionError,
        refresh_user_business_projection,
    )
    from apps.tabchat.constants import MessageType
    from apps.tabchat.handoff.models import HandoffEvent
    from apps.tabchat.handoff.service import HandoffService

    event = HandoffEvent.objects.select_related('package').filter(pk=event_id).first()
    if event is None or event.package.card_message_ref is None:
        return 0

    package = event.package
    try:
        refresh_user_business_projection(
            organization_id=str(package.organization_id),
            message_ref=str(package.card_message_ref),
            business_projection_revision=str(uuid.uuid5(
                uuid.NAMESPACE_URL,
                f'tabtin:handoff-event:{event.pk}',
            )),
            content=f'[交接] {package.goal}',
            message_type=MessageType.TEXT,
            metadata={'card': HandoffService._build_card_snapshot(package)},
        )
    except PermanentIMBusinessProjectionError as exc:
        logger.warning('交接 IM 卡片刷新被拒绝: event=%s error=%s', event_id, exc)
        return 0
    except TransientIMBusinessProjectionError as exc:
        raise self.retry(exc=exc, countdown=min(2 ** self.request.retries, 30))
    return 1


@shared_task(
    name='conversation.refresh_handoff_im_projection',
    bind=True,
    max_retries=5,
    ignore_result=True,
    queue='realtime_delivery',
    acks_late=True,
)
def refresh_handoff_im_projection(self, event_id: int) -> int:
    """把交接对象的新版本投影到原 IM 卡片消息。"""
    from apps.chat.conversation.services.im_business_projection_service import (
        PermanentIMBusinessProjectionError,
        TransientIMBusinessProjectionError,
        refresh_user_business_projection,
    )
    from apps.tabchat.constants import MessageType
    from apps.tabchat.handoff.models import HandoffEvent
    from apps.tabchat.handoff.service import HandoffService

    event = HandoffEvent.objects.select_related('package').filter(pk=event_id).first()
    if event is None or event.package.card_message_ref is None:
        return 0

    package = event.package
    try:
        refresh_user_business_projection(
            organization_id=str(package.organization_id),
            message_ref=str(package.card_message_ref),
            business_projection_revision=str(uuid.uuid5(
                uuid.NAMESPACE_URL,
                f'tabtin:handoff-event:{event.pk}',
            )),
            content=f'[交接] {package.goal}',
            message_type=MessageType.TEXT,
            metadata={'card': HandoffService._build_card_snapshot(package)},
        )
    except PermanentIMBusinessProjectionError as exc:
        logger.warning('交接 IM 卡片刷新被拒绝: event=%s error=%s', event_id, exc)
        return 0
    except TransientIMBusinessProjectionError as exc:
        raise self.retry(exc=exc, countdown=min(2 ** self.request.retries, 30))
    return 1


@shared_task(
    ignore_result=True,
    time_limit=1800,
    soft_time_limit=1740,
)
def cleanup_old_chat_messages(retention_days: int = DEFAULT_RETENTION_DAYS):
    """删除超过保留期的 ChatMessage，分两步执行。

    策略：
    1. 清理已归档/已完成 session 中超过 retention_days 的消息
    2. 清理活跃 session 中超过 retention_days 的消息
    分批删除避免长事务锁表，每步最多 _MAX_BATCHES 轮（50 万条）。
    """
    from apps.chat.conversation.models import ChatMessage, ChatSession

    cutoff = timezone.now() - timedelta(days=retention_days)
    total_deleted = 0
    batches_used = 0

    # --- 第一步：清理已归档 session ---
    inactive_session_ids = list(
        ChatSession.objects.filter(status__in=['archived', 'completed'])
        .values_list('id', flat=True)
    )

    if inactive_session_ids:
        for batch_start in range(0, len(inactive_session_ids), 200):
            sid_batch = inactive_session_ids[batch_start:batch_start + 200]
            for _ in range(_MAX_BATCHES):
                batch_ids = list(
                    ChatMessage.objects
                    .filter(session_id__in=sid_batch, created_at__lt=cutoff)
                    .values_list('id', flat=True)[:_DELETE_BATCH_SIZE]
                )
                if not batch_ids:
                    break
                deleted, _ = ChatMessage.objects.filter(id__in=batch_ids).delete()
                total_deleted += deleted
                batches_used += 1
                time.sleep(0.05)

    # --- 第二步：清理活跃 session 中超过 retention_days 的旧消息 ---
    active_deleted = 0
    for _ in range(_MAX_BATCHES):
        batch_ids = list(
            ChatMessage.objects
            .filter(created_at__lt=cutoff)
            .exclude(session__status__in=['archived', 'completed'])
            .values_list('id', flat=True)[:_DELETE_BATCH_SIZE]
        )
        if not batch_ids:
            break
        deleted, _ = ChatMessage.objects.filter(id__in=batch_ids).delete()
        active_deleted += deleted
        total_deleted += deleted
        batches_used += 1
        time.sleep(0.05)

    if total_deleted:
        logger.info(
            "[ChatMessage] Cleanup completed: deleted=%d (inactive=%d, active=%d) batches=%d cutoff=%s",
            total_deleted, total_deleted - active_deleted, active_deleted, batches_used, cutoff,
        )
    return {"success": True, "deleted": total_deleted}


# ：放弃创建由客户端立即清理空会话；本任务不再挂 Celery beat。
# 默认仍保留 2h 参数，仅供运维手动排障（客户端崩溃泄漏的孤儿空壳）。
# 手动：archive_empty_sessions.delay() 或 archive_empty_sessions.delay(retention_hours=0)
_EMPTY_SESSION_RETENTION_HOURS = 2


@shared_task(
    name="conversation.archive_empty_sessions",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=540,
)
def archive_empty_sessions(retention_hours: int = _EMPTY_SESSION_RETENTION_HOURS) -> dict:
    """
    归档无消息的空 session（运维兜底，非产品主路径）。

     起：放弃创建由 Electron ``discardAbandonedEmptySessions`` 立即软归档；
    本任务已从 beat 摘除，不再充当 2h「归档窗口」。仅手动触发时用于清客户端
    崩溃等泄漏的孤儿空壳。

    策略（不删、只归档）：
    - 软删（``status='archived'``）而非 ``.delete()``：避免触发跨库 cascade 删除
      ConversationState / ConversationCheckpoint / ExecutionTrace 等 PG 端记录
      引发不可恢复的事务异常（v0.1 §5.1 软引用文档）。归档后用户在 settings 的
      "已归档对话" 页面仍可看见，需要永久删时单独走 deleteSessionPermanently 路径。
    - 默认只归档"无消息 + 创建后超过 retention_hours"——手动排障时可传 0。
    - status='active' 才扫——已归档 / 已完成的不重复处理。
    - 不处理 -sub- thread_id（子 agent session）——它们由父 agent 生命周期管理。
    """
    from datetime import timedelta
    from django.db.models import Count
    from apps.chat.conversation.models import ChatSession

    cutoff = timezone.now() - timedelta(hours=retention_hours)

    # 一次拿到所有候选 ID 再 update（避免 GROUP BY HAVING 跟 UPDATE 混在一条 SQL）
    candidate_ids = list(
        ChatSession.objects
        .filter(status='active', created_at__lt=cutoff)
        .exclude(thread_id__contains='-sub-')
        .annotate(_msg_cnt=Count('messages'))
        .filter(_msg_cnt=0)
        .values_list('id', flat=True)[:1000]  # 单轮上限，防失控
    )

    if not candidate_ids:
        return {"archived": 0}

    archived = ChatSession.objects.filter(id__in=candidate_ids).update(
        status='archived',
    )
    logger.info(
        "[ArchiveEmptySessions] archived %d empty sessions (older than %dh, with 0 messages)",
        archived, retention_hours,
    )
    return {"archived": archived}


@shared_task(
    name="conversation.backfill_sender_user_id",
    ignore_result=True,
    time_limit=1800,
    soft_time_limit=1740,
)
def backfill_sender_user_id(batch_size=1000):
    """批量回填历史消息的 sender_user_id"""
    from apps.chat.conversation.models import ChatMessage

    total_updated = 0
    while True:
        msg_ids_with_user = list(
            ChatMessage.objects
            .filter(sender_user_id='', role='user')
            .select_related('session')
            .values_list('id', 'session__user_id')[:batch_size]
        )
        if not msg_ids_with_user:
            break

        user_id_groups: dict[str, list] = {}
        for msg_id, user_id in msg_ids_with_user:
            user_id_groups.setdefault(str(user_id) if user_id else '', []).append(msg_id)

        batch_updated = 0
        for uid, ids in user_id_groups.items():
            if not uid:
                continue
            n = ChatMessage.objects.filter(id__in=ids).update(sender_user_id=uid)
            batch_updated += n

        if batch_updated == 0:
            orphan_ids = [mid for mid, _ in msg_ids_with_user]
            ChatMessage.objects.filter(id__in=orphan_ids).update(sender_user_id='__orphan__')
            logger.warning(
                "[BackfillSenderUserId] batch_updated=0, marked %d messages as __orphan__",
                len(orphan_ids),
            )

        total_updated += batch_updated
        logger.info(
            "[BackfillSenderUserId] 本批处理 %d 条，累计 %d 条",
            batch_updated, total_updated,
        )

        if len(msg_ids_with_user) < batch_size:
            break

    logger.info("[BackfillSenderUserId] 完成，共更新 %d 条", total_updated)
    return {"updated": total_updated}


@shared_task(
    ignore_result=True,
    time_limit=300,
    soft_time_limit=280,
    autoretry_for=(OSError, ConnectionError),
    retry_kwargs={'max_retries': 2},
    retry_backoff=True,
    retry_backoff_max=60,
)
def fork_copy_messages_async(
    *,
    source_session_id: str,
    new_session_id: str,
    fork_point_message_id: str | None = None,
    fork_point_created_at: str | None = None,
    source_thread_id: str | None = None,
    space_id: str | None = None,
):
    """异步复制大对话的消息到 fork session。

    当源对话超过 200 条消息时由 fork_session API 触发，
    避免同步请求阻塞过久。
    """
    import uuid as _uuid

    from .models import ChatSession, ChatMessage, ChatContext

    new_session = ChatSession.objects.filter(id=new_session_id).first()
    if not new_session:
        logger.error("[ForkAsync] New session %s not found", new_session_id)
        return

    def _mark_fork_copy_status(status: str) -> None:
        ChatSession.objects.filter(id=new_session_id).update(
            fork_copy_status=status,
            updated_at=timezone.now(),
        )

    source_session = ChatSession.objects.filter(id=source_session_id).first()
    if not source_session:
        logger.error("[ForkAsync] Source session %s not found", source_session_id)
        _mark_fork_copy_status('failed')
        return

    # CH-5：async fork 同样不复制子 Agent message（与 fork.py sync 路径同口径）。
    main_timeline = ChatMessage.objects.filter(session=source_session).exclude(subagent_run_id__gt='')
    if fork_point_message_id:
        fork_msg = (
            main_timeline
            .filter(id=fork_point_message_id)
            .only("id", "created_at", "role", "arrival_seq")
            .first()
        )
        if not fork_msg:
            logger.error("[ForkAsync] Fork point message %s not found", fork_point_message_id)
            _mark_fork_copy_status('failed')
            return
        from .api.fork import _fork_boundary_queryset

        msg_filter = _fork_boundary_queryset(main_timeline, fork_msg)
    else:
        msg_filter = main_timeline

    _BATCH = 500
    total_copied = 0
    batch = []
    from types import SimpleNamespace

    from .services.conversation_time import conversation_sort_key

    source_rows = sorted(
        msg_filter.values("id", "created_at", "role", "text_summary", "arrival_seq"),
        key=conversation_sort_key,
    )
    ordered_ids = [str(row["id"]) for row in source_rows]
    last_created_at = source_rows[-1]["created_at"] if source_rows else None
    source_message_points = [
        SimpleNamespace(
            id=row["id"],
            created_at=row["created_at"],
            role=row["role"],
            text_summary=row["text_summary"] or "",
            content=row["text_summary"] or "",
            arrival_seq=row["arrival_seq"],
        )
        for row in source_rows
    ]

    #  引用回复：与同步 fork 同款——先建 旧id→新id 全量映射，让 reply_to 这个
    # self-FK 重映射到新 session 的对应新 id（否则悬空指向源 session）。async 路径
    # 处理的是大 fork（超阈值），故用独立轻查询（只取 id）先建映射，避免把全部
    # 消息对象一次性载入内存。映射不含的（fork 截断点之外）→ reply_to 置 None，
    # preview 快照始终保留。
    from .services.fork_message_id_remap import forked_message_id

    id_map: dict = {
        str(mid): forked_message_id(new_session.id, mid)
        for mid in ordered_ids
    }
    # ：整次 async fork 共用一张 tool id 映射表。
    from .services.fork_tool_id_remap import (
        ForkToolIdMapper,
        remap_content_blocks_json,
        remap_messages_json,
    )
    tool_id_mapper = ForkToolIdMapper()

    try:
        # W3 §3.3.1：fork async 字段全量迁移到新字段集（与 fork.py 同款）
        timestamps_batch = []
        copy_fields = (
            "id",
            "reply_to_id",
            "reply_to_preview",
            "role",
            "content_blocks_json",
            "text_summary",
            "error_info_json",
            "usage_json",
            "stop_reason",
            "subagent_run_id",
            "model_name_snapshot",
            "checkpoint_anchor_block_id",
            "checkpoint_anchor_block_index",
            "content_blocks_trimmed_at",
            "model_id",
            "trace_id",
            "sender_user_id",
            "agent_id",
            "agent_run_id",
            "checkpoint_hash",
            "checkpoint_state_index",
            "diff_summary",
            "changed_files",
            "message_kind",
            "arrival_seq",
            "metadata",
            "created_at",
        )
        for batch_start in range(0, len(ordered_ids), _BATCH):
            batch_ids = ordered_ids[batch_start:batch_start + _BATCH]
            messages_by_id = {
                str(msg.id): msg
                for msg in (
                    msg_filter
                    .filter(id__in=batch_ids)
                    .only(*copy_fields)
                    .iterator(chunk_size=_BATCH)
                )
            }
            for message_id in batch_ids:
                msg = messages_by_id.get(message_id)
                if msg is None:
                    continue
                timestamps_batch.append(msg.created_at)
                batch.append(ChatMessage(
                    id=id_map[str(msg.id)],
                    session=new_session,
                    reply_to_id=id_map.get(str(msg.reply_to_id)) if msg.reply_to_id else None,
                    reply_to_preview=msg.reply_to_preview,
                    role=msg.role,
                    content_blocks_json=remap_content_blocks_json(
                        msg.content_blocks_json,
                        tool_id_mapper,
                    ),
                    text_summary=msg.text_summary,
                    error_info_json=msg.error_info_json,
                    usage_json=msg.usage_json,
                    stop_reason=msg.stop_reason,
                    subagent_run_id=msg.subagent_run_id,
                    model_name_snapshot=msg.model_name_snapshot,
                    checkpoint_anchor_block_id=msg.checkpoint_anchor_block_id,
                    checkpoint_anchor_block_index=msg.checkpoint_anchor_block_index,
                    content_blocks_trimmed_at=msg.content_blocks_trimmed_at,
                    model_id=msg.model_id,
                    trace_id=msg.trace_id,
                    sender_user_id=msg.sender_user_id,
                    agent_id=msg.agent_id,
                    agent_run_id=msg.agent_run_id,
                    checkpoint_hash=msg.checkpoint_hash,
                    checkpoint_state_index=msg.checkpoint_state_index,
                    diff_summary=msg.diff_summary,
                    changed_files=msg.changed_files,
                    message_kind=msg.message_kind,
                    arrival_seq=msg.arrival_seq,
                    metadata=dict(msg.metadata or {}),
                ))
                if len(batch) >= _BATCH:
                    ChatMessage.objects.bulk_create(batch, batch_size=_BATCH)
                    for obj, ts in zip(batch, timestamps_batch):
                        obj.created_at = ts
                    ChatMessage.objects.bulk_update(batch, ['created_at'], batch_size=_BATCH)
                    try:
                        from apps.fts.services.sync_service import enqueue_messages_bulk_created
                        enqueue_messages_bulk_created(batch)
                    except Exception:
                        logger.exception("[FTS] fork_async bulk_create outbox enqueue failed")
                    total_copied += len(batch)
                    batch = []
                    timestamps_batch = []

        if batch:
            ChatMessage.objects.bulk_create(batch, batch_size=_BATCH)
            for obj, ts in zip(batch, timestamps_batch):
                obj.created_at = ts
            ChatMessage.objects.bulk_update(batch, ['created_at'], batch_size=_BATCH)
            try:
                from apps.fts.services.sync_service import enqueue_messages_bulk_created
                enqueue_messages_bulk_created(batch)
            except Exception:
                logger.exception("[FTS] fork_async bulk_create outbox enqueue failed")
            total_copied += len(batch)

        if last_created_at:
            new_session.last_message_at = last_created_at
            new_session.save(update_fields=['last_message_at'])

        pg_copy_failed = False
        # PG ConversationState
        try:
            from apps.services.agent_engine.models import ConversationState
            from .api import _truncate_pg_messages_at_fork_point, _fork_state_json

            src_thread = source_thread_id or source_session.effective_thread_id
            src_state = ConversationState.objects.filter(thread_id=src_thread).first()
            if src_state:
                src_msgs = src_state.messages_json or []
                fork_pid = _uuid.UUID(fork_point_message_id) if fork_point_message_id else None
                forked_msgs, truncation_failed = _truncate_pg_messages_at_fork_point(
                    src_msgs, source_message_points, fork_pid,
                )
                if truncation_failed:
                    logger.warning(
                        "[fork async] PG 截断点定位失败，已保守截断 thread=%s",
                        new_session.effective_thread_id,
                    )
                ConversationState.objects.update_or_create(
                    thread_id=new_session.effective_thread_id,
                    defaults={
                        "messages_json": remap_messages_json(
                            forked_msgs,
                            tool_id_mapper,
                            {
                                source_id: str(target_id)
                                for source_id, target_id in id_map.items()
                            },
                        ),
                        "state_json": _fork_state_json(src_state.state_json),
                    },
                )
        except Exception:
            pg_copy_failed = True
            logger.warning("[ForkAsync] Failed to copy ConversationState", exc_info=True)

        # ChatContext
        # Workspace / Project 都由 ChatSession 显式持有；ChatContext 只复制 UI
        # 资源上下文与当前协作投影，不能再把 Project 塞回 current_space_id。
        try:
            src_ctx = ChatContext.objects.filter(session=source_session).first()
            space_id_str = str(new_session.workspace_id) if new_session.workspace_id else None
            if src_ctx:
                ChatContext.objects.get_or_create(
                    session=new_session,
                    defaults={
                        "current_space_id": src_ctx.current_space_id,
                        "current_project_id": src_ctx.current_project_id,
                        "current_table_id": src_ctx.current_table_id,
                        "current_view_id": src_ctx.current_view_id,
                        "recent_spaces": src_ctx.recent_spaces,
                        "recent_tables": src_ctx.recent_tables,
                        "recent_views": src_ctx.recent_views,
                        "context_data": src_ctx.context_data,
                    },
                )
            elif space_id_str:
                ChatContext.objects.get_or_create(
                    session=new_session,
                    defaults={
                        "current_space_id": space_id_str,
                        "current_project_id": new_session.project_id,
                    },
                )
        except Exception:
            logger.warning("[ForkAsync] Failed to copy ChatContext", exc_info=True)

        logger.info(
            "[ForkAsync] Done: %s -> %s, copied %d messages pg_failed=%s",
            source_session_id, new_session_id, total_copied, pg_copy_failed,
        )
        _mark_fork_copy_status('complete')
    except Exception:
        logger.exception(
            "[ForkAsync] Message copy failed: %s -> %s",
            source_session_id, new_session_id,
        )
        _mark_fork_copy_status('failed')
        raise


_TRIM_BATCH_SIZE = 500
_TRIM_MAX_BATCHES = 2000
_DEFAULT_BLOCKS_RETENTION_HOURS = 24

_BLOCKS_FIELDS_TO_CLEAR = {
    "thinking": ("content",),
    "tool_call": ("input", "output"),
}


def _trim_blocks(blocks: list) -> list:
    """Trim thinking/tool_call large fields, keeping structural metadata."""
    trimmed = []
    changed = False
    for block in blocks:
        if not isinstance(block, dict):
            trimmed.append(block)
            continue
        block_type = block.get("type")
        fields_to_clear = _BLOCKS_FIELDS_TO_CLEAR.get(block_type)
        if not fields_to_clear:
            trimmed.append(block)
            continue
        has_data = any(block.get(f) for f in fields_to_clear)
        if not has_data:
            trimmed.append(block)
            continue
        new_block = {k: v for k, v in block.items() if k not in fields_to_clear}
        trimmed.append(new_block)
        changed = True
    return trimmed if changed else blocks


@shared_task(
    ignore_result=True,
    time_limit=1800,
    soft_time_limit=1740,
)
def trim_blocks_json(retention_hours: int | None = None):
    """W3 §3.3.1：Trim thinking/tool_call large fields from old ChatMessage.content_blocks_json.

    保留 structural metadata (type, tool_name, tool_call_id, duration_ms,
    is_error, error, args_summary, output_summary) so UI can still show
    "called tool X" indicators. Text blocks and rich_content blocks 保留全文。
    使用 `content_blocks_trimmed_at` 列（indexed）做去重替代 JSON marker。

    W3：blocks_json → content_blocks_json + blocks_trimmed_at →
    content_blocks_trimmed_at（字段重命名）。
    """
    from apps.chat.conversation.models import ChatMessage, EngineRuntimeConfig

    if retention_hours is None:
        try:
            config = EngineRuntimeConfig.objects.filter(pk=1).first()
            retention_hours = (
                config.cleanup_blocks_retention_hours
                if config
                else _DEFAULT_BLOCKS_RETENTION_HOURS
            )
        except Exception:
            retention_hours = _DEFAULT_BLOCKS_RETENTION_HOURS

    cutoff = timezone.now() - timedelta(hours=retention_hours)
    now = timezone.now()
    total_trimmed = 0
    batches_used = 0

    for _ in range(_TRIM_MAX_BATCHES):
        msg_ids = list(
            ChatMessage.objects
            .filter(
                created_at__lt=cutoff,
                role='assistant',
                content_blocks_trimmed_at__isnull=True,
            )
            .exclude(content_blocks_json=[])
            .values_list('id', flat=True)[:_TRIM_BATCH_SIZE]
        )
        if not msg_ids:
            break

        messages = ChatMessage.objects.filter(id__in=msg_ids)
        batch_trimmed = 0
        for msg in messages:
            if not msg.content_blocks_json:
                ChatMessage.objects.filter(id=msg.id).update(
                    content_blocks_trimmed_at=now,
                    updated_at=now,
                )
                continue
            new_blocks = _trim_blocks(msg.content_blocks_json)
            if new_blocks is not msg.content_blocks_json:
                msg.content_blocks_json = new_blocks
                msg.content_blocks_trimmed_at = now
                msg.save(update_fields=['content_blocks_json', 'content_blocks_trimmed_at', 'updated_at'])
                batch_trimmed += 1
            else:
                ChatMessage.objects.filter(id=msg.id).update(
                    content_blocks_trimmed_at=now,
                    updated_at=now,
                )

        total_trimmed += batch_trimmed
        batches_used += 1
        if batch_trimmed == 0:
            break
        time.sleep(0.1)

    logger.info(
        "[TrimBlocks] Done: trimmed=%d batches=%d retention_hours=%d",
        total_trimmed, batches_used, retention_hours,
    )


# ────────────────────────────────────────────────────────
#  会话标题生成（替代旧 spawn_title_thread daemon thread 实现）
# ────────────────────────────────────────────────────────
#
# 设计要点：
#
# 1. **只对瞬时错重试**（autoretry_for 收窄）。永久错——SceneBinding 未配 /
#    LLM 提示词校验失败 / 配额耗尽——retry 3 次仍是同样的失败，纯浪费配额、
#    占 worker slot、灌 dead-letter。
# 2. **只在最终失败时 mark failed**。重试中间过程不写 DB，避免每轮重试都 bump
#    status / `title_generation_failed_at`，跟前端按活跃时间排序冲突。
# 3. **状态写入不 bump updated_at**。"标题生成"是后台运维行为，不是用户活动；
#    bump updated_at 会让一周前会话突然跳到"今天"分组——典型副作用伤害。

# 这些异常是"瞬时的"——retry 可能恢复。其他异常默认不重试，task 内部
# 自己 mark failed 后 swallow 掉，避免无效退避占用 worker slot。
#
# 注意：实际 LLM 调用失败常抛 ``httpx.TimeoutException`` / ``openai.APITimeoutError``
# / ``httpx.ConnectError`` 这些**第三方异常类**，**不是** Python 内置
# ``ConnectionError`` / ``TimeoutError``——必须显式 import + 加进白名单。
# 老逻辑只看内置异常，导致网络抖动一次就被识别为永久错 mark failed → 用户标题
# 4 小时内不再重试。这条 _try_import_transient_classes 把第三方类型动态加进来。
_TRANSIENT_TITLE_ERRORS_BUILTIN = (
    ConnectionError,
    TimeoutError,
)


def _try_import_transient_classes() -> tuple:
    """惰性加载 httpx / openai 的瞬时错类型，没装该库时安全跳过。"""
    extras = []
    try:
        import httpx  # type: ignore
        for name in ('TimeoutException', 'ConnectError', 'RemoteProtocolError', 'NetworkError'):
            cls = getattr(httpx, name, None)
            if isinstance(cls, type):
                extras.append(cls)
    except ImportError:
        pass
    try:
        import openai  # type: ignore
        for name in ('APITimeoutError', 'APIConnectionError'):
            cls = getattr(openai, name, None)
            if isinstance(cls, type):
                extras.append(cls)
    except ImportError:
        pass
    try:
        import requests  # type: ignore
        from requests.exceptions import Timeout as _ReqTimeout, ConnectionError as _ReqConnErr
        extras.extend([_ReqTimeout, _ReqConnErr])
    except ImportError:
        pass
    try:
        from django.db.utils import OperationalError as _DBOpError
        extras.append(_DBOpError)
    except ImportError:
        pass
    return tuple(extras)


_TRANSIENT_TITLE_ERRORS = _TRANSIENT_TITLE_ERRORS_BUILTIN + _try_import_transient_classes()

_TRANSIENT_TITLE_SCENE_ERROR_CODES = frozenset({
    "RATE_LIMIT",
    "PROVIDER_DOWN",
})

_TRANSIENT_TITLE_ERROR_MARKERS = tuple(sorted(_TRANSIENT_TITLE_SCENE_ERROR_CODES))


def _is_transient_exc(exc: BaseException) -> bool:
    if isinstance(exc, _TRANSIENT_TITLE_ERRORS):
        return True
    context = getattr(exc, "context", {}) or {}
    error_code = str(context.get("error_code") or "").upper()
    if error_code in _TRANSIENT_TITLE_SCENE_ERROR_CODES:
        return True
    message = str(exc).upper()
    return any(marker in message for marker in _TRANSIENT_TITLE_ERROR_MARKERS)


@shared_task(
    bind=True,
    name="conversation.generate_session_title",
    ignore_result=True,
    time_limit=120,
    soft_time_limit=110,
    # 注意：retry 由 task 内部按异常类型显式触发，**不**用 autoretry_for=(Exception,)：
    # 否则 SceneBinding 未配 / 配额耗尽这类永久错也会重试 3 次 + 退避，浪费配额、
    # 卡 worker、灌 dead-letter。
    autoretry_for=(),
    retry_backoff=True,
    retry_backoff_max=300,
    retry_jitter=True,
)
def generate_session_title_task(
    self,
    session_id: str,
    thread_id: str,
    user_message: str,
    *,
    force: bool = False,
    max_retries: int = 3,
    selected_model_id: str | None = None,
) -> None:
    """
    后台为指定 session 生成会话标题。

    daemon thread 模式的替代实现。daemon thread 在进程退出时立刻被杀，
    title 生成请求会静默丢失。Celery task 用 broker 持久化 + 显式 retry 替代。

    幂等性：``should_generate_title`` 在 task 内部校验，多次入队同一 sessionId
    （前后端兜底 + 手动重生成）都安全；任一次成功后续都被跳过。
    """
    from django.db import close_old_connections
    from apps.chat.conversation.models import ChatSession
    from apps.chat.conversation.services.title_generator import (
        TitleGeneratorService,
    )
    from apps.services.common.chat_stream_publisher import ChatStreamPublisher as Publisher

    close_old_connections()
    try:
        session_obj = ChatSession.objects.get(id=session_id)
        original_title = session_obj.title
        if not force and not TitleGeneratorService.should_auto_generate_title(session_obj):
            # 已经有真实标题——把 status 修对，避免被 backfill 反复捞
            if session_obj.title_generation_status != 'done':
                ChatSession.objects.filter(id=session_id).update(
                    title_generation_status='done',
                    title_generation_failed_at=None,
                )
            return

        # ：首条消息已被 Unsend 撤回后不应再调 LLM / 写标题。
        if not session_obj.messages.filter(role='user').exists():
            TitleGeneratorService.cancel_title_generation_for_empty_session(
                session_obj,
                publish=True,
            )
            logger.info(
                "[TitleGen] skip because session has no user messages session=%s",
                session_id,
            )
            return

        # 用 [first_user_message] 单条作为生成上下文（spawn_title_thread 时代行为，
        # 与 /sessions/{id}/generate-title 走完整 message list 的路径行为分离——
        # 那条路径仍走 view 直接调 generate_title）。
        messages = [{"role": "user", "content": user_message}]
        generation_kwargs = {"session": session_obj}
        if selected_model_id:
            generation_kwargs["requested_model_id"] = selected_model_id
        title = TitleGeneratorService.generate_title(messages, **generation_kwargs)

        if title:
            from django.db import transaction

            with transaction.atomic():
                current_session = ChatSession.objects.select_for_update().get(id=session_id)
                # LLM 期间若 Unsend 已清空 user 消息：放弃写入，保持默认标题。
                if not current_session.messages.filter(role='user').exists():
                    TitleGeneratorService.cancel_title_generation_for_empty_session(
                        current_session,
                        publish=True,
                    )
                    logger.info(
                        "[TitleGen] skip persist; user messages withdrawn session=%s",
                        session_id,
                    )
                    return
                if current_session.title != original_title:
                    # LLM 生成期间用户可能手动重命名。用户写入优先，避免随后
                    # 的 title_updated 事件把刚改好的标题覆盖掉。
                    if current_session.title_generation_status != 'done':
                        current_session.title_generation_status = 'done'
                        current_session.title_generation_failed_at = None
                        current_session.save(update_fields=[
                            "title_generation_status",
                            "title_generation_failed_at",
                        ])
                    logger.info(
                        "[TitleGen] skip persist because title changed session=%s",
                        session_id,
                    )
                    return

                if not force and not TitleGeneratorService.should_auto_generate_title(current_session):
                    if current_session.title_generation_status != 'done':
                        current_session.title_generation_status = 'done'
                        current_session.title_generation_failed_at = None
                        current_session.save(update_fields=[
                            "title_generation_status",
                            "title_generation_failed_at",
                        ])
                    return

                current_session.title = title
                current_session.title_generation_status = 'done'
                current_session.title_generation_failed_at = None
                # 注意：update_fields 不含 'updated_at'。"后台 backfill 写标题"
                # 不是用户活动，不应该把老 session 提到"今天"分组。
                current_session.save(update_fields=[
                    "title", "title_generation_status",
                    "title_generation_failed_at",
                ])
            Publisher.publish_title_update(
                str(current_session.user_id) if current_session.user_id else "",
                session_id=session_id,
                title=title,
                thread_id=thread_id,
            )
            logger.info("[TitleGen] generated session=%s title=%s", session_id, title)
            return

        # LLM 返回空（很罕见）。永久错，不重试。
        _mark_title_generation_failed(session_id, reason='llm_returned_empty')
        logger.warning("[TitleGen] LLM returned empty title for session=%s", session_id)
        return
    except ChatSession.DoesNotExist:
        # session 被删除了——正常退出，不重试也不 mark。
        logger.warning("[TitleGen] session %s not found, skipping", session_id)
        return
    except Exception as exc:
        # 瞬时错——bubble 让 Celery retry（指数退避）；最终用完 retry 时 mark failed。
        if _is_transient_exc(exc) and self.request.retries < max_retries:
            logger.warning(
                "[TitleGen] transient error session=%s retries=%d/%d: %r",
                session_id, self.request.retries, max_retries, exc,
            )
            raise self.retry(exc=exc, max_retries=max_retries)

        # 永久错 / 重试用完——mark failed 后 swallow（不 raise，避免 dead-letter 噪音）
        _mark_title_generation_failed(
            session_id,
            reason='retries_exhausted' if self.request.retries >= max_retries else 'permanent_error',
        )
        logger.warning(
            "[TitleGen] session=%s failed permanently (retries=%d/%d): %r",
            session_id, self.request.retries, max_retries, exc,
        )
        return
    finally:
        close_old_connections()


def _mark_title_generation_failed(session_id: str, *, reason: str) -> None:
    """
    记录标题生成失败状态。

    用 .update() 而非 instance.save()——避免 auto_now 把 updated_at 推到 now。
    标题生成失败是后台运维事件不是用户活动，bump updated_at 会让老 session
    跳到"今天"分组、扰乱时间序。
    """
    from apps.chat.conversation.models import ChatSession
    updated = ChatSession.objects.filter(id=session_id).update(
        title_generation_status='failed',
        title_generation_failed_at=timezone.now(),
    )
    if updated:
        logger.warning("[TitleGen] marked session=%s as failed (reason=%s)", session_id, reason)


# backfill 退避：在 failed 状态停留这么久之内不重试，避免永久错（譬如 SceneBinding 未配）
# 把 worker 跟 LLM 配额无限刷爆。
#
# dogfood 阶段的 trade-off：值太长（4h）→ 用户配好 SceneBinding 后等好久才看到
# 标题恢复；值太短（5min）→ 永久错配额死循环。1h 是夸张前贵后省的折中：
# - 用户主动打开会话仍有前端 selectSession 兜底立即触发
# - 重启 / 修配置后的 backfill 第一波在 30min 内可见
# - 配额耗尽这种永久错每小时尝试一次，可承受
_TITLE_BACKFILL_FAIL_COOLDOWN_HOURS = 1

# in_progress 卡死的兜底窗口：超过这个时间没完成视为僵死，重新入队。覆盖
# spawn_title_thread mark in_progress 之后 broker 失败 / worker 崩溃这类
# 状态机断点。注意 _enqueue_atomically 现在 bump updated_at 后，新入队的
# session 不会立刻触发 stale 检测——这条窗口主要兜底 worker mid-task crash。
_TITLE_BACKFILL_INPROGRESS_STALE_MINUTES = 15
_TITLE_BACKFILL_ENQUEUE_LIMIT = 20

@shared_task(
    name="conversation.backfill_session_titles",
    ignore_result=True,
    time_limit=1800,
    soft_time_limit=1740,
)
def backfill_session_titles(limit: int = _TITLE_BACKFILL_ENQUEUE_LIMIT) -> dict:
    """
    周期扫描"有消息但没标题"的 session 重新入队生成。

    覆盖的失败 case：
    - generate_session_title_task 最终 retry 用完进 failed
    - spawn_title_thread mark 了 in_progress 但 .delay() 失败 / worker 崩溃，
      session 永久卡 in_progress
    - 历史遗留的 spawn_title_thread daemon thread 时代失败的 session
    - 进程退出窗口里来不及入队的 session

    退避：
    - failed 状态在冷却期内不重试（避免永久错刷爆配额）
    - in_progress 15 分钟内不重试（给 LLM call 留充足时间）
    """
    from django.db.models import Count, Q, Subquery, OuterRef
    from apps.chat.conversation.models import ChatSession, ChatMessage
    from apps.chat.conversation.services.semantic_message_count import (
        CONTEXT_INJECTION_KINDS,
    )
    from apps.chat.conversation.services.title_generator import TitleGeneratorService

    now = timezone.now()
    fail_cooldown_cutoff = now - timedelta(hours=_TITLE_BACKFILL_FAIL_COOLDOWN_HOURS)
    inprogress_stale_cutoff = now - timedelta(minutes=_TITLE_BACKFILL_INPROGRESS_STALE_MINUTES)

    # Subquery 一次性把每条候选 session 的"首条真实 user 消息 text_summary"拿出来,
    # 避免 for sess in candidates 内部 N+1 二次查询(原版每条 candidate 都
    # sess.messages.filter().first()——200 个 candidate = 200 次额外 SQL)。
    # ：排除 system_prompt_context 等注入 kind。
    first_user_subq = (
        ChatMessage.objects
        .filter(session_id=OuterRef('id'), role='user')
        .exclude(message_kind__in=CONTEXT_INJECTION_KINDS)
        .order_by('created_at')
        .values('text_summary')[:1]
    )

    # `status__in` 先收窄到三种 backfill 关心的状态,让索引前缀
    # (status, title_generation_status, -last_message_at) 命中
    # ——避免 OR 多个 title_generation_status 值在 MySQL 上退化成 index_merge / filesort。
    candidates = list(
        ChatSession.objects.filter(
            status='active',
            title_generation_status__in=['pending', 'failed', 'in_progress'],
        )
        # ChatSession 模型上没有 message_count 字段，必须 annotate 出来才能 filter。
        # 之前直接 filter(message_count__gt=0) 会抛 FieldError——整个 backfill 任务
        # 跑不起来。
        .annotate(
            _msg_cnt=Count('messages'),
            _first_user_msg=Subquery(first_user_subq),
        )
        .filter(_msg_cnt__gt=0)
        .filter(
            # pending（默认）/ failed 但已超退避窗口 / in_progress 但卡死太久
            Q(title_generation_status='pending')
            | Q(title_generation_status='failed', title_generation_failed_at__lt=fail_cooldown_cutoff)
            | Q(title_generation_status='failed', title_generation_failed_at__isnull=True)
            | Q(title_generation_status='in_progress', updated_at__lt=inprogress_stale_cutoff)
        )
        .order_by('-last_message_at')[:limit]
    )

    enqueued = 0
    fixed_status = 0
    stale_in_progress_reset = 0
    for sess in candidates:
        # fork 数字编号占位：尚未有「fork 之后」的新 user 消息时，
        # 不要用拷贝来的旧消息去生成，也不要把 status 误标 done。
        if TitleGeneratorService.is_fork_title_pending(sess):
            has_post_fork_user = (
                sess.messages.filter(
                    role="user",
                    created_at__gte=sess.created_at,
                )
                .exclude(message_kind__in=CONTEXT_INJECTION_KINDS)
                .exists()
            )
            if not has_post_fork_user:
                continue

        if not TitleGeneratorService.should_auto_generate_title(sess):
            # 历史遗留：title 已是真实值但 status 没维护到 done。顺手修对，避免下次扫描再捞。
            ChatSession.objects.filter(id=sess.id).update(
                title_generation_status='done',
                title_generation_failed_at=None,
            )
            fixed_status += 1
            continue

        first_user_msg = sess._first_user_msg  # Subquery annotate 出来,零额外 SQL
        # fork 补生成：用 fork 后最新一条真实 user 正文，而不是拷贝历史的首条
        if TitleGeneratorService.is_fork_title_pending(sess):
            latest_post_fork = (
                sess.messages.filter(role="user", created_at__gte=sess.created_at)
                .exclude(message_kind__in=CONTEXT_INJECTION_KINDS)
                .order_by("-created_at")
                .values_list("text_summary", flat=True)
                .first()
            )
            if latest_post_fork:
                first_user_msg = latest_post_fork

        if not first_user_msg:
            continue

        if sess.title_generation_status == 'in_progress':
            reset = ChatSession.objects.filter(
                id=sess.id,
                title_generation_status='in_progress',
                updated_at__lt=inprogress_stale_cutoff,
            ).update(
                title_generation_status='pending',
                title_generation_failed_at=None,
            )
            if reset == 0:
                continue
            stale_in_progress_reset += reset

        generate_session_title_task.delay(
            session_id=str(sess.id),
            thread_id=sess.effective_thread_id,
            user_message=first_user_msg,
            force=False,
        )
        enqueued += 1

    if enqueued or fixed_status:
        logger.info(
            "[TitleBackfill] enqueued=%d fixed_status=%d stale_reset=%d (limit=%d)",
            enqueued, fixed_status, stale_in_progress_reset, limit,
        )
    return {
        "enqueued": enqueued,
        "fixed_status": fixed_status,
        "stale_in_progress_reset": stale_in_progress_reset,
    }


# ────────────────────────────────────────────────────────
#  终端"假运行"诚实降级 —— Layer 3 主判定（终端假运行根治 v3 §5 / 失败模式 F14）
# ────────────────────────────────────────────────────────
#
# 周期扫 ChatMessage.content_blocks_json 内 status:"running" 的终端 tool_result，
# 超 hard_timeout（默认 12h 或 record 自带 hard_timeout_ms）仍无终态 → 标"未知终态"
# （status:"unknown"，不是成功/失败）。这是 Layer 1（可靠投递）+ Layer 2（崩溃兜底）
# 双双失效时的诚实底线：显示"运行状态未知（可能已结束）"而非无限转圈，且**不**朴素
# 超时改判误杀正常长跑任务。纯逻辑 + 扫描实现见 `terminal_state_gc`（拆出便于无 DB
# 单测纯函数）；本处只做 celery 装饰器包装。判定阈值如何避免误杀长跑详见该模块 docstring。


@shared_task(
    name="conversation.mark_stale_running_terminals",
    ignore_result=True,
    time_limit=600,
    soft_time_limit=540,
)
def mark_stale_running_terminals(
    default_hard_timeout_ms: int | None = None,
    max_lookback_days: int | None = None,
    limit: int | None = None,
) -> dict:
    """把"超 hard_timeout 仍 running 无终态"的终端块标成 unknown（Layer 3 主判定）。

    参数留空走 `terminal_state_gc` 的默认值（12h 死线 / 30d 回看 / 单轮 2000）。
    """
    from apps.chat.conversation.terminal_state_gc import (
        DEFAULT_HARD_TIMEOUT_MS,
        DEFAULT_MAX_LOOKBACK_DAYS,
        DEFAULT_SCAN_LIMIT,
        mark_stale_running_terminals_impl,
    )

    return mark_stale_running_terminals_impl(
        default_hard_timeout_ms=(
            default_hard_timeout_ms if default_hard_timeout_ms is not None
            else DEFAULT_HARD_TIMEOUT_MS
        ),
        max_lookback_days=(
            max_lookback_days if max_lookback_days is not None
            else DEFAULT_MAX_LOOKBACK_DAYS
        ),
        limit=limit if limit is not None else DEFAULT_SCAN_LIMIT,
    )


# 隐患 4（B P1）归档窗口：每周归档一次 7+ 天前已终态的 Tracker 对话。
# 选 7 天的理由：per_run 模式下高频 Tracker（如每小时跑）一周生成 168 条 ChatSession，
# 7 天后用户已不会再回看具体某次执行的 transcript（看的是 Tracker 详情页统计）；
# 归档而非删除是因为关联的 TrackerRun.chat_session 仍指向它，用户在 Run 详情页点
# "跳到对应对话"时归档态仍可访问（charter §4.4 审计资产保留）。
_TRACKER_SESSION_ARCHIVE_DAYS = 7


@shared_task(
    bind=True,
    name="conversation.archive_old_tracker_sessions",
    ignore_result=True,
    # Review C1：瞬时 DB 异常自动重试 3 次，每次间隔 60s——
    # 高频 Tracker 单次任务可能扫到几万条 ChatSession，PG/MySQL 短暂抖动不应让
    # "归档任务失败 → 老对话堆 7 天 → 用户左栏堆几千条"恶化成产品事故。
    autoretry_for=(OperationalError, ConnectionError),
    retry_kwargs={'max_retries': 3, 'countdown': 60},
    # Review C1：单次 task 时长上限提到 15min。原 600s 在 daily + batch 5000
    # 模式下，每天 1 次扫描 ~7d 累积量足够；高频 Tracker（每小时 1 跑）一周
    # 一个 Tracker = 168 条 ChatSession，1000 个 Tracker = 16.8 万条；按
    # 5000/批 + 100ms 索引查询 + 简单 update，预算 5min 完成，留 10min 余量给重试。
    time_limit=900,
    soft_time_limit=840,
)
def archive_old_tracker_sessions(self, retention_days: int = _TRACKER_SESSION_ARCHIVE_DAYS) -> dict:
    """归档老的 [Tracker] 对话（隐患 4 / B P1）。

    策略：
    - 范围：关联 TrackerRun 已终态（completed/failed/cancelled/partial_failed）
      + ``TrackerRun.created_at < cutoff``（先收窄到老 Run，避免每次扫全量历史）
      + ``ChatSession.created_at < cutoff``（双保险）
    - 软删（``status='archived'``）而非 ``.delete()``，与 ``archive_empty_sessions`` 同模式，
      避免触发跨库 cascade 删除 ConversationState 等记录引发不可恢复事务异常。
    - 跨库流程：先 PG 查 TrackerRun 拿终态老 Run 的 ``chat_session_id`` 集合（去重），
      再分批（每批 5000）跨库查 MySQL 对应 ChatSession。
    - **batch 5000 + daily 是 Review C1 提出的 sizing**：原 1000/周对高频 Tracker
      （每小时 1 次 → 一周 168 条 / Tracker；1k 个 Tracker → 16.8k/周）追不上；
      改 daily + batch 5000 后正常负载完全跟得上。
    - **守卫 retention_days >= 1**：0 / 负值会让 cutoff = 现在或将来，瞬间归档所有
      active session（包括用户当前对话），是灾难性 bug。task entry 显式校验。

    用户体验：归档的 Tracker 对话从 ChatSession sidebar"定时任务执行记录"分组里消失，
    但 Tracker 详情页 Run 列表里点"跳到对应对话"仍能打开（只是要去 settings/已归档对话
    里找）。删除 Tracker 走软删（status=archived，保留全部 TrackerRun 审计历史），
    本任务按 TrackerRun 终态 + created_at 筛、不看 Tracker.status，所以**软删 Tracker
    遗留的 [Tracker] 对话照样会被本任务归档**，不会漏。
    """
    if retention_days < 1:
        # 守卫：0 / 负值会让 cutoff >= now → 整张 ChatSession 表 status 全部翻成 archived。
        raise ValueError(
            f"archive_old_tracker_sessions: retention_days must be >= 1, got {retention_days}"
        )

    from datetime import timedelta
    from apps.chat.conversation.models import ChatSession

    cutoff = timezone.now() - timedelta(days=retention_days)

    try:
        from apps.tracker.models import TrackerRun
    except Exception:
        logger.warning("[ArchiveOldTrackerSessions] tracker module not available, skip")
        return {"archived": 0, "skipped": True}

    # Review C1：PG 查询里加 created_at__lt=cutoff，把 Run 集合先收窄到老数据；
    # 失败时让 exception 自然抛出（让 autoretry_for 接住），不再 silent return 0
    # 让 schedule 假装成功。
    terminal_session_ids = set(
        TrackerRun.objects
        .filter(
            status__in=("completed", "failed", "cancelled", "partial_failed"),
            created_at__lt=cutoff,
        )
        .exclude(chat_session_id__isnull=True)
        .values_list("chat_session_id", flat=True)
    )

    if not terminal_session_ids:
        return {"archived": 0}

    # Review C1：跨库 IN 改成 batch（每批 5000 个 UUID）——避免单条
    # ``WHERE id IN (huge list)`` 在 MySQL 上 query plan 退化或超过 max_allowed_packet。
    total_archived = 0
    batch_size = 5000
    ids_list = list(terminal_session_ids)
    for i in range(0, len(ids_list), batch_size):
        batch = ids_list[i:i + batch_size]
        candidate_ids = list(
            ChatSession.objects
            .filter(
                id__in=batch,
                status='active',
                created_at__lt=cutoff,
            )
            .values_list('id', flat=True)
        )
        if candidate_ids:
            archived = ChatSession.objects.filter(id__in=candidate_ids).update(
                status='archived',
            )
            total_archived += archived

    logger.info(
        "[ArchiveOldTrackerSessions] archived %d Tracker sessions older than %dd "
        "(scanned %d candidate ids in batches of %d)",
        total_archived, retention_days, len(ids_list), batch_size,
    )
    return {"archived": total_archived}


@shared_task(
    ignore_result=True,
    time_limit=600,
    soft_time_limit=560,
)
def cleanup_expired_llm_snapshots(retention_days: int | None = None):
    """#5430：清理过期 LLM 调用快照（chat_llm_snapshot）。

    快照含 system prompt / 工具 schema 全文，属调试观测数据——与对话正文
    生命周期解耦，按 `EngineRuntimeConfig.cleanup_llm_snapshot_retention_days`
    （默认 90 天）批删，避免长事务。
    """
    from apps.chat.conversation.models import ChatLLMSnapshot, EngineRuntimeConfig

    if retention_days is None:
        try:
            config = EngineRuntimeConfig.objects.filter(pk=1).first()
            retention_days = (
                config.cleanup_llm_snapshot_retention_days if config else 90
            )
        except Exception:
            retention_days = 90

    cutoff = timezone.now() - timedelta(days=retention_days)
    total_deleted = 0
    batch_size = 500
    for _ in range(200):  # 单次运行上限 10 万行，剩余留给下一轮
        ids = list(
            ChatLLMSnapshot.objects
            .filter(created_at__lt=cutoff)
            .values_list('id', flat=True)[:batch_size]
        )
        if not ids:
            break
        deleted, _detail = ChatLLMSnapshot.objects.filter(id__in=ids).delete()
        total_deleted += deleted

    logger.info(
        "[CleanupLLMSnapshots] deleted %d snapshots older than %dd",
        total_deleted, retention_days,
    )
    return {"deleted": total_deleted}


CONVERSATION_BEAT_SCHEDULE = {
    "retry-session-share-resource-sync": {
        "task": "conversation.sync_session_share_resource_grants",
        "schedule": crontab(minute="*"),
        "options": {"expires": 50},
    },
    "retry-session-share-card-refresh": {
        "task": "conversation.retry_session_share_card_refresh",
        "schedule": crontab(minute="*/5"),
        "options": {"expires": 240},
    },
    "cleanup-old-chat-messages": {
        "task": "apps.chat.conversation.tasks.cleanup_old_chat_messages",
        "schedule": crontab(hour=3, minute=30),
        "options": {"expires": 3600},
    },
    # ：LLM 调用快照 TTL 清理
    "cleanup-expired-llm-snapshots": {
        "task": "apps.chat.conversation.tasks.cleanup_expired_llm_snapshots",
        "schedule": crontab(hour=4, minute=40),
        "options": {"expires": 3600},
    },
    "trim-blocks-json": {
        "task": "apps.chat.conversation.tasks.trim_blocks_json",
        "schedule": crontab(hour=5, minute=0),
        "options": {"expires": 3600},
    },
    # 周期把"有消息但没标题"的 session 重新入队生成标题。
    # 覆盖以下失败 case：
    # - generate_session_title_task 最终重试用完进 failed
    # - 历史遗留（spawn_title_thread daemon thread 时代）失败的 session
    # - spawn_title_thread mark in_progress 后 broker 失败 / worker 崩溃
    #
    # 每 15 分钟跑一次（之前 30 分钟）——dogfood 阶段升级 / 配好 SceneBinding 后,
    # 用户不希望等半小时才看到一片"新对话"标题陆续恢复;15 分钟空窗加上 selectSession
    # 兜底,主路径基本无感。任务本身很轻(扫描结果 backfill_session_titles fixed_status
    # 路径 几条 SQL 完事),频率提一档无压力。
    #
    # 想立即触发(配好 LLMSceneBinding 之后手动救一波):
    #   python manage.py shell -c "from apps.chat.conversation.tasks import backfill_session_titles; backfill_session_titles.delay()"
    "backfill-session-titles": {
        "task": "conversation.backfill_session_titles",
        "schedule": crontab(minute='*/15'),
        "kwargs": {"limit": _TITLE_BACKFILL_ENQUEUE_LIMIT},
        "options": {"expires": 800},
    },
    # ：空会话清理改由客户端放弃创建时立即完成；不再挂 beat。
    # 运维排障：archive_empty_sessions.delay() / delay(retention_hours=0)
    # 终端"假运行"诚实降级（Layer 3 / F14）：每小时 :40 扫一次，把超 hard_timeout
    # （默认 12h）仍 running 无终态的终端块标成 unknown（"运行状态未知"），兜底 Layer 1/2
    # 双双失效（host 崩溃/断电/kill -9 且 sidecar+relay 落盘都丢）的残余假运行。
    # 任务很轻（时间窗 + JSON 文本预筛 + 单轮上限），:40 错开其它 conversation 周期任务。
    "mark-stale-running-terminals": {
        "task": "conversation.mark_stale_running_terminals",
        "schedule": crontab(minute=40),
        "options": {"expires": 3000},
    },
    # 隐患 4（B P1）+ Review C1 sizing 修订：每天凌晨 04:45 归档 7+ 天前已终态
    # 的 [Tracker] 对话——per_run 模式下高频 Tracker 会持续生成 ChatSession，
    # 不归档会无限堆积。
    # sizing 选择（Review A 提出 1000/周对高频 Tracker 追不上）：改 daily + batch 5000
    # 后，单 Tracker 每小时 1 次 = 24/天 = 168/周；1k 个 Tracker → 16.8k/周，每天扫
    # 1 次每次 ~2.4k 候选 << 5k 单批，正常负载完全跟得上。
    # 时间错开：避开 03:30 (cleanup-old-chat-messages) / 04:30 (cleanup-stale-conversation-states)
    # / 05:00 (trim-blocks-json) 三个邻居，独占 04:45。
    "archive-old-tracker-sessions": {
        "task": "conversation.archive_old_tracker_sessions",
        "schedule": crontab(hour=4, minute=45),
        "options": {"expires": 6 * 3600},
    },
}
