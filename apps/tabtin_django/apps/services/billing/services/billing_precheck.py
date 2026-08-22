"""
统一五层计费预检。

所有产生费用的操作都应通过 ``billing_precheck()`` 执行预检，
确保五层检查（Guard / ServiceGuard / Budget / MemberBudget / Balance）一致覆盖。

用法::

    from apps.services.billing.services.billing_precheck import billing_precheck

    result = billing_precheck(organization_id, user_id, context="chat_send")
    if result.blocked:
        return result.to_error_dict(thread_id=tid)

五层检查（任一命中即阻断）：

- L1 Guard:        会员过期 / 异常告警阻断
- L2 ServiceGuard: 管理员服务开关
- L3 Budget:       月度预算策略
- L5 MemberBudget: 成员级限额（月度/日度/模型等级）
- L4 Balance:      钱包余额
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, FrozenSet, Literal

from django.db import InterfaceError, OperationalError

logger = logging.getLogger(__name__)

Layer = Literal["guard", "service_guard", "budget", "member_budget", "balance"]

LAYER_GUARD: Layer = "guard"
LAYER_SERVICE_GUARD: Layer = "service_guard"
LAYER_BUDGET: Layer = "budget"
LAYER_MEMBER_BUDGET: Layer = "member_budget"
LAYER_BALANCE: Layer = "balance"

_VALID_LAYERS = frozenset({
    LAYER_GUARD, LAYER_SERVICE_GUARD, LAYER_BUDGET, LAYER_MEMBER_BUDGET, LAYER_BALANCE,
})

_AI_SERVICE_KEY_PREFIXES = (
    "ai.",
    "agent.",
    "embedding.",
    "llm.",
    "media.",
    "model.",
    "multimodal.",
    "rag.",
    "search.",
    "speech.",
)

_AI_CONTEXT_PREFIXES = (
    "llm_",
    "llm.",
    "llm:",
    "scene:",
    "structured_output",
    "chat_send",
    "agent_",
)

_LAYER_HTTP_STATUS: dict[str, int] = {
    "resolver": 400,
    "guard": 403,
    "service_guard": 403,
    "budget": 429,
    "member_budget": 429,
    "balance": 402,
}

try:
    from redis.exceptions import RedisError as _RedisError
except ImportError:
    _RedisError = type(None)

_INFRA_EXCEPTIONS = (
    ConnectionError,
    TimeoutError,
    OperationalError,
    InterfaceError,
    OSError,
    _RedisError,
)


@dataclass(frozen=True)
class BillingPrecheckResult:
    """预检结果（不可变，防止 _PASS 单例被意外修改）。"""

    blocked: bool = False
    layer: str = ""
    reason: str = ""
    error_code: str = ""
    error_category: str = ""
    block_type: str = ""
    unblock_actions: tuple = ()
    raw_detail: tuple = ()

    def to_error_dict(self, **extra) -> dict:
        """转为前端可识别的标准错误结构。"""
        base = {
            "success": False,
            "error_code": self.error_code,
            "error_category": self.error_category,
            "reason": self.reason,
            "block_type": self.block_type,
            "unblock_actions": list(self.unblock_actions),
            "http_status": _LAYER_HTTP_STATUS.get(self.layer, 400),
        }
        if self.raw_detail:
            base["billing_result"] = dict(self.raw_detail)
        base.update(extra)
        return base

    def get_raw_detail_dict(self) -> dict:
        """获取底层返回值的 dict 形式（供需要 billing_result 的调用方使用）。"""
        return dict(self.raw_detail) if self.raw_detail else {}

    def raise_if_blocked(self) -> None:
        """如果预检被阻断，抛出对应的 BillingError 子类异常。

        按 layer 选择精确的异常类型，避免各调用方手动做 layer→异常 映射。

        Raises:
            BillingBlockedError: Guard 层阻断（会员过期/异常告警）
            ServiceDisabledError: ServiceGuard 层阻断（管理员关闭服务）
            BudgetExceededException: Budget 层阻断（预算超限）
            MemberBudgetExceededError: MemberBudget 层阻断（成员限额/模型等级）
            InsufficientBalanceError: Balance 层阻断（余额不足）
        """
        if not self.blocked:
            return
        if self.layer == "resolver":
            from ninja.errors import HttpError
            raise HttpError(400, self.reason or "organization_id is required")
        if self.layer == "guard":
            from apps.services.billing.services.guard_service import BillingBlockedError
            raise BillingBlockedError(
                organization_id="",
                reason=self.reason,
                block_type=self.block_type,
            )
        if self.layer == "service_guard":
            from apps.services.billing.services.service_guard import ServiceDisabledError
            raise ServiceDisabledError(
                service_key="",
                organization_id="",
            )
        if self.layer == "budget":
            from apps.services.llm.services.billing import BudgetExceededException
            raise BudgetExceededException(
                organization_id="",
                budget_status="critical",
            )
        if self.layer == "member_budget":
            from apps.services.billing.services.member_budget_service import MemberBudgetExceededError
            raise MemberBudgetExceededError(
                reason=self.reason,
                error_category=self.error_category,
            )
        from apps.services.llm.services.billed_call import InsufficientBalanceError
        raise InsufficientBalanceError(
            user_id="",
            organization_id="",
            reason=self.reason,
        )


_PASS = BillingPrecheckResult()

try:
    from prometheus_client import Counter

    _precheck_total = Counter(
        "billing_unified_precheck_total",
        "统一预检结果",
        ["layer", "result", "context"],
    )
except Exception:
    from apps.services.billing.services.billing_metrics import _NullMetric

    _precheck_total = _NullMetric()


def billing_precheck(
    organization_id: str,
    user_id: str = "",
    *,
    service_key: str | None = None,
    skip_layers: FrozenSet[str] = frozenset(),
    context: str = "",
    user_role: str | None = None,
    model_cost_tier: str | None = None,
    model_instance: Any = None,
    **kwargs: Any,
) -> BillingPrecheckResult:
    """统一五层计费预检。

    Args:
        organization_id: 组织 ID，空值时跳过所有检查。
        user_id: 用户 ID，空值时跳过 L4/L5。
        service_key: 服务标识（如 ``"media.image"``），空值时跳过 L2。
        skip_layers: 显式跳过的检查层（使用 ``LAYER_*`` 常量）。
        context: 调用上下文标识，用于日志和指标（限使用预定义常量值）。
        user_role: 用户在团队中的角色（owner/admin/editor/viewer），用于 L5 豁免判断。
        model_cost_tier: 模型费用等级（standard/premium/enterprise），用于 L5 模型限制。
        model_instance: 本次调用选定的模型实例，用于 L4 余额预检按「本次预估」口径
            判断（quota_only 下避免仅用 0.01 阈值放行、随后在 Proxy/结算层才拦下的
            「假放行 → 秒失败」体验）。缺省时退化为最小阈值口径，行为不变。
        **kwargs: 扩展参数。``source`` 用于 L5 判断是否跳过 scheduler/goal 调用。
    """
    if not organization_id:
        logger.warning(
            "[billing_precheck] organization_id is empty, rejecting (W2-1c): ctx=%s",
            context,
        )
        _precheck_total.labels(
            layer="resolver", result="missing_organization_blocked", context=context,
        ).inc()
        return BillingPrecheckResult(
            blocked=True,
            layer="resolver",
            reason="organization_id is required for billing",
            error_code="MISSING_ORGANIZATION",
            error_category="missing_organization",
            block_type="missing_organization",
        )

    if __debug__ and skip_layers:
        invalid = skip_layers - _VALID_LAYERS
        if invalid:
            logger.warning(
                "[billing_precheck] skip_layers 含无效层名 %s，已忽略。"
                "有效值: %s",
                invalid,
                _VALID_LAYERS,
            )

    result = _check_organization_ai_control(organization_id, service_key, context)
    if result.blocked:
        return result

    if LAYER_GUARD not in skip_layers:
        result = _check_guard(organization_id, context)
        if result.blocked:
            return result

    if LAYER_SERVICE_GUARD not in skip_layers and service_key:
        result = _check_service(organization_id, service_key, context)
        if result.blocked:
            return result

    if LAYER_BUDGET not in skip_layers:
        result = _check_budget(organization_id, context)
        if result.blocked:
            return result

    # L5: 成员级限额检查（在 L3 Budget 之后、L4 Balance 之前）
    if LAYER_MEMBER_BUDGET not in skip_layers and user_id and organization_id:
        result = _check_member_budget(
            organization_id, user_id, user_role, model_cost_tier,
            source=kwargs.get("source"),
            context=context,
        )
        if result.blocked:
            return result

    if LAYER_BALANCE not in skip_layers and user_id:
        result = _check_balance(organization_id, user_id, context, model_instance=model_instance)
        if result.blocked:
            return result

    _precheck_total.labels(layer="all", result="pass", context=context).inc()
    return _PASS


# ---------------------------------------------------------------------------
# L1 — BillingGuard（会员过期 / 异常告警阻断）
# ---------------------------------------------------------------------------


def _check_organization_ai_control(
    organization_id: str,
    service_key: str | None,
    context: str,
) -> BillingPrecheckResult:
    """Apply OrganizationControlPolicy to AI-like billed calls."""

    normalized_service_key = (service_key or "").strip().lower()
    normalized_context = (context or "").strip().lower()
    is_ai_call = normalized_service_key.startswith(_AI_SERVICE_KEY_PREFIXES) or normalized_context.startswith(
        _AI_CONTEXT_PREFIXES
    )
    if not is_ai_call:
        return _PASS
    try:
        from apps.tabtinspace.services.organization_control_guard import (
            OrganizationControlBlockedError,
            assert_organization_ai_allowed,
        )

        assert_organization_ai_allowed(organization_id)
        return _PASS
    except OrganizationControlBlockedError as exc:
        _precheck_total.labels(layer="guard", result="organization_control_blocked", context=context).inc()
        return BillingPrecheckResult(
            blocked=True,
            layer="guard",
            reason=exc.message,
            error_code=exc.code,
            error_category="organization_control",
            block_type=exc.code.lower(),
        )
    except _INFRA_EXCEPTIONS as exc:
        logger.warning(
            "[billing_precheck] OrganizationControl infra error, pass-through: ctx=%s err=%s",
            context,
            exc,
        )
        return _PASS
    except Exception as exc:
        logger.error(
            "[billing_precheck] OrganizationControl unexpected error: ctx=%s err=%s",
            context,
            exc,
            exc_info=True,
        )
        return _PASS


def _check_guard(organization_id: str, context: str) -> BillingPrecheckResult:
    try:
        from apps.services.billing.services.guard_service import (
            BillingBlockedError,
            BillingGuardService,
        )

        BillingGuardService.check_organization_billing_guard(
            organization_id, raise_on_block=True
        )
        return _PASS
    except BillingBlockedError as exc:
        _precheck_total.labels(layer="guard", result="blocked", context=context).inc()
        return BillingPrecheckResult(
            blocked=True,
            layer="guard",
            reason=exc.reason,
            error_code="BILLING_BLOCKED",
            error_category="billing_blocked",
            block_type=exc.block_type,
            unblock_actions=tuple(exc.unblock_actions),
        )
    except _INFRA_EXCEPTIONS as exc:
        logger.warning(
            "[billing_precheck] L1 Guard infra error, pass-through: ctx=%s err=%s",
            context,
            exc,
        )
        return _PASS
    except Exception as exc:
        logger.error(
            "[billing_precheck] L1 Guard unexpected error: ctx=%s err=%s",
            context,
            exc,
            exc_info=True,
        )
        return _PASS


# ---------------------------------------------------------------------------
# L2 — ServiceGuard（管理员服务开关）
# ---------------------------------------------------------------------------


def _check_service(
    organization_id: str, service_key: str, context: str
) -> BillingPrecheckResult:
    try:
        from apps.services.billing.services.service_guard import (
            ServiceDisabledError,
            ServiceGuardService,
        )

        ServiceGuardService.check_service_enabled(
            organization_id, service_key, raise_on_disabled=True
        )
        return _PASS
    except ServiceDisabledError:
        _precheck_total.labels(
            layer="service_guard", result="blocked", context=context
        ).inc()
        return BillingPrecheckResult(
            blocked=True,
            layer="service_guard",
            reason="service_disabled",
            error_code="SERVICE_DISABLED",
            error_category="service_disabled",
        )
    except _INFRA_EXCEPTIONS as exc:
        logger.warning(
            "[billing_precheck] L2 ServiceGuard infra error, pass-through: ctx=%s err=%s",
            context,
            exc,
        )
        return _PASS
    except Exception as exc:
        logger.error(
            "[billing_precheck] L2 ServiceGuard unexpected error: ctx=%s err=%s",
            context,
            exc,
            exc_info=True,
        )
        return _PASS


# ---------------------------------------------------------------------------
# L3 — Budget（月度预算策略）
# 使用 check_budget_before_request(skip_guard=True) 复用已有逻辑，
# skip_guard=True 避免与 L1 的 Guard 重复查询。
# ---------------------------------------------------------------------------


def _check_budget(organization_id: str, context: str) -> BillingPrecheckResult:
    try:
        from apps.services.llm.services.billing import check_budget_before_request

        budget_block = check_budget_before_request(organization_id, skip_guard=True)
        if not budget_block:
            return _PASS

        raw = tuple(budget_block.items()) if isinstance(budget_block, dict) else ()
        _precheck_total.labels(layer="budget", result="blocked", context=context).inc()
        return BillingPrecheckResult(
            blocked=True,
            layer="budget",
            reason=budget_block.get("reason", "budget_exceeded")
            if isinstance(budget_block, dict)
            else "budget_exceeded",
            error_code="BUDGET_EXCEEDED",
            error_category="budget_exceeded",
            raw_detail=raw,
        )
    except _INFRA_EXCEPTIONS as exc:
        logger.warning(
            "[billing_precheck] L3 Budget infra error, pass-through: ctx=%s err=%s",
            context,
            exc,
        )
        return _PASS
    except Exception as exc:
        logger.error(
            "[billing_precheck] L3 Budget unexpected error: ctx=%s err=%s",
            context,
            exc,
            exc_info=True,
        )
        return _PASS


# ---------------------------------------------------------------------------
# L5 — MemberBudget（成员级限额：月度/日度/模型等级）
# 在 L3 之后、L4 之前，先检查"管理员是否允许"再检查"钱够不够"。
# Scheduler/Goal 自动任务跳过此层（仅受 L3 + L4 约束）。
# ---------------------------------------------------------------------------

# 波次 4 Stage 2.4 一刀切：``goal`` / ``goal_trigger`` 历史 source 保留作向后
# 比对（旧日志查询用），但新写入路径只产 ``tracker`` / ``auto_task``。
_SCHEDULER_SOURCES = frozenset({
    "tracker", "tracker_trigger", "scheduler", "goal", "goal_trigger", "auto_task",
})


def resolve_billing_precheck_source(
    *,
    app_context: dict | None = None,
    client_type: str | None = None,
    execution_profile: str | None = None,
) -> str | None:
    """推断是否属于自动化调用源，供 L5 跳过判断（与 _SCHEDULER_SOURCES 对齐）。

    优先使用 app_context["billing_precheck_source"]；否则根据 Tracker 自动任务 /
    服务端 task 等上下文推断。

    信任假设（P1-9）
    ─────────────────
    - app_context 由服务端组装（ChatService / decorator），客户端不可伪造。
    - client_type 和 execution_profile 来自请求上下文，非用户直传。
    - 如果未来开放客户端传递 app_context 字段，需在网关层做白名单过滤，
      防止调用方伪造 billing_precheck_source 绕过 L5。

    波次 4 Stage 2.4 一刀切：legacy ``_agenda_goal_*`` / ``_tabgoal_*`` 检测分支
    下线，唯一 ``_tracker_*`` 前缀。
    """
    ctx = app_context or {}
    explicit = ctx.get("billing_precheck_source")
    if explicit is not None and str(explicit).strip():
        return str(explicit).strip().lower()
    if ctx.get("_tracker_tracker_run_id"):
        return "tracker"
    ct = (client_type or "").lower()
    ep = (execution_profile or "").lower()
    if ct == "server" and ep == "task":
        return "auto_task"
    return None


def _check_member_budget(
    organization_id: str,
    user_id: str,
    user_role: str | None,
    model_cost_tier: str | None,
    *,
    source: str | None = None,
    context: str = "",
) -> BillingPrecheckResult:
    try:
        from django.utils import timezone
        from apps.services.billing.constants import BILLING_TZ
        from apps.services.billing.services.member_budget_service import (
            MemberBudgetService,
        )

        # P0-3: Scheduler/Goal 自动任务跳过成员限额检查
        if source and source.lower() in _SCHEDULER_SOURCES:
            return _PASS

        # R1: 复用 MemberBudgetService.get_effective_policy 替代内联查询，
        # 消除 default=99 误匹配 bug；豁免角色判断和策略缓存均由 Service 统一处理。
        policy = MemberBudgetService.get_effective_policy(
            organization_id, user_id, user_role=user_role,
        )
        if not policy:
            return _PASS

        # 模型等级检查
        _TIER_ORDER = MemberBudgetService.MODEL_TIER_ORDER
        if model_cost_tier and policy.max_model_tier != "enterprise":
            policy_tier_val = _TIER_ORDER.get(policy.max_model_tier, 3)
            request_tier_val = _TIER_ORDER.get(model_cost_tier, 1)
            if request_tier_val > policy_tier_val:
                _precheck_total.labels(
                    layer="member_budget", result="blocked", context=context,
                ).inc()
                return BillingPrecheckResult(
                    blocked=True,
                    layer="member_budget",
                    reason="member_model_restricted",
                    error_code="MEMBER_MODEL_RESTRICTED",
                    error_category="member_model_restricted",
                    block_type="member_model_restricted",
                    raw_detail=tuple({
                        "allowed_tier": policy.max_model_tier,
                        "requested_tier": model_cost_tier,
                    }.items()),
                )

        now = timezone.now().astimezone(BILLING_TZ)
        today = now.date()
        month_start = today.replace(day=1)

        # 月度限额检查
        if policy.monthly_credits_limit is not None and policy.monthly_credits_limit > 0:
            monthly_used = MemberBudgetService._get_cached_usage(
                organization_id, user_id, month_start, "monthly",
            )
            if monthly_used >= policy.monthly_credits_limit:
                _precheck_total.labels(
                    layer="member_budget", result="blocked", context=context,
                ).inc()
                return BillingPrecheckResult(
                    blocked=True,
                    layer="member_budget",
                    reason="member_monthly_limit",
                    error_code="MEMBER_MONTHLY_LIMIT",
                    error_category="member_monthly_limit",
                    block_type="member_monthly_limit",
                    raw_detail=tuple({
                        "consumed": str(monthly_used),
                        "limit": str(policy.monthly_credits_limit),
                    }.items()),
                )

        # 日度限额检查
        if policy.daily_credits_limit is not None and policy.daily_credits_limit > 0:
            daily_used = MemberBudgetService._get_cached_usage(
                organization_id, user_id, today, "daily",
            )
            if daily_used >= policy.daily_credits_limit:
                _precheck_total.labels(
                    layer="member_budget", result="blocked", context=context,
                ).inc()
                return BillingPrecheckResult(
                    blocked=True,
                    layer="member_budget",
                    reason="member_daily_limit",
                    error_code="MEMBER_DAILY_LIMIT",
                    error_category="member_daily_limit",
                    block_type="member_daily_limit",
                    raw_detail=tuple({
                        "consumed": str(daily_used),
                        "limit": str(policy.daily_credits_limit),
                    }.items()),
                )

        return _PASS
    except _INFRA_EXCEPTIONS as exc:
        logger.warning(
            "[billing_precheck] L5 MemberBudget infra error, pass-through: ctx=%s err=%s",
            context, exc,
        )
        return _PASS
    except Exception as exc:
        logger.error(
            "[billing_precheck] L5 MemberBudget unexpected error: ctx=%s err=%s",
            context, exc, exc_info=True,
        )
        return _PASS


# ---------------------------------------------------------------------------
# L4 — Balance（钱包余额）
# 保留 raw_detail 供 build_precheck_error(billing_result=...) 使用，
# 以便前端区分团队/个人钱包 CTA。
# ---------------------------------------------------------------------------


def _check_balance(
    organization_id: str, user_id: str, context: str, *, model_instance: Any = None
) -> BillingPrecheckResult:
    try:
        from apps.services.llm.services.billed_call import check_balance_before_request

        block = check_balance_before_request(
            user_id, organization_id, model_instance=model_instance
        )
        if not block:
            return _PASS

        error_code = "INSUFFICIENT_CREDITS"
        error_category = "insufficient_credits"
        raw = ()
        if isinstance(block, dict):
            error_code = block.get("error_code", error_code)
            error_category = block.get("error_category", error_category)
            raw = tuple(block.items())

        _precheck_total.labels(
            layer="balance", result="blocked", context=context
        ).inc()
        return BillingPrecheckResult(
            blocked=True,
            layer="balance",
            reason="insufficient_credits",
            error_code=error_code,
            error_category=error_category,
            raw_detail=raw,
        )
    except _INFRA_EXCEPTIONS as exc:
        logger.warning(
            "[billing_precheck] L4 Balance infra error, pass-through: ctx=%s err=%s",
            context,
            exc,
        )
        return _PASS
    except Exception as exc:
        logger.error(
            "[billing_precheck] L4 Balance unexpected error: ctx=%s err=%s",
            context,
            exc,
            exc_info=True,
        )
        return _PASS
