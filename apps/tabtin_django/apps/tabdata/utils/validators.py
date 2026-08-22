"""
数据验证器

提供各种数据格式的验证功能
"""
import re
from typing import Any
from urllib.parse import urlparse


def is_valid_url(value: Any) -> bool:
    """
    验证是否为有效的URL

    Args:
        value: 待验证的值

    Returns:
        bool: 是否为有效URL
    """
    if not isinstance(value, str):
        return False

    try:
        result = urlparse(value)
        return all([result.scheme, result.netloc])
    except Exception:
        return False


def is_valid_email(value: Any) -> bool:
    """
    验证是否为有效的邮箱地址

    Args:
        value: 待验证的值

    Returns:
        bool: 是否为有效邮箱
    """
    if not isinstance(value, str):
        return False

    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, value))


def is_valid_phone(value: Any) -> bool:
    """
    验证是否为有效的手机号

    Args:
        value: 待验证的值

    Returns:
        bool: 是否为有效手机号
    """
    if not isinstance(value, str):
        return False

    from apps.services.common.constants import REGEX_PATTERNS
    return bool(re.match(REGEX_PATTERNS['PHONE'], value))


def infer_field_type(value: Any) -> str:
    """
    根据值推断字段类型

    Args:
        value: 字段值

    Returns:
        str: 推断的字段类型
    """
    if value is None or value == '':
        return 'text'

    # 检查是否为URL
    if is_valid_url(value):
        return 'url'

    # 检查是否为邮箱
    if is_valid_email(value):
        return 'email'

    # 检查是否为手机号
    if is_valid_phone(value):
        return 'phone'

    # 检查是否为数字
    try:
        float(value)
        return 'number'
    except (ValueError, TypeError):
        pass

    # 检查是否为日期
    if isinstance(value, str):
        # 简单的日期格式检查
        date_patterns = [
            r'^\d{4}-\d{2}-\d{2}$',  # YYYY-MM-DD
            r'^\d{4}/\d{2}/\d{2}$',  # YYYY/MM/DD
        ]
        for pattern in date_patterns:
            if re.match(pattern, value):
                return 'date'

    # 默认为文本
    return 'text'
