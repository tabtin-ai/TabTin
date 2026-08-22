"""
迁移助手 - 将现有错误消息迁移到i18n系统

使用方法：
    from apps.i18n.migration_helper import migrate_error_response

    # 旧代码
    return {"success": False, "code": "NOT_FOUND", "message": "表格不存在"}

    # 新代码（向后兼容）
    return migrate_error_response("NOT_FOUND", "resource.table_not_found")
"""

from typing import Any, Optional
from .response import success_response, error_response
from .error_mapping import get_i18n_key_for_error_code


def migrate_success_response(
    data: Any = None,
    legacy_message: str = "操作成功",
    message_key: Optional[str] = None
) -> dict:
    """
    迁移成功响应

    Args:
        data: 响应数据
        legacy_message: 旧的中文消息（向后兼容）
        message_key: 翻译键（新方式）

    Returns:
        标准响应
    """
    if message_key:
        return success_response(data=data, message_key=message_key)
    else:
        # 向后兼容：使用旧消息
        return success_response(data=data, message=legacy_message)


def migrate_error_response(
    code: str,
    message_key: Optional[str] = None,
    legacy_message: Optional[str] = None,
    status_code: int = 400,
    **kwargs
) -> dict:
    """
    迁移错误响应

    Args:
        code: 错误代码
        message_key: 翻译键（新方式）
        legacy_message: 旧的中文消息（向后兼容）
        status_code: HTTP状态码
        **kwargs: 翻译参数

    Returns:
        标准响应
    """
    # 如果没有提供message_key，尝试从错误代码映射
    if not message_key:
        message_key = get_i18n_key_for_error_code(code)

    if message_key and message_key != "common.error":
        # 使用翻译
        return error_response(
            code=code,
            message_key=message_key,
            status_code=status_code,
            **kwargs
        )
    else:
        # 向后兼容：使用旧消息
        return error_response(
            code=code,
            message=legacy_message or "操作失败",
            status_code=status_code
        )

