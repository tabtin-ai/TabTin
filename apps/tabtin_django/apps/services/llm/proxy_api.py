"""LLM Proxy API — 本地 Agent Runtime 的统一 LLM 请求入口。

端点: POST /api/llm/proxy
认证: JWTAuth（兼容 Daemon JWT Token 和用户 JWT Token）

处理流程:
1. 认证 → 解析 user_id, organization_id, agent_id
2. 解析请求体 → 模型解析
3. 计费预检 → 冻结
4. httpx SSE 流式转发
5. 结算 → 释放冻结
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from django.db import DatabaseError, OperationalError
from django.http import HttpRequest, JsonResponse, StreamingHttpResponse
from ninja import Router

from apps.users.auth.permissions import JWTAuth, DaemonJWTAuth
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

router = Router(tags=["LLM Proxy"])

_auth = [JWTAuth(), DaemonJWTAuth()]
_BILLING_IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9:._-]{1,255}$")


@dataclass(frozen=True)
class BillingHeaderValues:
    idempotency_key: str = ""
    logical_billing_key: str = ""
    attempt_index: Optional[int] = None


def _extract_billing_header_values(meta: Dict[str, Any]) -> BillingHeaderValues:
    legacy_idempotency_key = (
        meta.get("HTTP_X_TABTIN_BILLING_IDEMPOTENCY_KEY", "") or ""
    ).strip()
    logical_billing_key = (
        meta.get("HTTP_X_TABTIN_BILLING_LOGICAL_KEY", "") or ""
    ).strip()
    attempt_billing_key = (
        meta.get("HTTP_X_TABTIN_BILLING_ATTEMPT_KEY", "") or ""
    ).strip()
    attempt_index_raw = (
        meta.get("HTTP_X_TABTIN_BILLING_ATTEMPT_INDEX", "") or ""
    ).strip()

    attempt_index: Optional[int] = None
    if attempt_billing_key and attempt_index_raw:
        try:
            attempt_index = int(attempt_index_raw)
        except (TypeError, ValueError):
            attempt_index = -1

    return BillingHeaderValues(
        idempotency_key=attempt_billing_key or legacy_idempotency_key,
        logical_billing_key=logical_billing_key if attempt_billing_key else "",
        attempt_index=attempt_index,
    )


def _attempt_key_matches_logical_index(
    attempt_billing_key: str,
    *,
    logical_billing_key: str,
    attempt_index: Optional[int],
) -> bool:
    if not attempt_billing_key:
        return True
    if not logical_billing_key or attempt_index is None or attempt_index < 0:
        return False
    return attempt_billing_key == f"{logical_billing_key}:attempt:{attempt_index}"


def _billing_key_is_valid(key: str) -> bool:
    return bool(key and _BILLING_IDEMPOTENCY_KEY_RE.fullmatch(key))


def _is_trusted_agent_billing_key(
    key: str,
    *,
    user_id: str,
    organization_id: str,
    session_id: str,
    request_source: str,
) -> bool:
    if not key.startswith("agent-turn:") or not session_id:
        return False
    try:
        billing_scope, billing_source, call_index = key.removeprefix(
            "agent-turn:"
        ).rsplit(":", 2)
    except ValueError:
        return False
    if (
        not billing_scope
        or not call_index.isdigit()
        or billing_source != request_source
        or billing_source not in {
            "_main_chat",
            "_compact",
            "_summary_judge",
            "_sub_agent",
            "_digest",
        }
    ):
        return False

    from apps.tabchat.models import AgentMentionJob

    job_billing_scope = billing_scope.split(":subagent:", 1)[0]
    job_filters = {
        "billing_idempotency_key": job_billing_scope,
        "organization_id": organization_id,
        "source_message__sender_id": user_id,
        "status": AgentMentionJob.Status.RUNNING,
    }
    if ":subagent:" not in billing_scope:
        job_filters["session_id"] = session_id
    return AgentMentionJob.objects.filter(
        **job_filters,
    ).exists()


def _is_database_connectivity_error(exc: Exception) -> bool:
    """判断异常是否是数据库连接层不可用,避免把业务校验错误误归类。"""
    text = f"{type(exc).__name__}: {exc}".lower()
    if not isinstance(exc, DatabaseError) and "operationalerror" not in text:
        return False
    return any(
        marker in text
        for marker in (
            "timeout",
            "timed out",
            "timeout expired",
            "connection attempt failed",
            "could not connect",
            "could not translate host name",
            "connection to server",
            "connection already closed",
            "connection is closed",
            "terminating connection",
            "server closed the connection",
            "pg.rds.aliyuncs.com",
            "port 5432",
        )
    )


def _stream_database_unavailable_response(
    *,
    stage: str,
    exc: Exception,
    request_id: Optional[str] = None,
) -> StreamingHttpResponse:
    logger.error(
        "[LLMProxy] 数据库连接不可用: stage=%s err=%s",
        stage,
        exc,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return _stream_error_response(
        user_message="远程数据库/结果服务暂时不可用,请稍后重试。",
        technical_detail=f"stage={stage} internal_err={type(exc).__name__}",
        error_code="llm_proxy_result_backend_unavailable",
        status=503,
        request_id=request_id,
        extras={
            "error_category": "llm_proxy_result_backend_unavailable",
            "stage": stage,
        },
    )


def _extract_organization_id(request: HttpRequest) -> str:
    """从 header 或 request context 提取 organization_id（委托统一 resolver）。"""
    from apps.services.billing.organization_resolver import resolve_organization_id_from_request
    return resolve_organization_id_from_request(request, fallback_to_personal=False)


def _error_json(status: int, error_code: str, detail: str = "") -> JsonResponse:
    """JSON 错误响应。

    保留给"远在 stream 之前的硬错误"使用(认证/Body 解析/JSON 格式),
    这些错误客户端 fetch 必须直接 reject(SSE 流还没开),不能伪装成 SSE。

    业务级错误(model_not_found / billing / config error)走
    `_stream_error_response`,客户端能拿到 SSE 流 + 中文文案。
    """
    return JsonResponse(
        {"error": error_code, "detail": detail or error_code},
        status=status,
    )


def _stream_error_response(
    user_message: str,
    technical_detail: str = "",
    error_code: str = "proxy_error",
    status: Optional[int] = None,
    request_id: Optional[str] = None,
    extras: Optional[Dict[str, Any]] = None,
) -> StreamingHttpResponse:
    """把单个错误包装成 SSE 流(error chunk + [DONE])。

    返回 200 OK + StreamingHttpResponse,客户端 fetch 不会 reject,
    `proxy-provider.ts:parseSSEStream` 能识别 `chunk.error` 后立即
    抛 AgentError(non-retryable)让 react loop 走错误路径,而不是死等。

    `extras`(可选):透传给 SSE error chunk 的结构化字段(如 backend_error_type /
    stage),供前端 errorHandler 区分按钮/重试策略。

    总控 § 4 S0.1:view 层 4 处 catch 块统一改用本函数。
    """
    from apps.services.llm.services.proxy_service import stream_proxy_error_as_sse

    response = StreamingHttpResponse(
        stream_proxy_error_as_sse(
            user_message=user_message,
            technical_detail=technical_detail,
            error_code=error_code,
            status=status,
            extras=extras,
        ),
        content_type="text/event-stream",
    )
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"
    if request_id:
        response["X-TabTin-Request-Id"] = request_id
    return response


def _stream_error_for_proxy_error(
    exc,
    request_id: Optional[str] = None,
    model_name: str = "",
) -> StreamingHttpResponse:
    """ProxyError → SSE 错误响应的 helper(自动渲染中文文案)。

    `model_name` 由调用方从 ctx.model_name 透传,让 system_routing 类模板的
    `{model_name}` 占位渲染出真实模型名(如 "GPT-4o")而不是兜底"未知模型"。
    """
    from apps.services.llm.services.proxy_service import _proxy_error_to_friendly

    user_msg, tech, extras = _proxy_error_to_friendly(exc, model_name)
    return _stream_error_response(
        user_message=user_msg,
        technical_detail=tech,
        error_code=exc.error_code,
        status=exc.status,
        request_id=request_id,
        extras=extras,
    )


@router.post("/warmup", auth=_auth)
def llm_warmup(request: HttpRequest):
    """预热到上游 provider 的连接（草稿态 prefetch 调用）。

    解析模型 → 在请求线程内解析 api_base（DB）→ 后台线程完成 TCP+TLS 握手并入
    连接池，让随后的首条真实消息复用暖连接、跳过握手。立即返回，不阻塞调用方。
    best-effort：任何失败都静默降级，绝不影响后续正常发送。
    """
    from apps.services.llm.services.proxy_service import (
        resolve_proxy_model,
        resolve_upstream_api_base,
        prime_upstream_connection,
    )

    if not request.auth:
        return _error_json(401, "unauthorized", "认证失败")

    try:
        body = json.loads(request.body or b"{}")
    except (ValueError, TypeError):
        body = {}
    model_name = str(body.get("model") or body.get("model_id") or "").strip()
    if not model_name:
        return _error_json(400, "invalid_request", "缺少 model")

    try:
        organization_id = _extract_organization_id(request) or ""
    except Exception:  # noqa: BLE001 - 预热不因组织解析失败而失败
        organization_id = ""

    try:
        model_instance = resolve_proxy_model(model_name, organization_id)
    except Exception:  # noqa: BLE001
        model_instance = None
    if not model_instance:
        return JsonResponse({"warmed": False, "reason": "model_not_found"}, status=200)

    api_base = resolve_upstream_api_base(model_instance)
    if not api_base:
        return JsonResponse({"warmed": False, "reason": "no_api_base"}, status=200)

    threading.Thread(
        target=prime_upstream_connection,
        args=(api_base,),
        name="llm-upstream-warmup",
        daemon=True,
    ).start()
    return JsonResponse({"warmed": True}, status=200)


@router.post("/proxy", auth=_auth)
def llm_proxy(request: HttpRequest):
    """LLM 代理端点 — 接受 OpenAI 格式请求，流式转发到 LLM Provider。"""
    from apps.services.llm.services.proxy_service import (
        ProxyContext,
        ProxyError,
        resolve_proxy_model,
        build_upstream_config,
        billing_precheck,
        release_freeze,
        proxy_stream_events,
    )

    view_started_at = time.monotonic()
    timings: Dict[str, float] = {}
    stage_started_at = view_started_at

    user = request.auth
    if not user:
        # 401 unauthorized 保留 JsonResponse(产品判断 W0-fix Major 3):
        # JWT 失效语义上是"远在 stream 之前的硬错误",fetch reject 后由
        # Renderer 现成的 401 拦截层触发 token refresh / 重新登录跳转。
        # 改 SSE 需新增"SSE error_code='unauthorized' → relogin"路径,新增风险
        # 不值;但 detail 改成中文友好文案,确保用户拿到的 fetch 错误体可读。
        from apps.services.llm.wire_adapter import render_error
        user_msg, _tech = render_error("auth", "*", "unauthorized")
        return _error_json(401, "unauthorized", user_msg)

    user_id = str(user.id)
    organization_id = _extract_organization_id(request)
    agent_id = request.META.get("HTTP_X_TABTIN_AGENT_ID", "")
    session_id = request.META.get("HTTP_X_TABTIN_SESSION_ID", "")
    source = request.META.get("HTTP_X_TABTIN_REQUEST_SOURCE", "llm_proxy")
    context_tier_id = (request.META.get("HTTP_X_TABTIN_CONTEXT_TIER", "") or "").strip()
    billing_headers = _extract_billing_header_values(request.META)
    billing_idempotency_key = billing_headers.idempotency_key
    logical_billing_key = billing_headers.logical_billing_key
    attempt_index = billing_headers.attempt_index
    trusted_billing_key = logical_billing_key or billing_idempotency_key

    if billing_idempotency_key and not _billing_key_is_valid(billing_idempotency_key):
        return _stream_error_response(
            user_message="计费幂等标识格式无效，请更新客户端后重试。",
            technical_detail="invalid billing idempotency/attempt key",
            error_code="invalid_billing_idempotency_key",
            status=400,
        )
    if logical_billing_key and not _billing_key_is_valid(logical_billing_key):
        return _stream_error_response(
            user_message="计费逻辑标识格式无效，请更新客户端后重试。",
            technical_detail="invalid X-TabTin-Billing-Logical-Key",
            error_code="invalid_billing_logical_key",
            status=400,
        )
    attempt_billing_key_header = (
        request.META.get("HTTP_X_TABTIN_BILLING_ATTEMPT_KEY", "") or ""
    ).strip()
    attempt_header_present = bool(attempt_billing_key_header)
    if attempt_header_present and not logical_billing_key:
        return _stream_error_response(
            user_message="计费重试标识缺少逻辑标识，请更新客户端后重试。",
            technical_detail="missing X-TabTin-Billing-Logical-Key",
            error_code="missing_billing_logical_key",
            status=400,
        )
    if attempt_header_present and attempt_index is None:
        return _stream_error_response(
            user_message="计费重试序号缺失，请更新客户端后重试。",
            technical_detail="missing X-TabTin-Billing-Attempt-Index",
            error_code="missing_billing_attempt_index",
            status=400,
        )
    if attempt_index is not None and attempt_index < 0:
        return _stream_error_response(
            user_message="计费重试序号格式无效，请更新客户端后重试。",
            technical_detail="invalid X-TabTin-Billing-Attempt-Index",
            error_code="invalid_billing_attempt_index",
            status=400,
        )
    if not _attempt_key_matches_logical_index(
        attempt_billing_key_header,
        logical_billing_key=logical_billing_key,
        attempt_index=attempt_index,
    ):
        return _stream_error_response(
            user_message="计费重试标识不一致，请更新客户端后重试。",
            technical_detail="billing attempt key does not match logical key/index",
            error_code="invalid_billing_attempt_key",
            status=400,
        )

    # --- organization_id 必须存在 ---
    # v0.2.1:改 SSE 流,中文友好文案 + 引导刷新页面。
    if not organization_id:
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("system_routing", "*", "missing_organization_id")
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="missing_organization_id",
            status=400,
        )

    # --- organization 归属校验 ---
    # W0-fix Major 3:改 SSE 流,Renderer 用 ChatPanel 系统气泡展示中文。
    from apps.tabtinspace.models import OrganizationMember
    try:
        has_organization_membership = OrganizationMember.objects.using(postgres_app_db_alias()).filter(
            user_id=user_id, organization_id=organization_id,
        ).exists()
    except Exception as exc:
        if _is_database_connectivity_error(exc):
            return _stream_database_unavailable_response(stage="organization_membership", exc=exc)
        raise
    if not has_organization_membership:
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("auth", "*", "organization_forbidden")
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="organization_forbidden",
            status=403,
        )
    if trusted_billing_key:
        if not _is_trusted_agent_billing_key(
            trusted_billing_key,
            user_id=user_id,
            organization_id=organization_id,
            session_id=session_id,
            request_source=source,
        ):
            return _stream_error_response(
                user_message="计费幂等标识无效，请重新发起 Agent 请求。",
                technical_detail="billing idempotency scope is not bound to active Agent job",
                error_code="invalid_billing_idempotency_scope",
                status=403,
            )
    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        assert_organization_ai_allowed,
    )

    try:
        assert_organization_ai_allowed(organization_id)
    except OrganizationControlBlockedError as exc:
        return _stream_error_response(
            user_message=exc.message,
            technical_detail=f"organization_id={organization_id} code={exc.code}",
            error_code=exc.code,
            status=exc.http_status,
            extras={"error_category": "organization_control", "error_code": exc.code},
        )
    timings["view_auth_and_org_guard"] = (time.monotonic() - stage_started_at) * 1000
    stage_started_at = time.monotonic()

    # --- Body 大小检查 ---
    # W0-fix Major 3:改 SSE 流。
    if len(request.body) > 1_000_000:
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("request", "*", "body_too_large")
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="body_too_large",
            status=413,
        )

    # --- 解析请求体 ---
    # W0-fix Major 3:改 SSE 流。
    try:
        body = json.loads(request.body)
    except (json.JSONDecodeError, ValueError):
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("request", "*", "invalid_json")
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="invalid_json",
            status=400,
        )
    timings["view_parse_body"] = (time.monotonic() - stage_started_at) * 1000
    stage_started_at = time.monotonic()

    model_name = body.get("model", "")
    if not model_name:
        # W0-fix Major 3:改 SSE 流。
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("request", "*", "missing_model")
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="missing_model",
            status=400,
        )

    messages = body.get("messages")
    if not messages or not isinstance(messages, list):
        # W0-fix Major 3:改 SSE 流。
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("request", "*", "missing_messages")
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="missing_messages",
            status=400,
        )

    stream = body.get("stream", True)
    if not stream:
        # W0-fix Major 3:改 SSE 流。
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("request", "*", "stream_required")
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="stream_required",
            status=400,
        )

    # --- 模型解析 ---
    # v0.2.1:model_not_found 改 SSE 流,让前端拿到中文气泡,不再 fetch reject。
    # 这是用户最容易踩的错(切了一个失效 model),W0 必须在 200ms 内给反馈。
    try:
        model_instance = resolve_proxy_model(model_name, organization_id)
    except Exception as exc:
        if _is_database_connectivity_error(exc):
            return _stream_database_unavailable_response(stage="model_resolve", exc=exc)
        raise
    if not model_instance:
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error(
            "system_routing", "*", "model_not_found",
            model_name=model_name,
        )
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=tech,
            error_code="model_not_found",
            status=404,
        )
    timings["view_resolve_model"] = (time.monotonic() - stage_started_at) * 1000
    stage_started_at = time.monotonic()

    # --- 构建上下文 ---
    # v0.1: scene_key 按 source 映射成 4 个 system scene 之一（详见
    # PROXY_SCENE_KEY_MAP 和宪法 §2.3）。LLMUsageFact.scene_key 必填。
    from apps.services.llm.services.proxy_service import map_source_to_scene_key
    ctx = ProxyContext(
        user_id=user_id,
        organization_id=organization_id,
        agent_id=agent_id,
        session_id=session_id,
        source=source,
        billing_idempotency_key=billing_idempotency_key or None,
        logical_billing_key=logical_billing_key,
        attempt_index=attempt_index,
        usage_source="provider_final",
        scene_key=map_source_to_scene_key(source),
        model_name=model_instance.model_name,
        model_instance=model_instance,
        provider=model_instance.provider,
        stream=True,
        context_tier_id=context_tier_id or None,
        view_started_at=view_started_at,
        timings=timings,
    )

    # --- 获取上游配置 ---
    # v0.2.1:ProxyError(all_keys_exhausted / missing_api_base)改 SSE 流。
    try:
        upstream_config = build_upstream_config(model_instance)
        ctx.api_key = upstream_config["api_key"]
        ctx.api_base = upstream_config["api_base"]
        ctx.key_obj = upstream_config.get("key_obj")
        body["_upstream_model_name"] = upstream_config["model_name"]
    except ProxyError as e:
        return _stream_error_for_proxy_error(
            e, request_id=ctx.request_id, model_name=ctx.model_name,
        )
    except Exception as exc:
        if _is_database_connectivity_error(exc):
            return _stream_database_unavailable_response(
                stage="upstream_config",
                exc=exc,
                request_id=ctx.request_id,
            )
        logger.error("[LLMProxy] 上游配置构建失败: %s", exc, exc_info=True)
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("upstream", "*", "5xx", status=500)
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=f"{tech} stage=config internal_err={type(exc).__name__}",
            error_code="config_error",
            status=500,
            request_id=ctx.request_id,
        )
    ctx.timings["view_build_upstream_config"] = (time.monotonic() - stage_started_at) * 1000
    stage_started_at = time.monotonic()

    # --- 计费预检 + 冻结 ---
    # v0.2.1:ProxyError(missing_organization_id / budget_exceeded /
    # insufficient_credits / freeze_failed)改 SSE 流,让用户拿到中文气泡。
    try:
        billing_precheck(ctx)
    except ProxyError as e:
        return _stream_error_for_proxy_error(
            e, request_id=ctx.request_id, model_name=ctx.model_name,
        )
    except Exception as exc:
        if _is_database_connectivity_error(exc):
            release_freeze(ctx)
            return _stream_database_unavailable_response(
                stage="billing_precheck",
                exc=exc,
                request_id=ctx.request_id,
            )
        logger.error("[LLMProxy] 计费预检异常: %s", exc, exc_info=True)
        release_freeze(ctx)
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("upstream", "*", "5xx", status=500)
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=f"{tech} stage=billing internal_err={type(exc).__name__}",
            error_code="billing_error",
            status=500,
            request_id=ctx.request_id,
        )
    ctx.timings["view_billing_precheck"] = (time.monotonic() - stage_started_at) * 1000
    ctx.timings["view_total_before_stream_response"] = (time.monotonic() - view_started_at) * 1000

    # --- 流式响应 ---
    # Django 4.2 + daphne 4 的 sync StreamingHttpResponse 在 ASGI 模式下会
    # 经过 sync_to_async(thread_sensitive=True) 串行执行，加上 daphne transport
    # 的 ~64KB write buffer，导致小尺寸 SSE chunk 被累积到 buffer 满才 flush
    # —— 实测 Kimi K2.5 上第一个 chunk 从 2s 被推迟到 ~23s 才抵达客户端。
    # 解决：把 sync generator 包装成 async iterator，让 ASGIHandler 走 native
    # async 路径（thread_sensitive=False），每个 chunk 立刻 await send 到 socket。
    try:
        from asgiref.sync import sync_to_async

        sync_event_generator = proxy_stream_events(ctx, body)

        async def async_event_iter():
            sync_iter = iter(sync_event_generator)
            sentinel = object()
            while True:
                chunk = await sync_to_async(next, thread_sensitive=False)(sync_iter, sentinel)
                if chunk is sentinel:
                    break
                yield chunk

        response = StreamingHttpResponse(
            async_event_iter(),
            content_type="text/event-stream",
        )
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        response["X-TabTin-Request-Id"] = ctx.request_id
        return response
    except ProxyError as e:
        release_freeze(ctx)
        return _stream_error_for_proxy_error(
            e, request_id=ctx.request_id, model_name=ctx.model_name,
        )
    except Exception as exc:
        release_freeze(ctx)
        logger.error("[LLMProxy] 流式响应创建失败: %s", exc, exc_info=True)
        from apps.services.llm.wire_adapter import render_error
        user_msg, tech = render_error("upstream", "*", "5xx", status=500)
        return _stream_error_response(
            user_message=user_msg,
            technical_detail=f"{tech} stage=stream_response internal_err={type(exc).__name__}",
            error_code="internal_error",
            status=500,
            request_id=ctx.request_id,
        )
