"""
TabData 协作者邀请 / 管理 Service + TableShareService（公开分享）

本模块原本只承载「协作者邀请 / 管理」逻辑（invite_collaborators 等）。
PRD `tabdoc/PRD-shareperm-p0-fix.md` §5 Phase 2 起，
追加 ``TableShareService(PublicShareService)`` 继承公共基类，
统一封装 share_id 生成 / 密码三态 / verify_share_access / 横向越权防护
等所有「匿名公开链接」语义，供 ``tabdata/api_share.py`` 的 share
路由使用（meta / records 公开端点 + create / get / close 管理端点）。

| 区块 | 服务范围 |
|------|----------|
| 顶部：协作者邀请/管理 helper + service 函数 | TablePermission 邀请通知（不变） |
| 底部：``TableShareService`` 类 | TableShare 公开分享（Phase 2 新增） |

两块共享同一个 ``CollaboratorError`` 命名风格（向后兼容），但 TableShareService
统一抛 ``apps.services.common.public_share.exceptions`` 那套异常 ——
view 层可分别 catch 不同分支。
"""

import logging
from datetime import timedelta
from typing import Optional

from django.contrib.auth import get_user_model
from django.db import connections, transaction
from django.utils import timezone

from apps.services.common.public_share import PublicShareService
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TablePermission, TableShare, TableView

logger = logging.getLogger("tabdata.share")

TABDATA_DB = TABDATA_DB_ALIAS  # 'postgresql'
MAX_BATCH_INVITE = 50
DEDUPE_WINDOW_MINUTES = 5
VALID_PERMISSIONS = {"viewer", "editor", "admin"}


class CollaboratorError(Exception):
    """TabData 协作者邀请/管理 service 的统一异常。"""

    def __init__(self, code: str, message: str = "", status: int = 400, data=None):
        self.code = code
        self.message = message
        self.status = status
        self.data = data
        super().__init__(message or code)


# ────────────────────────────────────────────────────────
# helper（与 TabDoc 对称，差异仅在资源类型 / 模型）
# ────────────────────────────────────────────────────────


def _mask_email(email: Optional[str]) -> str:
    if not email or not isinstance(email, str) or "@" not in email:
        return ""
    local, domain = email.split("@", 1)
    if not local:
        return ""
    if len(local) <= 2:
        masked = local[0] + "***"
    else:
        masked = local[0] + "***" + local[-1]
    return f"{masked}@{domain}"


def _user_brief(u) -> dict:
    """统一 UserBrief 序列化；avatar object key 转成公开 CDN URL。"""
    if u is None:
        return {"user_id": "", "nickname": "", "avatar": None, "email": ""}
    nickname = getattr(u, "nickname", "") or getattr(u, "username", "") or ""
    return {
        "user_id": str(u.id),
        "nickname": nickname,
        "avatar": build_public_asset_url(getattr(u, "avatar", "") or "") or None,
        "email": _mask_email(getattr(u, "email", "")),
    }


def _format_inviter_name(inviter) -> str:
    if inviter is None:
        return ""
    nickname = getattr(inviter, "nickname", "") or getattr(inviter, "username", "")
    if nickname:
        return nickname
    email = getattr(inviter, "email", "") or ""
    if email and "@" in email:
        return email.split("@", 1)[0]
    return str(getattr(inviter, "id", ""))[:8]


def _get_table_owner_id(table: Table) -> str:
    """Table.owner 是跨库 FK；只读 owner_id 列即可，不触发跨库 join。"""
    owner_id = getattr(table, "owner_id", None)
    return str(owner_id) if owner_id else ""


def _check_table_admin_via_permission(table: Table, user) -> bool:
    """对操作者验证 admin 权限：owner / organization 内 admin / TablePermission(admin)."""
    if not user or not getattr(user, "id", None):
        return False
    if _get_table_owner_id(table) == str(user.id):
        return True

    from apps.tabdata.services.base import BaseService

    svc = BaseService(user=user)
    return svc.check_table_permission(str(table.id), required_role="admin")


def _check_table_viewer(table: Table, user) -> bool:
    if not user or not getattr(user, "id", None):
        return False
    if _get_table_owner_id(table) == str(user.id):
        return True

    from apps.tabdata.services.base import BaseService

    svc = BaseService(user=user)
    return svc.check_table_permission(str(table.id), required_role="viewer")


def _get_table_for_management(table_id, operator) -> Table:
    try:
        table = Table.objects.using(TABDATA_DB).get(id=table_id)
    except Table.DoesNotExist:
        raise CollaboratorError("TABLE_NOT_FOUND", "表格不存在", status=404)
    if not operator or not getattr(operator, "id", None):
        raise CollaboratorError("AUTH_REQUIRED", "需要登录", status=401)
    if not _check_table_admin_via_permission(table, operator):
        raise CollaboratorError(
            "PERMISSION_DENIED", "需要 admin 权限以管理协作者", status=403,
        )
    return table


def _get_table_for_view(table_id, viewer) -> Table:
    try:
        table = Table.objects.using(TABDATA_DB).get(id=table_id)
    except Table.DoesNotExist:
        raise CollaboratorError("TABLE_NOT_FOUND", "表格不存在", status=404)
    if not viewer or not getattr(viewer, "id", None):
        raise CollaboratorError("AUTH_REQUIRED", "需要登录", status=401)
    if not _check_table_viewer(table, viewer):
        raise CollaboratorError("PERMISSION_DENIED", "无访问权限", status=403)
    return table


def _build_metadata(table: Table, action: str, inviter, *, permission_from=None, permission_to=None) -> dict:
    return {
        "resource_type": "table",
        "resource_id": str(table.id),
        "resource_title": getattr(table, "name", "") or "",
        "action": action,
        "permission_from": permission_from,
        "permission_to": permission_to,
        "inviter_id": str(getattr(inviter, "id", "")),
        "inviter_name": _format_inviter_name(inviter),
        "organization_id": str(table.organization_id) if table.organization_id else None,
        "space_id": str(table.space_id) if table.space_id else None,
        "behavior": (
            "view_context"
            if action == "invited"
            else "notification_only"
        ),
    }


def _build_invitation_text(metadata: dict) -> tuple[str, str]:
    title_label = metadata.get("resource_title", "") or "（未命名）"
    inviter_name = metadata.get("inviter_name", "") or "未知用户"
    perm_to = metadata.get("permission_to")
    action = metadata.get("action")

    perm_label = {"viewer": "查看", "editor": "编辑", "admin": "管理"}
    perm_to_label = perm_label.get(perm_to, perm_to or "")

    if action == "invited":
        return (
            f"{inviter_name} 邀请你协作《{title_label}》",
            f"权限：{perm_to_label}",
        )
    if action == "permission_changed":
        return (
            f"你在《{title_label}》的权限调整为 {perm_to_label}",
            f"操作人：{inviter_name}",
        )
    if action == "removed":
        return (f"你被移出《{title_label}》", f"操作人：{inviter_name}")
    if action == "auto_removed":
        return (f"因离开组织，你已从《{title_label}》移除", "")
    return (f"关于《{title_label}》", "")


def _notify_or_merge(
    user_id: str,
    action: str,
    metadata: dict,
    *,
    dedupe_window_minutes: int = DEDUPE_WINDOW_MINUTES,
) -> None:
    """D7 通知去重，与 TabDoc 完全对称（resource_type='table'）。"""
    from apps.services.notification.models import Notification
    from apps.services.notification.services.notification_service import NotificationService

    resource_id = metadata.get("resource_id", "")
    resource_type = metadata.get("resource_type", "")
    title = metadata.get("_title", "")
    body = metadata.get("_body", "")
    organization_id = metadata.get("organization_id", "") or ""

    clean_meta = {k: v for k, v in metadata.items() if not k.startswith("_")}

    if action in ("removed", "auto_removed"):
        NotificationService.notify(
            user_id=str(user_id),
            type="resource_shared",
            title=title,
            body=body,
            metadata=clean_meta,
            organization_id=organization_id,
        )
        return

    window_start = timezone.now() - timedelta(minutes=dedupe_window_minutes)
    candidate_qs = Notification.objects.filter(
        user_id=str(user_id),
        type="resource_shared",
        is_read=False,
        created_at__gte=window_start,
        metadata__resource_id=resource_id,
        metadata__resource_type=resource_type,
    ).order_by("-created_at")

    existing = None
    for n in candidate_qs:
        prev_action = (n.metadata or {}).get("action")
        if prev_action in ("invited", "permission_changed"):
            existing = n
            break

    if existing is None:
        NotificationService.notify(
            user_id=str(user_id),
            type="resource_shared",
            title=title,
            body=body,
            metadata=clean_meta,
            organization_id=organization_id,
        )
        return

    merged_meta = dict(existing.metadata or {})
    merged_meta["action"] = "permission_changed"
    if "permission_from" not in merged_meta or merged_meta.get("permission_from") in (None, ""):
        merged_meta["permission_from"] = clean_meta.get("permission_from")
    merged_meta["permission_to"] = clean_meta.get("permission_to")
    merged_meta["behavior"] = clean_meta.get("behavior", "notification_only")
    for k in (
        "resource_type",
        "resource_id",
        "resource_title",
        "inviter_id",
        "inviter_name",
        "organization_id",
        "space_id",
    ):
        if k in clean_meta:
            merged_meta[k] = clean_meta[k]

    existing.metadata = merged_meta
    existing.title = title
    existing.body = body
    existing.space_id = merged_meta.get("space_id", "") or ""
    # ：合并后 bump created_at，避免 newest-wins 仍认更早的 removed。
    existing.created_at = timezone.now()
    existing.save(update_fields=["metadata", "title", "body", "space_id", "created_at"])


def _schedule_notify(user_id: str, action: str, metadata: dict) -> None:
    title, body = _build_invitation_text(metadata)
    enriched = dict(metadata)
    enriched["_title"] = title
    enriched["_body"] = body

    def _push():
        try:
            _notify_or_merge(user_id, action, enriched)
        except Exception as exc:
            logger.warning("协作者通知推送失败（非阻断）: %s", exc)

    connections[TABDATA_DB].on_commit(_push)


def _validate_permission(permission: str) -> None:
    if permission not in VALID_PERMISSIONS:
        raise CollaboratorError(
            "INVALID_PERMISSION",
            f"权限 {permission!r} 不合法，应为 viewer/editor/admin",
            status=400,
        )


def _schedule_table_collab_revoke(
    table_id, user_id: str, *, read_only: bool = False,
) -> None:
    """事务提交后异步踢/降级该用户在单表上的 collab-live 连接（RV-015）。"""
    document_name = f"table:{table_id}"
    user_id = str(user_id)

    def _do_revoke():
        try:
            from apps.collab.tasks import async_revoke_document_collab_access

            async_revoke_document_collab_access.delay(
                document_name, user_id, read_only=read_only,
            )
        except Exception:
            logger.warning(
                "[ShareService] schedule table collab revoke failed table=%s user=%s read_only=%s",
                document_name,
                user_id,
                read_only,
                exc_info=True,
            )

    connections[TABDATA_DB].on_commit(_do_revoke)


def _filter_organization_members(organization_id, user_ids: list[str]) -> set[str]:
    from apps.tabtinspace.models import OrganizationMember

    qs = OrganizationMember.objects.filter(
        organization_id=organization_id, user_id__in=user_ids,
    ).values_list("user_id", flat=True)
    return {str(uid) for uid in qs}


# ────────────────────────────────────────────────────────
# 公共 API（与 TabDoc 函数签名对称）
# ────────────────────────────────────────────────────────


def invite_collaborators(
    table_id, user_ids: list[str], permission: str, inviter,
    *, reactivate_inactive: bool = True,
) -> dict:
    """邀请协作者（D1 幂等 + D7 通知去重）。

    ``reactivate_inactive=False`` 用于资源卡等“仅首次授权”入口，保证共享服务
    不会在调用方预检后重新激活已撤权记录。
    返回：{'notified': int, 'skipped': [{user_id, reason}]}
    """
    if not isinstance(user_ids, list):
        raise CollaboratorError("INVALID_INPUT", "user_ids 必须是数组", status=400)

    user_ids = [str(uid) for uid in user_ids if uid]
    if len(user_ids) > MAX_BATCH_INVITE:
        raise CollaboratorError(
            "RATE_LIMIT_EXCEEDED",
            f"单次最多邀请 {MAX_BATCH_INVITE} 人",
            status=400,
        )

    _validate_permission(permission)

    table = _get_table_for_management(table_id, inviter)

    skipped: list[dict] = []
    owner_id_str = _get_table_owner_id(table)
    inviter_id_str = str(inviter.id)

    candidates: list[str] = []
    seen: set[str] = set()
    for uid in user_ids:
        if uid in seen:
            continue
        seen.add(uid)
        if uid == inviter_id_str:
            skipped.append({"user_id": uid, "reason": "self"})
            continue
        if owner_id_str and uid == owner_id_str:
            skipped.append({"user_id": uid, "reason": "is_owner"})
            continue
        candidates.append(uid)

    if not candidates:
        return {"notified": 0, "skipped": skipped}

    valid_member_ids = _filter_organization_members(table.organization_id, candidates)
    final_targets: list[str] = []
    for uid in candidates:
        if uid not in valid_member_ids:
            skipped.append({"user_id": uid, "reason": "not_in_organization"})
        else:
            final_targets.append(uid)

    if not final_targets:
        return {"notified": 0, "skipped": skipped}

    notified_count = 0
    newly_granted: list[str] = []
    changed_user_ids: list[str] = []
    independently_granted_user_ids: list[str] = []
    with transaction.atomic(using=TABDATA_DB):
        for uid in final_targets:
            existing = (
                TablePermission.objects.using(TABDATA_DB)
                .filter(table=table, subject_type="user", subject_id=uid)
                .first()
            )
            if existing and existing.is_active:
                independently_granted_user_ids.append(uid)
                if existing.permission == permission:
                    continue
                old_permission = existing.permission
                existing.permission = permission
                existing.save(using=TABDATA_DB, update_fields=["permission", "updated_at"])
                metadata = _build_metadata(
                    table, "permission_changed", inviter,
                    permission_from=old_permission, permission_to=permission,
                )
                _schedule_notify(uid, "permission_changed", metadata)
                changed_user_ids.append(uid)
                if permission == "viewer" and old_permission != "viewer":
                    _schedule_table_collab_revoke(table.id, uid, read_only=True)
                notified_count += 1
            elif existing and not existing.is_active:
                if not reactivate_inactive:
                    skipped.append({"user_id": uid, "reason": "previously_removed"})
                    continue
                existing.is_active = True
                existing.permission = permission
                existing.save(using=TABDATA_DB, update_fields=["is_active", "permission", "updated_at"])
                metadata = _build_metadata(
                    table, "invited", inviter,
                    permission_from=None, permission_to=permission,
                )
                _schedule_notify(uid, "invited", metadata)
                newly_granted.append(uid)
                independently_granted_user_ids.append(uid)
                notified_count += 1
            else:
                TablePermission.objects.using(TABDATA_DB).create(
                    table=table,
                    subject_type="user",
                    subject_id=uid,
                    permission=permission,
                    is_active=True,
                    granted_by=inviter_id_str,
                )
                metadata = _build_metadata(
                    table, "invited", inviter,
                    permission_from=None, permission_to=permission,
                )
                _schedule_notify(uid, "invited", metadata)
                newly_granted.append(uid)
                independently_granted_user_ids.append(uid)
                notified_count += 1

    if newly_granted:
        try:
            from apps.tabtinspace.services.cloud_resource_visibility_events import (
                notify_cloud_resource_access_granted,
            )

            notify_cloud_resource_access_granted(
                resource_type="tabdata",
                resource_id=str(table.id),
                organization_id=str(table.organization_id) if table.organization_id else None,
                user_ids=newly_granted,
                actor_user_id=inviter_id_str,
                title=getattr(table, "name", None) or getattr(table, "title", None),
                space_id=str(table.space_id) if getattr(table, "space_id", None) else None,
            )
        except Exception:
            logger.warning(
                "[ShareService]  access_granted publish failed table=%s",
                table.id,
                exc_info=True,
            )

    from apps.chat.conversation.services.session_share_resource_permission_service import (
        mark_resource_access_independently_granted,
    )

    mark_resource_access_independently_granted(
        resource_type="table",
        resource_id=str(table.id),
        user_ids=independently_granted_user_ids,
        permission=permission,
    )

    if changed_user_ids:
        try:
            from apps.tabtinspace.services.cloud_resource_visibility_events import (
                notify_cloud_resource_access_changed,
            )

            notify_cloud_resource_access_changed(
                resource_type="tabdata",
                resource_id=str(table.id),
                organization_id=str(table.organization_id) if table.organization_id else None,
                user_ids=changed_user_ids,
                actor_user_id=inviter_id_str,
                space_id=str(table.space_id) if getattr(table, "space_id", None) else None,
                db_alias=TABDATA_DB,
            )
        except Exception:
            logger.warning(
                "[ShareService] access_changed publish failed table=%s users=%s",
                table.id,
                changed_user_ids,
                exc_info=True,
            )
    return {"notified": notified_count, "skipped": skipped}


def list_collaborators(table_id, viewer) -> dict:
    """{'owner': UserBrief, 'collaborators': [CollaboratorOut]}（D9 + D1 user-only）。"""
    table = _get_table_for_view(table_id, viewer)
    User = get_user_model()

    perms = list(
        TablePermission.objects.using(TABDATA_DB)
        .filter(table=table, is_active=True, subject_type="user")
        .order_by("created_at")
    )

    subject_ids = [p.subject_id for p in perms]
    owner_id_str = _get_table_owner_id(table)
    extra_lookup_ids = set(subject_ids)
    if owner_id_str:
        extra_lookup_ids.add(owner_id_str)

    users_map: dict[str, object] = {}
    if extra_lookup_ids:
        for u in User.objects.using("default").filter(id__in=list(extra_lookup_ids)):
            users_map[str(u.id)] = u

    owner_brief = _user_brief(users_map.get(owner_id_str)) if owner_id_str else _user_brief(None)
    if owner_id_str and owner_brief["user_id"] == "":
        owner_brief = {
            "user_id": owner_id_str,
            "nickname": "",
            "avatar": None,
            "email": "",
        }

    collaborators: list[dict] = []
    for p in perms:
        u = users_map.get(p.subject_id)
        brief = _user_brief(u) if u else {
            "user_id": p.subject_id,
            "nickname": "",
            "avatar": None,
            "email": "",
        }
        item = dict(brief)
        item["permission"] = p.permission
        item["created_at"] = p.created_at.isoformat() if p.created_at else None
        collaborators.append(item)

    return {"owner": owner_brief, "collaborators": collaborators}


def update_collaborator_permission(
    table_id, user_id: str, permission: str, operator,
) -> dict:
    user_id = str(user_id)
    _validate_permission(permission)
    table = _get_table_for_management(table_id, operator)

    owner_id_str = _get_table_owner_id(table)
    if owner_id_str and user_id == owner_id_str:
        raise CollaboratorError("CANNOT_MODIFY_OWNER", "owner 的权限不可修改", status=400)

    perm = (
        TablePermission.objects.using(TABDATA_DB)
        .filter(table=table, subject_type="user", subject_id=user_id, is_active=True)
        .first()
    )
    if perm is None:
        raise CollaboratorError("COLLABORATOR_NOT_FOUND", "协作者不存在", status=404)

    from apps.chat.conversation.services.session_share_resource_permission_service import (
        mark_resource_access_independently_granted,
    )

    mark_resource_access_independently_granted(
        resource_type="table",
        resource_id=str(table.id),
        user_ids=[user_id],
        permission=permission,
    )

    if perm.permission == permission:
        return _serialize_collaborator(perm)

    old_permission = perm.permission
    with transaction.atomic(using=TABDATA_DB):
        perm.permission = permission
        perm.save(using=TABDATA_DB, update_fields=["permission", "updated_at"])
        metadata = _build_metadata(
            table, "permission_changed", operator,
            permission_from=old_permission, permission_to=permission,
        )
        _schedule_notify(user_id, "permission_changed", metadata)
        # 降为 viewer：立刻把既有可写连接降为只读，避免仍写 Yjs
        if permission == "viewer" and old_permission != "viewer":
            _schedule_table_collab_revoke(table.id, user_id, read_only=True)

    try:
        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_changed,
        )

        notify_cloud_resource_access_changed(
            resource_type="tabdata",
            resource_id=str(table.id),
            organization_id=str(table.organization_id) if table.organization_id else None,
            user_ids=[user_id],
            actor_user_id=str(operator.id) if operator else None,
            space_id=str(table.space_id) if getattr(table, "space_id", None) else None,
            db_alias=TABDATA_DB,
        )
    except Exception:
        logger.warning(
            "[ShareService] access_changed publish failed table=%s user=%s",
            table.id,
            user_id,
            exc_info=True,
        )

    return _serialize_collaborator(perm)


def remove_collaborator(
    table_id, user_id: str, operator, *, action: str = "removed",
) -> None:
    user_id = str(user_id)
    if action not in ("removed", "auto_removed"):
        raise CollaboratorError("INVALID_ACTION", f"action {action!r} 不合法", status=400)

    table = _get_table_for_management(table_id, operator)

    owner_id_str = _get_table_owner_id(table)
    if owner_id_str and user_id == owner_id_str:
        raise CollaboratorError("CANNOT_REMOVE_OWNER", "owner 不可移除", status=400)

    perm = (
        TablePermission.objects.using(TABDATA_DB)
        .filter(table=table, subject_type="user", subject_id=user_id, is_active=True)
        .first()
    )
    if perm is None:
        raise CollaboratorError("COLLABORATOR_NOT_FOUND", "协作者不存在", status=404)

    old_permission = perm.permission
    with transaction.atomic(using=TABDATA_DB):
        perm.is_active = False
        perm.save(using=TABDATA_DB, update_fields=["is_active", "updated_at"])
        metadata = _build_metadata(
            table, action, operator,
            permission_from=old_permission, permission_to=None,
        )
        _schedule_notify(user_id, action, metadata)
        # 撤权后立刻踢 collab 连接，避免在线列表/Awareness 滞留
        _schedule_table_collab_revoke(table.id, user_id, read_only=False)

    try:
        from apps.tabtinspace.services.cloud_resource_visibility_events import (
            notify_cloud_resource_access_revoked,
        )

        notify_cloud_resource_access_revoked(
            resource_type="tabdata",
            resource_id=str(table.id),
            organization_id=str(table.organization_id) if table.organization_id else None,
            user_ids=[user_id],
            actor_user_id=str(operator.id) if operator else None,
            space_id=str(table.space_id) if getattr(table, "space_id", None) else None,
        )
    except Exception:
        logger.warning(
            "[ShareService]  access_revoked publish failed table=%s user=%s",
            table.id,
            user_id,
            exc_info=True,
        )


def _serialize_collaborator(perm: TablePermission) -> dict:
    User = get_user_model()
    user = User.objects.using("default").filter(id=perm.subject_id).first()
    base = _user_brief(user) if user else {
        "user_id": perm.subject_id,
        "nickname": "",
        "avatar": None,
        "email": "",
    }
    base["permission"] = perm.permission
    base["created_at"] = perm.created_at.isoformat() if perm.created_at else None
    return base


def _enrich_shared_by(items: list[dict]) -> None:
    """批量回填 shared_by 展示信息（资源所有者）到 items[i]['shared_by']。

    「分享给我」的位置列需显示「由 xxx 分享」，xxx 即资源 owner。
    一次 build_user_info_map 批量解析，避免 N+1，并复用全站统一的
    display_name + 头像解析逻辑。每条 item 需先带 owner_id（会被消费弹出）。
    """
    owner_ids: list[str] = []
    seen: set[str] = set()
    for data in items:
        oid = data.get("owner_id")
        if oid:
            oid = str(oid)
            if oid not in seen:
                seen.add(oid)
                owner_ids.append(oid)

    info_map: dict = {}
    if owner_ids:
        try:
            from apps.services.billing.services.member_usage_service import build_user_info_map
            info_map = build_user_info_map(owner_ids)
        except Exception as exc:
            logger.warning("[shared_with_me] build_user_info_map failed: %s", exc)
            info_map = {}

    for data in items:
        oid = data.pop("owner_id", None)
        info = info_map.get(str(oid)) if oid else None
        if oid and info:
            data["shared_by"] = {
                "id": str(oid),
                "display_name": info.get("display_name", ""),
                "avatar": info.get("avatar", ""),
            }
        else:
            data["shared_by"] = None


def list_tables_shared_with_me(viewer, *, organization_id: str | None = None) -> list[dict]:
    """列出「分享给我」的表格（与 TabDoc 对称的独立访问发现入口）。

    Agent 私有化后协作者无法看到他人的 workspace，只能通过资源级
    TablePermission 访问被显式分享的表格。返回当前用户具备有效
    TablePermission（subject_type=user）但本人非 owner 的活跃表格，
    每条带 organization_id / table_id，供前端按资源 id 独立打开。
    """
    if not viewer or not getattr(viewer, "id", None):
        raise CollaboratorError("AUTH_REQUIRED", "需要登录", status=401)

    user_id = str(viewer.id)

    perms = (
        TablePermission.objects.using(TABDATA_DB)
        .filter(is_active=True, subject_type="user", subject_id=user_id)
        .select_related("table")
        .order_by("-table__updated_at")
    )

    items: list[dict] = []
    for perm in perms:
        table = perm.table
        if table is None:
            continue
        if _get_table_owner_id(table) == user_id:
            continue
        if getattr(table, "is_archived", False):
            continue
        if getattr(table, "trashed_at", None) is not None:
            continue
        if organization_id and str(table.organization_id) != str(organization_id):
            continue
        items.append(
            {
                "resource_type": "table",
                "table_id": str(table.id),
                "title": table.name or "",
                "icon": getattr(table, "icon", "") or "",
                "organization_id": str(table.organization_id) if table.organization_id else None,
                # org-only时 space_id 为空串，避免前端拿到字符串 "None"
                "space_id": str(table.space_id) if table.space_id else "",
                "permission": perm.permission,
                "updated_at": table.updated_at.isoformat() if getattr(table, "updated_at", None) else None,
                "owner_id": _get_table_owner_id(table),
            }
        )

    _enrich_shared_by(items)
    from apps.tabtinspace.services.shared_resource_location import (
        enrich_shared_rows_with_locations,
    )

    enrich_shared_rows_with_locations(
        items,
        viewer=viewer,
        item_type="tabdata",
        resource_id_key="table_id",
    )
    return items


# ════════════════════════════════════════════════════════════════════
# TableShareService —— TabData 公开分享统一入口
# （PRD `tabdoc/PRD-shareperm-p0-fix.md` §3.4 / §5 Phase 2）
# ════════════════════════════════════════════════════════════════════


class TableShareService(PublicShareService):
    """TabData 表格公开分享 service。

    继承 ``PublicShareService`` 公共基类，负责：

    - share_id 生成 / 密码三态（由基类提供）
    - ``verify_share_access`` 公开端点鉴权（organization 校验 + 密码校验）
    - ``load_resource_for_management`` 管理端点横向越权防护
    - ``validate_organization_scope`` 跨租户校验（P1-3）
    - ``serialize_meta`` / ``serialize_content`` 元信息 / 记录序列化

    与 TabDoc ``DocumentShareService`` 对称，仅在底层模型 + 序列化字段上有差异。

    **重要：本 service 不替代「协作者邀请 / TablePermission 管理」逻辑** ——
    后者继续走本文件顶部的 ``invite_collaborators`` / ``list_collaborators`` 等
    函数式 API（资源对象是 TablePermission，与 TableShare 完全独立）。
    """

    share_model = TableShare
    resource_model = Table
    db_alias = TABDATA_DB
    collab_resource_type = "table"

    @classmethod
    def issue_share_collab_token(cls, share, *, user=None) -> dict:
        """签发分享页 collab token；字段可见性受限时降级为 REST 投影。

        不签发 ``share_collab_token``，返回稳定降级契约，迫使客户端走角色过滤后的 REST。
        """
        from apps.tabdata.services.field_visibility import (
            COLLAB_MODE_FULL,
            build_collab_degradation_payload,
            evaluate_collab_access,
        )

        table = cls._resource_from_share(share)
        decision = evaluate_collab_access(user, table, share=share)
        if not decision.get("allowed"):
            return build_collab_degradation_payload(
                decision,
                resource_type=cls.collab_resource_type,
                resource_id=str(table.id),
                permission=getattr(share, "permission", None),
            )

        payload = super().issue_share_collab_token(share, user=user)
        payload["collab_mode"] = COLLAB_MODE_FULL
        payload["reason"] = None
        payload["authorized"] = True
        payload["visible_field_count"] = decision.get("visible_field_count")
        payload["total_field_count"] = decision.get("total_field_count")
        payload["hidden_field_count"] = 0
        return payload

    @classmethod
    def check_resource_admin(
        cls, resource, user, *, required_role: str = "admin",
    ) -> bool:
        """桥接到 ``BaseService.check_table_permission``。

        ``BaseService.check_table_permission``：

        1. ``table.owner_id == user.id`` 直通
        2. ``TablePermission(subject_type='user', is_active=True)`` 显式协作者；
           命中但级别不足时直接拒绝
        3. **不再**回退 Space / Organization 角色
        """
        from apps.tabdata.services.base import BaseService

        if not user or not getattr(user, "id", None):
            return False
        return BaseService(user=user).check_table_permission(
            str(resource.id), required_role=required_role,
        )

    @classmethod
    def serialize_meta(
        cls, share, *, include_protected: bool = False, user=None,
    ) -> dict:
        """序列化 meta 端点响应。

        **R2 关键约束**（PRD §6.1 R2）：tabdata 的 SharedTablePage 在「有密码 +
        密码未通过」态下需要 ``table_name`` / ``table_icon`` /
        ``table_description`` 才不白屏，但**绝不能**返回 ``fields[]`` / ``view_name``
        / ``permission`` / ``allow_download``（fields[] 是最严重泄漏 ——
        包含表完整字段 schema）。

        因此本方法用 ``include_protected`` 切换：

        - ``include_protected=False`` —— 密码未通过 / 越权未通过时调用，
          返回基础展示字段（share_id / share_type / has_password +
          table_name / table_icon / table_description）
        - ``include_protected=True`` —— verify_share_access 通过后调用，
          额外返回 ``fields[]`` / ``view_name`` / ``permission`` / ``allow_download``；
          ``fields[]`` 按分享有效角色过滤 visibility_roles

        Args:
            share: TableShare 实例（select_related('table', 'view') 优先）
            include_protected: 是否包含保护字段（fields / view_name / permission /
                allow_download）
            user: 当前访问者（匿名可为 None）；用于解析分享有效角色

        Returns:
            dict 形式的 meta 响应体
        """
        from apps.tabdata.services.field_visibility import (
            get_visible_fields,
            resolve_effective_table_role,
        )

        table = share.table
        meta: dict = {
            "share_id": share.share_id,
            "share_type": share.share_type,
            "has_password": share.has_password,
            "requires_login": cls.share_requires_authenticated_user(share),
            "table_name": table.name,
            "table_description": table.description or "",
            "table_icon": table.icon or "",
        }

        if not include_protected:
            return meta

        role = resolve_effective_table_role(user, table, share=share)
        visible_fields = get_visible_fields(table.id, role) if role else []
        meta.update({
            "table_id": str(table.id),
            "space_id": str(table.space_id) if getattr(table, "space_id", None) else None,
            "organization_id": str(table.organization_id) if getattr(table, "organization_id", None) else None,
            "view_id": str(share.view_id) if share.view_id else None,
            "permission": share.permission,
            "allow_download": share.allow_download,
            "fields": [
                {
                    "id": str(field.id),
                    "name": field.name,
                    "field_type": field.field_type,
                }
                for field in visible_fields
            ],
            "view_name": share.view.name if share.view_id and share.view else None,
        })
        return meta

    @classmethod
    def serialize_content(cls, share, *, user=None) -> dict:
        """序列化 content 端点响应（默认首页 records）。"""
        return cls.get_records(share, user=user, page=1, page_size=100)

    @classmethod
    def share_requires_authenticated_user(cls, share) -> bool:
        """旧调用点兼容：表示协作写入需要登录，不代表读取需要登录。"""
        return cls.share_requires_authenticated_editor(share)

    @classmethod
    def share_requires_authenticated_editor(cls, share) -> bool:
        """可编辑表格分享必须先登录，再进入写入能力。

        历史 ``comment`` 分享允许匿名读取 meta/records；评论专用端点
        会在 ``_authorize_comment_share`` 中单独要求登录，不收紧旧读契约。
        """
        return getattr(share, "permission", None) == "edit"

    @classmethod
    def ensure_authenticated_interactive_user(cls, share, *, user) -> None:
        if cls.share_requires_authenticated_editor(share) and not getattr(user, "id", None):
            from apps.services.common.public_share.exceptions import SharePermissionDeniedError

            raise SharePermissionDeniedError("Need login")

    @classmethod
    def get_records(cls, share, *, user=None, page: int = 1, page_size: int = 50) -> dict:
        """拉取分享视图的记录数据（分页）。

        鉴权由调用方的 ``verify_share_access`` 完成 —— 分享本身即授权。
        **禁止**以表格 owner 代读：按接收者 / 分享有效角色取数，
        并投影到该角色可见字段。

        视图解析顺序：share.view → table.default_view → order 最小的视图。
        """
        from apps.tabdata.services.field_visibility import (
            get_visible_fields,
            resolve_effective_table_role,
        )
        from apps.tabdata.services.view_data_service import ViewDataService

        table = share.table
        role = resolve_effective_table_role(user, table, share=share)
        if role is None:
            return {
                "share_id": share.share_id, "records": [], "total": 0,
                "page": page, "page_size": page_size,
            }

        view = share.view if (share.view_id and share.view) else None
        if view is None:
            view = getattr(table, "default_view", None)
        if view is None:
            view = (
                TableView.objects.using(cls.db_alias)
                .filter(table_id=table.id)
                .order_by("order", "created_at")
                .first()
            )
        if view is None:
            return {
                "share_id": share.share_id, "records": [], "total": 0,
                "page": page, "page_size": page_size,
            }

        visible_fields = get_visible_fields(table.id, role)
        visible_field_names = [field.name for field in visible_fields]

        # 挂上 share grant，供 ViewDataService 内 resolve_effective_table_role 读到分享上限
        # （不依赖 owner 代读；check_table_permission 仍由 skip_permission_check 跳过）
        from apps.tabdata.request_context import (
            get_current_table_share_grant,
            set_current_table_share_grant,
        )

        previous_grant = get_current_table_share_grant()
        set_current_table_share_grant(share)
        try:
            result = ViewDataService(user=user).get_view_records(
                view_id=view.id,
                page=page,
                page_size=page_size,
                fields=visible_field_names,
                field_key_type="name",
                skip_permission_check=True,
            )
        finally:
            set_current_table_share_grant(previous_grant)

        from apps.tabdata.services.attachment_service import AttachmentService

        records = AttachmentService(user=user).hydrate_authorized_records(
            result.get("records", []),
            table_id=table.id,
            visible_fields=visible_fields,
            field_key_type="name",
        )

        return {
            "share_id": share.share_id,
            "records": records,
            "total": result.get("total", 0),
            "page": page,
            "page_size": page_size,
        }

    @classmethod
    def update_shared_record(
        cls,
        share,
        *,
        user,
        password: str = "",
        record_id,
        data: dict,
    ):
        """通过可编辑分享链接更新一条记录的单元格数据。"""
        from apps.services.common.public_share.exceptions import SharePermissionDeniedError
        from apps.tabdata.models import TableRecord
        from apps.tabdata.services.record_service import RecordService

        cls.ensure_authenticated_interactive_user(share, user=user)
        cls.verify_share_access(share, password=password, user=user)
        if getattr(share, "permission", None) != "edit":
            raise SharePermissionDeniedError("Share link does not allow editing")

        record = (
            TableRecord.objects.using(cls.db_alias)
            .filter(id=record_id, table_id=share.table_id, is_deleted=False)
            .only("id", "table_id")
            .first()
        )
        if record is None:
            raise TableRecord.DoesNotExist

        from apps.tabdata.services.field_visibility import (
            get_visible_field_key_sets,
            reject_invisible_field_writes,
            resolve_effective_table_role,
        )

        write_err = reject_invisible_field_writes(
            data,
            user=user,
            table=share.table,
            share=share,
        )
        if write_err:
            raise ValueError(write_err)

        record_service = RecordService(user=user)
        updated_record, error = record_service.update_record(
            record.id,
            data,
            share_grant=share,
        )
        if error:
            raise ValueError(error)

        # 写回响应不得带回当前角色不可见字段（与 list/get 同一投影）
        if updated_record is not None:
            role = resolve_effective_table_role(user, share.table, share=share)
            visible_keys = get_visible_field_key_sets(share.table_id, role)
            record_service._apply_visibility_filter(updated_record, visible_keys)
        return updated_record
