"""任务共享产物权限的来源记录与对称回收。"""

from __future__ import annotations

import logging
import hashlib
import json
from uuid import UUID

from django.db import IntegrityError
from django.db import transaction
from django.utils import timezone

from apps.chat.conversation.models import (
    SessionShareResourceGrant,
    SessionShareResourceSyncJob,
)
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

_PERMISSION_LEVELS = {"viewer": 1, "editor": 2, "admin": 3, "owner": 4}


def _strongest_permission(permissions) -> str | None:
    return max(
        (permission for permission in permissions if permission in _PERMISSION_LEVELS),
        key=lambda permission: _PERMISSION_LEVELS[permission],
        default=None,
    )


def _share_resource_permission(share) -> str:
    return "editor" if bool(getattr(share, "can_chat", False)) else "viewer"


def _resource_pointers_from_blocks(blocks) -> list[tuple[str, str]]:
    from apps.tabtinspace.services.project_task_results import iter_resource_pointers

    resource_types = {"tabdata": "table", "tabdoc": "document"}
    pointers: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for resource_kind, resource_id in iter_resource_pointers(blocks):
        resource_type = resource_types.get(resource_kind)
        pointer = (resource_type or "", str(resource_id))
        if not resource_type or pointer in seen:
            continue
        try:
            UUID(pointer[1])
        except ValueError:
            continue
        seen.add(pointer)
        pointers.append(pointer)
    return pointers


def _load_share_owners(shares) -> dict[str, object]:
    from django.contrib.auth import get_user_model

    owner_ids = {str(share.owner_user_id) for share in shares}
    return {
        str(user.id): user
        for user in get_user_model().objects.filter(id__in=owner_ids)
    }


def _sync_resource_pointers_for_share(
    *, share, owner_user, resource_pointers: list[tuple[str, str]],
) -> None:
    from apps.tabtinspace.services.cloud_resource_acl import (
        resolve_tabdata_role,
        resolve_tabdoc_role,
        role_at_least,
    )

    granted_permission = _share_resource_permission(share)
    with transaction.atomic(using=postgres_app_db_alias()):
        for resource_type, resource_id in resource_pointers:
            resource = _load_shareable_resource(resource_type, resource_id)
            if resource is None:
                _log_skipped_resource(share, resource_type, resource_id, "missing")
                continue
            if str(resource.organization_id) != str(share.organization_id):
                _log_skipped_resource(share, resource_type, resource_id, "cross_organization")
                continue

            owner_role = (
                resolve_tabdata_role(owner_user, resource_id)
                if resource_type == "table"
                else resolve_tabdoc_role(owner_user, resource_id)
            )
            if not role_at_least(owner_role, "admin"):
                _log_skipped_resource(share, resource_type, resource_id, "owner_cannot_share")
                continue

            existing_permission = get_active_resource_permission(
                resource_type=resource_type,
                resource_id=resource_id,
                user_id=str(share.grantee_user_id),
            )
            changed = _grant_resource_permission(
                resource_type=resource_type,
                resource=resource,
                user_id=str(share.grantee_user_id),
                granted_by=str(share.owner_user_id),
                permission=granted_permission,
            )
            record_session_share_resource_grant(
                share=share,
                resource_type=resource_type,
                resource_id=resource_id,
                had_active_access=existing_permission is not None,
                granted_permission=granted_permission,
                independent_permission=existing_permission,
            )
            if changed:
                _notify_resource_access_granted(
                    share=share,
                    resource_type=resource_type,
                    resource=resource,
                )


def sync_session_share_resource_grants(*, share, owner_user) -> None:
    """把任务明确交付的云文档/表格授予接收人只读权限。

    这是任务共享领域能力，不依赖已废弃的 Django IM 消息服务。资源指针来自
    Agent 会话，仍需逐个校验 owner 的管理权限和组织边界，不能信任消息内容。
    pending 共享尚未生效，禁止授 ACL。
    """
    if getattr(share, "status", None) != "active":
        return

    messages = (
        share.session.messages.filter(role="assistant")
        .only("content_blocks_json")
        .order_by("created_at", "id")
    )
    resource_pointers: list[tuple[str, str]] = []
    for message in messages:
        resource_pointers.extend(
            _resource_pointers_from_blocks(message.content_blocks_json),
        )
    _sync_resource_pointers_for_share(
        share=share,
        owner_user=owner_user,
        resource_pointers=list(dict.fromkeys(resource_pointers)),
    )


def sync_active_session_share_resource_grants_for_message(*, message) -> None:
    """把一条新完成的会话产物增量同步给每位接收人的最新授权。"""
    if getattr(message, "role", None) != "assistant":
        return
    resource_pointers = _resource_pointers_from_blocks(
        getattr(message, "content_blocks_json", None),
    )
    if not resource_pointers:
        return

    with transaction.atomic(using=postgres_app_db_alias()):
        confirmed_shares = list(
            message.session.shares.select_for_update()
            .exclude(status="pending")
            .order_by("grantee_user_id", "-created_at", "-id"),
        )
        latest_shares = []
        seen_grantees: set[str] = set()
        for share in confirmed_shares:
            grantee_user_id = str(share.grantee_user_id)
            if grantee_user_id in seen_grantees:
                continue
            seen_grantees.add(grantee_user_id)
            if share.status == "active":
                latest_shares.append(share)

        if not latest_shares:
            return
        owners = _load_share_owners(latest_shares)
        for share in latest_shares:
            owner_user = owners.get(str(share.owner_user_id))
            if owner_user is None:
                _log_skipped_resource(
                    share,
                    resource_pointers[0][0],
                    resource_pointers[0][1],
                    "owner_missing",
                )
                continue
            _sync_resource_pointers_for_share(
                share=share,
                owner_user=owner_user,
                resource_pointers=resource_pointers,
            )


def enqueue_session_share_resource_sync(*, message) -> None:
    """在消息事务内记录可靠任务；提交后只负责唤醒 worker。"""
    if getattr(message, "role", None) != "assistant":
        return
    pointers = _resource_pointers_from_blocks(
        getattr(message, "content_blocks_json", None),
    )
    if not pointers:
        return
    digest = hashlib.sha256(
        json.dumps(pointers, ensure_ascii=False, separators=(",", ":")).encode(),
    ).hexdigest()
    job, _created = SessionShareResourceSyncJob.objects.get_or_create(
        message=message,
        content_digest=digest,
    )

    def dispatch(job_id=str(job.id)) -> None:
        from apps.chat.conversation.tasks import sync_session_share_resource_grants

        sync_session_share_resource_grants.delay(job_id)

    transaction.on_commit(dispatch, using=postgres_app_db_alias(), robust=True)


def supersede_prior_session_share_resource_grants(*, share) -> None:
    """停用同一接收人的历史共享产物来源，让最新授权成为唯一事实。"""
    prior_shares = share.session.shares.filter(
        grantee_user_id=str(share.grantee_user_id),
    ).exclude(id=share.id)
    for prior_share in prior_shares:
        revoke_session_share_resource_grants(share=prior_share)


def _load_shareable_resource(resource_type: str, resource_id: str):
    if resource_type == "table":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table

        return (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id=resource_id, trashed_at__isnull=True)
            .first()
        )

    from apps.tabdoc.models import Document

    return (
        Document.objects.using(postgres_app_db_alias())
        .filter(id=resource_id, trashed_at__isnull=True)
        .first()
    )


def _grant_resource_permission(
    *, resource_type: str, resource, user_id: str, granted_by: str, permission: str,
) -> bool:
    queryset = _permission_queryset(resource_type, str(resource.id), user_id)
    existing = queryset.order_by("-is_active", "-updated_at").first()
    if existing is not None:
        if existing.is_active:
            if _PERMISSION_LEVELS.get(existing.permission, 0) >= _PERMISSION_LEVELS[permission]:
                return False
            existing.permission = permission
            existing.save(update_fields=["permission", "updated_at"])
            return True
        existing.is_active = True
        if _PERMISSION_LEVELS.get(existing.permission, 0) < _PERMISSION_LEVELS[permission]:
            existing.permission = permission
            existing.save(update_fields=["is_active", "permission", "updated_at"])
        else:
            existing.save(update_fields=["is_active", "updated_at"])
        return True

    field_name = "table_id" if resource_type == "table" else "document_id"
    model = queryset.model
    create_kwargs = {
        field_name: resource.id,
        "subject_type": "user",
        "subject_id": user_id,
        "permission": permission,
        "is_active": True,
        "granted_by": granted_by,
    }
    if hasattr(model, "created_by_id"):
        create_kwargs["created_by_id"] = granted_by
    try:
        with transaction.atomic(using=queryset.db):
            model.objects.using(queryset.db).create(**create_kwargs)
            return True
    except IntegrityError:
        existing = queryset.first()
        if existing is None or existing.is_active:
            return False
        existing.is_active = True
        existing.save(update_fields=["is_active", "updated_at"])
        return True


def _notify_resource_access_granted(*, share, resource_type: str, resource) -> None:
    try:
        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_granted,
        )

        notify_cloud_resource_access_granted(
            resource_type="tabdata" if resource_type == "table" else "tabdoc",
            resource_id=str(resource.id),
            organization_id=str(share.organization_id),
            user_ids=[str(share.grantee_user_id)],
            actor_user_id=str(share.owner_user_id),
            title=getattr(resource, "name", None) or getattr(resource, "title", None),
            space_id=str(resource.space_id) if getattr(resource, "space_id", None) else None,
        )
    except Exception:
        logger.warning(
            "[SessionShare] resource grant side effect failed share=%s resource=%s:%s",
            share.id,
            resource_type,
            resource.id,
            exc_info=True,
        )


def _log_skipped_resource(share, resource_type: str, resource_id: str, reason: str) -> None:
    logger.warning(
        "[SessionShare] skipped resource share=%s resource=%s:%s reason=%s",
        share.id,
        resource_type,
        resource_id,
        reason,
    )


def _permission_queryset(resource_type: str, resource_id: str, user_id: str):
    if resource_type == "document":
        from apps.tabdoc.models import DocumentPermission

        return DocumentPermission.objects.using(postgres_app_db_alias()).filter(
            document_id=resource_id,
            subject_type="user",
            subject_id=str(user_id),
        )
    if resource_type == "table":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import TablePermission

        return TablePermission.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=resource_id,
            subject_type="user",
            subject_id=str(user_id),
        )
    raise ValueError(f"Unsupported session-share resource type: {resource_type}")


def has_active_resource_permission(*, resource_type: str, resource_id: str, user_id: str) -> bool:
    return get_active_resource_permission(
        resource_type=resource_type,
        resource_id=resource_id,
        user_id=user_id,
    ) is not None


def get_active_resource_permission(*, resource_type: str, resource_id: str, user_id: str) -> str | None:
    return _permission_queryset(resource_type, resource_id, user_id).filter(
        is_active=True,
    ).values_list("permission", flat=True).first()


def record_session_share_resource_grant(
    *, share, resource_type: str, resource_id: str, had_active_access: bool,
    granted_permission: str = "viewer",
    independent_permission: str | None = None,
) -> SessionShareResourceGrant:
    """记录一次任务共享同步。

    已存在的同一共享来源在 revoked → active 时只恢复来源状态，不能因为
    ACL 已被同步恢复就误判为用户另有独立权限。
    """
    resource_id = str(resource_id)
    user_id = str(share.grantee_user_id)
    grant = SessionShareResourceGrant.objects.filter(
        share=share,
        resource_type=resource_type,
        resource_id=resource_id,
    ).first()
    if grant is not None:
        update_fields = []
        if not grant.is_active:
            grant.is_active = True
            grant.revoked_at = None
            update_fields.extend(["is_active", "revoked_at"])
        if grant.granted_permission != granted_permission:
            grant.granted_permission = granted_permission
            update_fields.append("granted_permission")
        if update_fields:
            grant.save(update_fields=[*update_fields, "updated_at"])
        return grant

    active_session_source_exists = SessionShareResourceGrant.objects.filter(
        resource_type=resource_type,
        resource_id=resource_id,
        grantee_user_id=user_id,
        is_active=True,
        manages_resource_permission=True,
    ).exists()
    has_independent_access = bool(had_active_access and not active_session_source_exists)
    create_kwargs = {
        "grantee_user_id": user_id,
        "manages_resource_permission": not has_independent_access,
        "has_independent_access": has_independent_access,
        "granted_permission": granted_permission,
        "independent_permission": independent_permission if has_independent_access else None,
    }
    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            return SessionShareResourceGrant.objects.create(
                share=share,
                resource_type=resource_type,
                resource_id=resource_id,
                **create_kwargs,
            )
    except IntegrityError:
        # 同一条消息重放或并发保存时，以唯一约束下已落库的来源为准。
        return SessionShareResourceGrant.objects.get(
            share=share,
            resource_type=resource_type,
            resource_id=resource_id,
        )


def mark_resource_access_independently_granted(
    *, resource_type: str, resource_id: str, user_ids: list[str],
    permission: str = "viewer",
) -> None:
    """手动分享/交接等非任务共享渠道确认访问权后，保护已有任务来源。"""
    try:
        resource_id = str(UUID(str(resource_id)))
    except (TypeError, ValueError, AttributeError):
        # 资源服务的轻量 wiring 测试会使用占位 ID；真实云资源均为 UUID。
        return
    normalized_user_ids = [str(user_id) for user_id in user_ids if user_id]
    if not normalized_user_ids:
        return
    SessionShareResourceGrant.objects.filter(
        resource_type=resource_type,
        resource_id=resource_id,
        grantee_user_id__in=normalized_user_ids,
    ).update(
        has_independent_access=True,
        independent_permission=permission,
    )


def revoke_session_share_resource_grants(*, share) -> None:
    """撤销一条任务共享带来的资源访问；不碰其他有效来源。"""
    with transaction.atomic():
        grants = list(
            SessionShareResourceGrant.objects.select_for_update().filter(
                share=share,
                is_active=True,
            ),
        )
        if not grants:
            return

        now = timezone.now()
        for grant in grants:
            grant.is_active = False
            grant.revoked_at = now
            grant.save(update_fields=["is_active", "revoked_at", "updated_at"])

        for grant in grants:
            sibling_permissions = SessionShareResourceGrant.objects.filter(
                resource_type=grant.resource_type,
                resource_id=grant.resource_id,
                grantee_user_id=grant.grantee_user_id,
                is_active=True,
                manages_resource_permission=True,
            ).values_list("granted_permission", flat=True)
            independent_permissions = SessionShareResourceGrant.objects.filter(
                resource_type=grant.resource_type,
                resource_id=grant.resource_id,
                grantee_user_id=grant.grantee_user_id,
                has_independent_access=True,
            ).values_list("independent_permission", flat=True)
            target_permission = _strongest_permission([
                *sibling_permissions,
                *independent_permissions,
            ])

            permission = _permission_queryset(
                grant.resource_type,
                str(grant.resource_id),
                grant.grantee_user_id,
            ).filter(is_active=True).first()
            if permission is None:
                continue
            if target_permission:
                if permission.permission != target_permission or not permission.is_active:
                    permission.permission = target_permission
                    permission.is_active = True
                    permission.save(update_fields=["permission", "is_active", "updated_at"])
                continue
            permission.is_active = False
            permission.save(update_fields=["is_active", "updated_at"])
            _notify_resource_access_revoked(grant)


def _notify_resource_access_revoked(grant: SessionShareResourceGrant) -> None:
    try:
        if grant.resource_type == "document":
            from apps.tabdoc.services.share_service import _schedule_document_collab_revoke

            _schedule_document_collab_revoke(
                grant.resource_id,
                grant.grantee_user_id,
                read_only=False,
            )
            resource_type = "tabdoc"
        else:
            from apps.tabdata.services.share_service import _schedule_table_collab_revoke

            _schedule_table_collab_revoke(
                grant.resource_id,
                grant.grantee_user_id,
                read_only=False,
            )
            resource_type = "tabdata"

        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_revoked,
        )

        notify_cloud_resource_access_revoked(
            resource_type=resource_type,
            resource_id=str(grant.resource_id),
            organization_id=str(grant.share.organization_id),
            user_ids=[grant.grantee_user_id],
            actor_user_id=str(grant.share.owner_user_id),
        )
    except Exception:
        logger.warning(
            "[SessionShare] resource revoke side effect failed share=%s resource=%s:%s",
            grant.share_id,
            grant.resource_type,
            grant.resource_id,
            exc_info=True,
        )
