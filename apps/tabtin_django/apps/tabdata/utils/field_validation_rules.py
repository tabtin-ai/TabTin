"""
字段验证规则工具

支持的规则键：
- min_length / max_length: 针对字符串/列表的长度限制
- pattern: 正则表达式
- min_value / max_value: 数值或日期范围（日期需使用 ISO 格式字符串）
- allowed_values: 白名单列表
- max_items: 针对列表类型的最大元素数
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple
from decimal import Decimal, InvalidOperation
from datetime import datetime, date
import re


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str) and value.strip() == "":
        return True
    if isinstance(value, list) and len(value) == 0:
        return True
    return False


def _to_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        return Decimal(str(value))
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _to_datetime(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            return None
    return None


_JS_REGEX_LITERAL_RE = re.compile(r'^/(.+)/([gimsuy]*)$')


def normalize_validation_pattern(raw: str) -> str:
    """兼容用户粘贴的 JS 字面量 /pattern/flags，返回供 re.match 使用的裸模式。"""
    trimmed = (raw or '').strip()
    if not trimmed:
        return trimmed
    matched = _JS_REGEX_LITERAL_RE.match(trimmed)
    if matched:
        return matched.group(1)
    return trimmed


def validate_with_rules(field_rules: Dict[str, Any], value: Any) -> Tuple[bool, Optional[str]]:
    """
    根据字段验证规则检查值是否合法
    """
    if not field_rules:
        return True, None

    if _is_empty(value):
        return True, None

    # 长度限制（字符串或列表）
    if isinstance(value, (str, list)):
        length = len(value)
        min_length = field_rules.get('min_length')
        max_length = field_rules.get('max_length')
        if min_length is not None and length < int(min_length):
            return False, field_rules.get('message', f'长度不能小于 {min_length}')
        if max_length is not None and length > int(max_length):
            return False, field_rules.get('message', f'长度不能超过 {max_length}')

    # 列表元素数量限制
    if isinstance(value, list):
        max_items = field_rules.get('max_items')
        if max_items is not None and len(value) > int(max_items):
            return False, field_rules.get('message', f'最多允许 {max_items} 个条目')

    # 正则校验（兼容 /pattern/flags；re.match = 从开头匹配）
    pattern = field_rules.get('pattern')
    if pattern and isinstance(value, str):
        normalized = normalize_validation_pattern(str(pattern))
        try:
            if normalized and not re.match(normalized, value):
                return False, field_rules.get('message', '字段格式不符合要求')
        except re.error:
            # 非法正则配置不阻断；由字段配置侧修复
            pass

    # allowed_values 白名单
    allowed_values = field_rules.get('allowed_values')
    if allowed_values is not None:
        if isinstance(value, list):
            invalid = [v for v in value if v not in allowed_values]
            if invalid:
                return False, field_rules.get('message', f'包含不允许的值: {invalid}')
        else:
            if value not in allowed_values:
                return False, field_rules.get('message', f'值 {value} 不在允许列表中')

    # 数值范围
    min_value = field_rules.get('min_value')
    max_value = field_rules.get('max_value')
    numeric = _to_decimal(value)
    if numeric is not None:
        if min_value is not None and numeric < Decimal(str(min_value)):
            return False, field_rules.get('message', f'值不能小于 {min_value}')
        if max_value is not None and numeric > Decimal(str(max_value)):
            return False, field_rules.get('message', f'值不能大于 {max_value}')
    else:
        # 日期范围
        current = _to_datetime(value)
        if current is not None:
            if min_value is not None:
                min_dt = _to_datetime(min_value)
                if min_dt and current < min_dt:
                    return False, field_rules.get('message', f'日期不能早于 {min_value}')
            if max_value is not None:
                max_dt = _to_datetime(max_value)
                if max_dt and current > max_dt:
                    return False, field_rules.get('message', f'日期不能晚于 {max_value}')

    return True, None
