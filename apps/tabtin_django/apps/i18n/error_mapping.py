"""
错误代码映射

将现有的错误代码映射到翻译键
"""

from apps.tabdata.error_codes import ErrorCode


# 错误代码 -> 翻译键映射
ERROR_CODE_TO_I18N_KEY = {
    # 通用错误
    ErrorCode.SUCCESS: "common.success",
    ErrorCode.UNKNOWN_ERROR: "common.unknown_error",
    ErrorCode.INVALID_REQUEST: "common.invalid_request",
    ErrorCode.VALIDATION_ERROR: "common.validation_error",

    # 认证和授权
    ErrorCode.UNAUTHORIZED: "auth.unauthorized",
    ErrorCode.TOKEN_EXPIRED: "auth.token_expired",
    ErrorCode.TOKEN_INVALID: "auth.token_invalid",
    ErrorCode.PERMISSION_DENIED: "auth.permission_denied",

    # 资源不存在
    ErrorCode.ORGANIZATION_NOT_FOUND: "resource.organization_not_found",
    ErrorCode.PROJECT_NOT_FOUND: "resource.project_not_found",
    ErrorCode.TABLE_NOT_FOUND: "resource.table_not_found",
    ErrorCode.FIELD_NOT_FOUND: "resource.field_not_found",
    ErrorCode.RECORD_NOT_FOUND: "resource.record_not_found",

    # 业务逻辑
    ErrorCode.ORGANIZATION_DELETE_DENIED: "business.organization_delete_denied",
    ErrorCode.DEFAULT_ORGANIZATION_DELETE_DENIED: "business.default_organization_delete_denied",
    ErrorCode.PERSONAL_ORGANIZATION_NOT_ALLOWED: "business.personal_organization_not_allowed",
    ErrorCode.PRIMARY_FIELD_DELETE_DENIED: "business.primary_field_delete_denied",
    ErrorCode.PRIMARY_FIELD_REQUIRED: "business.primary_field_required",
    ErrorCode.PRIMARY_FIELD_TYPE_INVALID: "business.primary_field_type_invalid",
    ErrorCode.DUPLICATE_MEMBER: "business.duplicate_member",
    ErrorCode.OWNER_CANNOT_LEAVE: "business.owner_cannot_leave",
    ErrorCode.OWNER_CANNOT_BE_REMOVED: "business.owner_cannot_be_removed",

    # 验证
    ErrorCode.FIELD_REQUIRED: "validation.field_required",
    ErrorCode.INVALID_FIELD_TYPE: "validation.invalid_field_type",
    ErrorCode.INVALID_FIELD_VALUE: "validation.invalid_field_value",
}


def get_i18n_key_for_error_code(error_code: str) -> str:
    """
    获取错误代码对应的翻译键

    Args:
        error_code: 错误代码

    Returns:
        翻译键
    """
    return ERROR_CODE_TO_I18N_KEY.get(error_code, "common.error")

