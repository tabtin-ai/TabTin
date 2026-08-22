"""
tabdata 业务异常定义
"""


class TruncatedSnapshotError(ValueError):
    """快照因行数超限被截断，恢复会导致被截断的记录被永久删除。

    由 restore_from_snapshot 在检测到 is_truncated 或
    total_records > len(snapshot_records) 时抛出，
    供 TableCollabAdapter.restore() 精确捕获并 fallback 到
    RecordHistory 回放恢复。
    """


class SchemaVersionMismatchError(Exception):
    """字段结构版本冲突：客户端期望的 schema_version 与服务端不一致。

    通常发生在两用户并发修改字段结构时，后到达的请求应该返回 409，
    提示用户刷新后重试，而不是静默覆盖。

    Attributes:
        message: 人类可读的错误描述
        current_version: 服务端当前的 schema_version
        expected_version: 客户端期望的 schema_version
    """

    def __init__(
        self,
        message: str = "字段结构已被他人修改，请刷新后重试",
        current_version: int | None = None,
        expected_version: int | None = None,
    ):
        super().__init__(message)
        self.current_version = current_version
        self.expected_version = expected_version


class RecordVersionConflictError(RuntimeError):
    """A record changed after the caller read the version used for a CAS write."""

    def __init__(self, record_id, expected_version: int):
        self.record_id = record_id
        self.expected_version = expected_version
        super().__init__(
            f"并发冲突：记录 {record_id} 版本已变更"
            f"（期望 version={expected_version}），删除被拒绝"
        )


class PrimaryFieldDeleteError(ValueError):
    """主字段禁止删除"""
    pass


# ── A3 confirm_token 异常 ─────────────────────────────────────────


class ConfirmTokenError(Exception):
    """A3 confirm_token 异常基类。

    Attributes:
        code: 机器可读错误码（对应 i18n key）
        http_status: 建议 HTTP 状态码
    """

    code: str = "a3.commit.unknown"
    http_status: int = 400

    def __init__(self, message: str = "", **kwargs):
        super().__init__(message)
        for k, v in kwargs.items():
            setattr(self, k, v)


class ConfirmTokenMalformed(ConfirmTokenError):
    code = "a3.commit.malformed_confirm"
    http_status = 400


class ConfirmTokenBadSignature(ConfirmTokenError):
    code = "a3.commit.bad_signature"
    http_status = 403


class ConfirmTokenExpired(ConfirmTokenError):
    code = "a3.commit.expired"
    http_status = 410

    def __init__(self, issued_at: int = 0, expires_at: int = 0, **kwargs):
        super().__init__(f"token expired (issued={issued_at}, expires={expires_at})", **kwargs)
        self.issued_at = issued_at
        self.expires_at = expires_at


class ConfirmTokenSchemaUnknown(ConfirmTokenError):
    code = "a3.commit.schema_unknown"
    http_status = 400


class ConfirmTokenUserMismatch(ConfirmTokenError):
    code = "a3.commit.user_mismatch"
    http_status = 403


class ConfirmTokenSpaceMismatch(ConfirmTokenError):
    code = "a3.commit.space_mismatch"
    http_status = 403


class ConfirmTokenTableMismatch(ConfirmTokenError):
    code = "a3.commit.table_mismatch"
    http_status = 400


class ConfirmTokenTableChanged(ConfirmTokenError):
    code = "a3.commit.table_changed"
    http_status = 409


class ConfirmTokenFilterChanged(ConfirmTokenError):
    code = "a3.commit.filter_changed"
    http_status = 409


class ConfirmTokenPatchChanged(ConfirmTokenError):
    code = "a3.commit.patch_changed"
    http_status = 409


class ConfirmTokenPermissionChanged(ConfirmTokenError):
    code = "a3.commit.permission_changed"
    http_status = 403


class ConfirmTokenReplayDetected(ConfirmTokenError):
    code = "a3.commit.already_done"
    http_status = 409


class ConfirmTokenPreviouslyFailed(ConfirmTokenError):
    code = "a3.commit.previously_failed"
    http_status = 409

    def __init__(self, previous_error: str = "", **kwargs):
        super().__init__(f"previously failed: {previous_error}", **kwargs)
        self.previous_error = previous_error


class ConfirmTokenDriftTooLarge(ConfirmTokenError):
    code = "a3.commit.drift_too_large"
    http_status = 409

    def __init__(self, expected: int = 0, actual: int = 0, ratio: float = 0.0, **kwargs):
        super().__init__(f"drift too large: expected={expected}, actual={actual}, ratio={ratio:.2%}", **kwargs)
        self.expected = expected
        self.actual = actual
        self.ratio = ratio


class ConfirmTokenMatchTooLarge(ConfirmTokenError):
    code = "a3.preflight.match_too_large"
    http_status = 400

    def __init__(self, matched_total: int = 0, hard_limit: int = 10000, **kwargs):
        super().__init__(f"matched_total={matched_total} exceeds hard_limit={hard_limit}", **kwargs)
        self.matched_total = matched_total
        self.hard_limit = hard_limit


class ConfirmTokenRedisUnavailable(ConfirmTokenError):
    code = "a3.commit.service_unavailable"
    http_status = 503


class RLSAccessDenied(PermissionError):
    """行级安全策略拒绝访问。

    区分于 404（记录不存在）：记录存在但当前用户/Token 的 RLS 策略不允许访问。
    """
    pass


class FieldRestoreNotSupportedError(Exception):
    """C1 / Wave 1.3：字段类型不在本期"可撤销白名单"内，undo 时返回 409。

    Wave 1 仅支持 11 种简单类型的字段 undo（text/number/select/multi_select/
    date/checkbox/rating/url/email/phone/attachment）。
    关联字段需要重建依赖图、对称字段、Symmetric
    Link、Reference Graph 等多链路联动，统一推迟到 Wave 2 / 字段回收站能力。

    本异常被 :class:`UndoRedoService` 捕获后返回:

    - ``ErrorCode.FIELD_RESTORE_NOT_SUPPORTED`` （新增码）
    - HTTP 409
    - 文案对齐 W0-7 c5 命名规范，使用「无法撤销删除」+ 引导词

    Attributes:
        field_id: 首个失败字段 ID（用于前端定位）
        field_name: 首个失败字段名（W1.4 删除前对话框 / 错误 toast 用）
        field_type: 首个失败字段类型（决定文案）
        reason_code: 机器可读理由（``complex_dependency`` 等）
        unrestorable_fields: P0 修复（Review B-1）—— 全量不可撤销字段清单，
            前端可呈现需走版本历史的字段。每项含
            ``{field_id, field_name, field_type, reason_code, reason}``。
        restorable_fields: P0 修复（Review B-1）—— 同批次中可单独 undo 的字段清单
            （不在白名单触发整体 409 之前已检测出的简单字段）。前端可呈现
            "5 个简单字段可单独 Ctrl+Z 恢复"。
        message: 人类可读理由（W0-7 文案）
    """

    def __init__(
        self,
        message: str,
        *,
        field_id: str | None = None,
        field_name: str | None = None,
        field_type: str | None = None,
        reason_code: str = "complex_dependency",
        unrestorable_fields: list | None = None,
        restorable_fields: list | None = None,
    ):
        super().__init__(message)
        self.field_id = field_id
        self.field_name = field_name
        self.field_type = field_type
        self.reason_code = reason_code
        self.unrestorable_fields = unrestorable_fields or []
        self.restorable_fields = restorable_fields or []
