"""
数据导入服务

提供CSV、Excel和JSON文件的导入功能，支持数据预览和增量导入
"""
from apps.tabtinspace.services.organization_control_guard import (
    assert_org_resource_write_for_space,
    assert_organization_resource_write_allowed_optional,
)
import csv
import io
import json
import logging
import copy

logger = logging.getLogger(__name__)
from typing import Callable, List, Dict, Any, Optional, Tuple, Iterable
from uuid import UUID, uuid4
from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Max, Q
from django.utils import timezone
from .import_parsers import (
    parse_csv as _parse_csv,
    parse_excel as _parse_excel,
    parse_json as _parse_json,
    parse_table_full_json as _parse_table_full_json,
)
from .import_field_mapping import (
    resolve_target_field_id as _resolve_target_field_id,
    normalize_import_field_type as _normalize_import_field_type,
    extract_import_field_config as _extract_import_field_config,
    read_lookup_ref as _read_lookup_ref,
    collect_import_field_config_warnings as _collect_import_field_config_warnings,
    remap_field_reference_tree as _remap_field_reference_tree,
)
from .import_type_inference import (
    infer_field_type as _infer_field_type,
    smart_field_mapping as _smart_field_mapping,
    normalize_field_name as _normalize_field_name,
)
from apps.i18n import _
from apps.tabdata.constants import (
    BULK_WRITE_CHUNK_SIZE,
    IMPORT_FIELD_CHUNK_SIZE,
    MAX_IMPORT_ROWS_PER_REQUEST,
    SYSTEM_MANAGED_FIELD_TYPES,
    TABDATA_DB_ALIAS,
)
from apps.tabdata.history_events import emit_record_history_event, get_editor_type
from apps.tabdata.models import Table, TableField, TableRecord, TableView
from apps.tabdata.request_context import get_current_window_id
from apps.tabdata.utils.field_types import validate_field_value, format_field_value, get_field_type_label, deserialize_import_value
from apps.tabdata.utils.field_validation_rules import validate_with_rules
from apps.users.membership.services.quota_service import QuotaService
from apps.users.membership.exceptions import QuotaExceededError

import re as _re

# 未开启 skip_errors 时，行级校验失败会在写库事务开始前 abort（_import_data 内多处
# pre-transaction return）；此时 DB 实际零写入，提示必须与真实写入结果一致。
_IMPORT_ABORT_HINT = "导入已中止，未写入任何数据；可在导入选项中勾选『跳过错误行继续导入』后重试"

_RE_PERCENT = _re.compile(r'^[\s]*([-+]?\d+(?:\.\d+)?)\s*%\s*$')
_RE_CURRENCY = _re.compile(
    r'^[\s]*[¥$€£₹₩₫₽₺฿\u20B9\u20A8]*[\s]*([-+]?\d{1,3}(?:[,，]\d{3})*(?:\.\d+)?)\s*$'
)
CSV_UTF8_BOM = '\ufeff'

_NUMERIC_PK_FIELD_TYPES = frozenset({'number', 'rating'})


def _is_blank_pk_value(value: Any) -> bool:
    """判断主键单元格是否为空。0 / False 是合法主键，不能当空。"""
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == '':
        return True
    return False


def _coerce_pk_native_value(
    field_type: str,
    value: Any,
    field_config: Optional[Dict] = None,
) -> Any:
    """把导入单元格或已存值规范成与入库一致的原生类型（number → float 等）。"""
    if _is_blank_pk_value(value):
        return None
    config = field_config or {}
    prepared = _preprocess_import_value(field_type, value, config)
    prepared = deserialize_import_value(field_type, prepared, config)
    if _is_blank_pk_value(prepared):
        return None
    formatted = format_field_value(field_type, prepared, config)
    if formatted is None or formatted == '':
        return None
    return formatted


def _normalize_pk_match_key(
    field_type: str,
    value: Any,
    field_config: Optional[Dict] = None,
) -> Optional[str]:
    """增量导入主键匹配键：两边统一格式，避免 int 10 vs float 10.0 → '10'/'10.0' 对不上。"""
    formatted = _coerce_pk_native_value(field_type, value, field_config)
    if formatted is None:
        return None
    if field_type in _NUMERIC_PK_FIELD_TYPES and isinstance(formatted, (int, float)) and not isinstance(formatted, bool):
        num = float(formatted)
        if num.is_integer():
            return str(int(num))
        return format(num, 'g')
    return str(formatted)


def _expand_pk_lookup_values(field_type: str, pk_values: List[Any]) -> List[Any]:
    """为 JSONField / native IN 查询展开类型候选（数字字段同时带 int/float/str）。"""
    expanded: List[Any] = []
    seen: set = set()

    def _add(candidate: Any) -> None:
        key = (type(candidate).__name__, candidate)
        if key in seen:
            return
        seen.add(key)
        expanded.append(candidate)

    for value in pk_values:
        _add(value)
        if field_type not in _NUMERIC_PK_FIELD_TYPES:
            if not isinstance(value, str) and value is not None:
                _add(str(value))
            continue
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            num = float(value)
            _add(num)
            if num.is_integer():
                as_int = int(num)
                _add(as_int)
                _add(str(as_int))
            _add(str(value))
            _add(str(num))
        elif isinstance(value, str) and value.strip():
            try:
                num = float(value.strip())
            except (ValueError, TypeError):
                continue
            _add(num)
            if num.is_integer():
                as_int = int(num)
                _add(as_int)
                _add(str(as_int))
            _add(str(num))
    return expanded


def _preprocess_import_value(field_type: str, value: Any, field_config: dict) -> Any:
    """在 deserialize_import_value 之前，对 percent/currency/attachment 做预处理。

    percent: "75%" → 0.75（strip % → float → /100）
    currency: "¥1,200" → 1200.0（strip 货币符号和千分位逗号）
    attachment: 非 JSON 字符串（URL 或文件名）包装为 [{name, url}]
    """
    if value is None or value == '':
        return value

    if field_type == 'percent' and isinstance(value, str):
        m = _RE_PERCENT.match(value)
        if m:
            return float(m.group(1)) / 100.0

    if field_type == 'currency' and isinstance(value, str):
        stripped = value.strip()
        for ch in '¥$€£₹₩₫₽₺฿\u20B9\u20A8':
            stripped = stripped.replace(ch, '')
        stripped = stripped.replace(',', '').replace('，', '').strip()
        if stripped:
            try:
                return float(stripped)
            except (ValueError, TypeError):
                pass

    if field_type == 'attachment' and isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return value
        try:
            import json as _json
            parsed = _json.loads(stripped)
            if isinstance(parsed, (list, dict)):
                return value
        except (ValueError, TypeError):
            pass
        if stripped.startswith(('http://', 'https://', 'ftp://')):
            return [{'name': stripped.rsplit('/', 1)[-1] or stripped, 'url': stripped}]
        return [{'name': stripped}]

    return value
from apps.tabdata.services.record_service import next_record_version
from .import_error_classifier import classify_import_error, build_error_summary, ClassifiedError
from .base import BaseService
from apps.tabdata.utils.record_data_access import read_data

User = get_user_model()
_logger = logging.getLogger('tabdata.import_service')


def _chunked(items: List[Any], size: int) -> Iterable[List[Any]]:
    if size <= 0:
        yield items
        return
    for index in range(0, len(items), size):
        yield items[index:index + size]


class ImportService(BaseService):
    """
    数据导入服务

    支持CSV、Excel、JSON文件导入到表格
    支持数据预览、智能字段匹配、增量导入
    """

    _last_classified_errors: Optional[List[ClassifiedError]] = None
    _last_skipped_count: int = 0

    def _set_last_import_metadata(self, metadata: Dict[str, Any]) -> None:
        """
        保存最近一次导入过程元信息，供 API 层返回详细执行信息。
        """
        self.last_import_metadata = metadata

    @staticmethod
    def _build_field_changes(
        old_data: Optional[Dict[str, Any]],
        new_data: Optional[Dict[str, Any]],
    ) -> Dict[str, Dict[str, Any]]:
        old_map = old_data or {}
        new_map = new_data or {}
        field_changes: Dict[str, Dict[str, Any]] = {}
        all_keys = set(old_map.keys()) | set(new_map.keys())
        for key in all_keys:
            old_value = old_map.get(key)
            new_value = new_map.get(key)
            if old_value != new_value:
                field_changes[str(key)] = {
                    "old": old_value,
                    "new": new_value,
                }
        return field_changes

    def _emit_import_history_event(
        self,
        *,
        record: TableRecord,
        action: str,
        field_changes: Dict[str, Any],
        operation_group_id: UUID,
        import_source: str = "default",
    ) -> None:
        """单条 RH 入口（保留兼容）。新代码请用 :meth:`_emit_import_histories_batched`。"""
        if not field_changes:
            return

        # B-2 / I-2 / Wave 1.1：在 field_changes 中标识 import 来源，便于后续
        # fallback 反查 / 监控 / 灰度评估（不污染 editor_type 语义）。
        if import_source != "default":
            field_changes = {**field_changes, "_import_source": import_source}

        emit_record_history_event(
            record=record,
            action=action,
            field_changes=field_changes,
            user=self.user,
            window_id=get_current_window_id(),
            operation_group_id=operation_group_id,
            # 导入可能是大批量写入，当前仅做审计历史，不进入 undo 栈。
            push_to_stack=False,
            editor_type=get_editor_type(),
            sender=self.__class__,
        )

    def _emit_import_histories_batched(
        self,
        *,
        records_to_create: List[TableRecord],
        records_to_update: List[TableRecord],
        old_data_by_record_id: Dict[str, Dict[str, Any]],
        operation_group_id: UUID,
        import_source: str = "default",
    ) -> None:
        """B-2 / I-2 / Wave 1.1：批量化 RH 写入（替代 N×emit）。

        将原本 N 次 ``RecordHistory.create`` + N 次 ``RecordHistoryItem.bulk_create``
        合并为 1 次 ``RecordHistory.bulk_create`` + 1 次 ``RecordHistoryItem.bulk_create``，
        在 ``batch_write_record_histories`` 内同时享受 B-6 atomic 双写保护。

        理论性能（W0-2 audit §4.1）：1 万行 import RH 部分从 ~50-100s（N×emit）
        降到 ~200-400ms（batch_create），是 100x 量级改进；fast_mode 路径下
        相比"完全跳过"约多 1s（10000 行级），落入 PRD §A1/A2 可接受范围。

        :param import_source: ``'default'`` 或 ``'fast_mode'``——写入到
            ``field_changes['_import_source']`` 供 fallback / 监控识别。
        """
        from apps.tabdata.history_event_listeners import batch_write_record_histories
        from apps.tabdata.history_events import RecordHistoryEvent

        user = self.user
        window_id = get_current_window_id()
        editor_type = get_editor_type()
        # B-2：从 ContextVar 取，与 ChangeLogSubscriber 同源；emit_record_history_event
        # 默认行为相同，但批量路径直接构造 RecordHistoryEvent 时需显式传值。
        from apps.services.common.platform_context import (
            get_current_run_id, get_current_session_id,
        )
        agent_run_id = get_current_run_id() or ""
        session_id = get_current_session_id() or ""

        items: List[RecordHistoryEvent] = []
        for record in records_to_create:
            field_changes: Dict[str, Any] = {"data": read_data(record)}
            if import_source != "default":
                field_changes["_import_source"] = import_source
            items.append(RecordHistoryEvent(
                record=record,
                action='create',
                field_changes=field_changes,
                user=user,
                window_id=window_id,
                operation_group_id=operation_group_id,
                push_to_stack=False,
                editor_type=editor_type,
                agent_run_id=agent_run_id,
                session_id=session_id,
            ))

        for record in records_to_update:
            old = old_data_by_record_id.get(str(record.id), {})
            fc = self._build_field_changes(old, read_data(record))
            if not fc:
                continue
            if import_source != "default":
                fc = {**fc, "_import_source": import_source}
            items.append(RecordHistoryEvent(
                record=record,
                action='update',
                field_changes=fc,
                user=user,
                window_id=window_id,
                operation_group_id=operation_group_id,
                push_to_stack=False,
                editor_type=editor_type,
                agent_run_id=agent_run_id,
                session_id=session_id,
            ))

        if items:
            batch_write_record_histories(items)

    @staticmethod
    def _build_default_import_metadata() -> Dict[str, Any]:
        return {
            "auto_create_missing_fields": False,
            "field_creation": {
                "attempted": 0,
                "created": 0,
                "failed": 0,
                "created_fields": [],
                "errors": [],
            },
            "write_batches": {
                "batch_size": BULK_WRITE_CHUNK_SIZE,
                "create_batches": 0,
                "update_batches": 0,
            },
        }

    @staticmethod
    def _options_for_inferred_select_field(
        field_type: str,
        column_values: List[Any],
    ) -> Optional[Dict[str, Any]]:
        """从列值生成 select/multi_select 的 options.choices（按首次出现顺序）。

        导入推断出选项字段时若仍传 options=None，单元格有值但字段设置/下拉为空
        （；#5367 未覆盖的 CSV/Excel 直写路径）。
        """
        if field_type not in ('select', 'multi_select'):
            return None
        from apps.tabdata.utils.choice_utils import merge_select_choice_values

        choices = merge_select_choice_values([], column_values)
        if not choices:
            return None
        return {'choices': choices}

    def _auto_create_missing_fields(
        self,
        table_id: UUID,
        headers: List[str],
        rows: List[List[Any]],
    ) -> Dict[str, Any]:
        """
        自动创建导入中缺失的字段（按分片创建，规避单次 50 列上限）。
        """
        existing_names = set(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).values_list('name', flat=True)
        )
        # 与预览 smart_field_mapping 同口径的归一化匹配，避免大小写/空格差异
        # 让能匹配上的表头被当成缺失字段、平白建出重复新列。
        existing_names_normalized = {_normalize_field_name(name) for name in existing_names}

        missing_headers: List[str] = []
        seen: set[str] = set()
        for raw_header in headers:
            header = str(raw_header).strip()
            normalized = _normalize_field_name(header)
            if not header or normalized in existing_names_normalized or normalized in seen:
                continue
            seen.add(normalized)
            missing_headers.append(header)

        summary = {
            "attempted": len(missing_headers),
            "created": 0,
            "failed": 0,
            "created_fields": [],
            "errors": [],
        }
        if not missing_headers:
            return summary

        mapping_result = self.smart_field_mapping(table_id, headers, rows)
        type_suggestions = mapping_result.get('type_suggestions', {})
        header_index = {
            str(raw_header).strip(): idx
            for idx, raw_header in enumerate(headers)
            if str(raw_header).strip()
        }
        fields_payload = []
        for header in missing_headers:
            field_type = type_suggestions.get(header, "text")
            col_idx = header_index.get(header)
            column_values = (
                [row[col_idx] if col_idx < len(row) else '' for row in rows]
                if col_idx is not None
                else []
            )
            fields_payload.append({
                "name": header,
                "field_type": field_type,
                "description": "导入自动创建字段",
                "options": self._options_for_inferred_select_field(field_type, column_values),
            })

        from apps.tabdata.services.table_service import TableService

        table_service = TableService(user=self.user)
        created_names: set[str] = set()

        for chunk in _chunked(fields_payload, IMPORT_FIELD_CHUNK_SIZE):
            # ：导入自动建列不入 undo，避免连续撤销软删字段把导入表变成空壳
            created_fields, errors, skipped = table_service.bulk_create_fields(
                table_id=table_id,
                fields_data=chunk,
                push_to_undo_stack=False,
            )
            chunk_created_names = {field.name for field in created_fields}
            # 同名同类型的幂等 skip 视为"字段已就绪"，不算失败
            chunk_ready_names = chunk_created_names | {item["name"] for item in skipped}
            created_names.update(chunk_created_names)
            summary["created"] += len(chunk_created_names)
            summary["created_fields"].extend(sorted(chunk_created_names))

            for message in errors:
                summary["errors"].append(message)

            for item in chunk:
                name = item["name"]
                if name not in chunk_ready_names and not any(name in err for err in errors):
                    summary["errors"].append(f"字段 '{name}' 创建失败，请重试")

        summary["failed"] = max(0, summary["attempted"] - summary["created"])
        return summary

    def _publish_schema_refresh_after_import(self, table_id: UUID) -> None:
        """#8151：导入 auto-create 后广播全量 fields schema，驱动前端 loadFields/loadViews。

        bulk_create_fields 已发 batch_create_fields；此处再发 schema_stack_sync +
        fields_scope=full，与 undo/redo 后的 collab 对齐，覆盖错过增量事件的客户端。
        """
        from apps.tabdata.services.table_event_service import table_event_service
        from apps.tabdata.subscribers._utils import run_after_commit

        active_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS)
            .filter(table_id=table_id, is_deleted=False)
            .order_by("order", "created_at")
        )
        field_payloads = [
            {
                "id": str(f.id),
                "id_hex": f.id.hex,
                "name": f.name,
                "field_type": f.field_type,
                "config": f.config or {},
                "order": f.order,
                "is_deleted": False,
            }
            for f in active_fields
        ]
        table_id_str = str(table_id)
        user_id = str(self.user.id) if self.user else None

        def _publish() -> None:
            table_event_service.publish_field_change(
                table_id_str,
                action="schema_stack_sync",
                field_ids=[str(f.id) for f in active_fields],
                fields=field_payloads,
                metadata={
                    "fields_scope": "full",
                    "source": "import_auto_create",
                    "user_id": user_id,
                },
            )

        run_after_commit(_publish)

    def parse_csv(self, file_content: str, max_rows: int = 0) -> Tuple[List[str], List[List[str]]]:
        """
        解析CSV文件内容

        Args:
            file_content: CSV文件内容（字符串）
            max_rows: 最大解析行数，0 表示不限制

        Returns:
            Tuple: (列名列表, 数据行列表)
        """
        return _parse_csv(file_content, max_rows=max_rows)

    def parse_excel(self, file_bytes: bytes, sheet_name: Optional[str] = None, max_rows: int = 0) -> Tuple[List[str], List[List[Any]]]:
        """
        解析Excel文件内容

        Args:
            file_bytes: Excel文件字节内容
            sheet_name: 工作表名称（None表示使用第一个工作表）
            max_rows: 最大解析行数，0 表示不限制

        Returns:
            Tuple: (列名列表, 数据行列表)
        """
        return _parse_excel(file_bytes, sheet_name, max_rows=max_rows)

    def parse_json(self, json_content: str) -> Tuple[List[str], List[List[Any]]]:
        """
        解析JSON文件内容

        Args:
            json_content: JSON文件内容（字符串）
            支持格式：
            1. [{"field1": "value1", "field2": "value2"}, ...]  # 对象数组
            2. {"headers": ["field1", "field2"], "data": [[...], [...]]}  # 结构化格式
            3. {"fields": [...], "records": [...], "metadata": {"format":"table_full"}}  # table_full 快照

        Returns:
            Tuple: (列名列表, 数据行列表)
        """
        return _parse_json(json_content)

    def _parse_table_full_json(self, data: Dict[str, Any]) -> Tuple[List[str], List[List[Any]]]:
        """
        解析 table_full JSON 快照为通用导入结构（headers + rows）。

        说明：
        - headers 使用 fields 中定义的字段名，保持字段顺序；
        - records 支持从 `fields` 或 `data` 读取记录值；
        - 记录键优先按字段 ID 匹配，兼容字段名键。
        """
        return _parse_table_full_json(data)

    @staticmethod
    def _resolve_target_field_id(raw_value, source_to_target_field_id, target_field_id_by_name):
        return _resolve_target_field_id(raw_value, source_to_target_field_id, target_field_id_by_name)

    @staticmethod
    def _normalize_import_field_type(raw_field_type):
        return _normalize_import_field_type(raw_field_type)

    @staticmethod
    def _extract_import_field_config(raw_field):
        return _extract_import_field_config(raw_field)

    @staticmethod
    def _read_lookup_ref(config, key):
        return _read_lookup_ref(config, key)

    def _collect_import_field_config_warnings(self, field_name, field_type, config):
        return _collect_import_field_config_warnings(field_name, field_type, config)

    def _remap_field_reference_tree(self, payload, source_to_target_field_id, target_field_id_by_name, source_to_target_table_id=None, source_to_target_view_id=None):
        return _remap_field_reference_tree(payload, source_to_target_field_id, target_field_id_by_name, source_to_target_table_id, source_to_target_view_id)

    def _import_table_full_views_with_mapping(
        self,
        table_id: UUID,
        payload: Dict[str, Any],
        source_to_target_field_id_override: Optional[Dict[str, str]] = None,
    ) -> Tuple[List[str], Dict[str, str]]:
        """
        导入 table_full 快照中的视图定义（字段引用自动映射到目标表）。

        Returns:
            Tuple[List[str], Dict[str, str]]:
                - warnings: 视图导入警告信息
                - source_view_to_target_view_id: 源视图 ID 到目标视图 ID 的映射
        """
        raw_views = payload.get('views')
        raw_fields = payload.get('fields')

        if not isinstance(raw_views, list) or not raw_views:
            return [], {}
        if not isinstance(raw_fields, list):
            return [], {}

        source_field_name_by_id: Dict[str, str] = {}
        for raw_field in raw_fields:
            if not isinstance(raw_field, dict):
                continue
            source_field_id = str(raw_field.get('id') or '').strip()
            source_field_name = str(raw_field.get('name') or '').strip()
            if source_field_id and source_field_name:
                source_field_name_by_id[source_field_id] = source_field_name

        target_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).order_by('order')
        )
        target_field_id_by_name = {field.name: str(field.id) for field in target_fields}
        source_to_target_field_id = {
            source_field_id: target_field_id_by_name[source_field_name]
            for source_field_id, source_field_name in source_field_name_by_id.items()
            if source_field_name in target_field_id_by_name
        }
        if source_to_target_field_id_override:
            source_to_target_field_id.update(source_to_target_field_id_override)

        existing_names = set(
            TableView.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id).values_list('name', flat=True)
        )
        valid_view_types = {choice[0] for choice in TableView.VIEW_TYPE_CHOICES}
        max_order = (
            TableView.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id).aggregate(Max('order'))['order__max'] or 0
        )
        next_order = max_order + 1

        def _build_unique_name(raw_name: str, fallback_index: int) -> str:
            base_name = raw_name.strip() or f'导入视图 {fallback_index}'
            candidate = base_name
            seq = 1
            while candidate in existing_names:
                seq += 1
                candidate = f'{base_name} ({seq})'
            existing_names.add(candidate)
            return candidate

        ordered_raw_views: List[Dict[str, Any]] = []
        for index, raw_view in enumerate(raw_views):
            if not isinstance(raw_view, dict):
                continue
            raw_order = raw_view.get('order')
            normalized_order = int(raw_order) if isinstance(raw_order, (int, float)) else 10 ** 9
            ordered_raw_views.append({
                '_index': index,
                '_order': normalized_order,
                '_view': raw_view,
            })
        ordered_raw_views.sort(key=lambda item: (item['_order'], item['_index']))

        warnings: List[str] = []
        source_view_to_target_view_id: Dict[str, str] = {}
        for display_index, item in enumerate(ordered_raw_views, start=1):
            raw_view = item['_view']
            try:
                view_name = _build_unique_name(str(raw_view.get('name') or ''), display_index)
                view_type = str(raw_view.get('view_type') or raw_view.get('type') or 'grid')
                if view_type not in valid_view_types:
                    view_type = 'grid'

                raw_visible_fields = raw_view.get('visible_fields') or []
                visible_fields: List[str] = []
                for raw_ref in raw_visible_fields:
                    mapped = self._resolve_target_field_id(
                        raw_ref,
                        source_to_target_field_id,
                        target_field_id_by_name,
                    )
                    if mapped and mapped not in visible_fields:
                        visible_fields.append(mapped)

                raw_field_order = raw_view.get('field_order') or []
                field_order: List[str] = []
                for raw_ref in raw_field_order:
                    mapped = self._resolve_target_field_id(
                        raw_ref,
                        source_to_target_field_id,
                        target_field_id_by_name,
                    )
                    if mapped and mapped not in field_order:
                        field_order.append(mapped)

                raw_column_meta = raw_view.get('column_meta') or raw_view.get('columnMeta') or {}
                column_meta: Dict[str, Dict[str, Any]] = {}
                if isinstance(raw_column_meta, dict):
                    for raw_ref, raw_meta in raw_column_meta.items():
                        if not isinstance(raw_meta, dict):
                            continue
                        mapped = self._resolve_target_field_id(
                            raw_ref,
                            source_to_target_field_id,
                            target_field_id_by_name,
                        )
                        if not mapped:
                            continue
                        column_meta[mapped] = dict(raw_meta)

                if not raw_field_order and column_meta:
                    def _meta_order(field_key: str) -> int:
                        raw_order = column_meta[field_key].get('order')
                        if isinstance(raw_order, (int, float)):
                            return int(raw_order)
                        return 10 ** 9

                    ordered_keys = list(
                        sorted(
                            column_meta.keys(),
                            key=_meta_order,
                        )
                    )
                    field_order = [key for key in ordered_keys if key not in field_order]
                    if not raw_visible_fields:
                        def _is_meta_visible(meta: dict) -> bool:
                            if 'visible' in meta:
                                return bool(meta['visible'])
                            return not bool(meta.get('hidden', False))

                        visible_fields = [
                            key
                            for key in ordered_keys
                            if _is_meta_visible(column_meta.get(key, {}))
                        ]

                filters = self._remap_field_reference_tree(
                    raw_view.get('filters') or raw_view.get('filter') or [],
                    source_to_target_field_id,
                    target_field_id_by_name,
                )
                sorts = self._remap_field_reference_tree(
                    raw_view.get('sorts') or raw_view.get('sort') or [],
                    source_to_target_field_id,
                    target_field_id_by_name,
                )
                groups = self._remap_field_reference_tree(
                    raw_view.get('groups') or raw_view.get('group') or [],
                    source_to_target_field_id,
                    target_field_id_by_name,
                )
                config = self._remap_field_reference_tree(
                    raw_view.get('config') or raw_view.get('options') or {},
                    source_to_target_field_id,
                    target_field_id_by_name,
                )
                if not visible_fields:
                    visible_fields = [str(field.id) for field in target_fields]
                if not field_order:
                    field_order = [str(field.id) for field in target_fields]

                created_view = TableView.objects.using(TABDATA_DB_ALIAS).create(
                    table_id=table_id,
                    name=view_name,
                    view_type=view_type,
                    description=str(raw_view.get('description') or ''),
                    config=config if isinstance(config, dict) else {},
                    filters=filters if isinstance(filters, list) else [],
                    sorts=sorts if isinstance(sorts, list) else [],
                    groups=groups if isinstance(groups, list) else [],
                    visible_fields=visible_fields,
                    field_order=field_order,
                    column_meta=column_meta,
                    is_shared=bool(raw_view.get('is_shared') or raw_view.get('enableShare') or False),
                    is_locked=bool(raw_view.get('is_locked') or raw_view.get('isLocked') or False),
                    created_by_id=self.user.id if self.user else None,
                    order=next_order,
                )
                next_order += 1

                source_view_id = str(raw_view.get('id') or '').strip()
                if source_view_id:
                    source_view_to_target_view_id[source_view_id] = str(created_view.id)
            except Exception as exc:
                warnings.append(f"视图导入失败（{raw_view.get('name') or f'#{display_index}'}）: {str(exc)}")

        return warnings, source_view_to_target_view_id

    def _import_table_full_views(
        self,
        table_id: UUID,
        payload: Dict[str, Any],
        source_to_target_field_id_override: Optional[Dict[str, str]] = None,
    ) -> List[str]:
        """
        导入 table_full 快照中的视图定义（字段引用自动映射到目标表）。
        """
        warnings, _ = self._import_table_full_views_with_mapping(
            table_id=table_id,
            payload=payload,
            source_to_target_field_id_override=source_to_target_field_id_override,
        )
        return warnings

    @staticmethod
    def _build_unique_name(base_name: str, existing_names: set[str], fallback_name: str) -> str:
        normalized = base_name.strip() or fallback_name
        candidate = normalized
        seq = 1
        while candidate in existing_names:
            seq += 1
            candidate = f'{normalized} ({seq})'
        existing_names.add(candidate)
        return candidate

    def _create_fields_from_table_full(
        self,
        table_id: UUID,
        raw_fields: Any,
        source_to_target_table_id: Optional[Dict[str, str]] = None,
        source_to_target_view_id: Optional[Dict[str, str]] = None,
    ) -> Tuple[List[TableField], List[Tuple[str, str, str]], Dict[str, str], List[str]]:
        """
        从 table_full 字段快照创建目标表字段。

        Returns:
            Tuple:
                - created_fields: 创建后的字段（按 order）
                - source_field_refs: [(source_field_id, source_field_name, target_field_name)]
                - source_to_target_field_id: 源字段 ID -> 目标字段 ID
                - warnings: 非致命告警
        """
        if not isinstance(raw_fields, list):
            raise ValueError(_("tabdata.import_table_full_invalid_fields_array"))

        valid_field_types = {choice[0] for choice in TableField.FIELD_TYPE_CHOICES}
        ordered_raw_fields: List[Dict[str, Any]] = []
        for index, raw_field in enumerate(raw_fields):
            if not isinstance(raw_field, dict):
                continue
            raw_order = raw_field.get('order')
            normalized_order = int(raw_order) if isinstance(raw_order, (int, float)) else 10 ** 9
            ordered_raw_fields.append({
                '_index': index,
                '_order': normalized_order,
                '_field': raw_field,
            })
        ordered_raw_fields.sort(key=lambda item: (item['_order'], item['_index']))

        if not ordered_raw_fields:
            raise ValueError(_("tabdata.import_table_full_empty_fields"))

        warnings: List[str] = []
        used_target_names: set[str] = set()
        source_field_refs: List[Tuple[str, str, str]] = []
        fields_to_create: List[TableField] = []
        primary_index: Optional[int] = None

        for display_index, item in enumerate(ordered_raw_fields, start=1):
            raw_field = item['_field']
            source_field_id = str(raw_field.get('id') or '').strip()
            source_field_name = str(raw_field.get('name') or '').strip() or f'字段 {display_index}'

            target_field_name = self._build_unique_name(
                base_name=source_field_name,
                existing_names=used_target_names,
                fallback_name=f'字段 {display_index}',
            )
            if target_field_name != source_field_name:
                warnings.append(
                    f"字段名 '{source_field_name}' 重复，已重命名为 '{target_field_name}'"
                )

            raw_field_type = raw_field.get('field_type')
            if raw_field_type is None:
                raw_field_type = raw_field.get('type')
            normalized_field_type, field_type_alias_warning = self._normalize_import_field_type(
                raw_field_type
            )
            if field_type_alias_warning:
                warnings.append(f"字段 '{target_field_name}': {field_type_alias_warning}")

            field_type = normalized_field_type if normalized_field_type in valid_field_types else 'text'
            if field_type != normalized_field_type:
                warnings.append(
                    f"字段 '{target_field_name}' 的类型 '{normalized_field_type}' 不受支持，已回退为 text"
                )

            raw_is_primary = raw_field.get('is_primary')
            if raw_is_primary is None:
                raw_is_primary = raw_field.get('isPrimary')
            is_primary = bool(raw_is_primary)
            if is_primary and primary_index is not None:
                warnings.append(
                    f"字段 '{target_field_name}' 标记为主字段被忽略（已存在主字段）"
                )
                is_primary = False
            if is_primary and primary_index is None:
                primary_index = len(fields_to_create)

            raw_is_hidden = raw_field.get('is_hidden')
            if raw_is_hidden is None:
                raw_is_hidden = raw_field.get('isHidden')

            raw_config = self._extract_import_field_config(raw_field)
            from apps.tabdata.utils.default_values import validate_default_value
            try:
                imported_default = validate_default_value(
                    field_type,
                    raw_field.get('default_value', raw_field.get('defaultValue')),
                    raw_config,
                )
            except ValueError as exc:
                warnings.append(f"字段 '{target_field_name}' 的默认值已忽略：{exc}")
                imported_default = None
            warnings.extend(
                self._collect_import_field_config_warnings(
                    field_name=target_field_name,
                    field_type=field_type,
                    config=raw_config,
                )
            )
            raw_rules = raw_field.get('validation_rules')
            normalized_rules = dict(raw_rules) if isinstance(raw_rules, dict) else {}
            raw_width = raw_field.get('width')
            normalized_width = (
                int(raw_width)
                if isinstance(raw_width, (int, float)) and int(raw_width) > 0
                else 150
            )

            fields_to_create.append(
                TableField(
                    table_id=table_id,
                    name=target_field_name,
                    field_type=field_type,
                    description=str(raw_field.get('description') or ''),
                    config=raw_config if isinstance(raw_config, dict) else {},
                    validation_rules=normalized_rules,
                    order=len(fields_to_create),
                    width=normalized_width,
                    is_primary=is_primary,
                    is_hidden=bool(raw_is_hidden or False),
                    default_value=imported_default,
                    is_deleted=False,
                )
            )
            source_field_refs.append((source_field_id, source_field_name, target_field_name))

        if primary_index is None and fields_to_create:
            fields_to_create[0].is_primary = True

        TableField.objects.using(TABDATA_DB_ALIAS).bulk_create(
            fields_to_create,
            batch_size=IMPORT_FIELD_CHUNK_SIZE,
        )

        created_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).order_by('order', 'created_at')
        )
        source_to_target_field_id: Dict[str, str] = {}
        target_field_id_by_name: Dict[str, str] = {}
        for index, created_field in enumerate(created_fields):
            if index >= len(source_field_refs):
                break
            source_field_id = source_field_refs[index][0]
            if source_field_id:
                source_to_target_field_id[source_field_id] = str(created_field.id)
            target_field_id_by_name[created_field.name] = str(created_field.id)

        # 兼容公式里按原字段名引用（例如 {标题}），补齐 source_name -> target_id 映射。
        for index, created_field in enumerate(created_fields):
            if index >= len(source_field_refs):
                break
            source_field_name = source_field_refs[index][1]
            if source_field_name and source_field_name not in target_field_id_by_name:
                target_field_id_by_name[source_field_name] = str(created_field.id)

        fields_to_update: List[TableField] = []
        for created_field in created_fields:
            raw_config = created_field.config if isinstance(created_field.config, dict) else {}
            remapped_config = self._remap_field_reference_tree(
                payload=raw_config,
                source_to_target_field_id=source_to_target_field_id,
                target_field_id_by_name=target_field_id_by_name,
                source_to_target_table_id=source_to_target_table_id,
                source_to_target_view_id=source_to_target_view_id,
            )
            if isinstance(remapped_config, dict) and remapped_config != raw_config:
                created_field.config = remapped_config
                fields_to_update.append(created_field)

        if fields_to_update:
            TableField.objects.using(TABDATA_DB_ALIAS).bulk_update(
                fields_to_update,
                ['config'],
                batch_size=IMPORT_FIELD_CHUNK_SIZE,
            )

        return created_fields, source_field_refs, source_to_target_field_id, warnings

    def _post_remap_imported_field_configs(
        self,
        table_ids: List[UUID],
        source_to_target_field_id: Dict[str, str],
        source_to_target_table_id: Dict[str, str],
        source_to_target_view_id: Optional[Dict[str, str]] = None,
    ) -> Dict[str, List[str]]:
        """
        项目导入结束后执行全局字段配置重映射，修复跨表前向引用。
        """
        warnings_by_table_id: Dict[str, List[str]] = {}
        if not table_ids:
            return warnings_by_table_id

        for table_id in table_ids:
            table_warnings: List[str] = []
            try:
                fields = list(
                    TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table_id,
                        is_deleted=False,
                    ).order_by('order')
                )

                fields_to_update: List[TableField] = []
                for field in fields:
                    raw_config = field.config if isinstance(field.config, dict) else {}
                    remapped_config = self._remap_field_reference_tree(
                        payload=raw_config,
                        source_to_target_field_id=source_to_target_field_id,
                        target_field_id_by_name={},
                        source_to_target_table_id=source_to_target_table_id,
                        source_to_target_view_id=source_to_target_view_id,
                    )
                    if isinstance(remapped_config, dict) and remapped_config != raw_config:
                        field.config = remapped_config
                        fields_to_update.append(field)

                if fields_to_update:
                    TableField.objects.using(TABDATA_DB_ALIAS).bulk_update(
                        fields_to_update,
                        ['config'],
                        batch_size=IMPORT_FIELD_CHUNK_SIZE,
                    )
            except Exception as exc:
                table_warnings.append(f"字段配置二次映射失败: {str(exc)}")

            if table_warnings:
                warnings_by_table_id[str(table_id)] = table_warnings

        return warnings_by_table_id

    @staticmethod
    def _build_rows_from_table_full_records(
        raw_records: Any,
        source_field_refs: List[Tuple[str, str, str]],
    ) -> List[List[Any]]:
        """
        将 table_full 记录转换为 _import_data 所需二维行数据（按 source_field_refs 顺序）。
        """
        if not isinstance(raw_records, list):
            raise ValueError(_("tabdata.import_table_full_invalid_records_array"))

        rows: List[List[Any]] = []
        for raw_record in raw_records:
            if not isinstance(raw_record, dict):
                continue
            source_values = raw_record.get('fields')
            if not isinstance(source_values, dict):
                source_values = raw_record.get('data')
            if not isinstance(source_values, dict):
                source_values = {}

            row: List[Any] = []
            for source_field_id, source_field_name, _target_name in source_field_refs:
                if source_field_id and source_field_id in source_values:
                    row.append(source_values[source_field_id])
                elif source_field_name in source_values:
                    row.append(source_values[source_field_name])
                else:
                    row.append('')
            rows.append(row)
        return rows

    def import_space_from_json(
        self,
        space_id: UUID,
        json_content: str,
        skip_errors: bool = False,
        update_existing: bool = False,
        primary_key_field: Optional[str] = None,
        auto_create_missing_fields: bool = True,
        rls_context=None,
    ) -> Dict[str, Any]:
        """
        从 base_full JSON 快照导入 Space 数据（创建新表）。

        Returns:
            Dict:
                {
                    "created_tables": int,
                    "created_count": int,
                    "updated_count": int,
                    "errors": [...],
                    "table_results": [...]
                }
        """
        summary: Dict[str, Any] = {
            "created_tables": 0,
            "created_count": 0,
            "updated_count": 0,
            "errors": [],
            "table_results": [],
        }
        all_classified_errors: List[ClassifiedError] = []
        total_skipped = 0

        def _finalize_summary() -> Dict[str, Any]:
            summary["error_summary"] = build_error_summary(all_classified_errors) if all_classified_errors else {}
            summary["skipped_count"] = total_skipped
            return summary

        if not self.check_space_permission(str(space_id), 'editor'):
            raise PermissionError("无权限导入到该 Space")
        if not self.user:
            raise PermissionError("用户未登录")

        assert_org_resource_write_for_space(space_id)

        try:
            raw_data = json.loads(json_content)
        except json.JSONDecodeError as exc:
            err_msg = f"JSON解析失败: {str(exc)}"
            summary["errors"].append(err_msg)
            all_classified_errors.append(classify_import_error(err_msg))
            return _finalize_summary()

        if not isinstance(raw_data, dict):
            err_msg = "JSON格式不支持，请使用 base_full 对象格式"
            summary["errors"].append(err_msg)
            all_classified_errors.append(classify_import_error(err_msg))
            return _finalize_summary()

        raw_tables = raw_data.get('tables')
        if not isinstance(raw_tables, list):
            err_msg = "base_full 格式非法：tables 必须是数组"
            summary["errors"].append(err_msg)
            all_classified_errors.append(classify_import_error(err_msg))
            return _finalize_summary()

        existing_table_names = set(
            Table.objects.using(TABDATA_DB_ALIAS).filter(space_id=space_id).values_list('name', flat=True)
        )
        from apps.tabdata.services.table_service import TableService
        table_service = TableService(user=self.user)

        from apps.tabtinspace.services.host_resolver import host_organization_id

        # QTA-26: base_full 导入前预检 max_tables 配额
        tables_to_create = sum(1 for t in raw_tables if isinstance(t, dict))
        if tables_to_create > 0:
            from apps.users.membership.services.quota_service import check_quota_safe
            _wt_id_for_quota = host_organization_id(space_id)
            if _wt_id_for_quota:
                check_quota_safe(
                    quota_type="max_tables",
                    increment=tables_to_create,
                    organization_id=str(_wt_id_for_quota),
                    actor=self.user,
                )

        global_source_to_target_field_id: Dict[str, str] = {}
        global_source_to_target_table_id: Dict[str, str] = {}
        global_source_to_target_view_id: Dict[str, str] = {}
        imported_table_ids: List[UUID] = []
        table_result_index_by_table_id: Dict[str, int] = {}

        for index, raw_table in enumerate(raw_tables, start=1):
            if not isinstance(raw_table, dict):
                message = f"第{index}张表格式非法：必须是对象"
                summary["errors"].append(message)
                all_classified_errors.append(classify_import_error(message))
                if not skip_errors:
                    return _finalize_summary()
                continue

            try:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    source_table_name = str(raw_table.get('name') or '').strip() or f'导入表 {index}'
                    source_table_id = str(raw_table.get('id') or '').strip()
                    target_table_name = self._build_unique_name(
                        base_name=source_table_name,
                        existing_names=existing_table_names,
                        fallback_name=f'导入表 {index}',
                    )

                    _ws_id = host_organization_id(space_id)
                    # ：导入落库也不挂 Space；原生分区用 organization_id
                    table = Table.objects.using(TABDATA_DB_ALIAS).create(
                        organization_id=_ws_id,
                        space_id=None,
                        name=target_table_name,
                        description=str(raw_table.get('description') or ''),
                        icon=str(raw_table.get('icon') or ''),
                        owner_id=self.user.id,
                        is_archived=False,
                    )
                    table_mapping_for_current = dict(global_source_to_target_table_id)
                    if source_table_id:
                        table_mapping_for_current[source_table_id] = str(table.id)
                    view_mapping_for_current = dict(global_source_to_target_view_id)

                    created_fields, source_field_refs, source_to_target_field_id_local, field_warnings = (
                        self._create_fields_from_table_full(
                            table_id=table.id,
                            raw_fields=raw_table.get('fields'),
                            source_to_target_table_id=table_mapping_for_current,
                            source_to_target_view_id=view_mapping_for_current,
                        )
                    )
                    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id
                    table_service._native_ensure_table(
                        resolve_schema_partition_id(table), table.id, created_fields,
                    )
                    headers = [field.name for field in created_fields]
                    rows = self._build_rows_from_table_full_records(
                        raw_records=raw_table.get('records'),
                        source_field_refs=source_field_refs,
                    )

                    if rows:
                        created_count, updated_count, import_errors = self._import_data(
                            table_id=table.id,
                            headers=headers,
                            rows=rows,
                            skip_errors=skip_errors,
                            update_existing=update_existing,
                            primary_key_field=primary_key_field,
                            auto_create_missing_fields=auto_create_missing_fields,
                            rls_context=rls_context,
                        )

                        if import_errors and not skip_errors:
                            raise ValueError(import_errors[0])
                    else:
                        created_count, updated_count, import_errors = 0, 0, []

                    view_warnings, _ = self._import_table_full_views_with_mapping(
                        table_id=table.id,
                        payload=raw_table,
                        source_to_target_field_id_override=source_to_target_field_id_local,
                    )

                    # default_view 字段仅保留为旧接口兼容锚点；导入后始终同步为 order 第一的视图。
                    default_view: Optional[TableView] = TableView.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table.id,
                    ).order_by('order', 'created_at').first()
                    if default_view is None:
                        visible_fields = [str(field.id) for field in created_fields]
                        default_view = TableView.objects.using(TABDATA_DB_ALIAS).create(
                            table_id=table.id,
                            name='表格视图',
                            view_type='grid',
                            description='',
                            config={},
                            filters=[],
                            sorts=[],
                            groups=[],
                            visible_fields=visible_fields,
                            field_order=visible_fields,
                            column_meta={},
                            is_shared=False,
                            is_locked=False,
                            created_by_id=self.user.id if self.user else None,
                            order=0,
                        )
                    if default_view and table.default_view_id != default_view.id:
                        table.default_view = default_view
                        table.save(update_fields=['default_view'])

                    current_field_count = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table.id,
                        is_deleted=False,
                    ).count()
                    current_row_count = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table.id,
                        is_deleted=False,
                    ).count()
                    table.field_count = current_field_count
                    table.row_count = current_row_count
                    table.save(update_fields=['field_count', 'row_count'])
                    try:
                        from apps.tabtinspace.services.resource_bridge import ResourceBridge
                        ResourceBridge.on_update(table, user=self.user)
                    except Exception as exc:
                        view_warnings.append(f"上下文同步失败: {str(exc)}")

                    table_classified = list(getattr(self, '_last_classified_errors', None) or [])
                    table_skipped = getattr(self, '_last_skipped_count', 0)

                    for w in field_warnings + view_warnings:
                        table_classified.append(classify_import_error(w))

                    all_classified_errors.extend(table_classified)
                    total_skipped += table_skipped

                    table_result_errors = list(import_errors) + field_warnings + view_warnings
                    summary["table_results"].append({
                        "table_id": str(table.id),
                        "source_table_id": source_table_id or None,
                        "source_table_name": source_table_name,
                        "table_name": table.name,
                        "created_count": created_count,
                        "updated_count": updated_count,
                        "errors": table_result_errors,
                        "error_summary": build_error_summary(table_classified) if table_classified else {},
                        "skipped_count": table_skipped,
                    })
                    summary["created_tables"] += 1
                    summary["created_count"] += created_count
                    summary["updated_count"] += updated_count
                    if import_errors:
                        summary["errors"].extend(import_errors)
                    if source_table_id:
                        global_source_to_target_table_id[source_table_id] = str(table.id)
                    global_source_to_target_field_id.update(source_to_target_field_id_local)
                    global_source_to_target_view_id.update(source_view_to_target_view_id)
                    imported_table_ids.append(table.id)
                    table_result_index_by_table_id[str(table.id)] = len(summary["table_results"]) - 1

            except Exception as exc:
                message = f"第{index}张表导入失败: {str(exc)}"
                summary["errors"].append(message)
                all_classified_errors.append(classify_import_error(message))
                if not skip_errors:
                    return _finalize_summary()

        post_warnings_by_table = self._post_remap_imported_field_configs(
            table_ids=imported_table_ids,
            source_to_target_field_id=global_source_to_target_field_id,
            source_to_target_table_id=global_source_to_target_table_id,
            source_to_target_view_id=global_source_to_target_view_id,
        )
        for table_id_str, warnings in post_warnings_by_table.items():
            classified_warnings = [classify_import_error(w) for w in warnings]
            all_classified_errors.extend(classified_warnings)
            idx = table_result_index_by_table_id.get(table_id_str)
            if idx is not None:
                summary["table_results"][idx]["errors"].extend(warnings)
                existing_table_classified = [classify_import_error(e) for e in summary["table_results"][idx]["errors"]]
                summary["table_results"][idx]["error_summary"] = build_error_summary(existing_table_classified) if existing_table_classified else {}
            summary["errors"].extend(warnings)

        return _finalize_summary()

    def infer_field_type(self, values: List[Any], *, header: str | None = None) -> str:
        return _infer_field_type(values, header=header)

    def smart_field_mapping(self, table_id: UUID, headers: List[str], rows: List[List[Any]]) -> Dict[str, Any]:
        return _smart_field_mapping(table_id, headers, rows)

    def preview_import(
        self,
        table_id: UUID,
        file_content: Any,
        file_type: str = 'csv',
        preview_rows: int = 10,
        sheet_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        导入前数据预览和验证

        Args:
            table_id: 目标表格ID
            file_content: 文件内容
            file_type: 文件类型 (csv/excel/json)
            preview_rows: 预览行数
            sheet_name: Excel 工作表名称，仅 file_type=excel 时生效

        Returns:
            Dict: {
                'preview_data': [{header: value, ...}, ...],
                'field_mapping': [{source, target, confidence, inferred_type}, ...],
                'validation_issues': [{row, field, issue}, ...],
                'stats': {total_rows, preview_rows, field_count}
            }

        Raises:
            PermissionError: 无编辑权限时抛出
            ValueError: 文件解析失败时抛出
        """
        # 检查权限
        if not self.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限导入数据")

        # 解析文件
        try:
            if file_type == 'csv':
                headers, rows = self.parse_csv(file_content)
            elif file_type == 'excel':
                headers, rows = self.parse_excel(file_content, sheet_name)
            elif file_type == 'json':
                headers, rows = self.parse_json(file_content)
            else:
                raise ValueError(_("tabdata.import_unsupported_file_type", file_type=file_type))
        except ValueError:
            raise
        except Exception as e:
            logger.warning(
                "import_file_parse_failed file_type=%s err=%s",
                file_type, repr(e),
            )
            raise ValueError(
                _(
                    "tabdata.import_file_parse_failed",
                    detail=_("tabdata.import_parse_reason_generic"),
                )
            ) from e

        # 智能字段匹配
        mapping_result = self.smart_field_mapping(table_id, headers, rows)

        # 数据验证
        validation_errors = []
        for idx, row in enumerate(rows[:preview_rows], start=2):
            for col_idx, (header, value) in enumerate(zip(headers, row)):
                if header in mapping_result['field_mapping']:
                    field = mapping_result['field_mapping'][header]
                    field_config = getattr(field, 'config', {}) or {}
                    deserialized = deserialize_import_value(field.field_type, value, field_config)
                    if not validate_field_value(field.field_type, deserialized, field_config):
                        validation_errors.append({
                            'row': idx,
                            'column': header,
                            'value': value,
                            'error': f'值类型与字段类型 {field.field_type} 不匹配'
                        })
                        continue
                    try:
                        formatted_preview = format_field_value(
                            field.field_type,
                            deserialized,
                            field_config
                        )
                    except Exception as e:
                        validation_errors.append({
                            'row': idx,
                            'column': header,
                            'value': value,
                            'error': f'值格式化失败: {str(e)}'
                        })
                        continue
                    is_valid, rule_error = validate_with_rules(field.validation_rules or {}, formatted_preview)
                    if not is_valid:
                        validation_errors.append({
                            'row': idx,
                            'column': header,
                            'value': value,
                            'error': rule_error or '未通过字段验证规则'
                        })

        field_mapping_dict = mapping_result['field_mapping']
        match_confidence = mapping_result['match_confidence']
        type_suggestions = mapping_result['type_suggestions']

        field_mapping_list = []
        for header in headers:
            if header in field_mapping_dict:
                field = field_mapping_dict[header]
                field_mapping_list.append({
                    'source': header,
                    'target': str(field.id),
                    'target_name': field.name,
                    'confidence': match_confidence.get(header, 1.0),
                    'inferred_type': field.field_type,
                })
            else:
                field_mapping_list.append({
                    'source': header,
                    'target': '',
                    'target_name': '',
                    'confidence': 0.0,
                    'inferred_type': type_suggestions.get(header, 'text'),
                })

        preview_data_objs = []
        for row in rows[:preview_rows]:
            row_obj = {}
            for i, header in enumerate(headers):
                row_obj[header] = row[i] if i < len(row) else None
            preview_data_objs.append(row_obj)

        return {
            'preview_data': preview_data_objs,
            'field_mapping': field_mapping_list,
            'validation_issues': [
                {'row': e['row'], 'field': e['column'], 'issue': e['error']}
                for e in validation_errors[:20]
            ],
            'stats': {
                'total_rows': len(rows),
                'preview_rows': min(preview_rows, len(rows)),
                'field_count': len(headers),
                'total_validation_issues': len(validation_errors),
            },
        }

    def validate_import_data(
        self,
        table_id: UUID,
        headers: List[str],
        rows: List[List[str]]
    ) -> Tuple[bool, Optional[str], Dict[str, Any]]:
        """
        验证导入数据

        Args:
            table_id: 目标表格ID
            headers: CSV列名
            rows: CSV数据行

        Returns:
            Tuple: (是否有效, 错误信息, 字段映射)
        """
        # 获取表格字段
        fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False
        ).exclude(is_hidden=True).order_by('order')

        if not fields.exists():
            return False, "表格没有字段", {}

        # 构建字段映射（CSV列名 -> 字段信息）
        field_map = {}
        field_names = {field.name: field for field in fields}
        # 归一化匹配表：与预览 smart_field_mapping 同口径（trim + 大小写不敏感 + 去分隔符），
        # 避免精确匹配漏掉大小写/空格差异的表头，导致导入落不进已有列。
        normalized_lookup: Dict[str, Any] = {}
        for field in fields:
            normalized_lookup.setdefault(_normalize_field_name(field.name), field)

        # 验证CSV列名是否与表格字段匹配
        for header in headers:
            if header in field_names:
                field_map[header] = field_names[header]
            else:
                matched = normalized_lookup.get(_normalize_field_name(header))
                if matched is not None:
                    field_map[header] = matched
                # 否则允许额外的列，但会被忽略

        # 验证数据行数
        if not rows:
            return False, "文件没有数据", {}

        return True, None, field_map

    def import_from_csv(
        self,
        table_id: UUID,
        file_content: str,
        skip_errors: bool = False,
        update_existing: bool = False,
        primary_key_field: Optional[str] = None,
        auto_create_missing_fields: bool = True,
        rls_context=None,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Tuple[int, int, List[str]]:
        """
        从CSV文件导入数据

        Args:
            table_id: 目标表格ID
            file_content: CSV文件内容
            skip_errors: 是否跳过错误行继续导入
            update_existing: 是否更新已存在的记录（增量导入）
            primary_key_field: 用于匹配已存在记录的主键字段名
            progress_callback: 写入进度回调 (processed_rows, total_rows) -> None

        Returns:
            Tuple: (成功导入数量, 更新数量, 错误信息列表)
        """
        self._set_last_import_metadata(self._build_default_import_metadata())

        if not self.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限导入数据")
        if not self.user:
            raise PermissionError("用户未登录")

        try:
            # 不在 parse 阶段按上限截断：否则 _import_data 看不到真实行数，
            # truncation_warning 永远不触发，客户端会显示「成功导入 1000」且 errors=0。
            headers, rows = self.parse_csv(file_content, max_rows=0)
        except Exception as e:
            return 0, 0, [f"CSV解析失败: {str(e)}"]

        return self._import_data(
            table_id, headers, rows, skip_errors,
            update_existing, primary_key_field,
            auto_create_missing_fields=auto_create_missing_fields,
            rls_context=rls_context,
            progress_callback=progress_callback,
        )

    def import_from_excel(
        self,
        table_id: UUID,
        file_bytes: bytes,
        skip_errors: bool = False,
        update_existing: bool = False,
        primary_key_field: Optional[str] = None,
        sheet_name: Optional[str] = None,
        auto_create_missing_fields: bool = True,
        rls_context=None,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Tuple[int, int, List[str]]:
        """
        从Excel文件导入数据

        Args:
            table_id: 目标表格ID
            file_bytes: Excel文件字节内容
            skip_errors: 是否跳过错误行继续导入
            update_existing: 是否更新已存在的记录
            primary_key_field: 用于匹配已存在记录的主键字段名
            sheet_name: 工作表名称
            progress_callback: 写入进度回调 (processed_rows, total_rows) -> None

        Returns:
            Tuple: (成功导入数量, 更新数量, 错误信息列表)
        """
        self._set_last_import_metadata(self._build_default_import_metadata())

        if not self.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限导入数据")
        if not self.user:
            raise PermissionError("用户未登录")

        try:
            # 与 CSV 同口径：完整解析后由 _import_data 做上限截断并返回警告。
            headers, rows = self.parse_excel(file_bytes, sheet_name, max_rows=0)
        except Exception as e:
            return 0, 0, [f"Excel解析失败: {str(e)}"]

        return self._import_data(
            table_id, headers, rows, skip_errors,
            update_existing, primary_key_field,
            auto_create_missing_fields=auto_create_missing_fields,
            rls_context=rls_context,
            progress_callback=progress_callback,
        )

    def import_from_json(
        self,
        table_id: UUID,
        json_content: str,
        skip_errors: bool = False,
        update_existing: bool = False,
        primary_key_field: Optional[str] = None,
        auto_create_missing_fields: bool = True,
        fast_mode: bool = False,
        rls_context=None,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Tuple[int, int, List[str]]:
        """
        从JSON文件导入数据

        Args:
            table_id: 目标表格ID
            json_content: JSON文件内容
            skip_errors: 是否跳过错误行继续导入
            update_existing: 是否更新已存在的记录
            primary_key_field: 用于匹配已存在记录的主键字段名
            progress_callback: 写入进度回调 (processed_rows, total_rows) -> None

        Returns:
            Tuple: (成功导入数量, 更新数量, 错误信息列表)
        """
        self._set_last_import_metadata(self._build_default_import_metadata())

        if not self.check_table_permission(str(table_id), 'editor'):
            raise PermissionError("无权限导入数据")
        if not self.user:
            raise PermissionError("用户未登录")

        # 解析JSON
        try:
            raw_data = json.loads(json_content)
            table_full_payload: Optional[Dict[str, Any]] = None
            if isinstance(raw_data, dict) and 'records' in raw_data and 'fields' in raw_data:
                table_full_payload = raw_data
            headers, rows = self.parse_json(json_content)
        except Exception as e:
            return 0, 0, [f"JSON解析失败: {str(e)}"]

        if table_full_payload is not None and not rows:
            created_count, updated_count, errors = 0, 0, []
        else:
            created_count, updated_count, errors = self._import_data(
                table_id, headers, rows, skip_errors,
                update_existing, primary_key_field,
                auto_create_missing_fields=auto_create_missing_fields,
                fast_mode=fast_mode,
                rls_context=rls_context,
                progress_callback=progress_callback,
            )
        if table_full_payload is not None:
            errors = list(errors)
            errors.extend(self._import_table_full_views(table_id=table_id, payload=table_full_payload))

        return created_count, updated_count, errors

    def _import_data(
        self,
        table_id: UUID,
        headers: List[str],
        rows: List[List[Any]],
        skip_errors: bool = False,
        update_existing: bool = False,
        primary_key_field: Optional[str] = None,
        auto_create_missing_fields: bool = True,
        fast_mode: bool = False,
        rls_context=None,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> Tuple[int, int, List[str]]:
        """
        内部方法：执行实际的数据导入

        Args:
            table_id: 目标表格ID
            headers: 列名
            rows: 数据行
            skip_errors: 是否跳过错误
            update_existing: 是否更新已存在的记录
            primary_key_field: 主键字段名
            progress_callback: 写入进度回调 (processed_rows, total_rows) -> None

        Returns:
            Tuple: (新建数量, 更新数量, 错误列表)
        """
        import_metadata = self._build_default_import_metadata()
        import_metadata["auto_create_missing_fields"] = bool(auto_create_missing_fields)
        self._set_last_import_metadata(import_metadata)

        org_id = Table.objects.using(TABDATA_DB_ALIAS).filter(
            id=table_id,
        ).values_list('organization_id', flat=True).first()
        assert_organization_resource_write_allowed_optional(org_id)

        classified_errors: List[ClassifiedError] = []
        skipped_count = 0
        truncation_warning: Optional[str] = None

        # 产品上限走套餐 max_records_per_table；此处仅在显式配置 >0 时作请求级安全阀。
        if MAX_IMPORT_ROWS_PER_REQUEST > 0 and len(rows) > MAX_IMPORT_ROWS_PER_REQUEST:
            total_rows = len(rows)
            rows = rows[:MAX_IMPORT_ROWS_PER_REQUEST]
            truncation_warning = (
                f"数据已截断，共 {total_rows} 行中的前 {MAX_IMPORT_ROWS_PER_REQUEST} 行被导入"
            )
            _logger.warning("Import truncated: %d -> %d rows for table %s", total_rows, MAX_IMPORT_ROWS_PER_REQUEST, table_id)

        if auto_create_missing_fields:
            field_creation = self._auto_create_missing_fields(table_id, headers, rows)
            import_metadata["field_creation"] = field_creation
            if field_creation["failed"] > 0 and not skip_errors:
                retry_hint = "部分字段创建失败，请修复字段问题后重试导入，或开启 skip_errors 跳过错误继续。"
                all_msgs = list(field_creation.get("errors", [])) + [retry_hint]
                for m in all_msgs:
                    classified_errors.append(classify_import_error(m))
                self._last_classified_errors = classified_errors
                self._last_skipped_count = len(rows)
                return 0, 0, all_msgs

        # 验证数据
        is_valid, error_msg, field_map = self.validate_import_data(
            table_id, headers, rows
        )

        if not is_valid:
            classified_errors.append(classify_import_error(error_msg))
            self._last_classified_errors = classified_errors
            self._last_skipped_count = len(rows)
            return 0, 0, [error_msg]

        # 如果启用增量导入，需要主键字段
        errors: List[str] = list(import_metadata.get("field_creation", {}).get("errors", []))
        for e_msg in errors:
            classified_errors.append(classify_import_error(e_msg))
        existing_records: Dict[str, TableRecord] = {}
        primary_key_field_meta: Optional[TableField] = None
        primary_key_headers: set[str] = set()

        if update_existing and not primary_key_field:
            raw_msg = "增量导入模式（update_existing=True）必须指定 primary_key_field 参数"
            classified_errors.append(classify_import_error(raw_msg))
            self._last_classified_errors = classified_errors
            self._last_skipped_count = len(rows)
            return 0, 0, [raw_msg]

        if update_existing and primary_key_field:
            # 支持传字段名或字段ID
            for field in field_map.values():
                if primary_key_field in {field.name, str(field.id)}:
                    primary_key_field_meta = field
                    break

            if primary_key_field_meta is None:
                pk_field_by_id = None
                try:
                    pk_uuid = UUID(str(primary_key_field))
                    pk_field_by_id = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table_id,
                        is_deleted=False,
                        id=pk_uuid,
                    ).first()
                except (TypeError, ValueError):
                    pk_field_by_id = None

                primary_key_field_meta = TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id,
                    is_deleted=False,
                    name=primary_key_field,
                ).first()

                if primary_key_field_meta is None:
                    primary_key_field_meta = pk_field_by_id

            if primary_key_field_meta is None:
                raw_msg = f"主键字段 '{primary_key_field}' 不存在或不可用于增量导入"
                classified_errors.append(classify_import_error(raw_msg))
                self._last_classified_errors = classified_errors
                self._last_skipped_count = len(rows)
                return 0, 0, [raw_msg]

            primary_key_headers = {
                header
                for header, field in field_map.items()
                if str(field.id) == str(primary_key_field_meta.id) or field.name == primary_key_field_meta.name
            }
            if not primary_key_headers and primary_key_field in headers:
                primary_key_headers.add(primary_key_field)

            if not primary_key_headers:
                raw_msg = f"主键字段 '{primary_key_field}' 不在导入数据中"
                classified_errors.append(classify_import_error(raw_msg))
                self._last_classified_errors = classified_errors
                self._last_skipped_count = len(rows)
                return 0, 0, [raw_msg]

            # 从导入数据中提取所有 primary key 值，然后分批查询（避免全表加载 OOM）
            pk_field_id_str = str(primary_key_field_meta.id)
            pk_field_name = primary_key_field_meta.name
            pk_field_type = primary_key_field_meta.field_type
            pk_field_config = getattr(primary_key_field_meta, 'config', {}) or {}
            import_pk_native_values: List[Any] = []
            seen_pk_match_keys: set[str] = set()
            for _row in rows:
                if len(_row) != len(headers):
                    continue
                for _h, _v in zip(headers, _row):
                    if _h not in primary_key_headers:
                        continue
                    if _is_blank_pk_value(_v):
                        break
                    match_key = _normalize_pk_match_key(pk_field_type, _v, pk_field_config)
                    if match_key is None or match_key in seen_pk_match_keys:
                        break
                    seen_pk_match_keys.add(match_key)
                    native_pk = _coerce_pk_native_value(pk_field_type, _v, pk_field_config)
                    if native_pk is not None:
                        import_pk_native_values.append(native_pk)
                    break

            _PK_BATCH_SIZE = 500
            for batch_start in range(0, len(import_pk_native_values), _PK_BATCH_SIZE):
                pk_batch = import_pk_native_values[batch_start:batch_start + _PK_BATCH_SIZE]
                batch_qs = self._find_records_by_field_values(
                    table_id=table_id,
                    pk_field=primary_key_field_meta,
                    pk_values=pk_batch,
                )
                for record in batch_qs.iterator(chunk_size=_PK_BATCH_SIZE):
                    _rd = read_data(record)
                    stored_pk = _rd.get(pk_field_id_str)
                    if _is_blank_pk_value(stored_pk):
                        stored_pk = _rd.get(pk_field_name)
                    match_key = _normalize_pk_match_key(pk_field_type, stored_pk, pk_field_config)
                    if match_key is not None:
                        existing_records[match_key] = record

        # 导入数据
        created_count = 0
        updated_count = 0
        records_to_create = []
        records_to_update = []
        old_data_by_record_id: Dict[str, Dict[str, Any]] = {}
        all_fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).order_by('order')
        )

        max_order = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            is_deleted=False
        ).aggregate(Max('order'))['order__max']
        current_order = (max_order or 0) + 1

        for row_idx, row in enumerate(rows, start=2):  # 从第2行开始（第1行是表头）
            # 跳过全空行：表格文件（Excel/CSV）常在数据区中间或末尾夹带空行，
            # 它们不承载任何数据，既不应写入也不应让整份导入中止或报错。
            if all(cell is None or str(cell).strip() == '' for cell in row):
                continue

            if len(row) != len(headers):
                error_msg = f"第{row_idx}行: 列数不匹配"
                classified_errors.append(classify_import_error(error_msg))
                if skip_errors:
                    errors.append(error_msg)
                    skipped_count += 1
                    continue
                else:
                    self._last_classified_errors = classified_errors
                    self._last_skipped_count = len(rows)
                    return 0, 0, errors + [error_msg, _IMPORT_ABORT_HINT]

            # 构建记录数据
            record_data = {}
            pk_value = None

            for header, value in zip(headers, row):
                if header not in field_map:
                    continue

                field = field_map[header]

                # 系统托管字段由系统生成，忽略导入值。
                if field.field_type in SYSTEM_MANAGED_FIELD_TYPES:
                    continue

                field_config = getattr(field, 'config', {}) or {}

                if (field.default_value or {}).get('mode') == 'last_modified_time':
                    # 系统维护字段忽略源文件输入，稍后统一解析器写服务端时间。
                    continue

                # 记录主键匹配键（与已有记录侧同一套归一化，兼容 int/float/0）
                if header in primary_key_headers:
                    pk_value = _normalize_pk_match_key(field.field_type, value, field_config)

                if value is None or value == '':
                    # 列存在即代表用户显式留空，不能在后续被字段默认值补回。
                    record_data[str(field.id)] = value
                    continue

                value = _preprocess_import_value(field.field_type, value, field_config)
                value = deserialize_import_value(field.field_type, value, field_config)
                if not validate_field_value(field.field_type, value, field_config):
                    label = get_field_type_label(field.field_type)
                    error_msg = f"第{row_idx}行, 字段'{header}': 格式不符：{label}类型不支持此值"
                    errors.append(error_msg)
                    classified_errors.append(classify_import_error(error_msg))
                    if not skip_errors:
                        self._last_classified_errors = classified_errors
                        self._last_skipped_count = len(rows)
                        return 0, 0, errors + [_IMPORT_ABORT_HINT]
                    continue

                # 格式化字段值（⭐ 使用字段 UUID 作为 key）
                try:
                    formatted_value = format_field_value(
                        field.field_type,
                        value,
                        field_config
                    )
                    rules = dict(field.validation_rules or {})
                    is_valid, rule_error = validate_with_rules(rules, formatted_value)
                    if not is_valid:
                        error_msg = f"第{row_idx}行, 字段'{header}': {rule_error or '未通过验证规则'}"
                        errors.append(error_msg)
                        classified_errors.append(classify_import_error(error_msg))
                        if not skip_errors:
                            self._last_classified_errors = classified_errors
                            self._last_skipped_count = len(rows)
                            return 0, 0, errors + [_IMPORT_ABORT_HINT]
                        continue
                    record_data[str(field.id)] = formatted_value
                except Exception as e:
                    error_msg = f"第{row_idx}行, 字段'{header}': 格式化失败 - {str(e)}"
                    errors.append(error_msg)
                    classified_errors.append(classify_import_error(error_msg))
                    if not skip_errors:
                        self._last_classified_errors = classified_errors
                        self._last_skipped_count = len(rows)
                        return 0, 0, errors + [_IMPORT_ABORT_HINT]
                    continue

            from apps.tabdata.utils.default_values import apply_record_defaults
            is_existing = bool(update_existing and pk_value and pk_value in existing_records)
            apply_record_defaults(
                record_data,
                all_fields,
                is_create=not is_existing,
                actor_id=str(self.user.id),
            )

            if not record_data:
                error_msg = f"第{row_idx}行: 没有可导入的有效字段"
                classified_errors.append(classify_import_error(error_msg))
                if skip_errors:
                    errors.append(error_msg)
                    skipped_count += 1
                    continue
                self._last_classified_errors = classified_errors
                self._last_skipped_count = len(rows)
                return 0, 0, errors + [error_msg, _IMPORT_ABORT_HINT]

            # 判断是新建还是更新
            if is_existing:
                # 更新已有记录
                existing_record = existing_records[pk_value]
                record_id_key = str(existing_record.id)
                if record_id_key not in old_data_by_record_id:
                    old_data_by_record_id[record_id_key] = copy.deepcopy(read_data(existing_record))
                _cur = copy.deepcopy(read_data(existing_record))
                _cur.update(record_data)
                existing_record.__dict__['data'] = _cur
                existing_record.updated_by_id = self.user.id
                # version 稍后批量分配
                existing_record.updated_at = timezone.now()
                records_to_update.append(existing_record)
                updated_count += 1
            else:
                # 创建新记录
                record = TableRecord(
                    table_id=table_id,
                    data=record_data,
                    created_by_id=self.user.id,
                    updated_by_id=self.user.id,
                    version=0,  # 稍后批量分配
                    order=current_order,
                )
                records_to_create.append(record)
                created_count += 1
                current_order += 1

        # QTA-01: 导入前检查单表记录数配额
        if records_to_create:
            try:
                table_obj = Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).first()
                current_usage = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False,
                ).count()
                QuotaService().check_quota(
                    quota_type="max_records_per_table",
                    increment=len(records_to_create),
                    current_usage=current_usage,
                    organization_id=str(table_obj.organization_id) if table_obj and table_obj.organization_id else None,
                    actor=self.user,
                )
            except QuotaExceededError:
                raise
            except Exception as e:
                logger.warning("导入配额预检异常，按 D1 放行: %s", e)

        if rls_context is not None and (records_to_create or records_to_update):
            _rls_table = Table.objects.using(TABDATA_DB_ALIAS).filter(
                id=table_id,
            ).only('rls_enabled', 'rls_force').first()
            if _rls_table and _rls_table.rls_enabled:
                _should_apply = rls_context.is_token_auth if not _rls_table.rls_force else True
                if _should_apply:
                    from apps.tabdata.services.rls_service import rls_service
                    if records_to_create:
                        _rls_pass_create = []
                        for rec in records_to_create:
                            if rls_service.check_rls_for_write(
                                table_id=table_id, operation='INSERT',
                                context=rls_context, record_data=read_data(rec),
                            ):
                                _rls_pass_create.append(rec)
                            else:
                                _msg = f"行级安全策略拒绝写入记录（order={rec.order}）"
                                errors.append(_msg)
                                classified_errors.append(classify_import_error(_msg))
                                skipped_count += 1
                        if len(_rls_pass_create) != len(records_to_create):
                            records_to_create = _rls_pass_create
                            created_count = len(records_to_create)
                    if records_to_update:
                        _rls_pass_update = []
                        for rec in records_to_update:
                            if rls_service.check_rls_for_write(
                                table_id=table_id, operation='UPDATE',
                                context=rls_context, record_data=read_data(rec),
                            ):
                                _rls_pass_update.append(rec)
                            else:
                                _msg = f"行级安全策略拒绝更新记录 {rec.id}"
                                errors.append(_msg)
                                classified_errors.append(classify_import_error(_msg))
                                skipped_count += 1
                        if len(_rls_pass_update) != len(records_to_update):
                            records_to_update = _rls_pass_update
                            updated_count = len(records_to_update)

        create_batches = 0
        update_batches = 0
        operation_group_id = uuid4()
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                Table.objects.using(TABDATA_DB_ALIAS).select_for_update().get(id=table_id)

                if records_to_create:
                    actual_max = TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table_id, is_deleted=False,
                    ).aggregate(Max('order'))['order__max']
                    actual_start = (actual_max or 0) + 1
                    expected_start = (max_order or 0) + 1
                    if actual_start != expected_start:
                        for i, rec in enumerate(records_to_create):
                            rec.order = actual_start + i

                total_need = len(records_to_create) + len(records_to_update)
                if total_need > 0:
                    version_end = next_record_version(table_id, count=total_need)
                    version_start = version_end - total_need + 1
                    cursor = version_start
                    for rec in records_to_create:
                        rec.version = cursor
                        cursor += 1
                    for rec in records_to_update:
                        rec.version = cursor
                        cursor += 1

                total_write_records = len(records_to_create) + len(records_to_update)
                processed_write = 0

                if records_to_create:
                    for chunk in _chunked(records_to_create, BULK_WRITE_CHUNK_SIZE):
                        TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_create(chunk, batch_size=BULK_WRITE_CHUNK_SIZE)
                        create_batches += 1
                        processed_write += len(chunk)
                        if progress_callback and total_write_records > 0:
                            progress_callback(processed_write, total_write_records)
                if records_to_update:
                    for chunk in _chunked(records_to_update, BULK_WRITE_CHUNK_SIZE):
                        TableRecord.objects.using(TABDATA_DB_ALIAS).bulk_update(
                            chunk,
                            ['data', 'updated_by_id', 'updated_at', 'version'],
                            batch_size=BULK_WRITE_CHUNK_SIZE,
                        )
                        update_batches += 1
                        processed_write += len(chunk)
                        if progress_callback and total_write_records > 0:
                            progress_callback(processed_write, total_write_records)
        except Table.DoesNotExist:
            raise
        except Exception as e:
            raw_msg = f"批量保存失败: {str(e)}"
            classified_errors.append(classify_import_error(raw_msg))
            self._last_classified_errors = classified_errors
            self._last_skipped_count = skipped_count
            return 0, 0, [raw_msg]

        self._sync_import_to_native(
            table_id, field_map, records_to_create, records_to_update,
        )

        self._sync_link_fields_after_import(
            table_id, field_map, records_to_create + records_to_update,
        )

        # B-2 / I-2 / Wave 1.1：把"按 record_id 回查持久化对象"逻辑抽出，
        # fast_mode 和 default 路径都需要——之前 fast_mode 完全跳过 → C5 链路断裂
        # （W0-2 audit §2.1）。
        created_records, updated_records = self._resolve_persisted_records(
            table_id=table_id,
            records_to_create=records_to_create,
            records_to_update=records_to_update,
        )

        # B-2：fast_mode 现在与 default 走相同的副作用 + RH + CL + VH 流程，
        # 只在 RH `field_changes._import_source` 上标记来源（fast_mode / default），
        # 既满足 PRD §C5 line 658 "import 大批量接入 RH" 的硬要求，又给灰度
        # 评估留下识别钩子。
        import_source = "fast_mode" if fast_mode else "default"

        # B-2 / I-2：default 与 fast_mode 都用批量化 RH，一次 bulk_create 替代
        # N×emit；W0-2 audit §4.2 给的理论性能 100x 提升；现有 batch_write_record_histories
        # 已享 B-6 atomic 双写保护。
        self._emit_import_histories_batched(
            records_to_create=created_records,
            records_to_update=updated_records,
            old_data_by_record_id=old_data_by_record_id,
            operation_group_id=operation_group_id,
            import_source=import_source,
        )

        import_metadata["write_batches"]["create_batches"] = create_batches
        import_metadata["write_batches"]["update_batches"] = update_batches
        import_metadata["import_source"] = import_source
        self._set_last_import_metadata(import_metadata)
        self._last_classified_errors = classified_errors
        self._last_skipped_count = skipped_count

        if created_count + updated_count > 0:
            all_ids = (
                [str(r.id) for r in records_to_create if r.id]
                + [str(r.id) for r in records_to_update if r.id]
            )

            # EP-4 fix: 移除 [:200] 硬截断，发送完整 record_ids 列表
            try:
                from apps.tabdata.services.table_event_service import table_event_service
                table_event_service.publish_table_update(
                    table_id=str(table_id),
                    record_ids=all_ids,
                    action="records_imported",
                    metadata={
                        "user_id": str(self.user.id) if self.user else None,
                        "created_count": created_count,
                        "updated_count": updated_count,
                        "total_count": len(all_ids),
                    },
                )
            except Exception as exc:
                _logger.warning("Import WS push failed: %s", exc)

            # EP-4 fix: 补充 webhook 投递（导入之前不触发 webhook）
            try:
                from apps.tabdata.tasks.webhook_tasks import deliver_webhook_event
                table_obj = Table.objects.using(TABDATA_DB_ALIAS).only(
                    'space_id', 'rls_enabled',
                ).get(id=table_id)
                wh_payload = {
                    'action': 'records_imported',
                    'created_count': created_count,
                    'updated_count': updated_count,
                }
                if getattr(table_obj, 'rls_enabled', False):
                    wh_payload['rls_affected'] = True
                    wh_payload['count'] = len(all_ids)
                else:
                    wh_payload['record_ids'] = all_ids
                deliver_webhook_event.delay(
                    space_id=str(table_obj.space_id),
                    event_type='record.batch_created',
                    table_id=str(table_id),
                    data=wh_payload,
                )
            except Exception as wh_exc:
                _logger.warning("Import webhook dispatch failed: %s", wh_exc)

            # EP-4 fix: 补充 scheduler 自动化触发（导入之前不触发自动化）
            try:
                from apps.tabdata.utils.scheduler_bridge import trigger_scheduler_automations
                for rec in records_to_create:
                    trigger_scheduler_automations(rec, event_type="record_created")
                for rec in records_to_update:
                    trigger_scheduler_automations(rec, event_type="record_updated")
            except Exception as auto_exc:
                _logger.warning("Import scheduler automation trigger failed: %s", auto_exc)

            try:
                from apps.tabdata.utils.ydoc_sync import sync_records_to_ydoc
                all_records = list(records_to_create) + list(records_to_update)
                # 新建记录必须走 upsert_record（带 order 建行），否则协作层只收到
                # cell 级变更、不会长出新行，在线用户要整页刷新才看得到导入结果。
                upsert_ids = [str(r.id) for r in records_to_create if r.id]
                # fields 传 None 让 sync 自查全表字段：只传 CSV 匹配到的 field_map
                # 会导致新行缺少未在文件里出现的列。
                sync_records_to_ydoc(
                    table_id, all_records, None, source="import_service",
                    upsert_record_ids=upsert_ids,
                )
            except Exception as exc:
                _logger.warning("Import Y.js sync failed (non-blocking): %s", exc)

        # ：auto-create 后除 batch_create_fields 外再发一次 fields_scope=full，
        # 覆盖「标签未激活 / 错过增量 schema.changed」时协作端 fieldsMeta 仍旧的窗口。
        # 与记录条数无关——仅建字段的导入也要推。
        created_field_count = int(
            (import_metadata.get("field_creation") or {}).get("created") or 0
        )
        if created_field_count > 0:
            try:
                self._publish_schema_refresh_after_import(table_id)
            except Exception as exc:
                _logger.warning(
                    "Import schema refresh publish failed (non-blocking): table=%s err=%s",
                    table_id, exc,
                )

        if truncation_warning:
            errors.append(truncation_warning)
            import_metadata["truncation_warning"] = truncation_warning

        if created_count + updated_count > 0:
            self._compensate_after_bulk_import(table_id)

            try:
                self._ensure_select_choices_after_import(
                    field_map,
                    list(records_to_create) + list(records_to_update),
                )
            except Exception as exc:
                _logger.warning(
                    "Import select choices backfill failed (non-blocking): table=%s err=%s",
                    table_id, exc,
                )

            try:
                self._write_import_version_history(
                    table_id=table_id,
                    created_count=created_count,
                    updated_count=updated_count,
                    import_source=import_source,
                )
            except Exception as exc:
                _logger.warning(
                    "Import VH/CL write failed (non-blocking): table=%s err=%s",
                    table_id, exc,
                )

        return created_count, updated_count, errors

    def _resolve_persisted_records(
        self,
        *,
        table_id: UUID,
        records_to_create: List[TableRecord],
        records_to_update: List[TableRecord],
    ) -> Tuple[List[TableRecord], List[TableRecord]]:
        """从 bulk_create / bulk_update 后回查最终持久化的 ORM 对象列表。

        B-2 / Wave 1.1：从 ``_import_data`` 抽出，供 fast_mode 与 default 两条
        路径共享，避免 fast_mode 跳过该步导致 C5 链路（RH / CL / 副作用）全部
        断裂（W0-2 audit §2.1）。
        """
        created_records: List[TableRecord] = []
        created_ids = [record.id for record in records_to_create if record.id]
        if created_ids:
            created_map = {
                str(record.id): record
                for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=created_ids, is_deleted=False,
                )
            }
            created_records = [
                created_map[str(record.id)]
                for record in records_to_create
                if record.id and str(record.id) in created_map
            ]
        elif records_to_create:
            # 兼容不回填 PK 的数据库后端：按导入分配的 order 回查。
            created_orders = [record.order for record in records_to_create if record.order is not None]
            if created_orders:
                created_by_order = {
                    float(record.order): record
                    for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table_id,
                        is_deleted=False,
                        order__in=created_orders,
                    )
                }
                created_records = [
                    created_by_order[float(record.order)]
                    for record in records_to_create
                    if record.order is not None and float(record.order) in created_by_order
                ]

        updated_records: List[TableRecord] = []
        updated_ids: List[UUID] = []
        seen_updated_ids: set[str] = set()
        for record in records_to_update:
            if not record.id:
                continue
            key = str(record.id)
            if key in seen_updated_ids:
                continue
            seen_updated_ids.add(key)
            updated_ids.append(record.id)
        if updated_ids:
            updated_map = {
                str(record.id): record
                for record in TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    id__in=updated_ids, is_deleted=False,
                )
            }
            updated_records = [
                updated_map[str(record_id)]
                for record_id in updated_ids
                if str(record_id) in updated_map
            ]

        return created_records, updated_records

    def _ensure_select_choices_after_import(
        self,
        field_map: Dict[str, TableField],
        records: List[TableRecord],
    ) -> None:
        """bulk 导入不经 RecordService，补齐 select/multi_select 的 choices。

        建字段时已尽量从列值写入 choices；此处再覆盖「映射到已有空选项字段」等路径。
        """
        select_field_ids = {
            str(field.id)
            for field in (field_map or {}).values()
            if getattr(field, 'field_type', None) in ('select', 'multi_select')
        }
        if not select_field_ids or not records:
            return

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=select_field_ids,
                is_deleted=False,
            )
        )
        if not fields:
            return

        from apps.tabdata.services.record_service import RecordService
        from apps.tabdata.utils.record_data_access import read_data

        records_data = []
        for record in records:
            data = read_data(record)
            if data:
                records_data.append(data)
        if not records_data:
            return

        RecordService(user=self.user)._ensure_select_choices_from_data(fields, records_data)

    def _compensate_after_bulk_import(self, table_id: UUID) -> None:
        """bulk_create/bulk_update 不触发 post_save，补偿 row_count 和 RAG 索引。"""
        try:
            Table.objects.using(TABDATA_DB_ALIAS).filter(id=table_id).update(
                row_count=TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False,
                ).count()
            )
        except Exception as exc:
            _logger.warning("Import row_count refresh failed: table=%s err=%s", table_id, exc)

        try:
            from django.conf import settings as _settings
            if not getattr(_settings, "RAG_ENABLED", True):
                return
            if not getattr(_settings, "RAG_AUTO_EMBED_RECORDS", True):
                return
            from apps.rag.tasks import index_table_records_task
            index_table_records_task.apply_async(
                args=[str(table_id)], kwargs={"force": False}, countdown=5,
            )
        except Exception as exc:
            _logger.warning("Import RAG index trigger failed: table=%s err=%s", table_id, exc)

    def _write_import_version_history(
        self,
        table_id: UUID,
        created_count: int,
        updated_count: int,
        *,
        import_source: str = "default",
    ) -> None:
        """导入完成后补写 VersionHistory + ChangeLog，使导入操作可通过 Checkpoint 回滚。

        B-2 / Wave 1.1：``import_source`` 写入 ``ChangeLog.changes._import_source``，
        给 contributor 反查与监控提供识别钩子（fast_mode 灰度评估）。
        """
        from apps.collab.registry import get_adapter
        from apps.collab.service import VersionHistoryService
        from apps.collab.models import ChangeLog
        from apps.services.common.platform_context import get_current_run_id, get_current_session_id

        adapter = get_adapter("table")
        if not adapter:
            return

        resource = adapter.get_resource(str(table_id))
        if not resource:
            return

        version_data = adapter.get_version_data(resource)
        if version_data is None:
            return

        agent_run_id = get_current_run_id() or ""
        session_id = get_current_session_id() or ""  # QC-05
        # B-2：editor_type 优先反映"是 Agent 触发还是 user 触发"，与
        # ChangeLogSubscriber._write_change_log 的口径对齐（agent_run_id 非空 → 'agent'）
        if agent_run_id:
            editor_type = "agent"
        elif self.user:
            editor_type = "user"
        else:
            editor_type = "system"
        editor_id = str(self.user.id) if self.user else ""
        editor_info = {
            "editor_type": editor_type,
            "editor_id": editor_id,
            "editor_name": "",
        }
        organization_id = getattr(resource, "organization_id", None)

        svc = VersionHistoryService(adapter)
        with transaction.atomic(using="postgresql"):
            vh = svc.create_history(
                resource.id,
                version_data,
                editor_info,
                force_snapshot=True,
                skip_throttle=True,
                organization_id=organization_id,
            )
            ChangeLog.objects.using("postgresql").create(
                resource_type="table",
                resource_id=resource.id,
                change_type="import_data",
                summary=f"导入数据：新增 {created_count} 行，更新 {updated_count} 行",
                changes={
                    "created_count": created_count,
                    "updated_count": updated_count,
                    "_import_source": import_source,
                },
                editor_type=editor_type,
                editor_id=editor_id,
                version_history=vh,
                agent_run_id=agent_run_id,
                session_id=session_id,
            )

    @staticmethod
    def _find_records_by_field_values(
        table_id: UUID,
        pk_field: 'TableField',
        pk_values: list,
    ):
        """
        按字段值查找已有记录。优先使用 native 列索引，不可用时回退到 JSONField 查询。

        Returns:
            QuerySet[TableRecord]
        """
        pk_field_id_str = str(pk_field.id)
        pk_field_name = pk_field.name
        lookup_values = _expand_pk_lookup_values(pk_field.field_type, list(pk_values))
        if not lookup_values:
            return TableRecord.objects.using(TABDATA_DB_ALIAS).none()

        try:
            from apps.tabdata.models import NativeTableStatus
            from apps.tabdata.native.record_io import NativeRecordIO
            from apps.tabdata.native.query_builder import NativeQueryBuilder
            from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

            status = NativeTableStatus.objects.using(TABDATA_DB_ALIAS).get(table_id=table_id)
            if status.backfill_completed and status.columns_synced:
                table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
                fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(
                    table_id=table_id, is_deleted=False
                ))
                partition_id = resolve_schema_partition_id(table)
                qb = NativeQueryBuilder(partition_id, table.id, fields)
                native_io = NativeRecordIO(partition_id, table.id)

                filter_set = {
                    'conjunction': 'or',
                    'filterSet': [
                        {'field_id': pk_field_id_str, 'operator': 'in', 'value': lookup_values},
                    ]
                }
                where = qb.build_where_clause(filter_set)
                rows, _ = native_io.read_records(
                    qb, where=where, limit=max(len(lookup_values), len(pk_values)), field_ids=[]
                )
                record_ids = [row['__id'] for row in rows]
                if record_ids:
                    return TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
                        id__in=record_ids, is_deleted=False
                    )
        except NativeTableStatus.DoesNotExist:
            pass
        except Exception:
            _logger.warning("Native column lookup failed for table %s, using JSONField fallback", table_id, exc_info=True)

        return TableRecord.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id, is_deleted=False,
        ).filter(
            Q(**{f'data__{pk_field_id_str}__in': lookup_values})
            | Q(**{f'data__{pk_field_name}__in': lookup_values})
        )

    @staticmethod
    def _sync_import_to_native(
        table_id: UUID,
        field_map: Dict[str, 'TableField'],
        records_to_create: List[TableRecord],
        records_to_update: List[TableRecord],
    ) -> None:
        """ORM bulk_create/bulk_update 后同步数据到原生 PostgreSQL 列。"""
        if not records_to_create and not records_to_update:
            return
        try:
            from apps.tabdata.native.record_io import NativeRecordIO
            from apps.tabdata.native.value_converter import python_to_pg
            from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

            table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
            all_fields = list(TableField.objects.using(TABDATA_DB_ALIAS).filter(table_id=table_id, is_deleted=False))
            field_by_id = {str(f.id): f for f in all_fields}

            native_io = NativeRecordIO(resolve_schema_partition_id(table), table.id)

            if records_to_create:
                native_rows = []
                for rec in records_to_create:
                    data = read_data(rec)
                    row: Dict[str, Any] = {
                        '__id': rec.id,
                        '__order': rec.order,
                        '__version': rec.version,
                    }
                    if rec.created_by_id:
                        row['__created_by'] = rec.created_by_id
                    if rec.updated_by_id:
                        row['__updated_by'] = rec.updated_by_id
                    for fid_str, val in data.items():
                        if fid_str.startswith('_meta:'):
                            continue
                        field = field_by_id.get(fid_str)
                        if field:
                            row[field.id.hex] = python_to_pg(val, field.field_type, field.config)
                    native_rows.append(row)

                for chunk in _chunked(native_rows, 500):
                    native_io.bulk_insert_records(chunk)

            if records_to_update:
                # : 增量 update 必须同步 ORM 已 bump 的 __version，
                # 否则后续 bulk-delete 用 ORM version 做乐观锁会撞「并发冲突」。
                native_update_rows: List[Dict[str, Any]] = []
                for rec in records_to_update:
                    data = read_data(rec)
                    row: Dict[str, Any] = {
                        '__id': rec.id,
                        '__version': rec.version,
                    }
                    if rec.updated_by_id:
                        row['__updated_by'] = rec.updated_by_id
                    if rec.updated_at is not None:
                        row['__updated_at'] = rec.updated_at
                    for fid_str, val in data.items():
                        if fid_str.startswith('_meta:'):
                            continue
                        field = field_by_id.get(fid_str)
                        if field:
                            row[field.id.hex] = python_to_pg(val, field.field_type, field.config)
                    native_update_rows.append(row)

                for chunk in _chunked(native_update_rows, 500):
                    native_io.bulk_update_records(chunk)

            _logger.info(
                "Import native sync: table=%s created=%d updated=%d",
                table_id, len(records_to_create), len(records_to_update),
            )
        except Exception as exc:
            _logger.warning(
                "Import native sync failed (data in JSONField is consistent): table=%s err=%s",
                table_id, exc,
            )

    @staticmethod
    def _sync_link_fields_after_import(
        table_id: UUID,
        field_map: Dict[str, 'TableField'],
        all_records: List[TableRecord],
    ) -> None:
        """导入写入完成后，对 link 字段调用 set_link_cell 建立 LinkRecord 双向同步。"""
        link_fields = [f for f in field_map.values() if f.field_type == 'link']
        if not link_fields or not all_records:
            return
        try:
            from apps.tabdata.services.link_field_service import LinkFieldService
            for record in all_records:
                data = read_data(record)
                for field in link_fields:
                    cell_value = data.get(str(field.id))
                    if not cell_value:
                        continue
                    if isinstance(cell_value, list):
                        linked_ids = [
                            item.get('id') if isinstance(item, dict) else str(item)
                            for item in cell_value
                        ]
                    elif isinstance(cell_value, dict) and cell_value.get('id'):
                        linked_ids = [cell_value['id']]
                    else:
                        continue
                    valid_linked_ids = []
                    for lid in linked_ids:
                        if not lid:
                            continue
                        try:
                            UUID(str(lid))
                            valid_linked_ids.append(lid)
                        except (ValueError, TypeError):
                            _logger.warning(
                                "Link sync skipped invalid UUID %r for record %s field %s",
                                lid, record.id, field.id,
                            )
                    if valid_linked_ids:
                        try:
                            LinkFieldService.set_link_cell(
                                field=field,
                                record=record,
                                new_linked_ids=valid_linked_ids,
                            )
                        except Exception as exc:
                            _logger.warning(
                                "Link sync failed for record %s field %s: %s",
                                record.id, field.id, exc,
                            )
        except Exception as exc:
            _logger.warning("Link field import sync failed (non-blocking): %s", exc)

    def _iter_import_template_fields(self, table_id: UUID) -> List[TableField]:
        """加载可用于导入模板的字段（排除隐藏字段）。"""
        if not self.check_table_permission(str(table_id), 'viewer'):
            raise PermissionError("无权限获取导入模板")

        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table_id,
                is_deleted=False,
            ).exclude(is_hidden=True).order_by('order')
        )
        if not fields:
            raise ValueError(_("tabdata.import_no_available_fields"))
        return fields

    # 模板最少 2 行示例：一眼能看出 key=表头、每个对象/每行=一条记录
    IMPORT_TEMPLATE_MIN_ROWS = 2

    @staticmethod
    def _example_value_for_field(
        field: TableField,
        *,
        for_json: bool = False,
        row_index: int = 0,
    ) -> Any:
        """按字段类型与示例行序号生成导入模板示例值。"""
        if field.field_type == 'text':
            return '示例文本1' if row_index == 0 else '示例文本2'
        if field.field_type == 'number':
            value = 123 if row_index == 0 else 456
            return value if for_json else str(value)
        if field.field_type == 'date':
            return '2025-01-01' if row_index == 0 else '2025-01-02'
        if field.field_type == 'checkbox':
            value = row_index == 0
            return value if for_json else ('true' if value else 'false')
        if field.field_type in ('select', 'single_select', 'multi_select'):
            field_config = getattr(field, 'config', {}) or {}
            choices = field_config.get('choices') if field_config else None
            fallback = '选项1' if row_index == 0 else '选项2'
            if choices:
                pick = choices[min(row_index, len(choices) - 1)]
                if isinstance(pick, dict):
                    return pick.get('value') or pick.get('name') or pick.get('label') or fallback
                return pick
            return fallback
        return '' if for_json else ''

    def _build_template_example_rows(
        self,
        fields: List[TableField],
        *,
        for_json: bool,
        row_count: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        count = row_count if row_count is not None else self.IMPORT_TEMPLATE_MIN_ROWS
        rows: List[Dict[str, Any]] = []
        for row_index in range(count):
            rows.append({
                field.name: self._example_value_for_field(
                    field, for_json=for_json, row_index=row_index,
                )
                for field in fields
            })
        return rows

    def get_import_template(self, table_id: UUID, format: str = 'csv') -> str:
        """
        生成导入模板（CSV 或 JSON）

        Args:
            table_id: 表格ID
            format: ``csv``（默认）或 ``json``

        Returns:
            str: 模板内容。JSON 为对象数组且至少 2 行示例，便于识别表头与分行。

        Raises:
            PermissionError: 无权限时抛出
            ValueError: 表格没有可用字段或 format 非法时抛出
        """
        normalized = (format or 'csv').strip().lower()
        if normalized not in ('csv', 'json'):
            raise ValueError(f"不支持的模板 format「{format}」，合法值为：csv、json")

        fields = self._iter_import_template_fields(table_id)

        if normalized == 'json':
            rows = self._build_template_example_rows(fields, for_json=True)
            return json.dumps(rows, ensure_ascii=False, indent=2)

        # CSV：Windows Excel 依赖 BOM 识别带中文表头的 UTF-8；至少 2 行示例
        csv_buffer = io.StringIO()
        csv_buffer.write(CSV_UTF8_BOM)
        writer = csv.writer(csv_buffer)
        writer.writerow([field.name for field in fields])
        for row in self._build_template_example_rows(fields, for_json=False):
            writer.writerow([row[field.name] for field in fields])
        return csv_buffer.getvalue()
