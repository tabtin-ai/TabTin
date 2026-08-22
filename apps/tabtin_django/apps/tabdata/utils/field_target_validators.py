"""
字段目标类型校验器

按目标类型设计，不关心源类型是什么
核心原则：能转就转，转不了就清空
"""

from typing import Any, Optional, Tuple, List, Set
from datetime import datetime, date
import re
import logging

from apps.tabdata.utils.choice_utils import extract_choice_values

logger = logging.getLogger(__name__)


# 配置常量
MAX_OPTION_TEXT_LENGTH = 50    # 单个选项最多 50 字符
MAX_OPTIONS_COUNT = 200        # 最多创建 200 个选项


class TargetFieldValidator:
    """目标字段校验器基类"""

    @classmethod
    def validate_and_convert(
        cls,
        value: Any,
        target_options: Optional[dict] = None
    ) -> Tuple[bool, Any, Optional[str]]:
        """
        校验并转换值到目标类型

        Args:
            value: 任意类型的源值
            target_options: 目标字段配置

        Returns:
            (是否成功, 转换后的值, 错误信息)
            - 成功: (True, 转换后的值, None)
            - 失败: (False, None, 错误信息)
        """
        raise NotImplementedError


class TextTargetValidator(TargetFieldValidator):
    """文本类型：啥都能转"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None:
            return True, None, None

        # 空字符串
        if value == "":
            return True, None, None

        # 列表 → 逗号分隔
        if isinstance(value, list):
            # 过滤掉空值
            filtered = [str(v) for v in value if v is not None and v != ""]
            if not filtered:
                return True, None, None
            return True, ", ".join(filtered), None

        # 布尔值
        if isinstance(value, bool):
            return True, "true" if value else "false", None

        # 日期/时间
        if isinstance(value, (date, datetime)):
            return True, value.isoformat(), None

        # 其他 → 字符串
        return True, str(value), None


class NumberTargetValidator(TargetFieldValidator):
    """数字类型：统一数字校验"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 布尔值 → 0/1
        if isinstance(value, bool):
            return True, 1 if value else 0, None

        # 已经是数字
        if isinstance(value, (int, float)):
            return True, value, None

        # 列表 → 尝试转换第一个元素
        if isinstance(value, list):
            if not value:
                return True, None, None
            value = value[0]

        # 字符串 → 尝试解析
        str_value = str(value).strip()
        if not str_value:
            return True, None, None

        try:
            # 尝试整数
            if '.' not in str_value:
                return True, int(str_value), None
            # 尝试浮点数
            return True, float(str_value), None
        except (ValueError, TypeError):
            return False, None, f"无法将 '{str_value}' 转换为数字"


class SelectTargetValidator(TargetFieldValidator):
    """单选类型：自动创建或校验选项"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 统一转字符串
        if isinstance(value, list):
            # 多选 → 单选：只取第一个非空值
            filtered = [v for v in value if v is not None and v != ""]
            if not filtered:
                return True, None, None
            str_value = str(filtered[0]).strip()
        elif isinstance(value, bool):
            str_value = "true" if value else "false"
        elif isinstance(value, (date, datetime)):
            str_value = value.isoformat()
        else:
            str_value = str(value).strip()

        if not str_value:
            return True, None, None

        # 检查长度限制
        if len(str_value) > MAX_OPTION_TEXT_LENGTH:
            return False, None, f"文本超过 {MAX_OPTION_TEXT_LENGTH} 字符，无法作为选项"

        # 如果用户指定了选项列表，校验是否在其中
        choices = target_options.get('choices', []) if target_options else []
        if choices:
            choice_values = extract_choice_values(choices)
            if str_value in choice_values:
                return True, str_value, None
            else:
                return False, None, f"值 '{str_value}' 不在选项列表中"

        # 否则，标记为"需要自动创建"（返回成功，值会被收集用于自动创建）
        return True, str_value, None


class MultiSelectTargetValidator(TargetFieldValidator):
    """多选类型：自动创建或校验选项"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 统一转字符串列表
        if isinstance(value, list):
            str_values = [str(v).strip() for v in value if v is not None and v != ""]
        elif isinstance(value, bool):
            str_values = ["true" if value else "false"]
        elif isinstance(value, (date, datetime)):
            str_values = [value.isoformat()]
        else:
            # 尝试按分隔符拆分
            str_value = str(value).strip()
            if not str_value:
                return True, None, None

            # 检查是否包含分隔符
            for sep in [',', '|', ';', '\n']:
                if sep in str_value:
                    str_values = [v.strip() for v in str_value.split(sep) if v.strip()]
                    break
            else:
                # 没有分隔符，作为单个值
                str_values = [str_value]

        if not str_values:
            return True, None, None

        # 检查长度限制
        invalid = [v for v in str_values if len(v) > MAX_OPTION_TEXT_LENGTH]
        if invalid:
            return False, None, f"值超过 {MAX_OPTION_TEXT_LENGTH} 字符: {invalid[:3]}"

        # 如果用户指定了选项列表，校验
        choices = target_options.get('choices', []) if target_options else []
        if choices:
            choice_values = extract_choice_values(choices)
            invalid = [v for v in str_values if v not in choice_values]
            if invalid:
                return False, None, f"值不在选项列表中: {invalid[:3]}"

        return True, str_values, None


class CheckboxTargetValidator(TargetFieldValidator):
    """复选框类型：统一布尔转换"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, False, None

        # 已经是布尔
        if isinstance(value, bool):
            return True, value, None

        # 数字
        if isinstance(value, (int, float)):
            return True, value != 0, None

        # 列表
        if isinstance(value, list):
            # 空列表 → False
            if not value:
                return True, False, None
            # 有值 → True
            return True, True, None

        # 字符串
        str_value = str(value).strip().lower()
        if not str_value:
            return True, False, None

        true_values = ['true', '1', 'yes', 'y', '是', '真', 'on', '✓', 't']
        false_values = ['false', '0', 'no', 'n', '否', '假', 'off', '✗', 'f']

        if str_value in true_values:
            return True, True, None
        elif str_value in false_values:
            return True, False, None
        else:
            return False, None, f"无法将 '{value}' 转换为布尔值"


class DateTargetValidator(TargetFieldValidator):
    """日期类型：统一日期解析"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 已经是日期
        if isinstance(value, date) and not isinstance(value, datetime):
            return True, value.isoformat(), None
        if isinstance(value, datetime):
            return True, value.date().isoformat(), None

        # 布尔值/列表 → 无法转换
        if isinstance(value, (bool, list)):
            return False, None, "布尔值或列表无法转换为日期"

        # 时间戳（数字）
        if isinstance(value, (int, float)):
            try:
                # 支持秒级时间戳和毫秒级时间戳
                if value > 10000000000:  # 毫秒级时间戳
                    value = value / 1000
                dt = datetime.fromtimestamp(value)
                return True, dt.date().isoformat(), None
            except (ValueError, OSError, OverflowError):
                return False, None, f"无效的时间戳: {value}"

        # 字符串解析
        str_value = str(value).strip()
        if not str_value:
            return True, None, None

        # 常见日期格式
        patterns = [
            '%Y-%m-%d',
            '%Y/%m/%d',
            '%m/%d/%Y',
            '%d/%m/%Y',
            '%Y%m%d',
            '%Y.%m.%d',
        ]

        for pattern in patterns:
            try:
                parsed = datetime.strptime(str_value, pattern)
                return True, parsed.date().isoformat(), None
            except ValueError:
                continue

        return False, None, f"无法解析日期: '{str_value}'"


class UrlTargetValidator(TargetFieldValidator):
    """URL类型：格式校验"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 先转文本
        if isinstance(value, list):
            if not value:
                return True, None, None
            str_value = str(value[0]).strip()
        elif isinstance(value, (bool, date, datetime)):
            return False, None, "此类型无法转换为URL"
        else:
            str_value = str(value).strip()

        if not str_value:
            return True, None, None

        # URL格式校验
        url_pattern = r'^https?://.+'
        if re.match(url_pattern, str_value):
            return True, str_value, None
        else:
            return False, None, f"'{str_value}' 不是有效的URL格式"


class EmailTargetValidator(TargetFieldValidator):
    """邮箱类型：格式校验"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 先转文本
        if isinstance(value, list):
            if not value:
                return True, None, None
            str_value = str(value[0]).strip()
        elif isinstance(value, (bool, date, datetime)):
            return False, None, "此类型无法转换为邮箱"
        else:
            str_value = str(value).strip()

        if not str_value:
            return True, None, None

        # 邮箱格式校验
        email_pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
        if re.match(email_pattern, str_value):
            return True, str_value, None
        else:
            return False, None, f"'{str_value}' 不是有效的邮箱格式"


class PhoneTargetValidator(TargetFieldValidator):
    """手机号类型：格式校验"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 先转文本
        if isinstance(value, list):
            if not value:
                return True, None, None
            str_value = str(value[0])
        elif isinstance(value, (bool, date, datetime)):
            return False, None, "此类型无法转换为手机号"
        else:
            str_value = str(value)

        from apps.tabdata.utils.field_types import PhoneField

        if not PhoneField.validate(str_value, target_options):
            return False, None, f"'{str_value}' 不是有效的电话号码格式"

        clean_phone = PhoneField.format(str_value, target_options)
        return True, clean_phone, None


class AttachmentTargetValidator(TargetFieldValidator):
    """附件类型：需要URL格式"""

    @classmethod
    def validate_and_convert(cls, value: Any, target_options: Optional[dict] = None):
        if value is None or value == "":
            return True, None, None

        # 已经是附件格式
        if isinstance(value, dict) and 'url' in value:
            return True, value, None

        if isinstance(value, list):
            # 可能已经是附件列表
            if value and isinstance(value[0], dict) and 'url' in value[0]:
                return True, value, None
            # 可能是URL列表
            if not value:
                return True, None, None
            str_value = str(value[0]).strip()
        elif isinstance(value, (bool, date, datetime)):
            return False, None, "此类型无法转换为附件"
        else:
            str_value = str(value).strip()

        if not str_value:
            return True, None, None

        # 检查是否是URL
        url_pattern = r'^https?://.+'
        if re.match(url_pattern, str_value):
            file_name = str_value.split('/')[-1] or '附件'
            return True, [{
                'name': file_name,
                'url': str_value
            }], None
        else:
            return False, None, f"'{str_value}' 不是有效的URL，无法转换为附件"


# 目标类型校验器注册表
TARGET_VALIDATORS = {
    'text': TextTargetValidator,
    'number': NumberTargetValidator,
    'select': SelectTargetValidator,
    'multi_select': MultiSelectTargetValidator,
    'checkbox': CheckboxTargetValidator,
    'date': DateTargetValidator,
    'url': UrlTargetValidator,
    'email': EmailTargetValidator,
    'phone': PhoneTargetValidator,
    'attachment': AttachmentTargetValidator,
}


def convert_to_target_type(
    value: Any,
    target_type: str,
    target_options: Optional[dict] = None
) -> Tuple[bool, Any, Optional[str]]:
    """
    转换任意值到目标类型

    Args:
        value: 源值（任意类型）
        target_type: 目标字段类型
        target_options: 目标字段配置

    Returns:
        (是否成功, 转换后的值, 错误信息)
        - 成功: (True, 转换后的值, None)
        - 失败: (False, None, 错误信息) - 调用方应将该值清空
    """
    validator = TARGET_VALIDATORS.get(target_type)
    if not validator:
        return False, None, f"不支持的目标类型: {target_type}"

    try:
        return validator.validate_and_convert(value, target_options)
    except Exception as e:
        logger.error("转换值到 %s 时出错: %s", target_type, e, exc_info=True)
        return False, None, f"转换异常: {str(e)}"


def collect_auto_create_options(
    values: List[Any],
    target_type: str
) -> List[str]:
    """
    收集用于自动创建选项的值（仅用于 select/multi_select）

    Args:
        values: 值列表
        target_type: 目标类型

    Returns:
        去重后的选项列表（最多 MAX_OPTIONS_COUNT 个）
    """
    if target_type not in ['select', 'multi_select']:
        return []

    unique_options: Set[str] = set()

    for value in values:
        if value is None or value == "":
            continue

        # 如果是列表（多选），展开
        if isinstance(value, list):
            for item in value:
                if item and isinstance(item, str):
                    unique_options.add(item)
        elif isinstance(value, str):
            unique_options.add(value)

    # 限制数量
    options_list = sorted(unique_options)
    if len(options_list) > MAX_OPTIONS_COUNT:
        logger.warning("选项数量超过限制 %d，只保留前 %d 个", MAX_OPTIONS_COUNT, MAX_OPTIONS_COUNT)
        return options_list[:MAX_OPTIONS_COUNT]

    return options_list





