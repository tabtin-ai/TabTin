"""Retired Space-level scope helpers.

SF-1 removed SpaceShare / DelegationGrant as product objects. The validation
and parsing helpers remain for migrations/tests that still need to validate
historical JSON payload shape. Runtime permission lookup APIs were removed so
new code cannot accidentally treat Space-level object scope as active.
"""

import re
from typing import Optional
from uuid import UUID

_UUID_RE = re.compile(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    re.IGNORECASE,
)


def _is_valid_uuid(value: str) -> bool:
    return bool(_UUID_RE.match(value))


def validate_object_scope(scope: dict) -> list[str]:
    """校验 object_scope 格式，返回错误列表（空列表表示合法）。

    合法格式：
    - {} 或 {"scope_type": "all"} → 不限制
    - {"scope_type": "selective", "tables": [...], "docs": [...], "folders": [...]} → 限制
      tables/docs 中的值必须是合法 UUID 字符串；
      folders 中的值必须是非空字符串路径；
      selective 下至少有一个授权列表非空
    """
    if not scope:
        return []

    scope_type = scope.get("scope_type")
    if scope_type == "all":
        return []

    if scope_type != "selective":
        return [f"scope_type 必须是 'all' 或 'selective'，实际: {scope_type!r}"]

    errors: list[str] = []
    tables = scope.get("tables", [])
    docs = scope.get("docs", [])
    folders = scope.get("folders", [])

    if not isinstance(tables, list):
        errors.append("tables 必须是列表")
        tables = []
    if not isinstance(docs, list):
        errors.append("docs 必须是列表")
        docs = []
    if not isinstance(folders, list):
        errors.append("folders 必须是列表")
        folders = []

    if not tables and not docs and not folders:
        errors.append("selective 模式下 tables/docs/folders 至少需要一个非空列表")

    for i, tid in enumerate(tables):
        if not isinstance(tid, str) or not _is_valid_uuid(tid):
            errors.append(f"tables[{i}] 不是合法 UUID: {tid!r}")

    for i, did in enumerate(docs):
        if not isinstance(did, str) or not _is_valid_uuid(did):
            errors.append(f"docs[{i}] 不是合法 UUID: {did!r}")

    for i, folder in enumerate(folders):
        if not isinstance(folder, str) or not folder.strip():
            errors.append(f"folders[{i}] 不是合法路径字符串: {folder!r}")

    return errors


def parse_scope_ids(scope: dict, resource_type: str) -> Optional[list[UUID]]:
    """从 object_scope 中提取指定资源类型的 UUID 列表。

    返回 None 表示不限制（scope 为空或 scope_type=all）。
    返回空列表 [] 表示 selective 模式下该类型未授权（含缺失键、空列表或脏数据）。
    """
    if not scope:
        return None

    scope_type = scope.get("scope_type")
    if scope_type == "all":
        return None
    if scope_type != "selective":
        return []

    raw_ids = scope.get(resource_type, [])
    if raw_ids is None:
        return []

    if not isinstance(raw_ids, list):
        return []

    result: list[UUID] = []
    for v in raw_ids:
        if isinstance(v, str) and _is_valid_uuid(v):
            try:
                result.append(UUID(v))
            except (TypeError, ValueError):
                continue
    return result


def validate_object_scope_space_resources(space_id: UUID, scope: dict) -> list[str]:
    """校验 tables/docs 是否真实属于当前 Space。"""
    if not scope or scope.get("scope_type") != "selective":
        return []

    errors: list[str] = []

    table_ids = parse_scope_ids(scope, "tables") or []
    if table_ids:
        from apps.tabdata.constants import TABDATA_DB_ALIAS
        from apps.tabdata.models import Table

        existing_table_ids = set(
            Table.objects.using(TABDATA_DB_ALIAS)
            .filter(space_id=space_id, id__in=table_ids)
            .values_list("id", flat=True)
        )
        invalid_table_ids = [str(table_id) for table_id in table_ids if table_id not in existing_table_ids]
        if invalid_table_ids:
            errors.append(
                "tables 包含不属于当前 Space 或不存在的资源: "
                + ", ".join(invalid_table_ids)
            )

    doc_ids = parse_scope_ids(scope, "docs") or []
    if doc_ids:
        from apps.tabdoc.models import Document

        existing_doc_ids = set(
            Document.objects.filter(space_id=space_id, id__in=doc_ids).values_list("id", flat=True)
        )
        invalid_doc_ids = [str(doc_id) for doc_id in doc_ids if doc_id not in existing_doc_ids]
        if invalid_doc_ids:
            errors.append(
                "docs 包含不属于当前 Space 或不存在的资源: "
                + ", ".join(invalid_doc_ids)
            )

    return errors


__all__ = ["parse_scope_ids", "validate_object_scope", "validate_object_scope_space_resources"]
# End of retained historical scope helpers.
