"""
Plan 模式 HTTP API（Wave 1-C）

为云端运行时的 TabDocPlanStore 提供 plan_create / plan_update_todos 两个端点。
（：plan_exit 端点与审批状态机已删除——「执行」改为客户端行为。）
所有端点走 JWT auth，沿用 tabdoc app 的鉴权风格。

请求/响应均为薄壳：参数校验交给 Pydantic Schema，业务逻辑下沉到
``apps.tabdoc.services.plan_service.PlanService``。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field

from apps.i18n.response import (
    error_response_with_status as error_response,
    permission_denied_response,
    success_response,
    validation_error_response,
)
from apps.services.common.base_schemas import ErrorResponse
from apps.tabdoc.services.plan_schema import PlanProperties
from apps.tabdoc.services.plan_service import PlanService, PlanServiceError
from apps.users.auth.permissions import JWTAuth

logger = logging.getLogger("tabdoc.plan_api")

router = Router(tags=["TabDoc Plan"])
jwt_auth = JWTAuth()


# ── 请求 / 响应 Schema ──


class PlanTodoIn(Schema):
    """与 ``PlanTodo`` 字段对齐，但 id 在 create 时可选。"""

    id: Optional[str] = None
    content: str = Field(min_length=1, max_length=2000)
    status: Optional[str] = None  # pending / in_progress / completed / cancelled


class PlanPhaseIn(Schema):
    id: Optional[str] = None
    name: str = Field(min_length=1, max_length=200)
    summary: Optional[str] = ""
    todo_ids: Optional[List[str]] = None


class PlanCreateRequest(Schema):
    """#6603：Plan 只挂 Organization，不再接受 space_id。"""

    organization_id: str
    name: str = Field(min_length=1, max_length=200)
    overview: Optional[str] = ""
    plan: Optional[str] = ""
    todos: List[PlanTodoIn] = Field(default_factory=list)
    is_project: bool = False
    phases: Optional[List[PlanPhaseIn]] = None
    allowed_prompts: Optional[List[str]] = None
    session_id: Optional[str] = None
    agent_id: Optional[str] = None
    agent_mode_at_create: Optional[str] = None


class PlanUpdateTodosRequest(Schema):
    plan_document_id: str
    todos: List[PlanTodoIn] = Field(min_length=1)
    merge: bool = True


# ：PlanExitRequest 已随 `/api/plan/exit` 端点一并删除。


# ── 帮助函数 ──


def _todo_payload(item: PlanTodoIn) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"content": item.content}
    if item.id:
        payload["id"] = item.id
    if item.status:
        payload["status"] = item.status
    return payload


def _phase_payload(item: PlanPhaseIn) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"name": item.name}
    if item.id:
        payload["id"] = item.id
    if item.summary is not None:
        payload["summary"] = item.summary
    if item.todo_ids is not None:
        payload["todo_ids"] = item.todo_ids
    return payload


def _serialize_plan_document(document) -> Dict[str, Any]:
    return {
        "id": str(document.id),
        "organization_id": str(document.organization_id),
        "space_id": str(document.space_id) if document.space_id else None,
        "title": document.title,
        "tags": list(document.tags or []),
        "latest_version": int(document.latest_version or 0),
        "updated_at": document.updated_at.isoformat() if document.updated_at else None,
        "description_markdown": document.description_markdown or "",
    }


def _service_error_response(exc: PlanServiceError):
    """把 PlanServiceError 映射为 HTTP 响应。

    所有 PLAN_* 错误统一走 ``error_response_with_status``：
    - 顶层 ``code`` 始终是 ``PLAN_*``（不会被 helper 覆盖成 NOT_FOUND/PERMISSION_DENIED）
    - ``data.error_code`` 也带上 ``PLAN_*``，与 409 形态一致，方便 Runtime 单一分支判定
    无论 HTTP 状态是 400/403/404/409，错误体结构都对齐。
    """
    return error_response(
        code=exc.code,
        message=exc.message,
        status_code=exc.status,
        data={"error_code": exc.code},
    )


def _ensure_authed(request: HttpRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    return None


# ── 端点 ──


@router.post(
    "/create",
    response={
        200: dict,
        400: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
    },
    auth=jwt_auth,
    summary="创建 Plan 文档（Wave 1-C）",
)
def plan_create(request: HttpRequest, payload: PlanCreateRequest):
    auth_error = _ensure_authed(request)
    if auth_error:
        return auth_error
    try:
        service = PlanService(user=request.auth)
        result = service.create_plan(
            organization_id=payload.organization_id,
            name=payload.name,
            overview=payload.overview or "",
            plan_markdown=payload.plan or "",
            todos=[_todo_payload(t) for t in payload.todos],
            is_project=bool(payload.is_project),
            phases=[_phase_payload(p) for p in (payload.phases or [])],
            agent_mode_at_create=(payload.agent_mode_at_create or "plan"),
            session_id=payload.session_id or "",
            agent_id=payload.agent_id or "",
            allowed_prompts=payload.allowed_prompts,
        )
    except PlanServiceError as exc:
        return _service_error_response(exc)
    except ValueError as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    document = result["document"]
    plan_props: PlanProperties = result["plan"]
    return success_response(
        {
            "document_id": str(document.id),
            "organization_id": str(document.organization_id),
            "space_id": str(document.space_id) if document.space_id else None,
            "collection_id": result.get("collection_id"),
            "document": _serialize_plan_document(document),
            "plan": plan_props.model_dump(mode="json"),
        }
    )


@router.post(
    "/update_todos",
    response={
        200: dict,
        400: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
        409: ErrorResponse,
    },
    auth=jwt_auth,
    summary="更新 Plan todos（Wave 1-C，draft 期可用）",
)
def plan_update_todos(request: HttpRequest, payload: PlanUpdateTodosRequest):
    auth_error = _ensure_authed(request)
    if auth_error:
        return auth_error
    try:
        service = PlanService(user=request.auth)
        result = service.update_todos(
            plan_document_id=payload.plan_document_id,
            todos=[_todo_payload(t) for t in payload.todos],
            merge=bool(payload.merge),
        )
    except PlanServiceError as exc:
        return _service_error_response(exc)
    except ValueError as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    document = result["document"]
    plan_props: PlanProperties = result["plan"]
    return success_response(
        {
            "document_id": str(document.id),
            "document": _serialize_plan_document(document),
            "todos_after_update": result["todos_after_update"],
            "plan": plan_props.model_dump(mode="json"),
        }
    )


# ：`POST /api/plan/exit` 与审批状态机已删除。
# plan 的「执行」不再是后端结算——改由客户端点击 PlanProposalCard「执行」按钮，
# 纯 renderer 行为（切 agent 模式 + 用 plan_ref/快照拼继续消息）。云端 TabDocPlanStore
# 仅保留 create / update_todos 作为落库后端。


__all__ = ["router"]
