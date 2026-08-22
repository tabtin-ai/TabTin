"""
TabData 错误码定义

统一的错误码管理,方便前端处理和国际化。

通用错误码从 apps.services.common.error_codes 导入并 re-export，
TabData 特有的错误码在本文件中定义。
"""

from apps.services.common.error_codes import (  # noqa: F401 — re-export for backward compat
    CommonErrorCode,
    CommonErrorMessage,
    get_error_response as _common_get_error_response,
    get_success_response as _common_get_success_response,
)


class ErrorCode(CommonErrorCode):
    """
    TabData 错误码常量

    继承自 CommonErrorCode，包含所有通用错误码 + TabData 特有错误码。
    现有代码的 ErrorCode.XXX 引用无需修改。
    """

    # 资源不存在错误 (3000-3999) — TabData 特有
    NOT_FOUND = "NOT_FOUND"
    TABLE_NOT_FOUND = "TABLE_NOT_FOUND"
    FIELD_NOT_FOUND = "FIELD_NOT_FOUND"
    RECORD_NOT_FOUND = "RECORD_NOT_FOUND"

    # 业务逻辑错误 (4000-4999)
    ORGANIZATION_DELETE_DENIED = "ORGANIZATION_DELETE_DENIED"
    DEFAULT_ORGANIZATION_DELETE_DENIED = "DEFAULT_ORGANIZATION_DELETE_DENIED"
    PERSONAL_ORGANIZATION_NOT_ALLOWED = "PERSONAL_ORGANIZATION_NOT_ALLOWED"
    PRIMARY_FIELD_DELETE_DENIED = "PRIMARY_FIELD_DELETE_DENIED"
    PRIMARY_FIELD_REQUIRED = "PRIMARY_FIELD_REQUIRED"
    PRIMARY_FIELD_TYPE_INVALID = "PRIMARY_FIELD_TYPE_INVALID"
    PRIMARY_FIELD_CONVERSION_DENIED = "PRIMARY_FIELD_CONVERSION_DENIED"
    FIELD_REQUIRED = "FIELD_REQUIRED"
    INVALID_FIELD_TYPE = "INVALID_FIELD_TYPE"
    INVALID_FIELD_VALUE = "INVALID_FIELD_VALUE"
    INVALID_SELECT_OPTION = "INVALID_SELECT_OPTION"
    DUPLICATE_MEMBER = "DUPLICATE_MEMBER"
    OWNER_CANNOT_LEAVE = "OWNER_CANNOT_LEAVE"
    OWNER_CANNOT_BE_REMOVED = "OWNER_CANNOT_BE_REMOVED"
    REFRESH_TASK_NOT_FOUND = "REFRESH_TASK_NOT_FOUND"
    REFRESH_TASK_ERROR = "REFRESH_TASK_ERROR"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"

    # 操作限制错误 (5000-5999)
    BULK_SIZE_EXCEEDED = "BULK_SIZE_EXCEEDED"
    RECORD_SIZE_EXCEEDED = "RECORD_SIZE_EXCEEDED"
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"

    # 并发冲突错误 (7000-7999)
    SCHEMA_VERSION_CONFLICT = "SCHEMA_VERSION_CONFLICT"

    # Agent SQL 错误 (6000-6999)
    SQL_FORBIDDEN = "SQL_FORBIDDEN"
    SQL_SCHEMA_VIOLATION = "SQL_SCHEMA_VIOLATION"
    SQL_NAME_RESOLUTION_FAILED = "SQL_NAME_RESOLUTION_FAILED"
    SQL_WRITE_UNSAFE = "SQL_WRITE_UNSAFE"
    SQL_EXECUTION_ERROR = "SQL_EXECUTION_ERROR"

    # 撤销/重做 (7000-7999)
    UNDO_FAILED = "UNDO_FAILED"
    REDO_FAILED = "REDO_FAILED"
    # 栈为空（"没有可撤销/重做的操作"）——与执行失败区分：前端展示中性提示，
    # 不落到"撤销失败"这种误导性文案。
    NO_UNDO_OPERATIONS = "NO_UNDO_OPERATIONS"
    NO_REDO_OPERATIONS = "NO_REDO_OPERATIONS"
    RESTORE_FAILED = "RESTORE_FAILED"
    # C1 / Wave 1.3：复杂字段类型 undo 走 409，引导用户用字段回收站（W1.4 提示）
    FIELD_RESTORE_NOT_SUPPORTED = "FIELD_RESTORE_NOT_SUPPORTED"
    # C3 / Wave 1.3：删表后 schema_version_token 漂移，Celery worker 校验失败
    TABLE_SCHEMA_TOKEN_MISMATCH = "TABLE_SCHEMA_TOKEN_MISMATCH"

    # 数据库层错误 (7500-7999)
    DB_SCHEMA_ERROR = "DB_SCHEMA_ERROR"

    # API Token (8000-8999)
    INVALID_SCOPE = "INVALID_SCOPE"
    INVALID_SCOPE_PRESET = "INVALID_SCOPE_PRESET"
    TOKEN_LIMIT_EXCEEDED = "TOKEN_LIMIT_EXCEEDED"

    # 字段转换 (8500-8999)
    FIELD_CONVERSION_FAILED = "FIELD_CONVERSION_FAILED"

    # A3 update-by-filter (10000-10099)
    A3_COMMIT_MISSING_CONFIRM = "A3_COMMIT_MISSING_CONFIRM"
    A3_COMMIT_MALFORMED = "A3_COMMIT_MALFORMED"
    A3_COMMIT_BAD_SIGNATURE = "A3_COMMIT_BAD_SIGNATURE"
    A3_COMMIT_EXPIRED = "A3_COMMIT_EXPIRED"
    A3_COMMIT_SCHEMA_UNKNOWN = "A3_COMMIT_SCHEMA_UNKNOWN"
    A3_COMMIT_USER_MISMATCH = "A3_COMMIT_USER_MISMATCH"
    A3_COMMIT_SPACE_MISMATCH = "A3_COMMIT_SPACE_MISMATCH"
    A3_COMMIT_TABLE_MISMATCH = "A3_COMMIT_TABLE_MISMATCH"
    A3_COMMIT_TABLE_CHANGED = "A3_COMMIT_TABLE_CHANGED"
    A3_COMMIT_FILTER_CHANGED = "A3_COMMIT_FILTER_CHANGED"
    A3_COMMIT_PATCH_CHANGED = "A3_COMMIT_PATCH_CHANGED"
    A3_COMMIT_PERMISSION_CHANGED = "A3_COMMIT_PERMISSION_CHANGED"
    A3_COMMIT_ALREADY_DONE = "A3_COMMIT_ALREADY_DONE"
    A3_COMMIT_PREVIOUSLY_FAILED = "A3_COMMIT_PREVIOUSLY_FAILED"
    A3_COMMIT_DRIFT_TOO_LARGE = "A3_COMMIT_DRIFT_TOO_LARGE"
    A3_PREFLIGHT_MATCH_TOO_LARGE = "A3_PREFLIGHT_MATCH_TOO_LARGE"
    A3_COMMIT_SERVICE_UNAVAILABLE = "A3_COMMIT_SERVICE_UNAVAILABLE"
    # W2.perf-fix2 / 三视角 Review:A3 防御性校验
    A3_PREFLIGHT_EMPTY_FILTER = "A3_PREFLIGHT_EMPTY_FILTER"
    A3_PREFLIGHT_EMPTY_PATCH = "A3_PREFLIGHT_EMPTY_PATCH"
    A3_PREFLIGHT_TABLE_ARCHIVED = "A3_PREFLIGHT_TABLE_ARCHIVED"
    A3_PREFLIGHT_UNSUPPORTED_FIELD = "A3_PREFLIGHT_UNSUPPORTED_FIELD"
    A3_PREFLIGHT_UNKNOWN_FIELD = "A3_PREFLIGHT_UNKNOWN_FIELD"
    # W3.0c / G3:A3 整体一键关闭(SQL 注入紧急情况)
    A3_FEATURE_DISABLED = "A3_FEATURE_DISABLED"

    # 操作不支持 (9000-9999)
    UNSUPPORTED = "UNSUPPORTED"

    # 表单视图 (9100-9199)
    FORM_NOT_FOUND = "FORM_NOT_FOUND"
    FORM_EXPIRED = "FORM_EXPIRED"
    FORM_PASSWORD_INCORRECT = "FORM_PASSWORD_INCORRECT"
    FORM_SUBMIT_FAILED = "FORM_SUBMIT_FAILED"
    LOGIN_REQUIRED = "LOGIN_REQUIRED"


class ErrorMessage:
    """错误消息模板"""

    _CODE_TO_I18N = {
        **CommonErrorMessage._CODE_TO_I18N,
        ErrorCode.NOT_FOUND: "resource.not_found",
        ErrorCode.TABLE_NOT_FOUND: "resource.table_not_found",
        ErrorCode.FIELD_NOT_FOUND: "resource.field_not_found",
        ErrorCode.RECORD_NOT_FOUND: "resource.record_not_found",
        ErrorCode.ORGANIZATION_DELETE_DENIED: "business.organization_delete_denied",
        ErrorCode.DEFAULT_ORGANIZATION_DELETE_DENIED: "business.default_organization_delete_denied",
        ErrorCode.PRIMARY_FIELD_DELETE_DENIED: "business.primary_field_delete_denied",
        ErrorCode.PRIMARY_FIELD_REQUIRED: "business.primary_field_required",
        ErrorCode.PRIMARY_FIELD_TYPE_INVALID: "business.primary_field_type_invalid",
        ErrorCode.PRIMARY_FIELD_CONVERSION_DENIED: "tabdata.primary_field_conversion_denied",
        ErrorCode.FIELD_REQUIRED: "validation.field_required",
        ErrorCode.INVALID_FIELD_TYPE: "validation.invalid_field_type",
        ErrorCode.INVALID_FIELD_VALUE: "validation.invalid_field_value",
        ErrorCode.INVALID_SELECT_OPTION: "tabdata.invalid_select_option",
        ErrorCode.DUPLICATE_MEMBER: "business.duplicate_member",
        ErrorCode.OWNER_CANNOT_LEAVE: "business.owner_cannot_leave",
        ErrorCode.OWNER_CANNOT_BE_REMOVED: "business.owner_cannot_be_removed",
        ErrorCode.REFRESH_TASK_NOT_FOUND: "tabdata.refresh_task_not_found",
        ErrorCode.REFRESH_TASK_ERROR: "tabdata.refresh_task_error",
        ErrorCode.QUOTA_EXCEEDED: "common.quota_exceeded",
        ErrorCode.BULK_SIZE_EXCEEDED: "tabdata.bulk_size_exceeded",
        ErrorCode.RECORD_SIZE_EXCEEDED: "tabdata.record_size_exceeded",
        ErrorCode.RATE_LIMIT_EXCEEDED: "middleware.rate_limited",
        ErrorCode.SQL_FORBIDDEN: "tabdata.sql_forbidden",
        ErrorCode.SQL_SCHEMA_VIOLATION: "tabdata.sql_schema_violation",
        ErrorCode.SQL_NAME_RESOLUTION_FAILED: "tabdata.sql_name_resolution_failed",
        ErrorCode.SQL_WRITE_UNSAFE: "tabdata.sql_write_unsafe",
        ErrorCode.SQL_EXECUTION_ERROR: "tabdata.sql_execution_error",
        ErrorCode.UNDO_FAILED: "tabdata.undo_failed",
        ErrorCode.REDO_FAILED: "tabdata.redo_failed",
        ErrorCode.RESTORE_FAILED: "tabdata.restore_failed",
        ErrorCode.FIELD_RESTORE_NOT_SUPPORTED: "tabdata.field_restore_not_supported",
        ErrorCode.TABLE_SCHEMA_TOKEN_MISMATCH: "tabdata.table_schema_token_mismatch",
        ErrorCode.DB_SCHEMA_ERROR: "tabdata.db_schema_error",
        ErrorCode.INVALID_SCOPE: "tabdata.invalid_scope",
        ErrorCode.INVALID_SCOPE_PRESET: "tabdata.invalid_scope_preset",
        ErrorCode.TOKEN_LIMIT_EXCEEDED: "tabdata.token_limit_exceeded",
        ErrorCode.FIELD_CONVERSION_FAILED: "tabdata.field_conversion_failed",
        ErrorCode.UNSUPPORTED: "tabdata.unsupported",
        # W2.perf-fix2 / 三视角 Review:A3 防御性校验
        ErrorCode.A3_PREFLIGHT_EMPTY_FILTER: "tabdata.a3_preflight_empty_filter",
        ErrorCode.A3_PREFLIGHT_EMPTY_PATCH: "tabdata.a3_preflight_empty_patch",
        ErrorCode.A3_PREFLIGHT_TABLE_ARCHIVED: "tabdata.a3_preflight_table_archived",
        ErrorCode.A3_PREFLIGHT_UNSUPPORTED_FIELD: "tabdata.a3_preflight_unsupported_field",
        ErrorCode.A3_PREFLIGHT_UNKNOWN_FIELD: "tabdata.a3_preflight_unknown_field",
        ErrorCode.A3_FEATURE_DISABLED: "tabdata.a3_feature_disabled",
    }

    MESSAGES = {
        ErrorCode.SUCCESS: "操作成功",
        ErrorCode.UNKNOWN_ERROR: "未知错误",
        ErrorCode.INTERNAL_ERROR: "服务器内部错误: {detail}",
        ErrorCode.INVALID_REQUEST: "请求参数无效",
        ErrorCode.VALIDATION_ERROR: "数据验证失败: {detail}",
        ErrorCode.UNAUTHORIZED: "请先登录",
        ErrorCode.TOKEN_EXPIRED: "登录已过期,请重新登录",
        ErrorCode.TOKEN_INVALID: "登录凭证无效",
        ErrorCode.PERMISSION_DENIED: "您没有权限执行此操作",
        ErrorCode.NOT_FOUND: "资源不存在",
        ErrorCode.ORGANIZATION_NOT_FOUND: "组织不存在",
        ErrorCode.PROJECT_NOT_FOUND: "项目不存在",
        ErrorCode.TABLE_NOT_FOUND: "表格不存在",
        ErrorCode.FIELD_NOT_FOUND: "字段不存在",
        ErrorCode.RECORD_NOT_FOUND: "记录不存在",
        ErrorCode.ORGANIZATION_DELETE_DENIED: "无法删除组织,只有所有者可以删除",
        ErrorCode.DEFAULT_ORGANIZATION_DELETE_DENIED: "无法删除默认组织",
        ErrorCode.PRIMARY_FIELD_DELETE_DENIED: "主键字段不允许删除",
        ErrorCode.PRIMARY_FIELD_REQUIRED: "主键字段必须是必填的",
        ErrorCode.PRIMARY_FIELD_TYPE_INVALID: "主键字段类型 '{field_type}' 不被支持，只允许使用：text, number, select, url, email, phone",
        ErrorCode.PRIMARY_FIELD_CONVERSION_DENIED: "主键字段不能转换为 '{target_type}' 类型，只允许转换为：text, number, select, url, email, phone",
        ErrorCode.FIELD_REQUIRED: "字段 '{field_name}' 是必填的",
        ErrorCode.INVALID_FIELD_TYPE: "字段 '{field_name}' 的类型不正确",
        ErrorCode.INVALID_FIELD_VALUE: "字段 '{field_name}' 的值不符合要求",
        ErrorCode.INVALID_SELECT_OPTION: "选项值 '{value}' 不在可选范围内",
        ErrorCode.DUPLICATE_MEMBER: "用户已经是组织成员",
        ErrorCode.OWNER_CANNOT_LEAVE: "所有者不能离开自己的组织",
        ErrorCode.OWNER_CANNOT_BE_REMOVED: "不能移除组织所有者",
        ErrorCode.REFRESH_TASK_NOT_FOUND: "刷新任务不存在",
        ErrorCode.REFRESH_TASK_ERROR: "刷新任务处理失败: {detail}",
        ErrorCode.QUOTA_EXCEEDED: "配额不足: {detail}",
        ErrorCode.BULK_SIZE_EXCEEDED: "批量操作最多支持 {max_size} 条记录",
        ErrorCode.RECORD_SIZE_EXCEEDED: "记录数据过大,最大支持 {max_size} KB",
        ErrorCode.RATE_LIMIT_EXCEEDED: "操作过于频繁,请稍后再试",
        ErrorCode.SQL_FORBIDDEN: "SQL 语句类型不被允许: {detail}",
        ErrorCode.SQL_SCHEMA_VIOLATION: "SQL 引用了项目外的表: {detail}",
        ErrorCode.SQL_NAME_RESOLUTION_FAILED: "名称解析失败: {detail}",
        ErrorCode.SQL_WRITE_UNSAFE: "写入操作不安全: {detail}",
        ErrorCode.SQL_EXECUTION_ERROR: "SQL 执行错误: {detail}",
        ErrorCode.UNDO_FAILED: "撤销失败",
        ErrorCode.REDO_FAILED: "重做失败",
        ErrorCode.NO_UNDO_OPERATIONS: "没有可撤销的操作",
        ErrorCode.NO_REDO_OPERATIONS: "没有可重做的操作",
        ErrorCode.RESTORE_FAILED: "还原失败：历史记录已过期或被清理",
        # W0-7 c5 §3.1:用「无法撤销删除」+「版本时间线还原 / 联系管理员」三段式
        # 行动指引必须可达——本期不承诺"字段回收站"(属 Wave 2/3 字段回收站能力)
        # W3.0c 三视角 Review:zh 文案统一用「版本时间线」(c5 §3.4 推荐),
        # 与 i18n 词条 ``field_restore_type_disabled`` 保持术语一致。
        ErrorCode.FIELD_RESTORE_NOT_SUPPORTED: (
            "无法撤销删除「{field_name}」({field_type} 字段):{reason}。"
            "本次撤销整体未生效,删除的字段保持已删除状态。"
            "请在「版本时间线」中还原到删除前的版本,"
            "或联系组织管理员从备份恢复。"
        ),
        ErrorCode.TABLE_SCHEMA_TOKEN_MISMATCH: (
            "表已被删除或结构已重置，本次后台计算任务已停止。"
        ),
        ErrorCode.DB_SCHEMA_ERROR: "数据库结构异常，请联系管理员",
        ErrorCode.INVALID_SCOPE: "Token 权限范围无效",
        ErrorCode.INVALID_SCOPE_PRESET: "Token 权限预设无效",
        ErrorCode.TOKEN_LIMIT_EXCEEDED: "Token 数量已达上限",
        ErrorCode.FIELD_CONVERSION_FAILED: "字段转换失败: {detail}",
        ErrorCode.UNSUPPORTED: "不支持的操作",
        ErrorCode.A3_PREFLIGHT_EMPTY_FILTER: (
            "必须至少提供一个筛选条件,防止误改全表。请补充 filter_clause 后重试。"
        ),
        ErrorCode.A3_PREFLIGHT_EMPTY_PATCH: (
            "patch 不能为空,请至少提供一个要更新的字段。"
        ),
        ErrorCode.A3_PREFLIGHT_TABLE_ARCHIVED: (
            "该表已归档/已删除,无法批量更新。请先恢复表或选择其他表。"
        ),
        ErrorCode.A3_PREFLIGHT_UNSUPPORTED_FIELD: (
            "字段「{field_name}」({field_type} 类型) 暂不支持 update-by-filter。"
            "link / attachment 等字段请通过单条编辑修改。"
        ),
        ErrorCode.A3_PREFLIGHT_UNKNOWN_FIELD: (
            "字段「{field_key}」不存在或已删除,请刷新表结构后重试。"
        ),
        # W3.0c / G3:A3 整体一键关闭(运维侧 export TABDATA_A3_ENABLED=False
        # 后即时生效)。文案不暴露具体原因(可能是 SQL 注入应急),仅引导用户
        # 改用单条编辑或稍后重试。
        ErrorCode.A3_FEATURE_DISABLED: (
            "「按筛选条件批量更新」功能已被运维临时关闭。"
            "请改用单条编辑,或稍后再试。"
        ),
    }

    @classmethod
    def get(cls, code: str, **kwargs) -> str:
        i18n_key = cls._CODE_TO_I18N.get(code)
        if i18n_key:
            try:
                from apps.i18n import _
                return _(i18n_key, **kwargs)
            except Exception:
                pass
        message = cls.MESSAGES.get(code, cls.MESSAGES[ErrorCode.UNKNOWN_ERROR])
        try:
            return message.format(**kwargs)
        except KeyError:
            return message


def get_error_response(code: str, message: str = None, **kwargs):
    """
    生成标准错误响应

    Args:
        code: 错误码
        message: 自定义错误消息(可选)
        **kwargs: 消息模板参数

    Returns:
        标准错误响应字典
    """
    if message is None:
        message = ErrorMessage.get(code, **kwargs)

    return {
        "success": False,
        "code": code,
        "message": message,
        "data": None
    }


def get_success_response(data=None, message: str = ""):
    """
    生成标准成功响应

    Args:
        data: 响应数据
        message: 成功消息

    Returns:
        标准成功响应字典
    """
    if not message:
        try:
            from apps.i18n import _
            message = _("common.success")
        except Exception:
            message = "操作成功"
    return {
        "success": True,
        "code": ErrorCode.SUCCESS,
        "message": message,
        "data": data
    }
