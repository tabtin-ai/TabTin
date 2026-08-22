"""
字段映射与引用重写工具

从 import_service.py 拆分而来。
负责字段类型归一化、字段配置提取、字段引用递归重写等逻辑。
"""
import copy
from typing import List, Dict, Any, Optional, Tuple


def resolve_target_field_id(
    raw_value: Any,
    source_to_target_field_id: Dict[str, str],
    target_field_id_by_name: Dict[str, str],
) -> Optional[str]:
    if raw_value is None:
        return None
    key = str(raw_value).strip()
    if not key:
        return None
    if key in source_to_target_field_id:
        return source_to_target_field_id[key]
    if key in target_field_id_by_name:
        return target_field_id_by_name[key]
    return None


def normalize_import_field_type(raw_field_type: Any) -> Tuple[str, Optional[str]]:
    """
    兼容外部表格导出字段类型别名，统一映射为 TabTin 内部 field_type。
    """
    raw = str(raw_field_type or '').strip()
    if not raw:
        return 'text', None

    alias_map = {
        # TabTin / snake_case
        'text': 'text',
        'long_text': 'long_text',
        'number': 'number',
        'rating': 'rating',
        'select': 'select',
        'multi_select': 'multi_select',
        'checkbox': 'checkbox',
        'date': 'date',
        'created_time': 'created_time',
        'last_modified_time': 'last_modified_time',
        'url': 'url',
        'email': 'email',
        'phone': 'phone',
        'user': 'user',
        'created_by': 'created_by',
        'last_modified_by': 'last_modified_by',
        'attachment': 'attachment',
        'link': 'link',

        'singleLineText': 'text',
        'singlelinetext': 'text',
        'longText': 'long_text',
        'longtext': 'long_text',
        'singleSelect': 'select',
        'singleselect': 'select',
        'multipleSelect': 'multi_select',
        'multipleselect': 'multi_select',
        'createdTime': 'created_time',
        'createdtime': 'created_time',
        'lastModifiedTime': 'last_modified_time',
        'lastmodifiedtime': 'last_modified_time',
        'createdBy': 'created_by',
        'createdby': 'created_by',
        'lastModifiedBy': 'last_modified_by',
        'lastmodifiedby': 'last_modified_by',
    }

    normalized = alias_map.get(raw)
    if normalized:
        return normalized, None

    normalized = alias_map.get(raw.lower())
    if normalized:
        return normalized, None

    return raw, None


def extract_import_field_config(raw_field: Dict[str, Any]) -> Dict[str, Any]:
    """
    统一提取字段配置，兼容 TabTin(config) 与外部导出(options/lookupOptions) 结构。
    """
    raw_options = raw_field.get('options')
    raw_config = raw_field.get('config')

    config: Dict[str, Any] = {}
    if isinstance(raw_options, dict):
        config = copy.deepcopy(raw_options)
    if isinstance(raw_config, dict):
        if config:
            for key, value in raw_config.items():
                config[key] = copy.deepcopy(value)
        else:
            config = copy.deepcopy(raw_config)

    return config


def read_lookup_ref(config: Dict[str, Any], key: str) -> str:
    raw_value = config.get(key)
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip()
    return ''


def collect_import_field_config_warnings(
    field_name: str,
    field_type: str,
    config: Dict[str, Any],
) -> List[str]:
    warnings: List[str] = []

    if field_type == 'link':
        foreign_table_id = read_lookup_ref(config, 'foreignTableId')
        if not foreign_table_id:
            warnings.append(f"字段 '{field_name}' 的关联配置缺少 foreignTableId")

    return warnings


def remap_field_reference_tree(
    payload: Any,
    source_to_target_field_id: Dict[str, str],
    target_field_id_by_name: Dict[str, str],
    source_to_target_table_id: Optional[Dict[str, str]] = None,
    source_to_target_view_id: Optional[Dict[str, str]] = None,
) -> Any:
    """
    递归重写视图配置中的字段引用，尽量将源快照字段 ID/名称映射到目标表字段 ID。
    """
    ref_keys = {
        'field_id',
        'fieldId',
        'field',
        'fieldIdOrName',
        'date_field',
        'group_by_field',
        'lookupFieldId',
        'linkFieldId',
        'symmetricFieldId',
    }
    table_ref_keys = {
        'table_id',
        'tableId',
        'table',
        'foreignTableId',
        'sourceTableId',
        'targetTableId',
        'relatedTableId',
    }
    field_ref_list_keys = {
        'field_ids',
        'fieldIds',
        'input_fields',
        'inputFieldIds',
        'group_by_fields',
        'groupByFields',
        'visibleFieldIds',
    }
    table_ref_list_keys = {
        'table_ids',
        'tableIds',
        'relatedTableIds',
    }
    view_ref_keys = {
        'view_id',
        'viewId',
        'filterByViewId',
        'defaultViewId',
        'sourceViewId',
        'targetViewId',
        'relatedViewId',
    }
    view_ref_list_keys = {
        'view_ids',
        'viewIds',
        'relatedViewIds',
    }
    table_mapping = source_to_target_table_id or {}
    view_mapping = source_to_target_view_id or {}

    def _is_field_ref_key(raw_key: Any) -> bool:
        if raw_key in ref_keys:
            return True
        if not isinstance(raw_key, str):
            return False
        lowered = raw_key.lower()
        return lowered.endswith('fieldid') or lowered.endswith('_field_id')

    def _is_table_ref_key(raw_key: Any) -> bool:
        if raw_key in table_ref_keys:
            return True
        if not isinstance(raw_key, str):
            return False
        lowered = raw_key.lower()
        return lowered.endswith('tableid') or lowered.endswith('_table_id')

    def _is_field_ref_list_key(raw_key: Any) -> bool:
        if raw_key in field_ref_list_keys:
            return True
        if not isinstance(raw_key, str):
            return False
        lowered = raw_key.lower()
        return lowered.endswith('fieldids') or lowered.endswith('_field_ids')

    def _is_table_ref_list_key(raw_key: Any) -> bool:
        if raw_key in table_ref_list_keys:
            return True
        if not isinstance(raw_key, str):
            return False
        lowered = raw_key.lower()
        return lowered.endswith('tableids') or lowered.endswith('_table_ids')

    def _is_view_ref_key(raw_key: Any) -> bool:
        if raw_key in view_ref_keys:
            return True
        if not isinstance(raw_key, str):
            return False
        lowered = raw_key.lower()
        return lowered.endswith('viewid') or lowered.endswith('_view_id')

    def _is_view_ref_list_key(raw_key: Any) -> bool:
        if raw_key in view_ref_list_keys:
            return True
        if not isinstance(raw_key, str):
            return False
        lowered = raw_key.lower()
        return lowered.endswith('viewids') or lowered.endswith('_view_ids')

    if isinstance(payload, list):
        return [
            remap_field_reference_tree(
                item,
                source_to_target_field_id,
                target_field_id_by_name,
                source_to_target_table_id=table_mapping,
                source_to_target_view_id=view_mapping,
            )
            for item in payload
        ]

    if isinstance(payload, dict):
        remapped: Dict[str, Any] = {}
        for key, value in payload.items():
            if _is_field_ref_key(key):
                target_field_id = resolve_target_field_id(
                    value,
                    source_to_target_field_id,
                    target_field_id_by_name,
                )
                remapped[key] = target_field_id or value
                continue

            if _is_table_ref_key(key):
                raw_table_ref = str(value).strip() if value is not None else ''
                remapped[key] = table_mapping.get(raw_table_ref, value)
                continue

            if _is_view_ref_key(key):
                raw_view_ref = str(value).strip() if value is not None else ''
                remapped[key] = view_mapping.get(raw_view_ref, value)
                continue

            if _is_field_ref_list_key(key) and isinstance(value, list):
                remapped_refs: List[Any] = []
                for raw_ref in value:
                    mapped = resolve_target_field_id(
                        raw_ref,
                        source_to_target_field_id,
                        target_field_id_by_name,
                    )
                    remapped_refs.append(mapped or raw_ref)
                remapped[key] = remapped_refs
                continue

            if _is_table_ref_list_key(key) and isinstance(value, list):
                remapped_tables: List[Any] = []
                for raw_ref in value:
                    raw_table_ref = str(raw_ref).strip() if raw_ref is not None else ''
                    remapped_tables.append(table_mapping.get(raw_table_ref, raw_ref))
                remapped[key] = remapped_tables
                continue

            if _is_view_ref_list_key(key) and isinstance(value, list):
                remapped_views: List[Any] = []
                for raw_ref in value:
                    raw_view_ref = str(raw_ref).strip() if raw_ref is not None else ''
                    remapped_views.append(view_mapping.get(raw_view_ref, raw_ref))
                remapped[key] = remapped_views
                continue

            # 兼容 config.column_widths / 其他列映射结构
            if key in {'column_widths', 'columnWidths'} and isinstance(value, dict):
                remapped_widths: Dict[str, Any] = {}
                for raw_field_ref, width in value.items():
                    target_field_id = resolve_target_field_id(
                        raw_field_ref,
                        source_to_target_field_id,
                        target_field_id_by_name,
                    )
                    remapped_key = target_field_id or str(raw_field_ref)
                    remapped_widths[remapped_key] = width
                remapped[key] = remapped_widths
                continue

            remapped[key] = remap_field_reference_tree(
                value,
                source_to_target_field_id,
                target_field_id_by_name,
                source_to_target_table_id=table_mapping,
                source_to_target_view_id=view_mapping,
            )
        return remapped

    return payload
