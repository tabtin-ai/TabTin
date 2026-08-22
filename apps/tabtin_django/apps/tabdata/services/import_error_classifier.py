"""导入错误分类器 — 将原始错误字符串结构化为类型化错误对象。"""

import re
from collections import Counter
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional


class ImportErrorType(str, Enum):
    TYPE_MISMATCH = "type_mismatch"
    NULL_VIOLATION = "null_violation"
    UNIQUE_VIOLATION = "unique_violation"
    FORMAT_ERROR = "format_error"
    COLUMN_MISMATCH = "column_mismatch"
    TABLE_NOT_FOUND = "table_not_found"
    PERMISSION_DENIED = "permission_denied"
    VALIDATION_ERROR = "validation_error"
    ROW_LIMIT = "row_limit"
    FIELD_LIMIT = "field_limit"
    UNKNOWN = "unknown"


_ROW_PATTERN = re.compile(r"(?:第\s*(\d+)\s*行|[Rr]ow\s*(\d+)|[Ll]ine\s*(\d+))")
_FIELD_PATTERN = re.compile(r"字段['\u2018\u2019\u0060\"]([^''\u2018\u2019\u0060\"]+)['\u2018\u2019\u0060\"]")

_TYPE_KEYWORDS = (
    ("目标表不存在", ImportErrorType.TABLE_NOT_FOUND),
    ("table not found", ImportErrorType.TABLE_NOT_FOUND),
    ("表不存在", ImportErrorType.TABLE_NOT_FOUND),

    ("无权限", ImportErrorType.PERMISSION_DENIED),
    ("权限", ImportErrorType.PERMISSION_DENIED),
    ("permission denied", ImportErrorType.PERMISSION_DENIED),
    ("access denied", ImportErrorType.PERMISSION_DENIED),

    ("类型", ImportErrorType.TYPE_MISMATCH),
    ("转换", ImportErrorType.TYPE_MISMATCH),
    ("无法转换", ImportErrorType.TYPE_MISMATCH),
    ("type mismatch", ImportErrorType.TYPE_MISMATCH),
    ("cannot convert", ImportErrorType.TYPE_MISMATCH),

    ("不能为空", ImportErrorType.NULL_VIOLATION),
    ("必填", ImportErrorType.NULL_VIOLATION),
    ("为空", ImportErrorType.NULL_VIOLATION),
    ("缺少必填", ImportErrorType.NULL_VIOLATION),
    ("required", ImportErrorType.NULL_VIOLATION),
    ("not null", ImportErrorType.NULL_VIOLATION),
    ("null", ImportErrorType.NULL_VIOLATION),

    ("重复", ImportErrorType.UNIQUE_VIOLATION),
    ("唯一", ImportErrorType.UNIQUE_VIOLATION),
    ("主键", ImportErrorType.UNIQUE_VIOLATION),
    ("duplicate", ImportErrorType.UNIQUE_VIOLATION),
    ("unique", ImportErrorType.UNIQUE_VIOLATION),
    ("primary key", ImportErrorType.UNIQUE_VIOLATION),

    ("格式化失败", ImportErrorType.FORMAT_ERROR),
    ("格式", ImportErrorType.FORMAT_ERROR),
    ("日期格式", ImportErrorType.FORMAT_ERROR),
    ("无效", ImportErrorType.FORMAT_ERROR),
    ("invalid", ImportErrorType.FORMAT_ERROR),
    ("format", ImportErrorType.FORMAT_ERROR),
    ("没有数据", ImportErrorType.FORMAT_ERROR),
    ("文件为空", ImportErrorType.FORMAT_ERROR),
    ("不支持的文件类型", ImportErrorType.FORMAT_ERROR),
    ("不支持", ImportErrorType.FORMAT_ERROR),
    ("unsupported", ImportErrorType.FORMAT_ERROR),
    ("empty file", ImportErrorType.FORMAT_ERROR),
    ("no data", ImportErrorType.FORMAT_ERROR),

    ("没有字段", ImportErrorType.COLUMN_MISMATCH),
    ("没有可导入", ImportErrorType.COLUMN_MISMATCH),
    ("有效字段", ImportErrorType.COLUMN_MISMATCH),
    ("列数", ImportErrorType.COLUMN_MISMATCH),
    ("列不匹配", ImportErrorType.COLUMN_MISMATCH),
    ("column mismatch", ImportErrorType.COLUMN_MISMATCH),
    ("no valid", ImportErrorType.COLUMN_MISMATCH),

    ("验证", ImportErrorType.VALIDATION_ERROR),
    ("验证规则", ImportErrorType.VALIDATION_ERROR),
    ("validation", ImportErrorType.VALIDATION_ERROR),

    ("最多支持", ImportErrorType.ROW_LIMIT),
    ("行数限制", ImportErrorType.ROW_LIMIT),
    ("row limit", ImportErrorType.ROW_LIMIT),

    ("字段数限制", ImportErrorType.FIELD_LIMIT),
    ("field limit", ImportErrorType.FIELD_LIMIT),
)


@dataclass
class ClassifiedError:
    type: ImportErrorType
    row: Optional[int]
    field_name: Optional[str]
    message: str
    raw_message: str

    def to_dict(self) -> dict:
        return {
            "type": self.type.value,
            "row": self.row,
            "field_name": self.field_name,
            "message": self.message,
        }


def classify_import_error(raw: str) -> ClassifiedError:
    """将原始错误字符串分类为 ClassifiedError。"""
    row_match = _ROW_PATTERN.search(raw)
    row = int(row_match.group(1) or row_match.group(2) or row_match.group(3)) if row_match else None

    field_match = _FIELD_PATTERN.search(raw)
    field_name = field_match.group(1) if field_match else None

    lower = raw.lower()
    error_type = ImportErrorType.UNKNOWN
    for keyword, etype in _TYPE_KEYWORDS:
        if keyword in lower:
            error_type = etype
            break

    colon_idx = raw.rfind(": ")
    if colon_idx == -1:
        colon_idx = raw.rfind("：")
    message = raw[colon_idx + 2:].strip() if colon_idx != -1 else raw

    return ClassifiedError(
        type=error_type,
        row=row,
        field_name=field_name,
        message=message,
        raw_message=raw,
    )


def build_error_summary(errors: List[ClassifiedError]) -> Dict[str, int]:
    """按 ImportErrorType 聚合计数。"""
    counts = Counter(e.type.value for e in errors)
    return dict(counts)
