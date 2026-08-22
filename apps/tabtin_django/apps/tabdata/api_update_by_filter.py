"""
A3 update-by-filter API 端点

两段式执行：
  POST /tables/{table_id}/records/update-by-filter/preflight
  POST /tables/{table_id}/records/update-by-filter/commit

W3.0c / G3:整体一键关闭(``TABDATA_A3_ENABLED=False``)在 preflight + commit
两侧入口同步生效,关闭时返回 503 + i18n 文案,不暴露具体下线原因
(可能是 SQL 注入应急)。
"""

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from django.conf import settings as dj_settings
from ninja import Router, Schema
from pydantic import Field

from apps.i18n import _
from apps.tabdata.api_helpers import api_error_handler, error_response, success_response
from apps.tabdata.error_codes import ErrorCode, ErrorMessage
from apps.tabdata.exceptions import ConfirmTokenError
from apps.users.auth.permissions import JWTAuth

logger = logging.getLogger(__name__)

router = Router(tags=["TabData"])
jwt_auth = JWTAuth()


def _a3_disabled_response():
    """W3.0c / G3:返回 503 + i18n 文案。preflight + commit 共用入口校验。

    使用 503 而非 403/410 的理由:
    - 503 语义"服务暂时不可用",对客户端清晰提示"重试无意义,需运维干预"
    - 与 ``TABDATA_A3_HARD_LIMIT=0`` 软回退(返回 400/匹配过大)互补,
      构成"软关闭(数据保护)+ 硬关闭(路由级)"两层防御
    """
    return 503, {
        "success": False,
        "code": ErrorCode.A3_FEATURE_DISABLED,
        "message": ErrorMessage.get(ErrorCode.A3_FEATURE_DISABLED),
        "data": None,
    }


# ── Schemas ───────────────────────────────────────────────────────

class UpdateByFilterPreflightRequest(Schema):
    filter_clause: Dict[str, Any] = Field(..., description="筛选条件")
    patch: Dict[str, Any] = Field(..., description="要更新的字段值")


class UpdateByFilterPreflightResponse(Schema):
    matched_total: int
    sample_records: List[Dict[str, Any]]
    confirm_token: str
    estimated_duration_ms: int
    requires_checkpoint: bool


class UpdateByFilterCommitRequest(Schema):
    confirm_token: str = Field(..., description="preflight 返回的确认令牌")
    filter_clause: Dict[str, Any] = Field(..., description="与 preflight 相同的筛选条件")
    patch: Dict[str, Any] = Field(..., description="与 preflight 相同的更新值")


class UpdateByFilterCommitResponse(Schema):
    committed_ids: List[str]
    matched_total: int
    updated_count: int
    truncated: bool
    duration_ms: int
    drift_warning: bool
    auto_checkpoint_pending: bool
    drift_actual: Optional[int] = None
    drift_expected: Optional[int] = None


class ErrorResponse(Schema):
    success: bool = False
    code: str
    message: str
    data: Optional[Any] = None


# ── Endpoints ─────────────────────────────────────────────────────

@router.post(
    "/tables/{table_id}/records/update-by-filter/preflight",
    response={200: dict, 400: dict, 403: dict, 404: dict, 503: dict},
    auth=jwt_auth,
    summary="A3 预检：统计影响行数 + 签发 confirm_token",
)
@api_error_handler
def preflight_update_by_filter(
    request,
    table_id: UUID,
    body: UpdateByFilterPreflightRequest,
):
    if not getattr(dj_settings, 'TABDATA_A3_ENABLED', True):
        logger.warning(
            "[A3] preflight rejected: TABDATA_A3_ENABLED=False (table=%s)",
            table_id,
        )
        return _a3_disabled_response()

    from apps.tabdata.services.update_by_filter_service import (
        A3PreflightError,
        UpdateByFilterService,
    )

    space_id = _resolve_space_id(request, table_id)
    if not space_id:
        # W2.perf-fix2 P2-4:_resolve_space_id 失败时不再 fallback ""
        # 防止后续 confirm_token 的 space 校验被绕过
        return error_response(ErrorCode.TABLE_NOT_FOUND, status_code=404)

    try:
        svc = UpdateByFilterService(user=request.auth, space_id=space_id)
        result = svc.preflight(
            table_id=str(table_id),
            filter_clause=body.filter_clause,
            patch=body.patch,
        )
    except A3PreflightError as exc:
        return _preflight_error_status(exc.code), {
            "success": False,
            "code": exc.code,
            "message": ErrorMessage.get(exc.code, **exc.context),
            "data": None,
        }
    except PermissionError as exc:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=ErrorMessage.get(ErrorCode.PERMISSION_DENIED),
            status_code=403,
        )
    except ConfirmTokenError as exc:
        return exc.http_status, {
            "success": False,
            "code": exc.code,
            "message": _get_confirm_token_message(exc),
            "data": None,
        }

    return success_response(data=result)


@router.post(
    "/tables/{table_id}/records/update-by-filter/commit",
    response={200: dict, 400: dict, 403: dict, 409: dict, 410: dict, 503: dict},
    auth=jwt_auth,
    summary="A3 提交：校验 token + 原子更新",
)
@api_error_handler
def commit_update_by_filter(
    request,
    table_id: UUID,
    body: UpdateByFilterCommitRequest,
):
    if not getattr(dj_settings, 'TABDATA_A3_ENABLED', True):
        logger.warning(
            "[A3] commit rejected: TABDATA_A3_ENABLED=False (table=%s)",
            table_id,
        )
        return _a3_disabled_response()

    from apps.tabdata.services.update_by_filter_service import (
        A3PreflightError,
        UpdateByFilterService,
    )

    space_id = _resolve_space_id(request, table_id)
    if not space_id:
        return error_response(ErrorCode.TABLE_NOT_FOUND, status_code=404)

    try:
        svc = UpdateByFilterService(user=request.auth, space_id=space_id)
        http_status, result = svc.commit(
            table_id=str(table_id),
            confirm_token=body.confirm_token,
            filter_clause=body.filter_clause,
            patch=body.patch,
        )
    except A3PreflightError as exc:
        return _preflight_error_status(exc.code), {
            "success": False,
            "code": exc.code,
            "message": ErrorMessage.get(exc.code, **exc.context),
            "data": None,
        }
    except PermissionError:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=ErrorMessage.get(ErrorCode.PERMISSION_DENIED),
            status_code=403,
        )
    except ConfirmTokenError as exc:
        return exc.http_status, {
            "success": False,
            "code": exc.code,
            "message": _get_confirm_token_message(exc),
            "data": _get_confirm_token_extra_data(exc),
        }

    return success_response(data=result)


# ── helpers ───────────────────────────────────────────────────────

def _resolve_space_id(request, table_id: UUID) -> str:
    """从 table 反查 confirm_token 作用域 ID。

    ：org-only 表 ``space_id`` 为空时回落 ``organization_id``
    （与 ``resolve_schema_partition_id`` 一致），避免 ``str(None) == "None"``
    绕过后续空串校验。
    """
    try:
        from apps.tabdata.models import Table
        from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

        table = (
            Table.objects.using("postgresql")
            .filter(id=table_id)
            .only("space_id", "organization_id")
            .first()
        )
        if not table:
            return ""
        partition_id = resolve_schema_partition_id(table)
        return str(partition_id) if partition_id else ""
    except Exception:
        pass
    return ""


def _get_confirm_token_message(exc: ConfirmTokenError) -> str:
    """优先走 i18n，fallback 到异常 message。"""
    try:
        msg = _(exc.code)
        if msg and msg != exc.code:
            extra = {}
            if hasattr(exc, 'matched_total'):
                extra['n'] = exc.matched_total
            if hasattr(exc, 'expected') and hasattr(exc, 'actual'):
                extra['n'] = exc.expected
                extra['m'] = exc.actual
            if extra:
                try:
                    msg = msg.format(**extra)
                except (KeyError, IndexError):
                    pass
            return msg
    except Exception:
        pass
    return str(exc)


def _get_confirm_token_extra_data(exc: ConfirmTokenError) -> Optional[dict]:
    if hasattr(exc, 'previous_error') and exc.previous_error:
        return {"previous_error": exc.previous_error}
    if hasattr(exc, 'expected') and hasattr(exc, 'actual'):
        return {"drift_expected": exc.expected, "drift_actual": exc.actual}
    return None


# A3PreflightError → HTTP status 映射
_PREFLIGHT_STATUS_MAP = {
    ErrorCode.A3_PREFLIGHT_EMPTY_FILTER: 400,
    ErrorCode.A3_PREFLIGHT_EMPTY_PATCH: 400,
    ErrorCode.A3_PREFLIGHT_TABLE_ARCHIVED: 410,
    ErrorCode.A3_PREFLIGHT_UNSUPPORTED_FIELD: 400,
    ErrorCode.A3_PREFLIGHT_UNKNOWN_FIELD: 400,
    ErrorCode.TABLE_NOT_FOUND: 404,
}


def _preflight_error_status(code: str) -> int:
    return _PREFLIGHT_STATUS_MAP.get(code, 400)
