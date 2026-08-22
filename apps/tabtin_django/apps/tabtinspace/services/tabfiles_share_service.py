"""TabFiles 协作者分享。

与 TabDoc/TabData 对称：显式 FilePermission(subject_type=user) 才进「分享给我」。
"""
from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction

from apps.services.common.constants import ASSIGNABLE_ROLES
from apps.services.common.db_router import postgres_app_db_alias
from apps.tabtinspace.models import ContextItem, FilePermission, OrganizationMember
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.cloud_resource_acl import (
    TABFILES_SHARED_PERMISSION,
    check_item_resource_permission,
)

logger = logging.getLogger(__name__)
User = get_user_model()

MAX_BATCH_INVITE = 50


def _get_file_item(file_record_id, *, organization_id: Optional[str] = None) -> ContextItem:
    qs = ContextItem.objects.filter(
        item_type="tabfiles",
        resource_id=str(file_record_id),
        trashed_at__isnull=True,
    ).exclude(status="trashed")
    if organization_id:
        qs = qs.filter(organization_id=organization_id)
    item = qs.first()
    if item is None:
        raise ServiceError("TABFILE_NOT_FOUND", "文件不存在", status=404)
    return item


def invite_file_collaborators(
    file_record_id,
    user_ids: list[str],
    permission: str,
    inviter,
) -> dict:
    if permission not in ASSIGNABLE_ROLES:
        raise ServiceError("INVALID_PERMISSION", "无效权限级别", status=400)
    if not isinstance(user_ids, list):
        raise ServiceError("INVALID_INPUT", "user_ids 必须是数组", status=400)

    # 静态文件没有在线编辑/管理能力。继续接受旧客户端的角色参数，
    # 但领域能力统一收口为查看和下载，避免把 TabDoc/TabData 角色误套到文件。
    effective_permission = TABFILES_SHARED_PERMISSION

    user_ids = [str(uid) for uid in user_ids if uid]
    if len(user_ids) > MAX_BATCH_INVITE:
        raise ServiceError(
            "RATE_LIMIT_EXCEEDED",
            f"单次最多邀请 {MAX_BATCH_INVITE} 人",
            status=400,
        )

    item = _get_file_item(file_record_id)
    if not check_item_resource_permission(inviter, item, "admin"):
        raise ServiceError("PERMISSION_DENIED", "权限不足", status=403)

    owner_id = str(getattr(item, "created_by_id", "") or "")
    inviter_id = str(inviter.id)
    skipped: list[dict] = []
    candidates: list[str] = []
    seen: set[str] = set()
    for uid in user_ids:
        if uid in seen:
            continue
        seen.add(uid)
        if uid == inviter_id:
            skipped.append({"user_id": uid, "reason": "self"})
            continue
        if owner_id and uid == owner_id:
            skipped.append({"user_id": uid, "reason": "is_owner"})
            continue
        candidates.append(uid)

    if not candidates:
        return {"notified": 0, "skipped": skipped}

    org_id = getattr(item, "organization_id", None)
    valid_member_ids: set[str] = set()
    if org_id:
        valid_member_ids = {
            str(uid)
            for uid in OrganizationMember.objects.filter(
                organization_id=org_id, user_id__in=candidates,
            ).values_list("user_id", flat=True)
        }

    final_targets: list[str] = []
    for uid in candidates:
        if org_id and uid not in valid_member_ids:
            skipped.append({"user_id": uid, "reason": "not_in_organization"})
        else:
            final_targets.append(uid)

    notified = 0
    newly_granted: list[str] = []
    file_uuid = UUID(str(item.resource_id))
    with transaction.atomic(using=postgres_app_db_alias()):
        for uid in final_targets:
            existing = FilePermission.objects.filter(
                file_record_id=file_uuid,
                subject_type="user",
                subject_id=uid,
            ).first()
            if existing and existing.is_active and existing.permission == effective_permission:
                continue
            was_inactive_or_new = existing is None or not existing.is_active
            if existing:
                existing.is_active = True
                existing.permission = effective_permission
                existing.granted_by = inviter_id
                existing.save(update_fields=["is_active", "permission", "granted_by", "updated_at"])
            else:
                FilePermission.objects.create(
                    file_record_id=file_uuid,
                    subject_type="user",
                    subject_id=uid,
                    permission=effective_permission,
                    is_active=True,
                    granted_by=inviter_id,
                    created_by=inviter,
                )
            if was_inactive_or_new:
                newly_granted.append(uid)
            notified += 1

    if newly_granted:
        try:
            from apps.tabtinspace.services.cloud_resource_visibility_events import (
                notify_cloud_resource_access_granted,
            )
            from apps.tabtinspace.services.asset_host import host_id_of

            notify_cloud_resource_access_granted(
                resource_type="tabfiles",
                resource_id=str(item.resource_id),
                organization_id=str(org_id) if org_id else None,
                user_ids=newly_granted,
                actor_user_id=inviter_id,
                title=getattr(item, "title", None),
                space_id=host_id_of(item),
            )
        except Exception:
            logger.warning(
                "[TabFilesShare]  access_granted publish failed file=%s",
                item.resource_id,
                exc_info=True,
            )

    return {"notified": notified, "skipped": skipped}


def revoke_file_collaborator(file_record_id, user_id: str, actor) -> None:
    item = _get_file_item(file_record_id)
    if not check_item_resource_permission(actor, item, "admin"):
        raise ServiceError("PERMISSION_DENIED", "权限不足", status=403)
    FilePermission.objects.filter(
        file_record_id=UUID(str(item.resource_id)),
        subject_type="user",
        subject_id=str(user_id),
        is_active=True,
    ).update(is_active=False)

    try:
        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_revoked,
        )
        from apps.tabtinspace.services.asset_host import host_id_of

        org_id = getattr(item, "organization_id", None)
        notify_cloud_resource_access_revoked(
            resource_type="tabfiles",
            resource_id=str(item.resource_id),
            organization_id=str(org_id) if org_id else None,
            user_ids=[str(user_id)],
            actor_user_id=str(actor.id) if actor else None,
            space_id=host_id_of(item),
        )
    except Exception:
        logger.warning(
            "[TabFilesShare]  access_revoked publish failed file=%s user=%s",
            item.resource_id,
            user_id,
            exc_info=True,
        )


def _user_brief(user) -> dict:
    if user is None:
        return {"user_id": "", "nickname": "", "avatar": None, "email": ""}
    nickname = getattr(user, "nickname", "") or getattr(user, "username", "") or ""
    return {
        "user_id": str(user.id),
        "nickname": nickname,
        "avatar": getattr(user, "avatar", None) or None,
        "email": getattr(user, "email", "") or "",
    }


def list_file_collaborators(file_record_id, viewer) -> dict:
    """返回 {'owner': UserBrief, 'collaborators': [CollaboratorOut]}。"""
    item = _get_file_item(file_record_id)
    if not check_item_resource_permission(viewer, item, "viewer"):
        raise ServiceError("PERMISSION_DENIED", "权限不足", status=403)

    owner_id = str(getattr(item, "created_by_id", "") or "")
    perms = list(
        FilePermission.objects.filter(
            file_record_id=UUID(str(item.resource_id)),
            is_active=True,
            subject_type="user",
        ).order_by("created_at")
    )
    subject_ids = {p.subject_id for p in perms}
    if owner_id:
        subject_ids.add(owner_id)

    users_map = {
        str(u.id): u for u in User.objects.filter(id__in=list(subject_ids))
    } if subject_ids else {}

    owner_user = users_map.get(owner_id) if owner_id else None
    owner_brief = _user_brief(owner_user)
    if owner_id and not owner_brief["user_id"]:
        owner_brief = {
            "user_id": owner_id,
            "nickname": "",
            "avatar": None,
            "email": "",
        }

    collaborators: list[dict] = []
    for perm in perms:
        if owner_id and str(perm.subject_id) == owner_id:
            continue
        brief = _user_brief(users_map.get(str(perm.subject_id)))
        if not brief["user_id"]:
            brief = {
                "user_id": str(perm.subject_id),
                "nickname": "",
                "avatar": None,
                "email": "",
            }
        collaborators.append(
            {
                **brief,
                "permission": TABFILES_SHARED_PERMISSION,
                "created_at": perm.created_at.isoformat() if perm.created_at else None,
            }
        )
    return {"owner": owner_brief, "collaborators": collaborators}


def update_file_collaborator_permission(
    file_record_id,
    user_id: str,
    permission: str,
    actor,
) -> dict:
    if permission not in ASSIGNABLE_ROLES:
        raise ServiceError("INVALID_PERMISSION", "无效权限级别", status=400)
    item = _get_file_item(file_record_id)
    if not check_item_resource_permission(actor, item, "admin"):
        raise ServiceError("PERMISSION_DENIED", "权限不足", status=403)

    user_id = str(user_id)
    owner_id = str(getattr(item, "created_by_id", "") or "")
    if owner_id and user_id == owner_id:
        raise ServiceError("CANNOT_MODIFY_OWNER", "owner 的权限不可修改", status=400)

    perm = FilePermission.objects.filter(
        file_record_id=UUID(str(item.resource_id)),
        subject_type="user",
        subject_id=user_id,
        is_active=True,
    ).first()
    if perm is None:
        raise ServiceError("COLLABORATOR_NOT_FOUND", "协作者不存在", status=404)

    perm.permission = TABFILES_SHARED_PERMISSION
    perm.granted_by = str(actor.id)
    perm.save(update_fields=["permission", "granted_by", "updated_at"])

    target = User.objects.filter(id=user_id).first()
    brief = _user_brief(target)
    if not brief["user_id"]:
        brief = {
            "user_id": user_id,
            "nickname": "",
            "avatar": None,
            "email": "",
        }
    return {
        **brief,
        "permission": TABFILES_SHARED_PERMISSION,
        "created_at": perm.created_at.isoformat() if perm.created_at else None,
    }


def list_files_shared_with_me(viewer, *, organization_id: str | None = None) -> list[dict]:
    if not viewer or not getattr(viewer, "id", None):
        raise ServiceError("AUTH_REQUIRED", "需要登录", status=401)

    user_id = str(viewer.id)
    perms = list(
        FilePermission.objects.filter(
            is_active=True,
            subject_type="user",
            subject_id=user_id,
        ).order_by("-updated_at")
    )
    if not perms:
        return []

    file_ids = [str(p.file_record_id) for p in perms]
    item_qs = (
        ContextItem.objects.filter(
            item_type="tabfiles",
            resource_id__in=file_ids,
            is_archived=False,
            trashed_at__isnull=True,
        )
        .exclude(status="trashed")
        .select_related("created_by")
    )
    if organization_id:
        item_qs = item_qs.filter(organization_id=organization_id)
    items_by_rid = {str(ci.resource_id): ci for ci in item_qs}

    items: list[dict] = []
    for perm in perms:
        rid = str(perm.file_record_id)
        item = items_by_rid.get(rid)
        if item is None:
            continue
        if str(getattr(item, "created_by_id", "") or "") == user_id:
            continue
        owner = item.created_by
        items.append(
            {
                "resource_type": "file",
                "file_record_id": rid,
                "context_item_id": str(item.id),
                "title": item.title or "",
                "organization_id": str(item.organization_id or ""),
                "space_id": "",
                "permission": TABFILES_SHARED_PERMISSION,
                "updated_at": item.updated_at.isoformat() if item.updated_at else None,
                "owner_id": str(getattr(item, "created_by_id", "") or ""),
                "shared_by": (
                    {
                        "id": str(owner.id),
                        "display_name": getattr(owner, "nickname", None)
                        or getattr(owner, "username", "")
                        or str(owner.id),
                        "avatar": getattr(owner, "avatar", "") or "",
                    }
                    if owner
                    else None
                ),
            }
        )
    from apps.tabtinspace.services.shared_resource_location import (
        build_shared_resource_locations,
    )

    locations = build_shared_resource_locations(viewer, items_by_rid.values())
    for row in items:
        context_item = items_by_rid.get(str(row["file_record_id"]))
        row["location"] = (
            locations.get(str(context_item.id), {"kind": "unavailable"})
            if context_item is not None
            else {"kind": "unavailable"}
        )
    return items
