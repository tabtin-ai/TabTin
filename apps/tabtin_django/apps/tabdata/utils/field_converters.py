"""
字段类型转换器

提供字段类型之间的安全转换功能，包括数据转换和验证。
"""

from typing import Any, Dict, List, Optional, Tuple
from decimal import Decimal, InvalidOperation
from datetime import datetime, date
import re
import json

from apps.tabdata.constants import FILE_BASED_FIELD_TYPES


from apps.tabdata.utils.choice_utils import extract_choice_values as _extract_choice_values


class FieldConverter:
    """字段类型转换器基类"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        """
        检查是否可以转换到目标类型

        Args:
            target_type: 目标字段类型

        Returns:
            bool: 是否可以转换
        """
        return False

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        """
        转换字段值

        Args:
            value: 原始值
            target_type: 目标类型
            target_options: 目标类型选项

        Returns:
            Tuple[bool, Any, Optional[str]]: (是否成功, 转换后的值, 错误信息)
        """
        return False, value, "不支持的转换"


class TextConverter(FieldConverter):
    """文本字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in {
            'text', 'long_text', 'number', 'date',
            'select', 'multi_select', 'checkbox', 'url', 'email', 'phone',
            *FILE_BASED_FIELD_TYPES,
        }

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None or value == '':
            return True, None, None

        str_value = str(value).strip()

        if target_type in ('text', 'long_text'):
            return True, str_value, None

        elif target_type == 'number':
            try:
                # 尝试转换为数字
                if '.' in str_value:
                    return True, float(str_value), None
                else:
                    return True, int(str_value), None
            except ValueError:
                return False, value, f"无法将 '{str_value}' 转换为数字"

        elif target_type == 'date':
            # 尝试解析日期
            date_patterns = [
                ('%Y-%m-%d', r'^\d{4}-\d{2}-\d{2}$'),
                ('%Y/%m/%d', r'^\d{4}/\d{2}/\d{2}$'),
                ('%m/%d/%Y', r'^\d{2}/\d{2}/\d{4}$'),
                ('%d/%m/%Y', r'^\d{2}/\d{2}/\d{4}$'),
            ]

            for pattern, regex in date_patterns:
                if re.match(regex, str_value):
                    try:
                        parsed_date = datetime.strptime(str_value, pattern).date()
                        return True, parsed_date.isoformat(), None
                    except ValueError:
                        continue

            return False, value, f"无法将 '{str_value}' 转换为日期格式"

        elif target_type == 'select':
            raw_choices = target_options.get('choices', []) if target_options else []
            valid_values = _extract_choice_values(raw_choices)
            if str_value in valid_values:
                return True, str_value, None
            else:
                return False, value, f"值 '{str_value}' 不在选项列表中"

        elif target_type == 'multi_select':
            raw_choices = target_options.get('choices', []) if target_options else []
            valid_values = _extract_choice_values(raw_choices)

            if str_value in valid_values:
                return True, [str_value], None

            values = [v.strip() for v in str_value.split(',')]
            invalid_values = [v for v in values if v not in valid_values]

            if invalid_values:
                return False, value, f"值 {invalid_values} 不在选项列表中"

            return True, values, None

        elif target_type == 'checkbox':
            # 转换为布尔值
            true_values = ['true', '1', 'yes', 'y', '是', '真', 'on']
            false_values = ['false', '0', 'no', 'n', '否', '假', 'off']

            lower_value = str_value.lower()
            if lower_value in true_values:
                return True, True, None
            elif lower_value in false_values:
                return True, False, None
            else:
                return False, value, f"无法将 '{str_value}' 转换为布尔值"

        elif target_type == 'url':
            # 简单的URL验证
            url_pattern = r'^https?://.+'
            if re.match(url_pattern, str_value):
                return True, str_value, None
            else:
                return False, value, f"'{str_value}' 不是有效的URL格式"

        elif target_type == 'email':
            # 简单的邮箱验证
            email_pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
            if re.match(email_pattern, str_value):
                return True, str_value, None
            else:
                return False, value, f"'{str_value}' 不是有效的邮箱格式"

        elif target_type == 'phone':
            from apps.tabdata.utils.field_types import PhoneField
            if not PhoneField.validate(str_value, target_options):
                return False, value, f"'{str_value}' 不是有效的电话号码格式"
            return True, PhoneField.format(str_value, target_options), None

        elif target_type in FILE_BASED_FIELD_TYPES:
            url_pattern = r'^https?://.+'
            if re.match(url_pattern, str_value):
                default_name = target_options.get('default_name') if target_options else None
                file_name = default_name or str_value.split('/')[-1] or '附件'
                return True, [{
                    'name': file_name,
                    'url': str_value
                }], None
            return False, value, f"'{str_value}' 不是有效的附件 URL"

        return False, value, f"不支持从文本转换到 {target_type}"


class NumberConverter(FieldConverter):
    """数字字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in ['text', 'number', 'checkbox']

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, None, None

        if target_type in ['text']:
            return True, str(value), None

        elif target_type == 'number':
            return True, value, None

        elif target_type == 'checkbox':
            # 0为False，非0为True
            return True, bool(value), None

        return False, value, f"不支持从数字转换到 {target_type}"


class SelectConverter(FieldConverter):
    """单选字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in ['text', 'select', 'multi_select']

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, None, None

        if target_type in ['text']:
            return True, str(value), None

        elif target_type == 'select':
            raw_choices = target_options.get('choices', []) if target_options else []
            valid_values = _extract_choice_values(raw_choices)
            if str(value) in valid_values:
                return True, value, None
            else:
                return False, value, f"值 '{value}' 不在新的选项列表中"

        elif target_type == 'multi_select':
            raw_choices = target_options.get('choices', []) if target_options else []
            valid_values = _extract_choice_values(raw_choices)
            if str(value) in valid_values:
                return True, [value], None
            else:
                return False, value, f"值 '{value}' 不在选项列表中"

        return False, value, f"不支持从单选转换到 {target_type}"


class MultiSelectConverter(FieldConverter):
    """多选字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in ['text', 'select', 'multi_select']

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, None, None

        # 确保value是列表
        if not isinstance(value, list):
            value = [value]

        if target_type in ['text']:
            # 用逗号连接多个值
            return True, ', '.join(str(v) for v in value), None

        elif target_type == 'select':
            if len(value) == 1:
                raw_choices = target_options.get('choices', []) if target_options else []
                valid_values = _extract_choice_values(raw_choices)
                if str(value[0]) in valid_values:
                    return True, value[0], None
                else:
                    return False, value, f"值 '{value[0]}' 不在选项列表中"
            else:
                return False, value, "多选字段有多个值，无法转换为单选"

        elif target_type == 'multi_select':
            raw_choices = target_options.get('choices', []) if target_options else []
            valid_values = _extract_choice_values(raw_choices)
            invalid_values = [v for v in value if str(v) not in valid_values]

            if invalid_values:
                return False, value, f"值 {invalid_values} 不在新的选项列表中"

            return True, value, None

        return False, value, f"不支持从多选转换到 {target_type}"


class DateConverter(FieldConverter):
    """日期字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in ['text', 'date']

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, None, None

        if target_type in ['text']:
            return True, str(value), None

        elif target_type == 'date':
            return True, value, None

        return False, value, f"不支持从日期转换到 {target_type}"


class SystemTimestampConverter(FieldConverter):
    """系统时间字段转换器。"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in ['text', 'date']

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, None, None

        if target_type in ['text']:
            return True, str(value), None

        elif target_type == 'date':
            # 提取日期部分
            if isinstance(value, str):
                try:
                    datetime_obj = datetime.fromisoformat(value.replace('Z', '+00:00'))
                    return True, datetime_obj.date().isoformat(), None
                except ValueError:
                    return False, value, f"无法解析日期时间 '{value}'"

            return True, value, None

        return False, value, f"不支持从系统时间转换到 {target_type}"


class CheckboxConverter(FieldConverter):
    """复选框字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in ['text', 'number', 'checkbox']

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, None, None

        if target_type in ['text']:
            return True, '是' if value else '否', None

        elif target_type == 'number':
            return True, 1 if value else 0, None

        elif target_type == 'checkbox':
            return True, value, None

        return False, value, f"不支持从复选框转换到 {target_type}"


class RatingConverter(FieldConverter):
    """评分字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in {'text', 'number', 'rating'}

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, None, None

        if target_type == 'text':
            return True, str(value), None

        if target_type == 'number':
            try:
                return True, int(value), None
            except (ValueError, TypeError):
                return False, value, f"无法将评分值 '{value}' 转换为数字"

        if target_type == 'rating':
            return True, value, None

        return False, value, f"不支持从评分转换到 {target_type}"


class AttachmentConverter(FieldConverter):
    """附件字段转换器"""

    @classmethod
    def can_convert_to(cls, target_type: str) -> bool:
        return target_type in {*FILE_BASED_FIELD_TYPES, 'text', 'url'}

    @classmethod
    def convert_value(cls, value: Any, target_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
        if value is None:
            return True, [] if target_type in FILE_BASED_FIELD_TYPES else None, None

        attachments = value if isinstance(value, list) else [value]
        attachments = [att for att in attachments if isinstance(att, dict)]

        if target_type in FILE_BASED_FIELD_TYPES:
            return True, attachments, None

        if not attachments:
            return True, None, None

        if target_type == 'text':
            names = [att.get('name') or att.get('url', '') for att in attachments]
            return True, ', '.join(filter(None, names)), None

        if target_type == 'url':
            first = attachments[0]
            url = first.get('url')
            if url:
                return True, url, None
            return False, value, "附件缺少 URL，无法转换为 URL 类型"

        return False, value, f"不支持从附件转换到 {target_type}"


# 字段转换器注册表
FIELD_CONVERTERS = {
    'text': TextConverter,
    'long_text': TextConverter,
    'number': NumberConverter,
    'rating': RatingConverter,
    'select': SelectConverter,
    'multi_select': MultiSelectConverter,
    'date': DateConverter,
    'created_time': SystemTimestampConverter,
    'last_modified_time': SystemTimestampConverter,
    'checkbox': CheckboxConverter,
    'url': TextConverter,
    'email': TextConverter,
    'phone': TextConverter,
    'attachment': AttachmentConverter,
}


def can_convert_field_type(from_type: str, to_type: str) -> bool:
    """
    检查是否可以进行字段类型转换

    Args:
        from_type: 源字段类型
        to_type: 目标字段类型

    Returns:
        bool: 是否可以转换
    """
    converter = FIELD_CONVERTERS.get(from_type)
    if not converter:
        return False

    return converter.can_convert_to(to_type)


def convert_field_value(value: Any, from_type: str, to_type: str, target_options: Optional[Dict] = None) -> Tuple[bool, Any, Optional[str]]:
    """
    转换字段值

    Args:
        value: 原始值
        from_type: 源字段类型
        to_type: 目标字段类型
        target_options: 目标字段选项

    Returns:
        Tuple[bool, Any, Optional[str]]: (是否成功, 转换后的值, 错误信息)
    """
    converter = FIELD_CONVERTERS.get(from_type)
    if not converter:
        return False, value, f"不支持的源字段类型: {from_type}"

    return converter.convert_value(value, to_type, target_options)


def get_conversion_preview(from_type: str, to_type: str, sample_values: List[Any], target_options: Optional[Dict] = None) -> Dict[str, Any]:
    """
    获取转换预览

    Args:
        from_type: 源字段类型
        to_type: 目标字段类型
        sample_values: 示例值列表
        target_options: 目标字段选项

    Returns:
        Dict: 转换预览结果
    """
    if not can_convert_field_type(from_type, to_type):
        return {
            'can_convert': False,
            'error': f"不支持从 {from_type} 转换到 {to_type}",
            'preview': []
        }

    preview = []
    success_count = 0

    for value in sample_values:
        success, converted_value, error = convert_field_value(value, from_type, to_type, target_options)
        preview.append({
            'original': value,
            'converted': converted_value,
            'success': success,
            'error': error
        })

        if success:
            success_count += 1

    return {
        'can_convert': True,
        'success_rate': success_count / len(sample_values) if sample_values else 1.0,
        'preview': preview
    }
