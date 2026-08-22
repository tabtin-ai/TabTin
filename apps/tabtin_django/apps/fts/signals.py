"""6 类业务模型 post_save / post_delete signal → Outbox（PRD 4.3.A）。

核心约束（全部 handler 必守）：
    1. 入口 gate：`if not is_engine_enabled(): return`（ADR-12）
    2. Outbox 写入**在事务内**（`pre_save`/`post_save` 本身已在业务
       事务内；`write_outbox` 直接调用 ORM create）
    3. Celery 入队**在 `transaction.on_commit(...)`**（PRD 4.3.A），
       避免事务回滚后仍发 flush 任务
    4. post_delete 只写 delete outbox；级联（session → messages、
       space → resources/memos/messages）走 `delete_by_query_task`
       批量 task，而非逐条 outbox
    5. R0-08 易改字段同步（ChatSession.title / Conversation.name）：
       用 pre_save 缓存旧值 + post_save 对比触发 `update_by_query_task`
    6. handler 内部**禁止 raise**（哪怕 ES 不可达也要 swallow），
       保证业务事务不被搜索同步影响

Weak reference 注意：
    - handler 全部定义为模块级函数，保证 signal bus 的 weakref 不会被 GC
    - `register_signals()` 只做 connect，不包裹闭包
"""

from __future__ import annotations

import logging
from typing import Any

from django.db import transaction
from django.db.models.signals import post_delete, post_save, pre_save

from apps.fts.client import is_engine_enabled
from apps.fts.index_definitions import get_index_name, get_messages_alias
from apps.fts.services import sync_service
from apps.fts.services.outbox_service import write_outbox

logger = logging.getLogger(__name__)


# ── 通用 helper ────────────────────────────────────────────────
def _schedule_flush(db: str) -> None:
    """通过 `transaction.on_commit` 发一个立即 flush 的 Celery 任务。

    在业务事务提交后触发，比 beat 5s 扫描更低延迟（PRD 4.3.B）。
    事务回滚则不发送（on_commit 的内置行为）。
    """
    try:
        # 延迟 import 避免 Celery 启动时 signals 模块循环
        from apps.fts.tasks import flush_outbox_task
        transaction.on_commit(
            lambda: flush_outbox_task.delay(db=db),
            using=db,
        )
    except Exception:  # pragma: no cover - signal 内严禁 raise
        logger.exception("[FTS] schedule flush failed db=%s", db)


def _safe_write_outbox(**kwargs: Any) -> None:
    """signal 内写 outbox；任何失败都 swallow（handler 不影响业务）。

    Wave 5 R1-08：失败时打 metric `fts_outbox_write_failed_total{model}`；
    Grafana 告警 > 10/min 提示同步管道腐烂。
    """
    try:
        write_outbox(**kwargs)
    except Exception:
        logger.exception("[FTS] write_outbox failed kwargs=%s", kwargs)
        try:
            from apps.fts.metrics import record_outbox_write_failed
            # 从 index_name 推一个 model 标签（如 'tabtin-resources' → 'resources'）
            idx = (kwargs.get("index_name") or "").split("-", 1)
            label = idx[1] if len(idx) > 1 else "unknown"
            record_outbox_write_failed(model=label)
        except Exception:  # pragma: no cover
            pass


def _schedule_delete_by_query(
    index_alias: str, field: str, value: Any, *, using: str = "default",
) -> None:
    """级联 delete_by_query 通过 `transaction.on_commit` 异步下发。

    **using 参数是强制的**（技术 Review 2026-04-17 修正）：`transaction.on_commit`
    默认绑 `DEFAULT_DB_ALIAS`（即 default/MySQL）；如果 Space.delete() 在
    `transaction.atomic(using=postgres_app_db_alias())` 事务内调用，不传 using 的 on_commit
    回调会注册到 MySQL 事务上——**PG 事务提交时回调不触发，导致级联 delete_by_query
    静默丢失**（残留文档永远搜得到）。

    调用方必须按业务模型所在库传：
        - ChatSession (MySQL) → using="default"
        - Space / Conversation / ContextItem / Memo / Agent (PG) → using=postgres_app_db_alias()
    """
    if value is None:
        return
    try:
        from apps.fts.tasks import delete_by_query_task
        transaction.on_commit(
            lambda: delete_by_query_task.delay(
                index_alias=index_alias,
                field=field,
                value=str(value),
            ),
            using=using,
        )
    except Exception:  # pragma: no cover
        logger.exception(
            "[FTS] schedule delete_by_query failed index=%s field=%s value=%s using=%s",
            index_alias, field, value, using,
        )


def _schedule_update_by_query(
    index_alias: str,
    field: str,
    value: Any,
    partial_doc: dict[str, Any],
    *,
    using: str = "default",
) -> None:
    """改名 / 状态变更场景：通过 `update_by_query_task` 刷冗余字段。

    PRD 4.4 + R0-08：`session_title` / `conversation_name` 虽是易改字段，
    但"消息结果卡片需要会话标题"是强需求，不走 Hydration 走冗余刷新。

    using 参数语义同 `_schedule_delete_by_query`（技术 Review 2026-04-17 修正）。
    """
    if value is None or not partial_doc:
        return
    try:
        from apps.fts.tasks import update_by_query_task
        transaction.on_commit(
            lambda: update_by_query_task.delay(
                index_alias=index_alias,
                field=field,
                value=str(value),
                partial_doc=partial_doc,
            ),
            using=using,
        )
    except Exception:  # pragma: no cover
        logger.exception(
            "[FTS] schedule update_by_query failed index=%s field=%s value=%s using=%s",
            index_alias, field, value, using,
        )


# ── ChatMessage（MySQL） ────────────────────────────────────────
def on_chat_message_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    if not sync_service.should_index_chat_message(instance):
        return
    session = getattr(instance, "session", None)
    organization_id = (
        str(session.organization_id) if session and session.organization_id else None
    )
    _safe_write_outbox(
        db="default",
        index_name=get_messages_alias(),
        doc_id=str(instance.id),
        action="upsert",
        organization_id=organization_id,
    )
    _schedule_flush("default")


def on_chat_message_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    session = getattr(instance, "session", None)
    organization_id = (
        str(session.organization_id) if session and session.organization_id else None
    )
    _safe_write_outbox(
        db="default",
        index_name=get_messages_alias(),
        doc_id=str(instance.id),
        action="delete",
        organization_id=organization_id,
    )
    _schedule_flush("default")


# ── ChatSession（MySQL，改名 / 状态 / 回滚 → update_by_query） ─────
_CHAT_SESSION_SYNC_FIELDS = frozenset({"title", "status", "revert_state_index"})


def on_chat_session_pre_save(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    if instance.pk is None:
        instance._fts_old_snapshot = None
        return
    # 只在业务可能改动同步字段时才查旧 snapshot（R1-07 修复）：
    # `update_last_message_time()` 等高频 save 明确只改 `last_message_at`，
    # 这类 update 不会影响 ES 文档的 session_title/status/revert_state_index，
    # 不需要跑一次多余 SELECT。
    update_fields = kwargs.get("update_fields")
    if update_fields is not None and not (set(update_fields) & _CHAT_SESSION_SYNC_FIELDS):
        instance._fts_old_snapshot = None
        return
    try:
        old = (
            sender.objects
            .filter(pk=instance.pk)
            .values("title", "status", "revert_state_index")
            .first()
        )
        instance._fts_old_snapshot = old or None
    except Exception:
        instance._fts_old_snapshot = None


def on_chat_session_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    if created:
        return  # 新 session 还没有消息，无字段需刷新
    old = getattr(instance, "_fts_old_snapshot", None)
    if not old:
        return
    # 归一化 None / "" 等价（技术 Review 2026-04-17 修正）：
    # MySQL 里 CharField 的 default='' 和显式 NULL 共存；Django values() 对
    # NULL 返回 None，而新 instance 用 `title or ""` 规范成空串；直接对比
    # None != "" 会让每次 `update_last_message_time`（只改 last_message_at）
    # 都触发一次无效的 update_by_query，高并发下浪费 ES。
    partial: dict[str, Any] = {}
    old_title = old.get("title") or ""
    new_title = instance.title or ""
    if old_title != new_title:
        partial["session_title"] = new_title
    old_status = old.get("status") or ""
    new_status = instance.status or ""
    if old_status != new_status:
        partial["session_status"] = new_status
    if old.get("revert_state_index") != instance.revert_state_index:
        partial["session_revert_state_index"] = instance.revert_state_index
    if not partial:
        return
    _schedule_update_by_query(
        index_alias=get_messages_alias(),
        field="session_id",
        value=instance.id,
        partial_doc=partial,
        using="default",  # ChatSession 在 MySQL
    )


def on_chat_session_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    _schedule_delete_by_query(
        index_alias=get_messages_alias(),
        field="session_id",
        value=instance.id,
        using="default",  # ChatSession 在 MySQL
    )


# ── ContextItem（PG）→ tabtin-resources ─────────────────────────
def on_context_item_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    host = getattr(instance, "workspace", None) or getattr(instance, "project", None)
    organization_id = (
        str(host.organization_id) if host and host.organization_id else None
    )
    action = "delete" if instance.trashed_at is not None else "upsert"
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("resources"),
        doc_id=str(instance.id),
        action=action,
        organization_id=organization_id,
    )
    _schedule_flush("postgresql")


def on_context_item_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    host = getattr(instance, "workspace", None) or getattr(instance, "project", None)
    organization_id = (
        str(host.organization_id) if host and host.organization_id else None
    )
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("resources"),
        doc_id=str(instance.id),
        action="delete",
        organization_id=organization_id,
    )
    _schedule_flush("postgresql")


# ── Agent（PG）→ tabtin-agents ──────────────────────────────────
def on_agent_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    action = "upsert" if sync_service.should_index_agent(instance) else "delete"
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("agents"),
        doc_id=str(instance.id),
        action=action,
        organization_id=str(instance.organization_id) if instance.organization_id else None,
    )
    _schedule_flush("postgresql")


def on_agent_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("agents"),
        doc_id=str(instance.id),
        action="delete",
        organization_id=str(instance.organization_id) if instance.organization_id else None,
    )
    _schedule_flush("postgresql")


# ── Space（PG）→ tabtin-spaces + 级联 ──────────────────────────
_SPACE_TRASH_SYNC_FIELDS = frozenset({"trashed_at", "previous_status"})


def on_space_pre_save(sender, instance, **kwargs):
    """缓存 trashed_at 旧值，供 post_save 检测软删事件（R1-09 修复）。

    与 ChatSession/Conversation 的 pre_save 同结构；只在可能影响 trashed_at
    的 update_fields 命中时拉旧值，避免常规 save 多查 PG。
    Workspace 无 trashed_at 字段 → 跳过旧值查询。
    """
    if not is_engine_enabled():
        return
    if instance.pk is None:
        instance._fts_old_trash = None
        return
    # Workspace 无回收站字段；仅对真实 Django Model 做字段探测（测试 MagicMock 放行）
    from django.db import models as dj_models

    if isinstance(sender, type) and issubclass(sender, dj_models.Model):
        field_names = {f.name for f in sender._meta.fields}
        if "trashed_at" not in field_names:
            instance._fts_old_trash = None
            return
    update_fields = kwargs.get("update_fields")
    if update_fields is not None and not (set(update_fields) & _SPACE_TRASH_SYNC_FIELDS):
        instance._fts_old_trash = None
        return
    try:
        old = sender.objects.filter(pk=instance.pk).values("trashed_at").first()
        instance._fts_old_trash = old.get("trashed_at") if old else None
    except Exception:
        instance._fts_old_trash = None


def on_space_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    action = "upsert" if sync_service.should_index_space(instance) else "delete"
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("spaces"),
        doc_id=str(instance.id),
        action=action,
        organization_id=str(instance.organization_id) if instance.organization_id else None,
    )
    _schedule_flush("postgresql")
    # R1-09 修复：检测 trashed_at 从 None → 非 None（软删入回收站）
    # → 与 on_space_deleted（硬删）行为对称，级联清 4 个索引
    #
    # 设计要点（与硬删的差异）：
    #   - 软删是**单向**动作：恢复（trashed_at: 非 None → None）时不
    #     自动 reindex；ContextItem/Memo/ChatSession 各自的 signal 在
    #     业务恢复它们 trashed_at 时会重新发 upsert outbox
    #   - 没恢复的对象：等用户在 UI 编辑触发 save，或运维 Wave 5
    #     `manage.py fts_reindex --space=<id>`
    # 双重保险：业务侧 SpaceService.trash_space() 会同时把 ContextItem
    # 的 trashed_at 设为 now（_cascade_trash_child_resources），on_context_item_saved
    # 也会发 delete outbox。两条路径并存不会双重删，ES delete 是幂等的
    # （含 HIGH-4 修复后 not_found 也算成功）
    if created:
        return
    old_trash = getattr(instance, "_fts_old_trash", "_unset_")
    if old_trash == "_unset_":
        return
    new_trash = getattr(instance, "trashed_at", None)
    if old_trash is None and new_trash is not None:
        # 进入回收站事件
        _schedule_delete_by_query(
            index_alias=get_index_name("resources"),
            field="space_id",
            value=instance.id,
            using="postgresql",
        )
        _schedule_delete_by_query(
            index_alias=get_index_name("memos"),
            field="space_id",
            value=instance.id,
            using="postgresql",
        )
        _schedule_delete_by_query(
            index_alias=get_messages_alias(),
            field="space_id",
            value=instance.id,
            using="postgresql",
        )
        logger.info(
            "[FTS] space soft-trash cascade scheduled space=%s (resources/memos/messages)",
            instance.id,
        )


def on_space_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("spaces"),
        doc_id=str(instance.id),
        action="delete",
        organization_id=str(instance.organization_id) if instance.organization_id else None,
    )
    _schedule_flush("postgresql")
    # 级联清理所有 Space 下的 resources / memos / messages
    # Space 在 PG，on_commit 必须绑 postgresql 事务；否则 PG 事务提交时
    # 回调不触发 → messages/resources/memos 里残留孤儿文档永远搜得到
    _schedule_delete_by_query(
        index_alias=get_index_name("resources"),
        field="space_id",
        value=instance.id,
        using="postgresql",
    )
    _schedule_delete_by_query(
        index_alias=get_index_name("memos"),
        field="space_id",
        value=instance.id,
        using="postgresql",
    )
    _schedule_delete_by_query(
        index_alias=get_messages_alias(),
        field="space_id",
        value=instance.id,
        using="postgresql",
    )


# ── Memo（PG）→ tabtin-memos ────────────────────────────────────
def on_memo_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    action = "upsert" if sync_service.should_index_memo(instance) else "delete"
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("memos"),
        doc_id=str(instance.id),
        action=action,
        organization_id=str(instance.organization_id) if instance.organization_id else None,
    )
    _schedule_flush("postgresql")


def on_memo_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("memos"),
        doc_id=str(instance.id),
        action="delete",
        organization_id=str(instance.organization_id) if instance.organization_id else None,
    )
    _schedule_flush("postgresql")


# ── tabchat.Message（PG）→ tabtin-im ────────────────────────────
def on_im_message_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    action = "upsert" if sync_service.should_index_im_message(instance) else "delete"
    conv = getattr(instance, "conversation", None)
    organization_id = (
        str(conv.organization_id) if conv and conv.organization_id else None
    )
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("im"),
        doc_id=str(instance.id),
        action=action,
        organization_id=organization_id,
    )
    _schedule_flush("postgresql")


def on_im_message_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    conv = getattr(instance, "conversation", None)
    organization_id = (
        str(conv.organization_id) if conv and conv.organization_id else None
    )
    _safe_write_outbox(
        db="postgresql",
        index_name=get_index_name("im"),
        doc_id=str(instance.id),
        action="delete",
        organization_id=organization_id,
    )
    _schedule_flush("postgresql")


# ── Conversation（PG，改名 → update_by_query / 删除 → 级联） ────
_CONVERSATION_SYNC_FIELDS = frozenset({"name"})


def on_conversation_pre_save(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    if instance.pk is None:
        instance._fts_old_snapshot = None
        return
    # 同 on_chat_session_pre_save：只在 name 字段可能变时查旧值
    update_fields = kwargs.get("update_fields")
    if update_fields is not None and not (set(update_fields) & _CONVERSATION_SYNC_FIELDS):
        instance._fts_old_snapshot = None
        return
    try:
        old = sender.objects.filter(pk=instance.pk).values("name").first()
        instance._fts_old_snapshot = old or None
    except Exception:
        instance._fts_old_snapshot = None


def on_conversation_saved(sender, instance, created, **kwargs):
    if not is_engine_enabled():
        return
    if created:
        return
    old = getattr(instance, "_fts_old_snapshot", None)
    if not old:
        return
    # 归一化（同 on_chat_session_saved 修正）
    old_name = old.get("name") or ""
    new_name = instance.name or ""
    if old_name != new_name:
        _schedule_update_by_query(
            index_alias=get_index_name("im"),
            field="conversation_id",
            value=instance.id,
            partial_doc={"conversation_name": new_name},
            using="postgresql",  # Conversation 在 PG
        )


def on_conversation_deleted(sender, instance, **kwargs):
    if not is_engine_enabled():
        return
    _schedule_delete_by_query(
        index_alias=get_index_name("im"),
        field="conversation_id",
        value=instance.id,
        using="postgresql",  # Conversation 在 PG
    )


# ── ACL 缓存失效（Wave 2，PRD 4.7.B） ──────────────────────────
# 关键事件：
#   - SpaceMembership 变动 → 影响 user 自身 / agent 持有人的可访问 spaces
# 缓存失效是"最坏一次额外 PG 查询"代价（next read 时回源），不影响业务事务。
def _safe_invalidate_user(user_id: Any, organization_id: Any) -> None:
    if not user_id or not organization_id:
        return
    try:
        from apps.fts.services.acl_service import invalidate_user_acl
        invalidate_user_acl(str(user_id), str(organization_id))
    except Exception:  # pragma: no cover - signal 内严禁 raise
        logger.exception("[FTS][ACL] invalidate failed user=%s organization=%s", user_id, organization_id)
        # Wave 5 R2-10：失效失败 metric → 告警 > 10/min 提示 Redis 异常
        try:
            from apps.fts.metrics import record_acl_invalidate_failed
            record_acl_invalidate_failed()
        except Exception:
            pass


def _safe_invalidate_organization_users(organization_id: Any, user_ids: list[str]) -> None:
    if not organization_id or not user_ids:
        return
    try:
        from apps.fts.services.acl_service import invalidate_organization_users_acl
        invalidate_organization_users_acl(str(organization_id), [str(u) for u in user_ids if u])
    except Exception:  # pragma: no cover
        logger.exception("[FTS][ACL] invalidate batch failed organization=%s", organization_id)
        try:
            from apps.fts.metrics import record_acl_invalidate_failed
            record_acl_invalidate_failed()
        except Exception:
            pass


def _resolve_organization_id_from_space(space_id: Any) -> str | None:
    from apps.services.billing.organization_resolver import resolve_organization_id_from_space
    if not space_id:
        return None
    return resolve_organization_id_from_space(str(space_id))


def _resolve_organization_id_from_membership(instance) -> str | None:
    """Optimistic: 优先用 instance 已有字段，fallback 用统一 resolver 查 PG。"""
    workspace = getattr(instance, "workspace", None)
    if workspace is not None:
        wt = getattr(workspace, "organization_id", None)
        if wt:
            return str(wt)
    return _resolve_organization_id_from_space(getattr(instance, "workspace_id", None))


def on_space_membership_changed(sender, instance, **kwargs):
    """SpaceMembership.post_save / post_delete → 失效相关 user 的 ACL 缓存。"""
    organization_id = _resolve_organization_id_from_membership(instance)
    if not organization_id:
        return
    user_id = getattr(instance, "user_id", None)
    if user_id:
        _safe_invalidate_user(user_id, organization_id)


# ── 注册入口（apps.py 的 ready() 调用） ────────────────────────
_REGISTERED = False


def register_signals() -> None:
    """幂等地把 handler 挂到 Django signal bus。

    weak=False：handler 全部是模块级函数，不需要 weakref 语义；
    保留 dispatch_uid 保证 Django re-import（测试/重载）也不会重复注册。
    """
    global _REGISTERED
    if _REGISTERED:
        return

    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.tabchat.models import Conversation
    from apps.tabchat.models import Message as ImMessage
    from apps.tabmemo.models import Memo
    from apps.tabtinspace.models import Agent, ContextItem, Project, Workspace

    post_save.connect(on_chat_message_saved, sender=ChatMessage,
                      dispatch_uid="fts_chat_message_saved", weak=False)
    post_delete.connect(on_chat_message_deleted, sender=ChatMessage,
                        dispatch_uid="fts_chat_message_deleted", weak=False)

    pre_save.connect(on_chat_session_pre_save, sender=ChatSession,
                     dispatch_uid="fts_chat_session_presave", weak=False)
    post_save.connect(on_chat_session_saved, sender=ChatSession,
                      dispatch_uid="fts_chat_session_saved", weak=False)
    post_delete.connect(on_chat_session_deleted, sender=ChatSession,
                        dispatch_uid="fts_chat_session_deleted", weak=False)

    post_save.connect(on_context_item_saved, sender=ContextItem,
                      dispatch_uid="fts_context_item_saved", weak=False)
    post_delete.connect(on_context_item_deleted, sender=ContextItem,
                        dispatch_uid="fts_context_item_deleted", weak=False)

    post_save.connect(on_agent_saved, sender=Agent,
                      dispatch_uid="fts_agent_saved", weak=False)
    post_delete.connect(on_agent_deleted, sender=Agent,
                        dispatch_uid="fts_agent_deleted", weak=False)

    # ：Space 非模型壳；索引宿主挂 Workspace + Project
    pre_save.connect(on_space_pre_save, sender=Workspace,
                     dispatch_uid="fts_workspace_presave", weak=False)
    post_save.connect(on_space_saved, sender=Workspace,
                      dispatch_uid="fts_workspace_saved", weak=False)
    post_delete.connect(on_space_deleted, sender=Workspace,
                        dispatch_uid="fts_workspace_deleted", weak=False)
    pre_save.connect(on_space_pre_save, sender=Project,
                     dispatch_uid="fts_project_presave", weak=False)
    post_save.connect(on_space_saved, sender=Project,
                      dispatch_uid="fts_project_saved", weak=False)
    post_delete.connect(on_space_deleted, sender=Project,
                        dispatch_uid="fts_project_deleted", weak=False)

    post_save.connect(on_memo_saved, sender=Memo,
                      dispatch_uid="fts_memo_saved", weak=False)
    post_delete.connect(on_memo_deleted, sender=Memo,
                        dispatch_uid="fts_memo_deleted", weak=False)

    post_save.connect(on_im_message_saved, sender=ImMessage,
                      dispatch_uid="fts_im_message_saved", weak=False)
    post_delete.connect(on_im_message_deleted, sender=ImMessage,
                        dispatch_uid="fts_im_message_deleted", weak=False)

    pre_save.connect(on_conversation_pre_save, sender=Conversation,
                     dispatch_uid="fts_conversation_presave", weak=False)
    post_save.connect(on_conversation_saved, sender=Conversation,
                      dispatch_uid="fts_conversation_saved", weak=False)
    post_delete.connect(on_conversation_deleted, sender=Conversation,
                        dispatch_uid="fts_conversation_deleted", weak=False)

    # Wave 2 ACL 缓存失效
    from apps.tabtinspace.models import SpaceMembership
    post_save.connect(on_space_membership_changed, sender=SpaceMembership,
                      dispatch_uid="fts_acl_membership_saved", weak=False)
    post_delete.connect(on_space_membership_changed, sender=SpaceMembership,
                        dispatch_uid="fts_acl_membership_deleted", weak=False)

    _REGISTERED = True
    logger.info("[FTS] signal handlers registered for 6 models + 2 cascades + membership ACL invalidation")
