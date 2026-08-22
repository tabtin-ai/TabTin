"""TabCode Git 辅助 API（同步短调用）。"""

from __future__ import annotations

import logging

from apps.i18n.response import error_response_with_status, success_response
from apps.services.llm.api_common import (
    _get_organization_default_model_id,
    _read_user_default_model_id,
)
from apps.services.llm.scenes.exceptions import BudgetExceeded, SceneCallError
from apps.tabtinspace.services import SpaceService

from ..schemas import GenerateCommitMessageRequest, GenerateCommitMessageResponse
from ..services.commit_message_generator import generate_commit_message
from ._common import jwt_auth, router

logger = logging.getLogger(__name__)

# 与客户端约定一致：staged diff 正文最多 24 KB
MAX_DIFF_EXCERPT_CHARS = 24 * 1024
MAX_FILES = 200


def _resolve_commit_message_model_id(user, organization_id: str) -> str | None:
    """复用模型设置页的默认模型优先级，不新增客户端请求字段。"""
    user_model_id = _read_user_default_model_id(user, organization_id)
    return user_model_id or _get_organization_default_model_id(organization_id)


@router.post("/git/generate-commit-message", auth=jwt_auth, tags=["Git"])
def generate_commit_message_api(request, data: GenerateCommitMessageRequest):
    """根据客户端提供的 staged diff 摘要，同步生成一条 commit message。"""
    organization_id = (data.organization_id or "").strip()
    if not organization_id:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="organization_id is required",
            status_code=400,
        )

    if not SpaceService(user=request.auth).check_organization_permission(
        organization_id, "viewer"
    ):
        return error_response_with_status(
            "FORBIDDEN",
            message="无权访问该 Organization",
            status_code=403,
        )

    diff_excerpt = data.diff_excerpt or ""
    if len(diff_excerpt) > MAX_DIFF_EXCERPT_CHARS:
        return error_response_with_status(
            "VALIDATION_ERROR",
            message=f"diff_excerpt exceeds {MAX_DIFF_EXCERPT_CHARS} characters",
            status_code=400,
        )

    files = [path.strip() for path in (data.files or []) if path and path.strip()]
    if len(files) > MAX_FILES:
        files = files[:MAX_FILES]

    if not files and not diff_excerpt.strip():
        return error_response_with_status(
            "VALIDATION_ERROR",
            message="staged changes are required",
            status_code=400,
        )

    try:
        message = generate_commit_message(
            files=files,
            diff_excerpt=diff_excerpt,
            truncated=bool(data.truncated),
            user_id=str(request.auth.id),
            organization_id=organization_id,
            selected_model_id=_resolve_commit_message_model_id(
                request.auth,
                organization_id,
            ),
        )
    except BudgetExceeded as exc:
        return error_response_with_status(
            "BUDGET_EXCEEDED",
            message=str(exc) or "AI 额度不足，请充值后重试",
            status_code=402,
            data=getattr(exc, "context", None) or {},
        )
    except SceneCallError as exc:
        logger.warning(
            "[generate_commit_message] scene error code=%s org=%s",
            exc.error_code,
            organization_id,
        )
        return error_response_with_status(
            exc.error_code or "SCENE_CALL_FAILED",
            message=str(exc) or "生成提交信息失败",
            status_code=exc.http_status or 500,
            data={"scene_key": getattr(exc, "scene_key", "")},
        )
    except Exception:
        logger.exception(
            "[generate_commit_message] unexpected failure org=%s files=%s",
            organization_id,
            len(files),
        )
        return error_response_with_status(
            "INTERNAL_ERROR",
            message="生成提交信息失败",
            status_code=500,
        )

    if not message:
        return error_response_with_status(
            "GENERATION_EMPTY",
            message="未能生成有效的提交信息，请重试",
            status_code=502,
        )

    return success_response(
        data=GenerateCommitMessageResponse(commit_message=message).model_dump(),
    )
