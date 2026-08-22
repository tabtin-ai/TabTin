"""公开写入口可创建字段的产品契约。"""

from collections.abc import Iterable


UI_CREATABLE_FIELD_TYPES = frozenset({
    'text', 'long_text',
    'number', 'percent', 'currency', 'rating',
    'select', 'multi_select', 'checkbox',
    'date',
    'url', 'email', 'phone',
    'user',
    'attachment',
    'link',
})


def validate_ui_creatable_field_type(field_type: str) -> str | None:
    """返回用户可见字段创建契约的校验错误，合法时返回 ``None``。"""
    if field_type in UI_CREATABLE_FIELD_TYPES:
        return None
    return (
        f'不支持的字段类型: "{field_type}"'
    )


def validate_ui_creatable_field_types(field_types: Iterable[str]) -> str | None:
    """批量入口在写入前全量校验，避免部分字段已落库。"""
    for index, field_type in enumerate(field_types):
        error = validate_ui_creatable_field_type(field_type)
        if error:
            return f'第 {index + 1} 个字段：{error}'
    return None
