"""Context Sync 私有云资源发布。

云盘资源（tabdoc / tabdata / tabfiles）不再写入 organization / space topic。
接收人固定为「owner + active user Permission」与资源所属组织成员的交集，
按 ``context.sync.user.{user_id}`` 扇出；每个用户流有独立 Redis Stream 与断线重放。

删除 / 归档沿用提交前快照的接收人；分享新增发 ``resource_access_granted``，
撤权向被撤用户定向发 ``resource_access_revoked``。
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Optional, Sequence
from uuid import UUID

from django.db import transaction

from apps.tabtinspace.services.cloud_resource_acl import CLOUD_ITEM_TYPES

logger = logging.getLogger(__name__)

ACCESS_GRANTED = "resource_access_granted"
ACCESS_REVOKED = "resource_access_revoked"
ACCESS_CHANGED = "resource_access_changed"

# 组织 / space topic 上禁止下发的云资源事件（含历史漏改 publisher 的 fail-closed 防御）
_CLOUD_SENSITIVE_EVENT_PREFIXES = ("resource_",)
_CLOUD_SENSITIVE_EVENT_TYPES = frozenset({ACCESS_GRANTED, ACCESS_REVOKED, ACCESS_CHANGED})


def context_sync_user_topic(user_id: str) -> str:
    from apps.services.common.ws.protocol import ContextSyncEvent

    return f"{ContextSyncEvent.PREFIX}.user.{user_id}"


def is_cloud_resource_type(resource_type: Optional[str]) -> bool:
    return bool(resource_type) and resource_type in CLOUD_ITEM_TYPES


def is_context_sync_org_or_space_topic(topic: Optional[str]) -> bool:
    """True for ``context.sync.{space}`` / ``context.sync.organization.{org}``，不含 user topic。"""
    if not topic or not isinstance(topic, str):
        return False
    from apps.services.common.ws.protocol import ContextSyncEvent

    prefix = f"{ContextSyncEvent.PREFIX}."
    if not topic.startswith(prefix):
        return False
    remainder = topic[len(prefix) :]
    if remainder.startswith("user."):
        return False
    if remainder.startswith("organization."):
        return True
    # space topic: context.sync.{uuid}
    return bool(remainder) and not remainder.startswith("user.")


def is_sensitive_cloud_context_sync_event(envelope: dict) -> bool:
    """组织 / space topic 上不得下发的云资源敏感事件。"""
    if not isinstance(envelope, dict):
        return False
    resource_type = envelope.get("resource_type")
    if not is_cloud_resource_type(resource_type if isinstance(resource_type, str) else None):
        return False
    event_type = envelope.get("type") or ""
    if not isinstance(event_type, str):
        return False
    if event_type in _CLOUD_SENSITIVE_EVENT_TYPES:
        return True
    return any(event_type.startswith(p) for p in _CLOUD_SENSITIVE_EVENT_PREFIXES)


def should_drop_leaked_cloud_context_sync(envelope: dict) -> bool:
    """Gateway 实时投递与 resume 共用的 fail-closed 防御。

    若历史或漏改 publisher 仍把云资源事件写入组织 / space topic，拒绝下发。
    """
    topic = envelope.get("_topic") if isinstance(envelope, dict) else None
    if not is_context_sync_org_or_space_topic(topic if isinstance(topic, str) else None):
        return False
    return is_sensitive_cloud_context_sync_event(envelope)


def _intersect_org_members(user_ids: Iterable[str], organization_id: Optional[str]) -> set[str]:
    ids = {str(uid) for uid in user_ids if uid}
    if not ids:
        return set()
    if not organization_id:
        return ids
    try:
        UUID(str(organization_id))
    except (TypeError, ValueError):
        logger.warning(
            "[ContextSyncPublisher] invalid organization_id=%r; skip fanout",
            organization_id,
        )
        return set()

    from apps.tabtinspace.models import OrganizationMember

    try:
        return {
            str(uid)
            for uid in OrganizationMember.objects.filter(
                organization_id=organization_id,
                user_id__in=list(ids),
            ).values_list("user_id", flat=True)
        }
    except Exception as exc:
        logger.warning(
            "[ContextSyncPublisher] org member intersect failed org=%s: %s",
            organization_id,
            exc,
        )
        return set()


def resolve_cloud_resource_recipient_user_ids(
    resource_type: str,
    resource_id: str,
    organization_id: Optional[str] = None,
    *,
    created_by_id: Optional[str] = None,
) -> set[str]:
    """解析云资源可见用户：owner ∪ active user Permission，再与组织成员取交集。"""
    if not is_cloud_resource_type(resource_type) or not resource_id:
        return set()

    recipients: set[str] = set()
    rid = str(resource_id)

    if resource_type == "tabdoc":
        from apps.tabdoc.models import Document, DocumentPermission

        owner = (
            Document.objects.filter(id=rid)
            .values_list("owner_id", flat=True)
            .first()
        )
        if owner:
            recipients.add(str(owner))
        recipients.update(
            str(uid)
            for uid in DocumentPermission.objects.filter(
                document_id=rid,
                subject_type="user",
                is_active=True,
            ).values_list("subject_id", flat=True)
            if uid
        )

    elif resource_type == "tabdata":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table, TablePermission

        owner = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=rid)
            .values_list("owner_id", flat=True)
            .first()
        )
        if owner:
            recipients.add(str(owner))
        recipients.update(
            str(uid)
            for uid in TablePermission.objects.using(TABDATA_DB_ALIAS)
            .filter(
                table_id=rid,
                subject_type="user",
                is_active=True,
            )
            .values_list("subject_id", flat=True)
            if uid
        )

    elif resource_type == "tabfiles":
        from apps.services.oss.models import FileRecord
        from apps.tabtinspace.models import FilePermission

        if created_by_id:
            recipients.add(str(created_by_id))
        try:
            file_uuid = UUID(str(rid))
        except (TypeError, ValueError):
            return set()

        upload_user = (
            FileRecord.objects.filter(id=file_uuid)
            .values_list("upload_user", flat=True)
            .first()
        )
        if upload_user:
            recipients.add(str(upload_user))
        recipients.update(
            str(uid)
            for uid in FilePermission.objects.filter(
                file_record_id=file_uuid,
                subject_type="user",
                is_active=True,
            ).values_list("subject_id", flat=True)
            if uid
        )

    return _intersect_org_members(recipients, organization_id)


def _publish_to_user_topics(envelope: dict, user_ids: Sequence[str]) -> None:
    from apps.services.common.ws.bus import publish_ws_event

    seen: set[str] = set()
    for user_id in user_ids:
        uid = str(user_id or "").strip()
        if not uid or uid in seen:
            continue
        seen.add(uid)
        try:
            publish_ws_event(topic=context_sync_user_topic(uid), envelope=dict(envelope))
        except Exception as exc:
            logger.warning(
                "[ContextSyncPublisher] publish to user=%s failed: %s",
                uid,
                exc,
                exc_info=True,
            )


def _schedule_publish(
    envelope: dict,
    user_ids: Sequence[str],
    *,
    using: Optional[str] = None,
) -> None:
    """事务提交前快照 envelope / 接收人，on_commit 后发布。"""
    snapshot_envelope = dict(envelope)
    snapshot_users = tuple(str(uid) for uid in user_ids if uid)

    def _do_publish() -> None:
        if not snapshot_users:
            logger.debug(
                "[ContextSyncPublisher] skip empty recipients type=%s resource=%s",
                snapshot_envelope.get("type"),
                snapshot_envelope.get("resource_id"),
            )
            return
        _publish_to_user_topics(snapshot_envelope, snapshot_users)

    try:
        if transaction.get_connection(using=using).in_atomic_block:
            transaction.on_commit(_do_publish, using=using)
        else:
            _do_publish()
    except Exception:
        # 无事务连接时直接发
        _do_publish()


def publish_private_collection_event(
    envelope: dict,
    *,
    recipient_user_ids: Optional[Iterable[str]] = None,
    created_by_id: Optional[str] = None,
) -> None:
    """向创建者（或显式接收人）扇出 org-only Collection 事件。

    不写 organization / space topic，避免文件夹名/id 泄露给组织其他成员。
    """
    organization_id = envelope.get("organization_id")
    recipients: set[str] = set()
    if recipient_user_ids is not None:
        recipients.update(str(uid) for uid in recipient_user_ids if uid)
    if created_by_id:
        recipients.add(str(created_by_id))
    recipients = _intersect_org_members(
        recipients,
        str(organization_id) if organization_id else None,
    )
    _schedule_publish(envelope, sorted(recipients))


def publish_cloud_resource_event(
    envelope: dict,
    *,
    recipient_user_ids: Optional[Iterable[str]] = None,
    created_by_id: Optional[str] = None,
) -> None:
    """向可见用户扇出云资源 lifecycle 事件（不写 organization / space topic）。"""
    resource_type = envelope.get("resource_type")
    resource_id = envelope.get("resource_id")
    organization_id = envelope.get("organization_id")
    if not is_cloud_resource_type(resource_type if isinstance(resource_type, str) else None):
        logger.warning(
            "[ContextSyncPublisher] refuse non-cloud envelope type=%s resource_type=%s",
            envelope.get("type"),
            resource_type,
        )
        return

    if recipient_user_ids is None:
        recipients = resolve_cloud_resource_recipient_user_ids(
            str(resource_type),
            str(resource_id or ""),
            str(organization_id) if organization_id else None,
            created_by_id=created_by_id,
        )
    else:
        recipients = _intersect_org_members(
            recipient_user_ids,
            str(organization_id) if organization_id else None,
        )

    _schedule_publish(envelope, sorted(recipients))


def publish_resource_access_granted(
    *,
    resource_type: str,
    resource_id: str,
    organization_id: Optional[str],
    user_ids: Sequence[str],
    title: Optional[str] = None,
    space_id: Optional[str] = None,
    context_item_id: Optional[str] = None,
    metadata: Optional[dict] = None,
    preview: Optional[str] = None,
    status: Optional[str] = None,
    collection_id: Optional[str] = None,
    actor_user_id: Optional[str] = None,
) -> None:
    """分享新增：向新授权用户推送完整可见性事件（可乐观插入）。"""
    envelope: dict[str, Any] = {
        "type": ACCESS_GRANTED,
        "resource_type": resource_type,
        "resource_id": str(resource_id),
        "space_id": str(space_id) if space_id else None,
        "organization_id": str(organization_id) if organization_id else None,
        "user_id": actor_user_id,
        "title": title,
        "metadata": metadata or {},
        "preview": preview or "",
        "status": status,
        "context_item_id": context_item_id,
        "collection_id": collection_id,
    }
    targets = _intersect_org_members(user_ids, organization_id)
    _schedule_publish(envelope, sorted(targets))


def publish_resource_access_revoked(
    *,
    resource_type: str,
    resource_id: str,
    organization_id: Optional[str],
    user_ids: Sequence[str],
    space_id: Optional[str] = None,
    actor_user_id: Optional[str] = None,
) -> None:
    """撤权：向被撤用户定向推送，便于清理本地缓存（不依赖当前 ACL）。"""
    envelope: dict[str, Any] = {
        "type": ACCESS_REVOKED,
        "resource_type": resource_type,
        "resource_id": str(resource_id),
        "space_id": str(space_id) if space_id else None,
        "organization_id": str(organization_id) if organization_id else None,
        "user_id": actor_user_id,
    }
    # 撤权后用户可能已非「可见」集合，但仍需定向投递——不再与 org 交集二次过滤
    # （被撤用户通常仍是 org 成员；若已离组织则 topic 订阅本身会失败，无害）
    targets = {str(uid) for uid in user_ids if uid}
    if organization_id:
        targets = _intersect_org_members(targets, organization_id) or targets
    _schedule_publish(envelope, sorted(targets))


def publish_resource_access_changed(
    *,
    resource_type: str,
    resource_id: str,
    organization_id: Optional[str],
    user_ids: Sequence[str],
    space_id: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    db_alias: Optional[str] = None,
) -> None:
    """协作者权限等级变化：向受影响用户定向发送 ACL 失效事件。"""
    envelope: dict[str, Any] = {
        "type": ACCESS_CHANGED,
        "resource_type": resource_type,
        "resource_id": str(resource_id),
        "space_id": str(space_id) if space_id else None,
        "organization_id": str(organization_id) if organization_id else None,
        "user_id": actor_user_id,
    }
    # 权限变化的 user_ids 来自已完成 ACL 变更的明确受影响对象。私信资源卡允许
    # 跨组织协作，因此这里不能再与资源所属组织成员取交集；否则跨组织协作者
    # 虽然仍持有有效 ACL，却收不到卡片权限刷新事件。
    targets = {str(uid) for uid in user_ids if uid}
    _schedule_publish(envelope, sorted(targets), using=db_alias)


def enrich_envelope_from_context_item(item, envelope: dict) -> dict:
    """用 ContextItem 补齐 title / metadata 等字段（分享授权事件用）。"""
    out = dict(envelope)
    if item is None:
        return out
    out.setdefault("title", getattr(item, "title", None))
    out.setdefault("metadata", getattr(item, "metadata", None) or {})
    out.setdefault("preview", getattr(item, "preview", None) or "")
    out.setdefault("status", getattr(item, "status", None))
    out.setdefault(
        "context_item_id",
        str(getattr(item, "id", "") or "") or None,
    )
    collection_id = getattr(item, "collection_id", None)
    out.setdefault("collection_id", str(collection_id) if collection_id else None)
    return out
