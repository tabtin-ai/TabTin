"""
字段类型定义和验证

支持的字段类型：
- text: 文本字段
- number: 数字
- date: 日期
- select: 单选
- multi_select: 多选
- checkbox: 复选框
- url: URL 链接
- email: 邮箱地址
- phone: 手机号
- attachment: 附件信息
"""

from typing import Any, Dict, List, Optional
from datetime import datetime, date
from decimal import Decimal
import json
import math
import re
import uuid

try:
    from apps.services.oss.models import FileRecord
    from apps.services.oss.services.public_assets import build_public_asset_url
except Exception:
    FileRecord = None
    build_public_asset_url = None


def _file_record_display_url(file_record) -> str:
    if not file_record:
        return ''
    if getattr(file_record, 'is_public', False) and build_public_asset_url:
        return build_public_asset_url(getattr(file_record, 'file_key', '') or '') or ''
    return (getattr(file_record, 'cdn_url', '') or getattr(file_record, 'access_url', '') or '')


from apps.tabdata.utils.choice_utils import extract_choice_values as _extract_choice_values
from apps.tabdata.utils.choice_utils import normalize_select_choices as _normalize_select_choices


def _date_options_preserve_time(options: Optional[Dict] = None) -> bool:
    if not isinstance(options, dict):
        return False
    formatting = options.get('formatting')
    if not isinstance(formatting, dict):
        return False
    time_format = formatting.get('time')
    return isinstance(time_format, str) and time_format != 'None'


def _string_carries_time(value: str) -> bool:
    return bool(re.search(r'(?:[tT]|\s)\d{1,2}:\d{2}', value.strip()))


class FieldType:
    """字段类型基类"""

    type_name: str = ""

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        """
        验证字段值是否符合类型要求

        Args:
            value: 字段值
            options: 字段选项配置

        Returns:
            bool: 是否有效
        """
        raise NotImplementedError

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Any:
        """
        格式化字段值

        Args:
            value: 原始值
            options: 字段选项配置

        Returns:
            格式化后的值
        """
        return value


class TextField(FieldType):
    """文本字段"""

    type_name = "text"
    MAX_TEXT_LENGTH = 100_000

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        if not isinstance(value, str):
            return False
        max_len = (options or {}).get('max_length', cls.MAX_TEXT_LENGTH)
        return len(value) <= max_len

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> str:
        if value is None:
            return ""
        return str(value)


class NumberField(FieldType):
    """数字字段

    E2 / Wave 4: supports locale-aware parsing via ``parse_locale_number``.
    """

    type_name = "number"
    MAX_SAFE_DIGITS = 15

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        parsed = cls.parse_locale_number(value, options)
        if parsed is not None:
            value = parsed
        try:
            v = float(value)
            if not math.isfinite(v):
                return False
            if v != 0:
                import decimal
                d = decimal.Decimal(str(value))
                digits = len(d.as_tuple().digits)
                max_digits = (options or {}).get('max_digits', cls.MAX_SAFE_DIGITS)
                if digits > max_digits:
                    return False
            return True
        except (ValueError, TypeError):
            return False

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[float]:
        """格式化为float类型，以支持JSON序列化"""
        if value is None:
            return None
        parsed = cls.parse_locale_number(value, options)
        if parsed is not None:
            return parsed
        try:
            v = float(value) if not isinstance(value, float) else value
            if not math.isfinite(v):
                return None
            return v
        except (ValueError, TypeError):
            return None

    @staticmethod
    def parse_locale_number(value: Any, options: Optional[Dict] = None) -> Optional[float]:
        """E2 / Wave 4: parse locale-aware number strings.

        Supports:
        - US/CN: ``1,234.56`` (comma thousands, dot decimal)
        - EU:    ``1.234,56`` (dot thousands, comma decimal)

        ``options.locale`` hint:
        - ``"eu"`` / ``"de"`` / ``"fr"`` / ``"it"`` / ``"es"`` / ``"pt"`` / ``"nl"``:
          treat comma as decimal separator (EU convention)
        - ``"us"`` / ``"cn"`` / ``"en"`` / ``"zh"``:
          treat comma as thousands separator (US/CN convention)
        - ``None`` / absent: auto-detect using heuristic

        Auto-detection heuristic: if both comma and dot present, the **last**
        separator is the decimal mark; if only comma and no dot, auto-detect
        based on digit count after comma (3 digits = thousands, else decimal).
        """
        if not isinstance(value, str):
            return None
        s = value.strip()
        if not s:
            return None
        has_comma = ',' in s
        has_dot = '.' in s
        if not has_comma and not has_dot:
            return None

        locale_hint = (options or {}).get('locale', '') if options else ''
        locale_lower = (locale_hint or '').lower()
        is_eu = locale_lower in ('eu', 'de', 'fr', 'it', 'es', 'pt', 'nl')

        if has_comma and has_dot:
            last_comma = s.rfind(',')
            last_dot = s.rfind('.')
            if last_comma > last_dot:
                cleaned = s.replace('.', '').replace(',', '.')
            else:
                cleaned = s.replace(',', '')
        elif has_comma and not has_dot:
            if is_eu:
                cleaned = s.replace(',', '.')
            else:
                parts = s.split(',')
                if len(parts) == 2 and len(parts[1]) == 3 and parts[1].isdigit():
                    cleaned = s.replace(',', '')
                else:
                    cleaned = s.replace(',', '.')
        else:
            return None
        try:
            result = float(cleaned)
            if math.isfinite(result):
                return result
        except (ValueError, TypeError):
            pass
        return None


class PercentField(NumberField):
    """百分比字段（存储为小数，如 0.75 代表 75%）"""

    type_name = "percent"

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[float]:
        if value is None:
            return None
        try:
            v = float(value) if not isinstance(value, float) else value
            if not math.isfinite(v):
                return None
            return v
        except (ValueError, TypeError):
            return None


class CurrencyField(NumberField):
    """货币字段（存储为数值，格式化时附加货币符号）"""

    type_name = "currency"

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[float]:
        if value is None:
            return None
        try:
            v = float(value)
            if not math.isfinite(v):
                return None
            return v
        except (ValueError, TypeError):
            return None


class DateField(FieldType):
    """日期字段

    E2 / Wave 4: extended with i18n date parsing for multiple locales.
    """

    type_name = "date"

    _I18N_DATE_FORMATS = (
        '%Y-%m-%d',
        '%Y/%m/%d',
        '%m/%d/%Y',
        '%d-%m-%Y',
        '%d/%m/%Y',
        '%d.%m.%Y',
        '%Y.%m.%d',
        '%Y年%m月%d日',
    )

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        if isinstance(value, date):
            return True
        if isinstance(value, str):
            parsed = cls.parse_locale_date(value)
            if parsed is not None:
                return True
            try:
                datetime.fromisoformat(value.replace('Z', '+00:00'))
                return True
            except ValueError:
                return False
        return False

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[str]:
        if value is None:
            return None
        if _date_options_preserve_time(options):
            if isinstance(value, datetime):
                return value.isoformat()
            if isinstance(value, date):
                return value.isoformat()
            if isinstance(value, str):
                stripped = value.strip()
                if not stripped:
                    return None
                if _string_carries_time(stripped):
                    try:
                        return datetime.fromisoformat(stripped.replace('Z', '+00:00')).isoformat()
                    except ValueError:
                        pass
                    try:
                        from dateutil.parser import parse as _dateutil_parse
                        return _dateutil_parse(stripped).isoformat()
                    except Exception:
                        pass
                parsed = cls.parse_locale_date(stripped)
                if parsed is not None:
                    return parsed.isoformat()
                return stripped
        if isinstance(value, datetime):
            return value.date().isoformat()
        if isinstance(value, date):
            return value.isoformat()
        if isinstance(value, str):
            parsed = cls.parse_locale_date(value)
            if parsed is not None:
                return parsed.isoformat()
        return str(value)

    @classmethod
    def parse_locale_date(cls, value: str) -> Optional[date]:
        """E2 / Wave 4: parse date strings in multiple locale formats."""
        s = value.strip()
        if not s:
            return None
        for fmt in cls._I18N_DATE_FORMATS:
            try:
                return datetime.strptime(s, fmt).date()
            except ValueError:
                continue
        try:
            from dateutil.parser import parse as _dateutil_parse
            return _dateutil_parse(s).date()
        except Exception:
            pass
        return None


class SelectField(FieldType):
    """单选字段"""

    type_name = "select"

    @classmethod
    def validate_options(cls, options: Optional[Dict] = None) -> Optional[Dict]:
        """归一化 choices 为统一的 {value, label, color} 对象格式，返回修正后的 options。"""
        if options and 'options' in options:
            raise ValueError('select 字段 options 只接受 choices，不接受历史键 options')
        if not options or 'choices' not in options:
            return options
        normalized = dict(options)
        normalized['choices'] = _normalize_select_choices(options['choices'])
        return normalized

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        if not isinstance(value, str):
            return False
        if options and 'choices' in options:
            valid_values = _extract_choice_values(options['choices'])
            return value in valid_values
        return True

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[str]:
        if value is None:
            return None
        return str(value)


class MultiSelectField(FieldType):
    """多选字段"""

    type_name = "multi_select"

    @classmethod
    def validate_options(cls, options: Optional[Dict] = None) -> Optional[Dict]:
        """归一化 choices 为统一的 {value, label, color} 对象格式，返回修正后的 options。"""
        if options and 'options' in options:
            raise ValueError('multi_select 字段 options 只接受 choices，不接受历史键 options')
        if not options or 'choices' not in options:
            return options
        normalized = dict(options)
        normalized['choices'] = _normalize_select_choices(options['choices'])
        return normalized

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        if not isinstance(value, list):
            return False
        if options and 'choices' in options:
            valid_values = _extract_choice_values(options['choices'])
            return all(v in valid_values for v in value)
        return True

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> List[str]:
        if value is None:
            return []
        if isinstance(value, list):
            return [str(v) for v in value]
        return [str(value)]


class CheckboxField(FieldType):
    """复选框字段"""

    type_name = "checkbox"

    _TRUTHY_STRINGS = frozenset(('true', '1', 'yes', 'y', '是'))
    _FALSY_STRINGS = frozenset(('false', '0', 'no', 'n', '否', ''))

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        if isinstance(value, bool):
            return True
        if isinstance(value, float) and math.isnan(value):
            return False
        if isinstance(value, (int, float)):
            return True
        if isinstance(value, str):
            return value.lower() in cls._TRUTHY_STRINGS or value.lower() in cls._FALSY_STRINGS
        return False

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return False
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.lower() in cls._TRUTHY_STRINGS
        if isinstance(value, float) and math.isnan(value):
            return False
        if isinstance(value, (int, float)):
            return value != 0
        return bool(value)


class UrlField(FieldType):
    """URL 字段"""

    type_name = "url"

    _RE_DOMAIN = re.compile(
        r'^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(?:[:/?\#].*)?$'
    )

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None or value == "":
            return True
        if not isinstance(value, str):
            return False

        # 支持多种 URL 格式：
        # 1. 完整 URL：http://... 或 https://...
        # 2. 协议相对 URL：//example.com/...
        # 3. 相对路径：/path/to/resource
        # 4. 简单域名格式（会自动补全协议）
        value_str = value.strip()
        if not value_str:
            return True

        return (
            value_str.startswith("http://") or
            value_str.startswith("https://") or
            value_str.startswith("//") or
            value_str.startswith("/") or
            cls._RE_DOMAIN.match(value_str) is not None
        )

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[str]:
        if value is None or value == "":
            return None

        value_str = str(value).strip()
        if not value_str:
            return None

        if value_str.startswith("//"):
            return "https:" + value_str

        if not value_str.startswith(("http://", "https://", "/")):
            if cls._RE_DOMAIN.match(value_str):
                return "https://" + value_str

        return value_str


class EmailField(FieldType):
    """邮箱字段"""

    type_name = "email"

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None or value == "":
            return True
        if not isinstance(value, str):
            return False
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
        return re.match(pattern, value) is not None

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[str]:
        if value is None or value == "":
            return None
        return str(value).strip()


class PhoneField(FieldType):
    """电话字段

    默认 CN：大陆手机号 / 固话 / 400·800（与前端 table-kernel / table-ui 一致）；
    options.phone_region 可为 CN / US / international。
    """

    type_name = "phone"

    _RE_CN_MOBILE = re.compile(r'^1[3-9]\d{9}$')
    # 固话：0 + 区号(2~3 位) + 号码(7~8 位) → 抽数字后 10~12 位
    _RE_CN_LANDLINE = re.compile(r'^0\d{2,3}\d{7,8}$')
    _RE_CN_SERVICE = re.compile(r'^[48]00\d{7}$')
    _RE_US = re.compile(r'^1?\d{10}$')
    _RE_INTL_DIGITS = re.compile(r'^[1-9]\d{6,14}$')

    @classmethod
    def _is_valid_cn_digits(cls, digits: str) -> bool:
        return bool(
            cls._RE_CN_MOBILE.match(digits)
            or cls._RE_CN_LANDLINE.match(digits)
            or cls._RE_CN_SERVICE.match(digits)
        )

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None or value == "":
            return True
        if not isinstance(value, str):
            value = str(value)
        digits = re.sub(r'[^\d]', '', value.strip())
        if not digits:
            return False
        region = (options or {}).get('phone_region') or 'CN'
        if region == 'CN':
            return cls._is_valid_cn_digits(digits)
        if region == 'US':
            return bool(cls._RE_US.match(digits))
        return bool(cls._RE_INTL_DIGITS.match(digits))

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[str]:
        if value is None or value == "":
            return None
        digits = re.sub(r'[^\d]', '', str(value).strip())
        return digits or None


class AttachmentField(FieldType):
    """附件字段"""

    type_name = "attachment"
    REQUIRED_KEYS = {'name'}

    @classmethod
    def _collect_file_ids(cls, items: list) -> list:
        """从附件列表中收集所有合法的 file_id UUID"""
        ids = []
        for item in items:
            if not isinstance(item, dict):
                continue
            fid = item.get('file_id')
            if fid:
                try:
                    ids.append(uuid.UUID(str(fid)))
                except (ValueError, TypeError):
                    pass
        return ids

    @classmethod
    def _bulk_load_file_records(cls, file_uuids: list, completed_only: bool = False) -> dict:
        """批量加载 FileRecord，返回 {uuid: FileRecord} 字典"""
        if not file_uuids or not FileRecord:
            return {}
        qs = FileRecord.objects.filter(id__in=file_uuids)
        if completed_only:
            qs = qs.filter(status='completed')
        return {fr.id: fr for fr in qs}

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        if not isinstance(value, list):
            return False
        all_file_ids = cls._collect_file_ids(value)
        completed_map = cls._bulk_load_file_records(all_file_ids, completed_only=True) if all_file_ids else {}
        for item in value:
            if not isinstance(item, dict):
                return False
            file_id = item.get('file_id')
            if file_id and FileRecord:
                try:
                    file_uuid = uuid.UUID(str(file_id))
                except (ValueError, TypeError):
                    return False
                if file_uuid not in completed_map:
                    return False
            raw_name = item.get('name') or ''
            if not isinstance(raw_name, str):
                return False
            name = raw_name.strip()
            if not name and not file_id:
                return False
            url_value = item.get('url', '')
            if not isinstance(url_value, str):
                return False
            url = url_value.strip()
            if not url and not file_id:
                return False
        return True

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> List[Dict[str, Any]]:
        if value is None:
            return []
        formatted: List[Dict[str, Any]] = []
        items = value if isinstance(value, list) else [value]
        all_file_ids = cls._collect_file_ids(items)
        fr_map = cls._bulk_load_file_records(all_file_ids) if all_file_ids else {}
        for item in items:
            if not isinstance(item, dict):
                continue
            file_record = None
            file_id = item.get('file_id')
            if file_id and FileRecord:
                try:
                    file_uuid = uuid.UUID(str(file_id))
                    file_record = fr_map.get(file_uuid)
                except (ValueError, TypeError):
                    file_record = None
            name = str(item.get('name') or (file_record.file_name if file_record else '')).strip()
            url = str(_file_record_display_url(file_record) or item.get('url') or '').strip()
            data = {
                'file_id': str(file_record.id) if file_record else (str(file_id) if file_id else None),
                'reference_id': str(item.get('reference_id')) if item.get('reference_id') else None,
                'name': name,
                'url': url,
                'size': int(item.get('size') or (file_record.file_size if file_record else 0) or 0),
                'mime_type': str(item.get('mime_type') or (file_record.mime_type if file_record else '') or ''),
                'bucket': file_record.bucket_name if file_record else item.get('bucket', ''),
                'key': file_record.file_key if file_record else item.get('key', ''),
                'extra': item.get('extra') if isinstance(item.get('extra'), dict) else {}
            }
            formatted.append(data)
        return formatted


class RatingField(FieldType):
    """评分字段（0 ~ max 的整数值）"""

    type_name = "rating"

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        try:
            n = int(value)
        except (ValueError, TypeError):
            return False
        max_val = (options or {}).get('max', 5)
        return 0 <= n <= max_val

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[int]:
        if value is None:
            return None
        try:
            return int(value)
        except (ValueError, TypeError):
            return None


class UserField(FieldType):
    """用户字段（存储用户 ID 列表或单个用户对象）"""

    type_name = "user"

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        # 支持单个对象或列表
        if isinstance(value, dict):
            return True
        if isinstance(value, list):
            return all(isinstance(v, (dict, str)) for v in value)
        if isinstance(value, str):
            return True
        return False

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Any:
        if value is None:
            return None
        return value


class LinkField(FieldType):
    """关联字段 — 基数感知的验证与格式化

    多值 (ManyMany / OneMany):  [{id: str, title?: str}, ...]
    单值 (OneOne / ManyOne):    {id: str, title?: str} | null
    """

    type_name = "link"

    @classmethod
    def _is_multi(cls, options: Optional[Dict] = None) -> Optional[bool]:
        if not options:
            return None
        relationship = options.get('relationship')
        if not relationship:
            return None
        return relationship in ('ManyMany', 'OneMany')

    @classmethod
    def _is_valid_link_item(cls, item: Any) -> bool:
        """验证单个关联项"""
        if isinstance(item, str):
            return True
        if isinstance(item, dict) and 'id' in item:
            return True
        return False

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True

        is_multi = cls._is_multi(options)

        if is_multi is True:
            if not isinstance(value, list):
                return cls._is_valid_link_item(value)
            return all(cls._is_valid_link_item(v) for v in value)
        elif is_multi is False:
            if isinstance(value, list):
                if len(value) > 1:
                    return False
                return all(cls._is_valid_link_item(v) for v in value)
            return cls._is_valid_link_item(value)
        else:
            if isinstance(value, list):
                return all(cls._is_valid_link_item(v) for v in value)
            return cls._is_valid_link_item(value)

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Any:
        if value is None:
            return None

        is_multi = cls._is_multi(options)

        if is_multi is True:
            if isinstance(value, list):
                return [n for v in value if (n := cls._normalize_item(v)) is not None]
            item = cls._normalize_item(value)
            return [item] if item is not None else []
        elif is_multi is False:
            if isinstance(value, list):
                return cls._normalize_item(value[0]) if value else None
            return cls._normalize_item(value)
        else:
            if isinstance(value, list):
                return [n for v in value if (n := cls._normalize_item(v)) is not None]
            return cls._normalize_item(value)

    @classmethod
    def _normalize_item(cls, item: Any) -> Optional[Dict[str, Any]]:
        """标准化为 {id: str, title: str} 格式，确保 id 为字符串。
        无有效 id 时返回 None 以防脏数据落库。"""
        if item is None:
            return None
        if isinstance(item, str):
            stripped = item.strip()
            if not stripped:
                return None
            return {'id': stripped, 'title': ''}
        if isinstance(item, dict):
            raw_id = item.get('id')
            if raw_id is None:
                return None
            str_id = str(raw_id).strip()
            if not str_id:
                return None
            normalized: Dict[str, Any] = {**item}
            normalized['id'] = str_id
            normalized.setdefault('title', '')
            return normalized
        str_val = str(item).strip()
        if not str_val:
            return None
        return {'id': str_val, 'title': ''}


class ReadOnlyTimestampField(FieldType):
    """系统自动时间戳字段（created_time / last_modified_time，只读）"""

    type_name = "readonly_timestamp"

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        # 系统字段，接受 datetime 对象和 ISO 字符串
        if isinstance(value, datetime):
            return True
        if isinstance(value, str):
            try:
                datetime.fromisoformat(value.replace('Z', '+00:00'))
                return True
            except ValueError:
                return False
        return False

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        return str(value)


class ReadOnlyUserField(FieldType):
    """系统自动用户字段（created_by / last_modified_by，只读）"""

    type_name = "readonly_user"

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        # 系统字段：存储用户 ID 或用户对象
        if isinstance(value, (str, dict)):
            return True
        return False

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> Any:
        if value is None:
            return None
        return value


class LongTextField(TextField):
    """E1 / Wave 4: long text field with optional markdown support.

    Config options:
        ``format``: ``"plain"`` (default) or ``"markdown"``

    Storage is always plain text (including markdown syntax characters).
    The ``format`` option is a rendering hint for the frontend.
    """

    type_name = "long_text"

    @classmethod
    def validate(cls, value: Any, options: Optional[Dict] = None) -> bool:
        if value is None:
            return True
        if not isinstance(value, str):
            return False
        max_len = (options or {}).get('max_length', cls.MAX_TEXT_LENGTH)
        return len(value) <= max_len

    @classmethod
    def format(cls, value: Any, options: Optional[Dict] = None) -> str:
        if value is None:
            return ""
        return str(value)

    @staticmethod
    def is_markdown_enabled(config: Optional[Dict] = None) -> bool:
        if not config:
            return False
        return config.get('format') == 'markdown'


# 字段类型注册表
FIELD_TYPES = {
    # ── 基础文本 ──
    'text': TextField,
    'long_text': LongTextField,

    # ── 数值 ──
    'number': NumberField,
    'percent': PercentField,
    'currency': CurrencyField,
    'rating': RatingField,

    # ── 选择 ──
    'select': SelectField,
    'multi_select': MultiSelectField,
    'checkbox': CheckboxField,

    # ── 日期时间 ──
    'date': DateField,
    'created_time': ReadOnlyTimestampField,
    'last_modified_time': ReadOnlyTimestampField,

    # ── 链接与联系方式 ──
    'url': UrlField,
    'email': EmailField,
    'phone': PhoneField,

    # ── 用户 ──
    'user': UserField,
    'created_by': ReadOnlyUserField,
    'last_modified_by': ReadOnlyUserField,

    # ── 文件 ──
    'attachment': AttachmentField,

    # ── 关联字段 ──
    'link': LinkField,
}


def get_field_type(type_name: str) -> Optional[FieldType]:
    """
    获取字段类型处理器

    Args:
        type_name: 字段类型名称

    Returns:
        字段类型处理器类
    """
    return FIELD_TYPES.get(type_name)


FIELD_TYPE_LABELS: Dict[str, str] = {
    'text': '文本',
    'long_text': '多行文本',
    'number': '数字',
    'percent': '百分比',
    'currency': '货币',
    'rating': '评分',
    'select': '单选',
    'multi_select': '多选',
    'checkbox': '勾选框',
    'date': '日期',
    'created_time': '创建时间',
    'last_modified_time': '最后修改时间',
    'url': 'URL',
    'email': '邮箱',
    'phone': '电话',
    'attachment': '附件',
    'user': '用户',
    'created_by': '创建人',
    'last_modified_by': '最后修改人',
    'link': '关联',
}


def get_field_type_label(type_name: str) -> str:
    return FIELD_TYPE_LABELS.get(type_name, type_name)


def validate_field_value(type_name: str, value: Any, options: Optional[Dict] = None) -> bool:
    """
    验证字段值

    Args:
        type_name: 字段类型
        value: 字段值
        options: 字段选项

    Returns:
        bool: 是否有效
    """
    field_type = get_field_type(type_name)
    if not field_type:
        return False
    return field_type.validate(value, options)


def format_field_value(type_name: str, value: Any, options: Optional[Dict] = None) -> Any:
    """
    格式化字段值

    Args:
        type_name: 字段类型
        value: 原始值
        options: 字段选项

    Returns:
        格式化后的值
    """
    field_type = get_field_type(type_name)
    if not field_type:
        return value
    return field_type.format(value, options)


def _lookup_user_by_display_name(name: str) -> Optional[Dict[str, Any]]:
    """按昵称或用户名模糊查找用户，返回 {id, name} 或 None。"""
    try:
        from django.contrib.auth import get_user_model
        _User = get_user_model()
        user = _User.objects.filter(nickname=name).first()
        if user is None:
            user = _User.objects.filter(username=name).first()
        if user is not None:
            return {'id': str(user.id), 'name': user.get_display_name()}
    except Exception:
        pass
    return None


# 期望原生 str 值、且导入时需要把非字符串单元格桥接成字符串的字段类型。
_TEXT_LIKE_IMPORT_TYPES = ('text', 'long_text', 'select', 'url', 'email', 'phone')


def _coerce_scalar_to_text(value: Any) -> Any:
    """把 Excel 读出的非字符串标量（int/float/bool/date/datetime）转成干净的字符串。

    - int：直接字符串，不带 .0
    - float：整数值去掉小数（12.0 → '12'），否则保留（1.5 → '1.5'）
    - bool：'true'/'false'，与导出端约定一致
    - date/datetime：ISO 格式
    其它类型无法安全转换时原样返回，交给字段 validate 决定。
    """
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return repr(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, (list, dict)):
        return value
    return str(value)


def deserialize_import_value(field_type: str, value: Any, options: Optional[Dict] = None) -> Any:
    """将导入文件中的原始值（通常是字符串）反序列化为字段原生类型。

    导出端 _format_cell_value() 会将 list/dict → json.dumps、bool → 'true'/'false'，
    导入端 validate_field_value() 则要求原生 list/bool/dict。
    本函数在 validate 之前调用，桥接两端的类型契约。
    """
    if value is None or value == '':
        return value

    # 文本类字段要求原生 str。Excel(openpyxl) 会把纯数字/日期单元格读成 int/float/datetime，
    # 若不桥接，TextField/SelectField 等的 isinstance(value, str) 校验会直接拒绝整列。
    if field_type in _TEXT_LIKE_IMPORT_TYPES and not isinstance(value, str):
        return _coerce_scalar_to_text(value)

    if field_type == 'multi_select' and isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
        except (ValueError, TypeError):
            pass
        return [v.strip() for v in value.split(',') if v.strip()]

    if field_type == 'checkbox' and isinstance(value, str):
        return value.lower() in CheckboxField._TRUTHY_STRINGS

    if field_type == 'link' and isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, (list, dict)):
                return parsed
        except (ValueError, TypeError):
            pass
        stripped = value.strip()
        if not stripped:
            return []
        try:
            uuid.UUID(stripped)
            return [{'id': stripped}]
        except (ValueError, TypeError):
            return []

    if field_type == 'user' and isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, (dict, list)):
                return parsed
        except (ValueError, TypeError):
            pass
        stripped = value.strip()
        if stripped:
            matched_user = _lookup_user_by_display_name(stripped)
            if matched_user is not None:
                return matched_user

    if field_type == 'percent' and isinstance(value, str):
        stripped = value.strip()
        if stripped:
            has_pct = stripped.endswith('%')
            numeric_str = stripped.rstrip('%').strip().replace(',', '')
            try:
                num = float(numeric_str)
                return num / 100.0 if has_pct else num
            except (ValueError, TypeError):
                pass
        return value

    if field_type == 'currency' and isinstance(value, str):
        stripped = value.strip()
        if stripped:
            numeric_str = re.sub(r'^[^\d.+-]+|[^\d.+-]+$', '', stripped.replace(',', ''))
            if numeric_str:
                try:
                    return float(numeric_str)
                except (ValueError, TypeError):
                    pass
        return value

    if field_type in ('number', 'rating') and isinstance(value, str):
        value_stripped = value.strip()
        if value_stripped:
            locale_parsed = NumberField.parse_locale_number(value_stripped)
            if locale_parsed is not None:
                return locale_parsed
            try:
                return int(value_stripped) if '.' not in value_stripped else float(value_stripped)
            except (ValueError, TypeError):
                pass
        return value

    if field_type == 'date' and isinstance(value, str):
        value_stripped = value.strip()
        if value_stripped:
            if _date_options_preserve_time(options) and _string_carries_time(value_stripped):
                try:
                    return datetime.fromisoformat(value_stripped.replace('Z', '+00:00'))
                except ValueError:
                    pass
                try:
                    from dateutil.parser import parse as _dateutil_parse
                    return _dateutil_parse(value_stripped)
                except Exception:
                    pass
            for fmt in ('%Y-%m-%d', '%Y/%m/%d', '%m/%d/%Y', '%d-%m-%Y', '%d/%m/%Y',
                        '%Y.%m.%d', '%Y年%m月%d日'):
                try:
                    return datetime.strptime(value_stripped, fmt).date()
                except ValueError:
                    continue
            try:
                from dateutil.parser import parse as _dateutil_parse
                return _dateutil_parse(value_stripped).date()
            except Exception:
                pass
        return value

    if field_type == 'attachment' and isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
            if isinstance(parsed, dict):
                return [parsed]
            return []
        except (ValueError, TypeError):
            pass
        stripped = value.strip()
        if not stripped:
            return []
        parts = [p.strip() for p in re.split(r'[,\n]', stripped) if p.strip()]
        items = []
        for part in parts:
            if part.startswith(('http://', 'https://', '//')):
                name = part.rsplit('/', 1)[-1].split('?', 1)[0] or part
                items.append({'name': name, 'url': part})
            else:
                items.append({'name': part, 'url': ''})
        return items

    return value
