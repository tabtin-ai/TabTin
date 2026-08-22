"""
统一的资源消耗型 API 计费预检装饰器。

内部委托 ``billing_precheck()`` 执行五层检查（任一不通过则拒绝请求）：

1. **Guard** — 会员过期 / 异常告警阻断
2. **ServiceGuard** — 管理员服务开关
3. **Budget** — 月度预算策略
4. **MemberBudget** — 成员级限额（月度/日度/模型等级）
5. **Balance** — 钱包余额

API 开发者只需标注 ``service_key`` 即可获得完整的计费防护。

用法::

    @router.post("/generate/image", auth=jwt_auth)
    @billing_required(service_key="media.image")
    def generate_image(request, payload: ImageGenPayload):
        # request._billing_organization_id 已自动解析
        ...

    # 指定从 payload 取 organization_id 的字段名
    @router.post("/recognize/", auth=jwt_auth)
    @billing_required(service_key="speech.asr", organization_id_field="organization_id")
    def asr_recognize(request, payload: ASRRecognizeRequest):
        ...

    # 通过项目/资源 ID 间接推导 organization_id
    @router.post("/projects/{video_id}/synthesize-speech/", auth=jwt_auth)
    @billing_required(
        service_key="speech.tts",
        organization_id_resolver=lambda req, kw: _get_project_organization(kw.get("video_id")),
    )
    def synthesize_speech(request, video_id: str, payload: ...):
        ...
"""

from __future__ import annotations

import functools
import logging
from typing import Any, Callable, Optional

from ninja.errors import HttpError

logger = logging.getLogger(__name__)

_BILLING_PRECHECK_METRIC_NAME = "billing_precheck_total"

try:
    from prometheus_client import Counter

    billing_precheck_total = Counter(
        _BILLING_PRECHECK_METRIC_NAME,
        "billing_required 装饰器预检结果",
        ["service_key", "result"],
    )
except Exception:
    from apps.services.billing.services.billing_metrics import _NullMetric

    billing_precheck_total = _NullMetric()


def billing_required(
    service_key: str,
    *,
    scene_key: str = "",
    organization_id_field: str = "organization_id",
    organization_id_resolver: Optional[Callable[..., str]] = None,
    skip_balance_check: bool = False,
    require_organization: bool = True,
    enforce_organization_permission: bool = False,
):
    """统一的资源消耗型 API 计费预检装饰器。

    五层预检（通过 ``billing_precheck()`` 统一执行，任一不通过则拒绝请求）：
    1. Guard — 会员过期 / 异常告警阻断
    2. ServiceGuard — 管理员服务开关
    3. Budget — 月度预算策略
    4. MemberBudget — 成员级限额
    5. Balance — 钱包余额

    organization_id 推导顺序：
    1. organization_id_resolver（自定义函数）
    2. payload 中 organization_id_field 指定的字段
    3. 解析失败 → 拒绝服务（W2-1c：不再 fallback 个人团队）

    Args:
        service_key: 服务标识，如 "media.image", "speech.asr", "rag.embedding"。
        organization_id_field: payload 中 organization_id 的字段名。
        organization_id_resolver: 自定义的 organization_id 推导函数
            签名: (request, kwargs) -> str。用于从 path 参数间接推导
            （如通过 video_id 查项目的 workspace_id）。
        skip_balance_check: 是否跳过余额预检（仅用于只需服务开关检查的场景）。
        require_organization: 是否要求 organization_id 必须非空（为 True 时推导失败则拒绝）。
        enforce_organization_permission: 是否在预算/余额预检前校验用户属于目标团队。
    """

    def decorator(func: Callable) -> Callable:
        import inspect
        import types

        def _do_precheck(args, kwargs):
            """共享的预检逻辑，返回 (request, user_id, organization_id) 或抛异常。"""
            if scene_key:
                from apps.services.llm.scenes.policy import require_scene_enabled

                require_scene_enabled(scene_key)
            request = _extract_request(args, kwargs)
            if request is None:
                logger.warning(
                    "[billing_required] 无法提取 HttpRequest，跳过预检: service=%s",
                    service_key,
                )
                billing_precheck_total.labels(
                    service_key=service_key, result="no_request"
                ).inc()
                return None, "", ""

            from .organization_resolver import extract_user_id, resolve_organization_id

            user_id = extract_user_id(request)
            wt_id = _resolve_organization(
                request, args, kwargs,
                field=organization_id_field,
                resolver=organization_id_resolver,
            )

            if require_organization and not wt_id:
                billing_precheck_total.labels(
                    service_key=service_key, result="no_organization"
                ).inc()
                raise HttpError(400, "organization_id is required for this operation")

            if enforce_organization_permission and wt_id:
                _assert_organization_permission(request, wt_id, service_key)

            try:
                block_reason = _run_precheck(
                    user_id=user_id,
                    organization_id=wt_id,
                    service_key=service_key,
                    skip_balance_check=skip_balance_check,
                )
            except HttpError:
                raise
            except Exception as exc:
                logger.warning(
                    "[billing_required] 预检异常，放行: service=%s err=%s",
                    service_key, exc,
                )
                billing_precheck_total.labels(
                    service_key=service_key, result="error_passthrough"
                ).inc()
                block_reason = None
            else:
                billing_precheck_total.labels(
                    service_key=service_key, result="pass"
                ).inc()

            request._billing_organization_id = wt_id
            # 请求发起人，仅用于审计/预检；账务主体始终是 _billing_organization_id。
            request._billing_user_id = user_id
            return request, user_id, wt_id

        # ────────────────────────────────────────────────────────────────────
        # Wave 1 B4 修 OpenAPI 500 根因：
        #
        # 旧实现用 ``@functools.wraps(func)`` 定义 wrapper 后直接返回。
        # functools.wraps 会拷贝 ``__wrapped__`` / ``__module__`` / ``__qualname__``
        # 等元数据，但 wrapper 的 ``__globals__`` 永远 = 装饰器所在模块（即本
        # 文件 ``decorators.py``）的 globals——这是 Python 函数定义机制决定的。
        #
        # Django Ninja 在生成 OpenAPI schema 时通过 ``inspect.signature(view)``
        # 拿 view 的参数类型；如果 view 模块里写了 ``from __future__ import
        # annotations``，所有类型注解会变成字符串（PEP 563），ninja 内部用
        # ``typing.get_type_hints(view, globalns=view.__globals__)`` 把字符串
        # resolve 回真实类。
        #
        # 旧 wrapper.__globals__ 指向 ``decorators.py``，里面没有 view 用到
        # 的 ``SynthesizeSpeechRequest`` / ``GenerateBGMRequest`` /
        # ``TranscribeRequest`` 这些 schema 类——resolve 失败 → ninja 把
        # payload 当成 query params → Pydantic 报
        #   PydanticUserError: `QueryParams` is not fully defined
        # ↑ 整个 ``/api/openapi.json`` 500。
        #
        # 修法：用 ``types.FunctionType`` 重建 wrapper，把 ``__globals__``
        # 显式接到 ``func.__globals__``（view 自己的模块 globals），让
        # ninja 能 resolve 那些 forward references。这样所有用
        # ``@billing_required`` + Pydantic Schema payload 的 view 都能正常
        # 进入 OpenAPI schema 生成。
        #
        # 这不是 hack——`functools.wraps` 不复制 __globals__ 是 Python 标准库
        # 已知短板，社区常见模式（Flask 老 view 装饰器、django-ninja issue
        #  etc.）就是这样修。
        # ────────────────────────────────────────────────────────────────────
        if inspect.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                _do_precheck(args, kwargs)
                return await func(*args, **kwargs)
            return _rebind_wrapper_globals(async_wrapper, func)
        else:
            @functools.wraps(func)
            def sync_wrapper(*args: Any, **kwargs: Any) -> Any:
                _do_precheck(args, kwargs)
                return func(*args, **kwargs)
            return _rebind_wrapper_globals(sync_wrapper, func)

    return decorator


def _rebind_wrapper_globals(wrapper: Callable, original: Callable) -> Callable:
    """把 ``wrapper.__globals__`` 重新绑定到 ``original.__globals__``。

    见 ``decorator()`` 内 Wave 1 B4 注释 — 让 ninja schema 生成器能用 view
    自己模块的 globals resolve PEP 563 forward references。

    实现：基于 ``wrapper`` 的 ``__code__`` / ``__defaults__`` / ``__name__``
    等不变量，用 ``types.FunctionType`` 重新构造一个 globals 指向 original
    的函数；再把 ``functools.wraps`` 拷过来的 ``__wrapped__`` /
    ``__qualname__`` / ``__doc__`` / ``__dict__`` 等元数据搬过去。
    """
    import types

    rebound = types.FunctionType(
        wrapper.__code__,
        original.__globals__,
        name=wrapper.__name__,
        argdefs=wrapper.__defaults__,
        closure=wrapper.__closure__,
    )
    rebound.__kwdefaults__ = wrapper.__kwdefaults__
    rebound.__module__ = original.__module__
    rebound.__qualname__ = original.__qualname__
    rebound.__doc__ = original.__doc__
    rebound.__dict__.update(wrapper.__dict__)
    rebound.__wrapped__ = original
    return rebound


def _extract_request(args: tuple, kwargs: dict) -> Optional[Any]:
    """从 Ninja view 的参数中提取 HttpRequest。"""
    from django.http import HttpRequest

    if args and isinstance(args[0], HttpRequest):
        return args[0]
    for v in kwargs.values():
        if isinstance(v, HttpRequest):
            return v
    return None


def _resolve_organization(
    request: Any,
    args: tuple,
    kwargs: dict,
    *,
    field: str,
    resolver: Optional[Callable] = None,
) -> str:
    """按优先级推导 organization_id（委托统一 resolver）。"""
    from .organization_resolver import resolve_organization_id

    if resolver is not None:
        try:
            resolved = resolver(request, kwargs)
            if resolved:
                return str(resolved)
        except Exception as exc:
            logger.debug("[billing_required] resolver 异常: %s", exc)

    payload_wt = _extract_organization_from_payload(args, kwargs, field)
    return resolve_organization_id(
        payload_organization_id=payload_wt,
        request=request,
        fallback_to_personal=False,
    )


def _extract_organization_from_payload(
    args: tuple, kwargs: dict, field: str
) -> str:
    """从视图参数中的 payload 对象或 kwargs 中提取 organization_id。"""
    if field in kwargs:
        return str(kwargs[field] or "")

    for arg in args:
        if hasattr(arg, field):
            return str(getattr(arg, field) or "")

    if "payload" in kwargs:
        payload = kwargs["payload"]
        if hasattr(payload, field):
            return str(getattr(payload, field) or "")

    return ""


def _assert_organization_permission(request: Any, organization_id: str, service_key: str) -> None:
    """在 billing precheck 前挡住非成员，避免泄露预算/余额状态。"""
    try:
        from apps.tabtinspace.services.base import BaseService
        allowed = BaseService(user=getattr(request, "auth", None)).check_organization_permission(
            organization_id,
            "viewer",
        )
    except Exception as exc:
        logger.warning(
            "[billing_required] organization permission check failed: service=%s wt=%s err=%s",
            service_key,
            str(organization_id)[:8],
            exc,
        )
        allowed = False
    if not allowed:
        billing_precheck_total.labels(
            service_key=service_key, result="forbidden_organization"
        ).inc()
        raise HttpError(403, "无权使用该组织")


def _run_precheck(
    *,
    user_id: str,
    organization_id: str,
    service_key: str,
    skip_balance_check: bool,
) -> Optional[Any]:
    """委托 billing_precheck() 执行统一五层预检。"""
    from apps.i18n import _
    from apps.services.billing.services.billing_precheck import (
        LAYER_BALANCE,
        LAYER_BUDGET,
        billing_precheck,
    )

    skip = frozenset()
    if skip_balance_check:
        skip = frozenset({LAYER_BUDGET, LAYER_BALANCE})

    user_role = None
    if user_id:
        try:
            from apps.services.billing.services.member_budget_service import MemberBudgetService
            user_role = MemberBudgetService.resolve_user_role(organization_id, user_id)
        except Exception:
            pass

    result = billing_precheck(
        organization_id,
        user_id,
        service_key=service_key,
        skip_layers=skip,
        context=f"decorator:{service_key}",
        user_role=user_role,
    )
    if result.blocked:
        billing_precheck_total.labels(
            service_key=service_key, result=result.error_category
        ).inc()
        from apps.services.billing.services.billing_precheck import _LAYER_HTTP_STATUS
        status_code = _LAYER_HTTP_STATUS.get(result.layer, 400)
        raise HttpError(status_code, _(f"billing.{result.error_category}"))

    return None
