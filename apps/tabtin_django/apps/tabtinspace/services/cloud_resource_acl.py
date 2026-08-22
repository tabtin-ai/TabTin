"""云盘资源 ACL。

Organization 只做归属/计费边界，不授予内容权限。
云盘资源默认私有：仅 owner 或显式 Permission 可见/可操作。

组织回收站（个人视角）：每人只看/操作自己删除的资源；恢复时校验组织级类型额度。
活跃云盘列表仍不因组织角色抬权。
"""
from __future__ import annotations

import logging
from typing import Any, Iterable, Optional
from uuid import UUID

from django.db.models import Q

from apps.services.common.constants import ROLE_LEVELS

logger = logging.getLogger(__name__)

# 云资产类型：列表与写操作一律走资源级授权，不回退组织角色
CLOUD_ITEM_TYPES = frozenset({"tabdata", "tabdoc", "tabfiles"})
TABFILES_SHARED_PERMISSION = "viewer"

# 恢复时按类型校验的数量额度（与创建口径对齐；无映射类型仅走存储预检）
RESTORE_COUNT_QUOTA_BY_ITEM_TYPE = {
    "tabdoc": "max_documents",
    "tabdata": "max_tables",
}


def organization_resource_host_q(organization_id) -> Q:
    """本组织下 ContextItem 宿主范围（org-only ∪ workspace/project 属该 org）。"""
    return (
        Q(organization_id=organization_id)
        | Q(workspace__organization_id=organization_id)
        | Q(project__organization_id=organization_id)
    )


def is_personal_trash_operator(
    user,
    *,
    trashed_by=None,
    created_by_id=None,
) -> bool:
    """个人回收站操作权：删除者；历史空 trashed_by 时回退创建者。"""
    if not user or not getattr(user, "id", None):
        return False
    uid = str(user.id)
    if trashed_by is not None and str(trashed_by) != "":
        return str(trashed_by) == uid
    if created_by_id is not None and str(created_by_id) != "":
        return str(created_by_id) == uid
    return False


def personal_trash_visibility_q(user) -> Q:
    """列表过滤：当前用户删除的项（含历史空 trashed_by 的本人创建项）。"""
    if not user or not getattr(user, "id", None):
        return Q(pk__in=[])
    uid = user.id
    return Q(trashed_by=uid) | Q(trashed_by__isnull=True, created_by_id=uid)


def check_restore_count_quota(
    item_type: Optional[str],
    organization_id,
    user,
) -> None:
    """恢复前数量额度；超限抛 MembershipException（与创建同路径）。"""
    if not item_type or not organization_id:
        return
    quota_type = RESTORE_COUNT_QUOTA_BY_ITEM_TYPE.get(item_type)
    if not quota_type:
        return
    from apps.users.membership.services.quota_service import QuotaService

    QuotaService().check_quota(
        quota_type=quota_type,
        increment=1,
        organization_id=str(organization_id),
        actor=user,
    )

# 能力所需最低角色
# can_move=owner：个人文件夹树按创建者隔离，共享 editor 不能改 owner 资源的 collection 位置
CAPABILITY_MIN_ROLE = {
    "can_view": "viewer",
    "can_edit": "editor",
    "can_move": "owner",
    "can_share": "admin",
    "can_trash": "admin",
    "can_delete": "admin",
}


def role_at_least(role: Optional[str], required: str) -> bool:
    if not role:
        return False
    return ROLE_LEVELS.get(role, 0) >= ROLE_LEVELS.get(required, 0)


def capabilities_for_role(role: Optional[str], *, is_owner: bool = False) -> dict[str, bool]:
    effective = "owner" if is_owner else role
    return {
        key: role_at_least(effective, minimum)
        for key, minimum in CAPABILITY_MIN_ROLE.items()
    }


def empty_capabilities() -> dict[str, bool]:
    return {key: False for key in CAPABILITY_MIN_ROLE}


def resolve_tabdoc_role(user, resource_id: str) -> Optional[str]:
    if not user or not resource_id:
        return None
    from django.core.exceptions import ValidationError

    from apps.tabdoc.models import Document
    from apps.tabdoc.services.document_service import DocumentService

    try:
        document = Document.objects.filter(id=resource_id).first()
    except (ValueError, TypeError, ValidationError):
        return None
    if document is None:
        return None
    return DocumentService(user=user).compute_user_document_role(document)


def resolve_tabdata_role(user, resource_id: str) -> Optional[str]:
    if not user or not resource_id:
        return None
    from apps.tabdata.services.base import BaseService as TabDataBaseService

    return TabDataBaseService(user=user).get_table_role(str(resource_id))


def resolve_tabfiles_role(user, resource_id: str, *, created_by_id: Optional[str] = None) -> Optional[str]:
    """TabFiles：owner = ContextItem.created_by 或 FileRecord.upload_user；否则 FilePermission。"""
    if not user or not getattr(user, "id", None):
        return None
    user_id = str(user.id)
    if created_by_id and str(created_by_id) == user_id:
        return "owner"

    from apps.services.oss.models import FileRecord
    from apps.tabtinspace.models import FilePermission

    try:
        file_uuid = UUID(str(resource_id))
    except (TypeError, ValueError):
        return None

    if not created_by_id:
        upload_user = (
            FileRecord.objects.filter(id=file_uuid)
            .values_list("upload_user", flat=True)
            .first()
        )
        if upload_user and str(upload_user) == user_id:
            return "owner"

    has_permission = (
        FilePermission.objects.filter(
            file_record_id=file_uuid,
            subject_type="user",
            subject_id=user_id,
            is_active=True,
        )
        .exists()
    )
    # 静态文件只支持查看/下载；历史 editor/admin 行也不得提升能力。
    return TABFILES_SHARED_PERMISSION if has_permission else None


def resolve_item_role(user, item) -> Optional[str]:
    """解析 ContextItem 上当前用户的有效角色。"""
    item_type = getattr(item, "item_type", None)
    resource_id = getattr(item, "resource_id", None) or ""
    if item_type == "tabdoc":
        return resolve_tabdoc_role(user, resource_id)
    if item_type == "tabdata":
        return resolve_tabdata_role(user, resource_id)
    if item_type == "tabfiles":
        created_by_id = getattr(item, "created_by_id", None)
        return resolve_tabfiles_role(user, resource_id, created_by_id=created_by_id)
    return None


def check_item_resource_permission(user, item, required_role: str = "viewer") -> bool:
    role = resolve_item_role(user, item)
    if role == "owner":
        return True
    return role_at_least(role, required_role)


def owned_cloud_resource_ids(user, item_type: str) -> set[str]:
    """返回当前用户拥有的云资产 resource_id 集合。"""
    if not user or not getattr(user, "id", None):
        return set()
    item_type = (item_type or "").strip()

    if item_type == "tabdoc":
        from apps.tabdoc.models import Document

        return {
            str(rid)
            for rid in Document.objects.filter(owner_id=user.id).values_list("id", flat=True)
        }

    if item_type == "tabdata":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table

        return {
            str(rid)
            for rid in Table.objects.using(TABDATA_DB_ALIAS)
            .filter(owner_id=user.id)
            .values_list("id", flat=True)
        }

    return set()


def accessible_cloud_resource_ids(user, item_type: str) -> set[str]:
    """返回用户对某云资产类型可访问的 resource_id 集合（owner ∪ 显式 ACL）。"""
    if not user or not getattr(user, "id", None):
        return set()
    user_id = str(user.id)
    item_type = (item_type or "").strip()

    if item_type == "tabdoc":
        from apps.tabdoc.models import DocumentPermission

        shared = {
            str(rid)
            for rid in DocumentPermission.objects.filter(
                is_active=True,
                subject_type="user",
                subject_id=user_id,
            ).values_list("document_id", flat=True)
        }
        return owned_cloud_resource_ids(user, item_type) | shared

    if item_type == "tabdata":
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import TablePermission

        shared = {
            str(rid)
            for rid in TablePermission.objects.using(TABDATA_DB_ALIAS)
            .filter(
                is_active=True,
                subject_type="user",
                subject_id=user_id,
            )
            .values_list("table_id", flat=True)
        }
        return owned_cloud_resource_ids(user, item_type) | shared

    if item_type == "tabfiles":
        from apps.tabtinspace.models import FilePermission

        shared = {
            str(rid)
            for rid in FilePermission.objects.filter(
                is_active=True,
                subject_type="user",
                subject_id=user_id,
            ).values_list("file_record_id", flat=True)
        }
        return shared

    return set()


def build_cloud_item_visibility_q(user, *, item_types: Optional[Iterable[str]] = None) -> Q:
    """构建「当前用户可见的云盘 ContextItem」过滤条件。

    - tabdoc/tabdata：resource_id ∈ (owner ∪ 显式 Permission)
    - tabfiles：created_by=user ∪ resource_id ∈ FilePermission
    - 其它类型：不在此 Q 内（由调用方另加）
    """
    if not user or not getattr(user, "id", None):
        return Q(pk__in=[])

    types = set(item_types or CLOUD_ITEM_TYPES)
    parts: list[Q] = []

    if "tabdoc" in types:
        ids = accessible_cloud_resource_ids(user, "tabdoc")
        if ids:
            parts.append(Q(item_type="tabdoc", resource_id__in=ids))
        else:
            parts.append(Q(pk__in=[]))

    if "tabdata" in types:
        ids = accessible_cloud_resource_ids(user, "tabdata")
        if ids:
            parts.append(Q(item_type="tabdata", resource_id__in=ids))
        else:
            parts.append(Q(pk__in=[]))

    if "tabfiles" in types:
        shared_ids = accessible_cloud_resource_ids(user, "tabfiles")
        file_q = Q(item_type="tabfiles", created_by_id=user.id)
        if shared_ids:
            file_q |= Q(item_type="tabfiles", resource_id__in=shared_ids)
        parts.append(file_q)

    if not parts:
        return Q(pk__in=[])

    combined = parts[0]
    for part in parts[1:]:
        combined |= part
    return combined


def build_owned_cloud_item_visibility_q(
    user,
    *,
    item_types: Optional[Iterable[str]] = None,
) -> Q:
    """构建「当前用户拥有的云盘 ContextItem」过滤条件。"""
    if not user or not getattr(user, "id", None):
        return Q(pk__in=[])

    types = set(item_types or CLOUD_ITEM_TYPES)
    parts: list[Q] = []

    for item_type in ("tabdoc", "tabdata"):
        if item_type not in types:
            continue
        ids = owned_cloud_resource_ids(user, item_type)
        parts.append(
            Q(item_type=item_type, resource_id__in=ids)
            if ids
            else Q(pk__in=[])
        )

    if "tabfiles" in types:
        parts.append(Q(item_type="tabfiles", created_by_id=user.id))

    if not parts:
        return Q(pk__in=[])

    combined = parts[0]
    for part in parts[1:]:
        combined |= part
    return combined


def enrich_item_capabilities(items: list[Any], item_data: list[dict], user) -> None:
    """批量回填 can_* 到列表响应（与 _enrich_owner_info 同位置调用）。"""
    if not item_data:
        return
    if not user or not getattr(user, "id", None):
        for data in item_data:
            data.update(empty_capabilities())
        return

    for item, data in zip(items, item_data):
        item_type = data.get("item_type") or getattr(item, "item_type", None)
        if item_type not in CLOUD_ITEM_TYPES:
            # 非云资产：保留宿主 Space 语义时由前端另判；此处默认不给写能力
            data.update(empty_capabilities())
            data["can_view"] = True
            continue
        role = resolve_item_role(user, item)
        is_owner = role == "owner"
        caps = capabilities_for_role(role, is_owner=is_owner)
        data.update(caps)
