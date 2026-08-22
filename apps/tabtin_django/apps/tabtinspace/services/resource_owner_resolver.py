"""批量解析 ContextItem 对应资源的真实所有者（Document/Table.owner_id）。

与 ContextItem.created_by（创建审计）分离：列表「所有者」列应读本模块写入的
owner_id / owner，不得用 created_by 冒充。
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Iterable, Optional
from uuid import UUID

logger = logging.getLogger(__name__)


def _owner_key(item_type: str, resource_id: str) -> str:
    return f"{item_type}:{resource_id}"


def batch_resolve_resource_owner_ids(
    pairs: Iterable[tuple[str, str]],
) -> dict[str, Optional[str]]:
    """按 (item_type, resource_id) 批量解析资源 owner user id。

    Returns:
        key = ``{item_type}:{resource_id}`` → owner_user_id | None
    """
    by_type: dict[str, list[str]] = defaultdict(list)
    seen: set[str] = set()
    for item_type, resource_id in pairs:
        item_type = (item_type or "").strip()
        resource_id = str(resource_id or "").strip()
        if not item_type or not resource_id:
            continue
        key = _owner_key(item_type, resource_id)
        if key in seen:
            continue
        seen.add(key)
        by_type[item_type].append(resource_id)

    result: dict[str, Optional[str]] = {key: None for key in seen}

    doc_ids = by_type.get("tabdoc") or []
    if doc_ids:
        _resolve_tabdoc_owners(doc_ids, result)

    table_ids = by_type.get("tabdata") or []
    if table_ids:
        _resolve_tabdata_owners(table_ids, result)

    file_ids = by_type.get("tabfiles") or []
    if file_ids:
        _resolve_tabfiles_owners(file_ids, result)

    return result


def _resolve_tabdoc_owners(doc_ids: list[str], result: dict[str, Optional[str]]) -> None:
    try:
        from apps.tabdoc.models import Document, DocumentPermission
    except Exception as exc:
        logger.warning("[resource_owner] import tabdoc failed: %s", exc)
        return

    uuid_ids: list[UUID] = []
    for rid in doc_ids:
        try:
            uuid_ids.append(UUID(str(rid)))
        except (TypeError, ValueError):
            continue

    if not uuid_ids:
        return

    try:
        rows = Document.objects.filter(id__in=uuid_ids).values_list("id", "owner_id")
        missing: list[UUID] = []
        for doc_id, owner_id in rows:
            key = _owner_key("tabdoc", str(doc_id))
            if owner_id:
                result[key] = str(owner_id)
            else:
                missing.append(doc_id if isinstance(doc_id, UUID) else UUID(str(doc_id)))
    except Exception as exc:
        logger.warning("[resource_owner] tabdoc Document query failed: %s", exc)
        return

    if not missing:
        return

    try:
        perm_rows = (
            DocumentPermission.objects.filter(
                document_id__in=missing,
                subject_type="user",
                permission="owner",
                is_active=True,
            )
            .values_list("document_id", "subject_id")
        )
        for document_id, subject_id in perm_rows:
            if not subject_id:
                continue
            key = _owner_key("tabdoc", str(document_id))
            if result.get(key) is None:
                result[key] = str(subject_id)
    except Exception as exc:
        logger.warning("[resource_owner] tabdoc Permission query failed: %s", exc)


def _resolve_tabdata_owners(table_ids: list[str], result: dict[str, Optional[str]]) -> None:
    try:
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table
    except Exception as exc:
        logger.warning("[resource_owner] import tabdata failed: %s", exc)
        return

    uuid_ids: list[UUID] = []
    for rid in table_ids:
        try:
            uuid_ids.append(UUID(str(rid)))
        except (TypeError, ValueError):
            continue

    if not uuid_ids:
        return

    try:
        rows = (
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(id__in=uuid_ids)
            .values_list("id", "owner_id")
        )
        for table_id, owner_id in rows:
            if not owner_id:
                continue
            result[_owner_key("tabdata", str(table_id))] = str(owner_id)
    except Exception as exc:
        logger.warning("[resource_owner] tabdata Table query failed: %s", exc)


def _resolve_tabfiles_owners(file_ids: list[str], result: dict[str, Optional[str]]) -> None:
    try:
        from apps.services.oss.models import FileRecord
    except Exception as exc:
        logger.warning("[resource_owner] import FileRecord failed: %s", exc)
        return

    try:
        rows = FileRecord.objects.filter(id__in=file_ids).values_list("id", "upload_user")
        for file_id, upload_user in rows:
            if not upload_user:
                continue
            result[_owner_key("tabfiles", str(file_id))] = str(upload_user)
    except Exception as exc:
        logger.warning("[resource_owner] tabfiles FileRecord query failed: %s", exc)


def enrich_context_item_owners(items, item_data: list[dict]) -> None:
    """就地写入 owner_id / owner；同时保留 created_by（创建者）展示回填。

    - owner：资源级 SSOT（Document/Table.owner_id 等），缺失则为 null，不回退 created_by
    - created_by：仍按 ContextItem.created_by_id 回填展示信息
    """
    if len(items) != len(item_data):
        logger.warning(
            "[resource_owner] items/item_data length mismatch: %s vs %s",
            len(items),
            len(item_data),
        )

    pairs: list[tuple[str, str]] = []
    for item, data in zip(items, item_data):
        item_type = getattr(item, "item_type", None) or data.get("item_type") or ""
        resource_id = getattr(item, "resource_id", None) or data.get("resource_id") or ""
        if item_type and resource_id:
            pairs.append((str(item_type), str(resource_id)))

    owner_map = batch_resolve_resource_owner_ids(pairs) if pairs else {}

    # created_by 展示 + owner 展示共用一次 build_user_info_map
    user_ids: list[str] = []
    seen: set[str] = set()

    def _collect(uid: Optional[str]) -> None:
        if not uid:
            return
        uid = str(uid)
        if uid not in seen:
            seen.add(uid)
            user_ids.append(uid)

    for data in item_data:
        _collect(data.get("created_by_id"))

    for owner_id in owner_map.values():
        _collect(owner_id)

    info_map: dict = {}
    if user_ids:
        try:
            from apps.services.billing.services.member_usage_service import build_user_info_map

            info_map = build_user_info_map(user_ids)
        except Exception as exc:
            logger.warning("[resource_owner] build_user_info_map failed: %s", exc)
            info_map = {}

    def _brief(uid: Optional[str]) -> Optional[dict]:
        if not uid:
            return None
        info = info_map.get(str(uid))
        if not info:
            return None
        return {
            "id": str(uid),
            "display_name": info.get("display_name", ""),
            "avatar": info.get("avatar", ""),
        }

    for item, data in zip(items, item_data):
        item_type = getattr(item, "item_type", None) or data.get("item_type") or ""
        resource_id = getattr(item, "resource_id", None) or data.get("resource_id") or ""
        owner_id = None
        if item_type and resource_id:
            owner_id = owner_map.get(_owner_key(str(item_type), str(resource_id)))

        data["owner_id"] = owner_id
        data["owner"] = _brief(owner_id)
        data["created_by"] = _brief(data.get("created_by_id"))

    # zip 截断时把多余 item_data 置空
    for data in item_data[len(items):]:
        data.setdefault("owner_id", None)
        data.setdefault("owner", None)
        if "created_by" not in data:
            data["created_by"] = _brief(data.get("created_by_id"))
