"""
子记录树相关服务

从 view_data_service 提取的子记录树排序、祖先记录合并等逻辑。
"""
from typing import Any, Dict, List, Optional, Set
from uuid import UUID

from apps.tabdata.constants import TABDATA_DB_ALIAS


def apply_sub_record_tree_order(
    records_serialized: List[Dict[str, Any]],
    parent_field_id: str,
    table_id: UUID,
    *,
    has_filter: bool = False,
    space_id: Optional[UUID] = None,
    all_fields: Optional[list] = None,
    field_key_type: str = 'id',
    requested_fields: Optional[Set[str]] = None,
    context_ancestor_ids: Optional[Set[str]] = None,
    rls_context=None,
) -> Optional[Dict[str, Dict[str, Any]]]:
    """
    对已序列化的记录列表应用子记录树序排列。

    如果视图配置了 subRecordParentFieldId，则将平坦记录列表按 DFS 树序重排，
    并返回 tree_data 元数据字典。

    Expands the result set to include ancestor records so tree structure remains
    intact even when the current page starts from a child record.

    Returns:
        tree_data dict or None (如果父字段无效或没有树关系)
    """
    from apps.tabdata.services.sub_record_service import SubRecordService

    try:
        parent_field_uuid = UUID(parent_field_id)
    except (ValueError, TypeError):
        return None

    parent_field = SubRecordService.get_parent_field_by_id(
        table_id, parent_field_uuid
    )
    if parent_field is None:
        # 也尝试获取默认父字段
        parent_field = SubRecordService.get_parent_field(table_id)
        if parent_field is None or str(parent_field.id) != parent_field_id:
            return None

    # 提取记录 ID 列表
    record_ids = []
    record_map: Dict[str, Dict[str, Any]] = {}
    for rec in records_serialized:
        rec_id_str = rec.get('id') or rec.get('row_id')
        if rec_id_str:
            try:
                rec_id = UUID(str(rec_id_str))
                record_ids.append(rec_id)
                record_map[str(rec_id)] = rec
            except (ValueError, TypeError):
                continue

    if not record_ids:
        return None

    # ── 保留祖先记录 ──
    # 普通分页/增量也可能只命中子记录；补齐父链后前端才能保持稳定树形。
    if space_id and all_fields:
        matched_ids = set(record_ids)
        expanded_ids = SubRecordService.filter_with_ancestors(
            matched_ids, parent_field, table_id,
        )
        missing_ids = expanded_ids - matched_ids
        if missing_ids:
            merged_ancestor_ids = fetch_and_merge_ancestor_records(
                missing_ids, record_ids, record_map,
                table_id, space_id, all_fields, field_key_type,
                requested_fields=requested_fields,
                rls_context=rls_context,
            )
            if context_ancestor_ids is not None:
                context_ancestor_ids.update(str(record_id) for record_id in merged_ancestor_ids)

    # 构建树序
    tree_ordered = SubRecordService.build_tree_ordered_records(
        record_ids, parent_field, table_id
    )

    # 重排 records_serialized
    reordered = []
    for rid, depth in tree_ordered:
        rec = record_map.get(str(rid))
        if rec:
            reordered.append(rec)

    # 原地替换
    records_serialized.clear()
    records_serialized.extend(reordered)

    # 构建 tree_data 元数据
    tree_data = SubRecordService.build_tree_metadata(
        tree_ordered, parent_field, table_id
    )
    backfill_parent_link_values(
        records_serialized,
        parent_field,
        field_key_type=field_key_type,
        requested_fields=requested_fields,
    )

    return tree_data if tree_data else None


def _resolve_output_key(field, field_key_type: str) -> str:
    if field_key_type == 'id':
        return str(field.id)
    if field_key_type == 'dbFieldName':
        return str((field.config or {}).get('db_field_name') or field.name)
    return field.name


def _should_backfill_parent_field(
    parent_field,
    requested_fields: Optional[Set[str]],
    field_key_type: str,
) -> bool:
    if requested_fields is None:
        return True
    output_key = _resolve_output_key(parent_field, field_key_type)
    return (
        output_key in requested_fields
        or str(parent_field.id) in requested_fields
        or parent_field.name in requested_fields
    )


def backfill_parent_link_values(
    records_serialized: List[Dict[str, Any]],
    parent_field,
    *,
    field_key_type: str,
    requested_fields: Optional[Set[str]],
) -> None:
    """
    用 LinkRecord 批量回填父记录字段。

    native 列是 link cell 的展示缓存，历史脏数据或 best-effort 同步失败时可能为空；
    子记录关系的 SSoT 仍是 LinkRecord。
    """
    if not records_serialized or not _should_backfill_parent_field(
        parent_field, requested_fields, field_key_type,
    ):
        return

    from apps.tabdata.models import LinkRecord, TableField
    from apps.tabdata.services.link_field_service import LinkFieldService

    record_ids: List[UUID] = []
    record_by_id: Dict[str, Dict[str, Any]] = {}
    for rec in records_serialized:
        rec_id_str = rec.get('id') or rec.get('row_id')
        if not rec_id_str:
            continue
        try:
            rec_id = UUID(str(rec_id_str))
        except (ValueError, TypeError):
            continue
        record_ids.append(rec_id)
        record_by_id[str(rec_id)] = rec
    if not record_ids:
        return

    lookup_field = None
    lookup_field_id = (parent_field.config or {}).get('lookupFieldId')
    if not lookup_field_id:
        lookup_field_id = LinkFieldService._resolve_lookup_field_id(
            (parent_field.config or {}).get('foreignTableId') or str(parent_field.table_id)
        )
    if lookup_field_id:
        lookup_field = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            id=lookup_field_id,
            is_deleted=False,
        ).first()

    output_key = _resolve_output_key(parent_field, field_key_type)
    links = (
        LinkRecord.objects.using(TABDATA_DB_ALIAS)
        .filter(link_field=parent_field, self_record_id__in=record_ids)
        .select_related('foreign_record')
        .order_by('self_record_id', 'order', 'created_at')
    )
    seen_children: Set[str] = set()
    for link in links:
        child_id = str(link.self_record_id)
        if child_id in seen_children:
            continue
        foreign_record = link.foreign_record
        if foreign_record.is_deleted:
            continue
        rec = record_by_id.get(child_id)
        if rec is None:
            continue

        data = rec.setdefault('data', {})
        fields = rec.setdefault('fields', {})
        existing_value = fields.get(output_key)
        existing_title = (
            existing_value.get('title')
            if isinstance(existing_value, dict)
            else None
        )
        if existing_value not in (None, [], '') and existing_title:
            seen_children.add(child_id)
            continue

        cell_value = {
            'id': str(foreign_record.id),
            'title': LinkFieldService._extract_record_title(foreign_record, lookup_field),
        }
        data[parent_field.name] = cell_value
        fields[output_key] = cell_value
        seen_children.add(child_id)


def fetch_and_merge_ancestor_records(
    missing_ids: Set[UUID],
    record_ids: list,
    record_map: Dict[str, Dict[str, Any]],
    table_id: UUID,
    space_id: UUID,
    all_fields: list,
    field_key_type: str,
    requested_fields: Optional[Set[str]] = None,
    rls_context=None,
) -> Set[UUID]:
    """
    获取缺失的祖先记录并合并到 record_ids / record_map 中。
    用于筛选时保留子记录的完整祖先链。
    """
    missing_list = list(missing_ids)
    from apps.tabdata.models import TableRecord
    from apps.tabdata.utils.record_serializers import serialize_records

    records = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        id__in=missing_list,
        is_deleted=False,
    )
    if rls_context is not None:
        from .rls_service import apply_rls_to_orm_queryset

        records = apply_rls_to_orm_queryset(records, table_id, rls_context)
    ancestor_serialized = serialize_records(
        records,
        fields=requested_fields,
        field_key_type=field_key_type,
    )

    existing_ids = {rid for rid in record_ids}
    merged_ids: Set[UUID] = set()
    for rec in ancestor_serialized:
        rec_id_str = rec.get('id') or rec.get('row_id')
        if rec_id_str:
            rec_id = UUID(str(rec_id_str))
            if rec_id not in existing_ids:
                record_ids.append(rec_id)
                record_map[str(rec_id)] = rec
                existing_ids.add(rec_id)
                merged_ids.add(rec_id)
    return merged_ids
