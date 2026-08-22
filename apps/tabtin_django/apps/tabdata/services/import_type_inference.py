"""
字段类型推断

根据数据样本推断字段类型，以及智能字段匹配。
从 import_service.py 拆分而来。
"""
import re
from datetime import date, datetime
from typing import List, Dict, Any
from uuid import UUID

from django.utils.dateparse import parse_date, parse_datetime

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableField
from apps.tabdata.utils.field_types import deserialize_import_value, validate_field_value

_RE_EMAIL = re.compile(r'^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$')
_RE_URL = re.compile(r'^https?://', re.IGNORECASE)
_RE_PROTOCOL_RELATIVE_URL = re.compile(
    r'^//(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?\#].*)?$'
)
_RE_DOMAIN_URL = re.compile(
    r'^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?\#].*)?$'
)
_RE_PHONE = re.compile(r'^\+?[\d\s()\-]{7,}$')
# 列名暗示 URL 时降低样本命中阈值（ Agent 建表 / 导入偶发落成 text）
_RE_URL_HEADER = re.compile(
    r'(链接|网址|官网|主页)$|(^|[_\-\s])(url|href|link|website)([_\-\s]|$)',
    re.IGNORECASE,
)
DATE_INFERENCE_THRESHOLD = 0.7
URL_INFERENCE_THRESHOLD = 0.8
URL_NAME_HINT_THRESHOLD = 0.5


def normalize_field_name(name: Any) -> str:
    """字段名归一化：trim + 小写 + 去除下划线/连字符/空格。

    导入时的字段匹配（validate_import_data / _auto_create_missing_fields）与
    预览的 smart_field_mapping 必须共用同一口径，否则会出现「预览说匹配上、
    导入却当成缺失字段建新列」的不一致。
    """
    return str(name).strip().lower().replace('_', '').replace('-', '').replace(' ', '')


def _parse_date_like(value: Any) -> str | None:
    """
    Return 'date' or 'date_time' only when the value can actually be parsed.

    Import inference used to treat any long string containing '-' as date-like,
    which misclassified UUID/link/reference columns and blocked row writes.
    """
    if isinstance(value, datetime):
        return 'date_time'
    if isinstance(value, date):
        return 'date'

    text = str(value).strip()
    if not text:
        return None

    prefers_date_time = 'T' in text or ':' in text or bool(re.search(r'\d\s+\d', text))
    date_time_config = {'formatting': {'time': 'HH:mm:ss'}}
    if prefers_date_time:
        date_time_value = deserialize_import_value('date', text, date_time_config)
        if date_time_value is not text and validate_field_value('date', date_time_value, date_time_config):
            return 'date_time'

    date_value = deserialize_import_value('date', text, {})
    if date_value is not text and validate_field_value('date', date_value, {}):
        return 'date'

    date_time_value = deserialize_import_value('date', text, date_time_config)
    if date_time_value is not text and validate_field_value('date', date_time_value, date_time_config):
        return 'date_time'

    # Keep Django's ISO parsers as a narrow fallback for formats the write
    # layer already accepts in practice.
    if parse_date(text) is not None:
        return 'date'
    if parse_datetime(text) is not None:
        return 'date_time'
    return None


def _is_url_like(value: str) -> bool:
    """Inference-time URL check; aligns with UrlField minus bare relative `/path`."""
    text = value.strip()
    if not text:
        return False
    if _RE_URL.match(text):
        return True
    if _RE_PROTOCOL_RELATIVE_URL.match(text):
        return True
    return _RE_DOMAIN_URL.match(text) is not None


def infer_field_type(
    values: List[Any],
    *,
    max_samples: int = 30,
    header: str | None = None,
) -> str:
    """
    根据数据推断字段类型

    Args:
        values: 字段的所有值列表
        max_samples: 采样数量上限（等距采样）
        header: 可选列名；命中链接类命名时降低 URL 识别阈值

    Returns:
        str: 推断的字段类型
    """
    if not values:
        return 'text'

    non_empty = [v for v in values if v and str(v).strip()]
    if not non_empty:
        return 'text'

    try:
        float_values = [float(str(v)) for v in non_empty]
        is_all_int = all(float(v) == int(float(v)) for v in float_values)
        if is_all_int:
            int_values = [int(v) for v in float_values]
            unique_ints = set(int_values)
            if (all(0 <= iv <= 5 for iv in int_values)
                    and len(unique_ints) <= 6
                    and len(non_empty) >= 5):
                return 'rating'
        return 'number'
    except (ValueError, TypeError):
        pass

    if len(non_empty) <= max_samples:
        str_sample = [str(v).strip() for v in non_empty]
    else:
        step = (len(non_empty) - 1) / (max_samples - 1)
        str_sample = [str(non_empty[round(step * i)]).strip() for i in range(max_samples)]
    sample_size = len(str_sample)

    # email / url / phone: 默认 80%+；链接类列名降至 50%
    threshold = 0.8
    url_threshold = (
        URL_NAME_HINT_THRESHOLD
        if header and _RE_URL_HEADER.search(str(header).strip())
        else URL_INFERENCE_THRESHOLD
    )

    email_count = sum(1 for s in str_sample if _RE_EMAIL.match(s))
    if email_count >= sample_size * threshold:
        return 'email'

    url_count = sum(1 for s in str_sample if _is_url_like(s))
    if url_count >= sample_size * url_threshold:
        return 'url'

    date_kinds = [_parse_date_like(s) for s in str_sample]
    date_like_count = sum(1 for kind in date_kinds if kind is not None)
    if date_like_count >= sample_size * DATE_INFERENCE_THRESHOLD:
        if any(kind == 'date_time' for kind in date_kinds):
            # 自动建字段没有时间格式配置；用文本保留完整时间值，避免静默截断。
            return 'text'
        return 'date'

    phone_count = sum(1 for s in str_sample if _RE_PHONE.match(s))
    if phone_count >= sample_size * threshold:
        return 'phone'

    bool_values = {'true', 'false', 'yes', 'no', '是', '否', '1', '0'}
    if all(s.lower() in bool_values for s in str_sample):
        return 'checkbox'

    unique_count = len(set([str(v) for v in non_empty]))
    if unique_count <= 10 and len(non_empty) > unique_count * 3:
        return 'select'

    return 'text'


def smart_field_mapping(
    table_id: UUID,
    headers: List[str],
    rows: List[List[Any]]
) -> Dict[str, Any]:
    """
    智能字段匹配和类型推断

    Args:
        table_id: 目标表格ID
        headers: 导入数据的列名
        rows: 导入数据的行

    Returns:
        Dict: {
            'field_mapping': {csv_header: field_object},
            'match_confidence': {csv_header: float},
            'new_fields': [{name, type, description}],
            'type_suggestions': {csv_header: suggested_type}
        }
    """
    existing_fields = TableField.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        is_deleted=False
    ).exclude(is_hidden=True).order_by('order')

    field_names = {field.name.lower(): field for field in existing_fields}

    field_mapping = {}
    match_confidence = {}
    new_fields = []
    type_suggestions = {}

    for idx, header in enumerate(headers):
        header_lower = header.lower()

        if header_lower in field_names:
            field_mapping[header] = field_names[header_lower]
            match_confidence[header] = 1.0
        else:
            normalized = normalize_field_name(header)
            for field_name, field in field_names.items():
                if normalized == normalize_field_name(field_name):
                    field_mapping[header] = field
                    match_confidence[header] = 0.8
                    break

        if header not in field_mapping:
            column_values = [row[idx] if idx < len(row) else '' for row in rows]
            suggested_type = infer_field_type(column_values, header=header)

            type_suggestions[header] = suggested_type
            match_confidence[header] = 0.0
            new_fields.append({
                'name': header,
                'type': suggested_type,
                'description': '从导入数据自动创建'
            })

    return {
        'field_mapping': field_mapping,
        'match_confidence': match_confidence,
        'new_fields': new_fields,
        'type_suggestions': type_suggestions
    }
