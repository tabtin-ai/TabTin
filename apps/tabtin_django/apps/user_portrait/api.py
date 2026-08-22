"""
User Portrait REST API（/#4118 画像 per-Agent 化）

薄 API 层：参数解析 → 调用 UserPortraitService → 格式化响应。

端点：
  - GET    /me/{organization_id}                获取当前用户在指定 (Organization, Agent) 的画像
  - POST   /me/{organization_id}/hint           提交 hint（D7：实时触发蒸馏）
  - POST   /me/{organization_id}/distill        主动触发蒸馏
  - GET    /me/{organization_id}/snapshots      该 (Organization, Agent) 内的画像历史快照

权限：
  - JWTAuth + 成员身份校验（用户必须是 organization 的成员/所有者，否则 403）
  - agent_id 归属校验：必须是该 Agent 的 owner，否则 403（AGENT_ACCESS_DENIED）
  - Service 层会做 _check_organization_membership 兜底
"""

from __future__ import annotations

import logging

from django.utils import timezone
from ninja import Router

from apps.i18n.response import (
    success_response,
    error_response_with_status,
    validation_error_response,
)

# v0.2 NinjaAPI 兼容：endpoint 既可能返回 200 dict，也可能返回 (status, dict) tuple
# （来自 _handle_service_error / validation_error_response）。Ninja 1.5 默认只允许
# 200 status，遇到非 200 报 ConfigError；这里声明 ``Ellipsis`` 作为 catch-all
# 让所有 status code 都被接受并把 body 当 dict 处理。
#
# 副作用：OpenAPI schema 对 4xx/5xx 的精度会被弱化（统一标为 dict）。
# UserPortrait API 当前没有发布对外 SDK，可接受这种弱化；如果未来要做
# 强类型 SDK，应改成 ``response={200: PortraitOut, 400: ErrorOut, ...}`` 显式列举。
_API_RESPONSE_SCHEMA = {200: dict, ...: dict}
from apps.users.auth.permissions import JWTAuth
from apps.user_portrait.error_codes import ErrorCode, ServiceError
from apps.user_portrait.models import UserPortrait, UserPortraitSnapshot
from apps.user_portrait.schemas import (
    DistillTriggerRequest,
    HintSubmitRequest,
    PortraitOut,
    SnapshotListOut,
    SnapshotOut,
)
from apps.user_portrait.services.portrait_service import (
    UserPortraitService,
    _normalize_organization_id,
    is_valid_uuid as _is_valid_uuid,
)
from apps.user_portrait.constants import HINT_SOFT_LIMIT_CHARS
from apps.user_portrait.user_messages import humanize_api_error

logger = logging.getLogger(__name__)

router = Router(tags=["UserPortrait"])

jwt_auth = JWTAuth()


# ── 序列化工具 ──────────────────────────────────────


def _serialize_portrait(p: UserPortrait, *, memory_enabled: bool = True) -> dict:
    # 门控：记忆总闸关闭时 content_md 恒空——不返回画像内容，host 据此不注入。
    return PortraitOut(
        id=str(p.id),
        user_id=str(p.user_id),
        organization_id=str(p.organization_id),
        agent_id=str(p.agent_id or ""),
        content_md=(p.content_md or "") if memory_enabled else "",
        version=p.version or 0,
        last_distilled_at=p.last_distilled_at,
        last_distill_status=p.last_distill_status or UserPortrait.DistillStatus.IDLE,
        last_distill_error=p.last_distill_error or "",
        pending_hints_count=len(p.pending_hints or []),
        memory_enabled=memory_enabled,
        created_at=p.created_at,
        updated_at=p.updated_at,
    ).dict()


def _blank_portrait_dto(user, organization_id: str, agent_id: str) -> dict:
    """无 portrait 行（或记忆关闭）时的 fail-closed 空画像 DTO。

    不落库、不返回任何内容——host 收到 content_md="" 后不注入画像。
    """
    now = timezone.now()
    return PortraitOut(
        id="",
        user_id=str(user.id),
        organization_id=str(organization_id),
        agent_id=str(agent_id),
        content_md="",
        version=0,
        last_distilled_at=None,
        last_distill_status=UserPortrait.DistillStatus.IDLE,
        last_distill_error="",
        pending_hints_count=0,
        memory_enabled=False,
        created_at=now,
        updated_at=now,
    ).dict()


def _resolve_agent_scope(request, organization_id: str, agent_id: str) -> str:
    """#4090/#4118：校验 agent_id 合法 + （apps.agent 可用时）agent 属该 org 且当前用户可用。

    - 缺失 / 非法 agent_id → INVALID_AGENT_ID（400），fail-closed 不落无主画像。
    - apps.agent 可用（真实部署）：agent 不存在/不属该 org → 404；非 Agent owner → 403。
      与 agent_memory 域 resolve_scope 同口径（记忆归属 = Agent owner × subject）。
    - apps.agent 不可用（部分单测 settings）：跳过 agent 归属校验，只校验 UUID 合法性
      （与 portrait_service 的 _check_organization_membership graceful-skip 一致）。

    返回归一化 agent_id。
    """
    if not agent_id or not _is_valid_uuid(agent_id):
        raise ServiceError(
            ErrorCode.INVALID_AGENT_ID,
            humanize_api_error(ErrorCode.INVALID_AGENT_ID),
            400,
            data={"raw_detail": f"invalid/missing agent_id: {agent_id!r}"},
        )
    from django.apps import apps as django_apps

    try:
        Agent = django_apps.get_model("agent", "Agent")
    except LookupError:
        return str(agent_id)

    agent = Agent.objects.filter(
        id=agent_id, organization_id=organization_id, is_active=True,
    ).first()
    if not agent:
        raise ServiceError(
            ErrorCode.INVALID_AGENT_ID,
            "Agent 不存在或不可用",
            404,
            data={"raw_detail": f"agent {agent_id} not in org {organization_id}"},
        )
    from apps.tabtinspace.services.base import BaseService

    if not BaseService(user=request.auth).check_agent_owner(agent):
        # 用 AGENT_ACCESS_DENIED 而非 PERMISSION_DENIED——用户可能是组织成员、
        # 只是非该 Agent owner；复用"非组织成员"文案会误导。
        raise ServiceError(
            ErrorCode.AGENT_ACCESS_DENIED,
            humanize_api_error(ErrorCode.AGENT_ACCESS_DENIED),
            403,
            data={"raw_detail": f"user {request.auth.id} not owner of agent {agent_id}"},
        )
    return str(agent.id)


def _serialize_snapshot(s: UserPortraitSnapshot) -> dict:
    return SnapshotOut(
        id=str(s.id),
        version_at_snapshot=s.version_at_snapshot,
        content_md=s.content_md or "",
        trigger_reason=s.trigger_reason,
        input_summary=s.input_summary or {},
        created_at=s.created_at,
    ).dict()


def _svc(request) -> UserPortraitService:
    return UserPortraitService(user=request.auth)


def _memory_enabled(user_id: str, organization_id: str) -> bool:
    from apps.tabmemo.services.record_style_service import resolve_record_preference

    enabled, _ = resolve_record_preference(str(user_id), str(organization_id))
    return bool(enabled)


def _portrait_execution(user_id: str, organization_id: str):
    from apps.agent_memory.workspace_memory_execution import (
        resolve_workspace_memory_dispatch,
    )

    return resolve_workspace_memory_dispatch(
        scene_key="user_portrait_distill",
        organization_id=str(organization_id),
        user_id=str(user_id),
    )


def _handle_service_error(exc: ServiceError):
    """统一把 ServiceError 转为带 status code 的 i18n response。

    v0.2 🟡-4：``exc.message`` 在 Service 抛出点已经是中文人话，
    这里只兜底——如果某条 ServiceError 漏写了 message（理论上不应出现），
    再次走 humanize_api_error 用错误码兜一层人话。
    """
    message = exc.message or humanize_api_error(exc.code)
    return error_response_with_status(
        exc.code,
        message,
        status_code=exc.status,
    )


# ── 端点 1: GET /me/{organization_id} ──────────────────


@router.get("/me/{organization_id}", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def get_my_portrait(request, organization_id: str, agent_id: str = ""):
    """获取当前用户在指定 (Organization, Agent) 的画像（/#4118 per-Agent）。

    契约（供 host ``loadUserPortraitAsync`` 注入用）：
    - **仅按 agent_id 定位**（不收 space_id、不做 space→执行 Agent 解析）；团队 Space
      多用户读画像推后续二期，本波不为团队成员扩权。
    - ``agent_id`` **缺省时 fail-closed 返回空画像**（200，``content_md=""``，
      ``memory_enabled`` 依总闸）——GET 只读，缺 agent scope 时绝不返回跨 Agent 聚合，
      也不 400 打断尚未透传 agent_id 的旧 host/客户端（过渡期）。host 收到空 content
      即不注入。
    - ``agent_id`` 给定但非法/非本人 Agent → 400/403。
    - 记忆总闸关闭 → 只返回空画像（content_md=""），host 不注入。
    - 不存在（且总闸开、agent_id 合法）则自动创建空 portrait。
    """
    try:
        wid = _normalize_organization_id(organization_id)
        if not agent_id:
            # 过渡兼容：host/旧客户端尚未透传 agent_id。GET 只读，缺 agent_id
            # 返回 fail-closed 空画像，不 400、不泄漏跨 Agent 数据。
            return success_response(_blank_portrait_dto(request.auth, wid, ""))
        aid = _resolve_agent_scope(request, wid, agent_id)
        svc = _svc(request)
        if not _memory_enabled(str(request.auth.id), wid):
            # 门控：记忆关闭 → 不生成画像行、不返回内容。仍走成员校验（get_portrait）
            # 保证越权 403 与开启态一致。
            portrait = svc.get_portrait(organization_id=wid, agent_id=aid)
            if portrait:
                return success_response(
                    _serialize_portrait(portrait, memory_enabled=False)
                )
            return success_response(_blank_portrait_dto(request.auth, wid, aid))
        portrait = svc.get_or_create_portrait(organization_id=wid, agent_id=aid)
        return success_response(_serialize_portrait(portrait, memory_enabled=True))
    except ServiceError as e:
        return _handle_service_error(e)


# ── 端点 2: POST /me/{organization_id}/hint ────────────


@router.post("/me/{organization_id}/hint", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def submit_hint(request, organization_id: str, payload: HintSubmitRequest, agent_id: str = ""):
    """提交一条 hint（D7）—— /#4118 per-Agent：hint 归属 (Organization, Agent) 画像。

    Hint 入队 + 立即触发该 Agent 画像的蒸馏。``agent_id`` 必传（缺失 → 400）。
    返回值附带 `soft_warning` 字段：超过软上限时给前端的提示文案。
    """
    text = (payload.text or "").strip()
    if not text:
        # 跟 service 层 INVALID_HINT 文案保持一致，避免"请填写..." vs "...不能为空"两种说法
        return validation_error_response(humanize_api_error(ErrorCode.INVALID_HINT))

    try:
        wid = _normalize_organization_id(organization_id)
        aid = _resolve_agent_scope(request, wid, agent_id)
    except ServiceError as e:
        return _handle_service_error(e)

    if not _memory_enabled(str(request.auth.id), wid):
        # 与 agent_memory 域 RECORD_DISABLED 同语义（状态冲突 409）；用专用 code
        # 让前端按 code 取到正确人话，而非 INVALID_INPUT 的"提交内容有误"。
        return error_response_with_status(
            ErrorCode.MEMORY_DISABLED,
            "记忆功能已关闭，无法提交画像 hint",
            status_code=409,
        )
    execution = _portrait_execution(str(request.auth.id), wid)
    if not execution.enabled:
        return error_response_with_status(
            ErrorCode.MEMORY_DISABLED,
            "自动记忆增强已关闭，无法提交画像 hint",
            status_code=409,
        )

    try:
        portrait = _svc(request).add_hint(
            organization_id=wid, agent_id=aid, text=text,
        )
    except ServiceError as e:
        return _handle_service_error(e)

    response_data = _serialize_portrait(portrait)
    if len(text) > HINT_SOFT_LIMIT_CHARS:
        response_data["soft_warning"] = (
            f"hint 应该简短（建议 {HINT_SOFT_LIMIT_CHARS} 字内），"
            "长内容请直接告诉 Agent 或写到 TabMemo"
        )

    # 立即触发该 Agent 画像的蒸馏（D7 修订）
    try:
        from apps.user_portrait.tasks import distill_portrait_task
        distill_portrait_task.delay(
            user_id=str(request.auth.id),
            organization_id=str(wid),
            agent_id=str(aid),
            reason="hint",
            selected_model_id=execution.selected_model_id,
        )
        response_data["distill_dispatched"] = True
    except Exception as exc:  # pragma: no cover - Celery 不可用时不阻塞 API
        logger.warning("[UserPortrait] distill dispatch failed: %s", exc)
        response_data["distill_dispatched"] = False

    return success_response(response_data)


# ── 端点 3: POST /me/{organization_id}/distill ─────────


@router.post("/me/{organization_id}/distill", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def trigger_distill(request, organization_id: str, payload: DistillTriggerRequest, agent_id: str = ""):
    """主动触发当前 (Organization, Agent) 画像的蒸馏（D5 路径 1，/#4118 per-Agent）。"""
    try:
        wid = _normalize_organization_id(organization_id)
        aid = _resolve_agent_scope(request, wid, agent_id)
    except ServiceError as e:
        return _handle_service_error(e)

    if not _memory_enabled(str(request.auth.id), wid):
        return error_response_with_status(
            ErrorCode.MEMORY_DISABLED,
            "记忆功能已关闭，无法触发画像整理",
            status_code=409,
        )
    execution = _portrait_execution(str(request.auth.id), wid)
    if not execution.enabled:
        return error_response_with_status(
            ErrorCode.MEMORY_DISABLED,
            "自动记忆增强已关闭，无法触发画像整理",
            status_code=409,
        )

    try:
        portrait = _svc(request).get_or_create_portrait(
            organization_id=wid, agent_id=aid,
        )
    except ServiceError as e:
        return _handle_service_error(e)

    if portrait.last_distill_status == UserPortrait.DistillStatus.PENDING:
        return error_response_with_status(
            ErrorCode.DISTILL_IN_PROGRESS,
            humanize_api_error(ErrorCode.DISTILL_IN_PROGRESS),
            status_code=409,
        )

    # ：入队前与 PortraitDistillService.run 使用同一「有无材料」判定。
    # 无材料时不派发 Celery，避免 accepted=true 假成功 + 静默 skip。
    from apps.user_portrait.services.distill_service import PortraitDistillService

    distill_svc = PortraitDistillService(
        user=request.auth,
        organization_id=wid,
        agent_id=aid,
    )
    if not distill_svc.has_distill_materials():
        response_data = _serialize_portrait(portrait)
        response_data["accepted"] = False
        response_data["message"] = "暂无新内容，本次跳过整理。"
        return success_response(response_data)

    try:
        from apps.user_portrait.tasks import distill_portrait_task
        distill_portrait_task.delay(
            user_id=str(request.auth.id),
            organization_id=str(wid),
            agent_id=str(aid),
            reason="manual",
            selected_model_id=execution.selected_model_id,
        )
        dispatched = True
    except Exception as exc:  # pragma: no cover
        logger.warning("[UserPortrait] manual distill dispatch failed: %s", exc)
        dispatched = False

    response_data = _serialize_portrait(portrait)
    response_data["accepted"] = dispatched
    # 用户视角：入队成功 → 安抚；调度失败 → 重试指引；无材料见上方提前返回
    response_data["message"] = (
        "整理任务已加入队列，请稍候"
        if dispatched else
        "任务调度失败，请稍后重试"
    )
    return success_response(response_data)


# ── 端点 4: GET /me/{organization_id}/snapshots ────────


@router.get("/me/{organization_id}/snapshots", auth=jwt_auth, response=_API_RESPONSE_SCHEMA)
def list_snapshots(request, organization_id: str, agent_id: str = "", limit: int = 20):
    """获取指定 (Organization, Agent) 画像的历史快照列表（最近 N 条，/#4118 per-Agent）。

    M1 阶段不开放给普通用户 UI——主要供内部调试和 v2 阶段做"恢复到上一版"用。
    ``agent_id`` 必传（缺失 → 400）。
    """
    limit = max(1, min(int(limit or 20), 100))
    try:
        wid = _normalize_organization_id(organization_id)
        aid = _resolve_agent_scope(request, wid, agent_id)
        snapshots = _svc(request).list_snapshots(
            organization_id=wid, agent_id=aid, limit=limit,
        )
    except ServiceError as e:
        return _handle_service_error(e)

    items = [_serialize_snapshot(s) for s in snapshots]
    return success_response(SnapshotListOut(items=items, count=len(items)).dict())
