"""
API 响应辅助工具 — DEPRECATED

此模块已迁移到 apps.i18n.response。
保留此文件仅为向后兼容，新代码请直接导入 apps.i18n.response。
"""
import warnings as _warnings

from apps.i18n.response import (  # noqa: F401
    success_response,
    error_response_with_status as error_response,
    not_found_response,
    permission_denied_response,
    validation_error_response,
)

_warnings.warn(
    "apps.tabtinspace.api_helpers is deprecated, use apps.i18n.response instead",
    DeprecationWarning,
    stacklevel=2,
)
