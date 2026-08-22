"""
统一的 LLM 计费调用封装。

提供 billed_llm_call() 和 check_balance_before_request()，
将"余额/预算预检 → LLM 调用 → 计费扣款"三步封装为一个原子操作，
防止业务方遗漏计费集成。
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from decimal import Decimal
from typing import Any, Dict, List, Optional

from apps.services.billing.exceptions import BillingError
from .llm_metrics import (
    _model_to_family,
    llm_call_duration_seconds,
    llm_calls_total,
    llm_cache_tokens_total,
    llm_cost_credits_total,
    llm_errors_total,
    llm_tokens_total,
)

logger = logging.getLogger(__name__)

_DEFAULT_MIN_BALANCE_THRESHOLD = Decimal("0.01")
MIN_BALANCE_THRESHOLD = _DEFAULT_MIN_BALANCE_THRESHOLD


# v0.1 §2.3：billed_llm_call / safe_charge_usage 是 v0.1 之前的老计费 helper，
# 主要被主对话或与主对话语义等价的路径调用。LLMUsageFact.scene_key 必填
# 且必须落在 4 个 system scene 之一（_main_chat / _compact / _summary_judge /
# _sub_agent）。caller 显式传 scene_key 优先；否则按 source 兜底映射，
# 未识别的 source 兜底为 '_main_chat'（视为主对话 ReAct 主循环）。
_BILLED_SOURCE_TO_SCENE_KEY = {
    '_main_chat': '_main_chat',
    '_compact': '_compact',
    '_summary_judge': '_summary_judge',
    '_sub_agent': '_sub_agent',
    'react_loop': '_main_chat',
    'compact': '_compact',
    'auto_condense': '_compact',
    'summary_judge': '_summary_judge',
    'sub_agent': '_sub_agent',
}


def _resolve_billed_scene_key(scene_key: Optional[str], source: str) -> str:
    """billed_llm_call / safe_charge_usage 路径的 scene_key 解析。"""
    if scene_key:
        return scene_key
    if not source:
        return '_main_chat'
    return _BILLED_SOURCE_TO_SCENE_KEY.get(source.strip(), '_main_chat')

_DEFAULT_FREEZE_ESTIMATED_INPUT_TOKENS = 2000
_DEFAULT_FREEZE_ESTIMATED_OUTPUT_TOKENS = 500
_DEFAULT_FREEZE_FALLBACK_CREDITS = Decimal("0.5")

_FREEZE_ESTIMATED_INPUT_TOKENS = _DEFAULT_FREEZE_ESTIMATED_INPUT_TOKENS
_FREEZE_ESTIMATED_OUTPUT_TOKENS = _DEFAULT_FREEZE_ESTIMATED_OUTPUT_TOKENS
_FREEZE_FALLBACK_CREDITS = _DEFAULT_FREEZE_FALLBACK_CREDITS

# ---------------------------------------------------------------------------
# 预检异常计数器 — 有上限的 fail-open
# P2-02: Redis 全局计数器，避免多 worker 下阈值被稀释。
# P2-01: 增加 fail-open 期间累计金额上限。
# 连续异常不超过阈值时放行，超过后切换为 fail-closed 拒绝请求。
# 任意一次成功预检会重置计数器。
# ---------------------------------------------------------------------------
_DEFAULT_PRECHECK_FAIL_THRESHOLD = 10
_DEFAULT_PRECHECK_FAIL_WINDOW = 60
_DEFAULT_FAILOPEN_MAX_CUMULATIVE_CREDITS = Decimal("10")

_PRECHECK_FAIL_THRESHOLD = _DEFAULT_PRECHECK_FAIL_THRESHOLD
_PRECHECK_FAIL_WINDOW = _DEFAULT_PRECHECK_FAIL_WINDOW
_FAILOPEN_MAX_CUMULATIVE_CREDITS = _DEFAULT_FAILOPEN_MAX_CUMULATIVE_CREDITS
_FAILOPEN_REDIS_COUNTER_KEY = "billing:precheck_fail_count"
_FAILOPEN_REDIS_AMOUNT_KEY = "billing:failopen_cumulative_amount"
_POST_CHARGE_INSUFFICIENT_CACHE_PREFIX = "billing:llm:post_charge_insufficient:"
_POST_CHARGE_INSUFFICIENT_CACHE_TTL = 3600

# 进程级回退（Redis 不可用时）
_precheck_fail_counter = 0
_precheck_fail_lock = threading.Lock()
_precheck_last_failure_time: float = 0.0


def _get_billing_config(key: str, default):
    """从 BillingConfigService 读取配置，失败时返回默认值。"""
    try:
        from apps.services.billing.services.runtime_config_service import BillingConfigService
        return BillingConfigService.get(key, default)
    except Exception:
        return default


def _record_precheck_failure() -> bool:
    """记录预检异常。返回 True 表示已超过阈值，应拒绝请求。

    P2-02: 使用 Redis 全局计数器替代进程级变量，
    多 worker 共享同一计数器，避免阈值被稀释。
    Redis 不可用时回退到进程级变量。
    """
    fail_threshold = _get_billing_config("precheck_fail_threshold", _DEFAULT_PRECHECK_FAIL_THRESHOLD)
    fail_window = _get_billing_config("precheck_fail_window", _DEFAULT_PRECHECK_FAIL_WINDOW)
    try:
        from django.core.cache import cache
        key = _FAILOPEN_REDIS_COUNTER_KEY
        cache.add(key, 0, fail_window)
        try:
            count = cache.incr(key)
        except ValueError:
            cache.set(key, 1, fail_window)
            count = 1
        return count >= fail_threshold
    except Exception:
        global _precheck_fail_counter, _precheck_last_failure_time
        now = time.monotonic()
        with _precheck_fail_lock:
            if now - _precheck_last_failure_time > fail_window:
                _precheck_fail_counter = 0
            _precheck_fail_counter += 1
            _precheck_last_failure_time = now
            return _precheck_fail_counter >= fail_threshold


def _reset_precheck_failures() -> None:
    """预检成功时重置异常计数器（同时清除 Redis + 进程级变量）。"""
    try:
        from django.core.cache import cache
        cache.delete(_FAILOPEN_REDIS_COUNTER_KEY)
        cache.delete(_FAILOPEN_REDIS_AMOUNT_KEY)
    except Exception:
        pass
    global _precheck_fail_counter
    with _precheck_fail_lock:
        _precheck_fail_counter = 0


def _is_failopen_amount_exceeded() -> bool:
    """P2-01: 检查 fail-open 期间累计放行金额是否已超过上限。"""
    max_credits = _get_billing_config("failopen_max_credits", _DEFAULT_FAILOPEN_MAX_CUMULATIVE_CREDITS)
    try:
        from django.core.cache import cache
        raw = cache.get(_FAILOPEN_REDIS_AMOUNT_KEY)
        if raw is None:
            return False
        return Decimal(str(raw)) / Decimal("100") >= max_credits
    except Exception:
        return False


def _record_failopen_amount() -> None:
    """P2-01: fail-open 放行时累加预估金额（每次按 freeze_fallback_credits 计）。

    用整数（分为单位）存储以避免浮点精度问题。
    """
    try:
        from django.core.cache import cache
        fallback_credits = _get_billing_config("freeze_fallback_credits", _DEFAULT_FREEZE_FALLBACK_CREDITS)
        fail_window = _get_billing_config("precheck_fail_window", _DEFAULT_PRECHECK_FAIL_WINDOW)
        delta_cents = int(Decimal(str(fallback_credits)) * 100)
        key = _FAILOPEN_REDIS_AMOUNT_KEY
        cache.add(key, 0, fail_window)
        try:
            cache.incr(key, delta_cents)
        except ValueError:
            cache.set(key, delta_cents, fail_window)
    except Exception:
        pass


def mark_post_charge_insufficient_balance(
    organization_id: str,
    *,
    required: Decimal | int | float | str = Decimal("0"),
    current: Decimal | int | float | str = Decimal("0"),
    model_instance: Any = None,
) -> None:
    """记录结算阶段余额不足，防止低余额账号反复 fail-open 继续刷 Agent。

    预检估算可能低于实际长上下文 / 工具调用后的最终费用。若结算阶段已经确认
    钱包余额不足，后续请求应先充值到覆盖本次真实所需金额，再恢复放行。
    """
    if not (organization_id or "").strip():
        return
    try:
        from django.core.cache import cache

        payload = {
            "required": str(Decimal(str(required or 0))),
            "current": str(Decimal(str(current or 0))),
            "model_fingerprint": _billing_model_fingerprint(model_instance),
        }
        cache.set(
            f"{_POST_CHARGE_INSUFFICIENT_CACHE_PREFIX}{organization_id}",
            payload,
            _POST_CHARGE_INSUFFICIENT_CACHE_TTL,
        )
    except Exception:
        pass


def _billing_model_fingerprint(model_instance: Any) -> str:
    """返回稳定的计费画像，避免一次高成本请求暂停所有模型。"""
    if model_instance is None:
        return ""
    provider = getattr(model_instance, "provider", None)
    return "|".join((
        str(getattr(provider, "provider_key", "") or getattr(provider, "name", "")),
        str(getattr(model_instance, "model_name", "") or getattr(model_instance, "id", "")),
        str(getattr(model_instance, "input_price_per_1k", "") or ""),
        str(getattr(model_instance, "output_price_per_1k", "") or ""),
    ))


def _has_post_charge_insufficient_block(
    organization_id: str,
    available: Decimal,
    *,
    model_instance: Any = None,
) -> bool:
    """同一计费画像结算不足后的短期防穿透；其他画像按本次预估独立判断。"""
    if not (organization_id or "").strip():
        return False
    try:
        from django.core.cache import cache

        key = f"{_POST_CHARGE_INSUFFICIENT_CACHE_PREFIX}{organization_id}"
        raw = cache.get(key)
        if not raw:
            return False
        required = Decimal(str((raw or {}).get("required") or 0))
        if required <= 0:
            return False
        previous_fingerprint = str((raw or {}).get("model_fingerprint") or "")
        current_fingerprint = _billing_model_fingerprint(model_instance)
        if (
            model_instance is not None
            and (
                not previous_fingerprint
                or current_fingerprint != previous_fingerprint
            )
        ):
            return False
        if available >= required:
            cache.delete(key)
            return False
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 统一预检失败错误结构工厂
# ---------------------------------------------------------------------------

_PRECHECK_PROTECTED_KEYS = frozenset({"success", "error_code", "error_category"})


def build_precheck_error(**extra) -> dict:
    """构建余额不足的标准错误结构。

    所有预检失败入口应使用此函数，确保前端可通过 error_category 统一识别。
    可通过 **extra 传入 thread_id / final_answer 等附加字段，但不可覆盖
    success / error_code / error_category 三个核心字段。

    BIL-16: 当 billing_result 携带团队专属错误码（ORGANIZATION_INSUFFICIENT_CREDITS）时，
    自动继承该错误码，前端据此切换 CTA 至团队钱包充值。

    quota_only：billing_result.topup_reason 提升到返回体顶层，供聊天 DONE
    metadata.error_extras / BillingErrorCard 按角色引导（与 Proxy extras 同口径）。
    """
    from apps.i18n import _
    billing_result = extra.get("billing_result")
    if isinstance(billing_result, dict) and billing_result.get("error_code", "").startswith("ORGANIZATION_"):
        error_code = billing_result["error_code"]
        error_category = billing_result.get("error_category", "organization_insufficient_credits")
        error_msg = billing_result.get("error", f"[{error_category}] {_('wallet.organization_credits_insufficient')}")
    else:
        error_code = "INSUFFICIENT_CREDITS"
        error_category = "insufficient_credits"
        error_msg = f"[insufficient_credits] {_('billing.insufficient_credits')}"
    safe_extra = {k: v for k, v in extra.items() if k not in _PRECHECK_PROTECTED_KEYS}
    result = {
        "success": False,
        "error": extra.get("error", error_msg),
        "error_code": error_code,
        "error_category": error_category,
        **safe_extra,
    }
    # 显式传入的 topup_reason 优先；否则从 billing_result 提升
    if not result.get("topup_reason") and isinstance(billing_result, dict):
        lifted = billing_result.get("topup_reason")
        if lifted:
            result["topup_reason"] = lifted
    return result


def build_budget_error(**extra) -> dict:
    """构建预算超限的标准错误结构。"""
    from apps.i18n import _
    billing_result = extra.get("billing_result")
    if isinstance(billing_result, dict) and billing_result.get("error_code"):
        error_code = str(billing_result.get("error_code") or "BUDGET_EXCEEDED")
        error_category = str(billing_result.get("error_category") or "budget_exceeded")
        error_msg = billing_result.get("detail") or billing_result.get("error")
    else:
        error_code = "BUDGET_EXCEEDED"
        error_category = "budget_exceeded"
        error_msg = None
    safe_extra = {k: v for k, v in extra.items() if k not in _PRECHECK_PROTECTED_KEYS}
    return {
        "success": False,
        "error": extra.get("error", error_msg or f"[budget_exceeded] {_('billing.budget_exceeded')}"),
        "error_code": error_code,
        "error_category": error_category,
        **safe_extra,
    }


def build_member_budget_error(**extra) -> dict:
    """构建成员级限额 / 模型档位阻断的标准错误结构（L5 member_budget）。"""
    from apps.i18n import _

    billing_result = extra.get("billing_result")
    br = billing_result if isinstance(billing_result, dict) else {}
    category = (
        extra.get("error_category")
        or br.get("error_category")
        or "member_monthly_limit"
    )
    code = extra.get("error_code") or br.get("error_code") or ""
    _msg_keys = {
        "member_monthly_limit": "billing.member_monthly_limit",
        "member_daily_limit": "billing.member_daily_limit",
        "member_model_restricted": "billing.member_model_restricted",
    }
    if not code:
        code = {
            "member_monthly_limit": "MEMBER_MONTHLY_LIMIT",
            "member_daily_limit": "MEMBER_DAILY_LIMIT",
            "member_model_restricted": "MEMBER_MODEL_RESTRICTED",
        }.get(category, "MEMBER_MONTHLY_LIMIT")
    msg_key = _msg_keys.get(category, None)
    if msg_key is None:
        logger.warning("[build_member_budget_error] unexpected category=%s, falling back to member_budget", category)
        msg_key = "billing.member_monthly_limit"
        category = "member_budget"
    safe_extra = {k: v for k, v in extra.items() if k not in _PRECHECK_PROTECTED_KEYS}
    return {
        "success": False,
        "error": extra.get("error", _(msg_key)),
        "error_code": code,
        "error_category": category,
        **safe_extra,
    }


def _alert_precheck_failopen(user_id: str, organization_id: str, exc: Exception) -> None:
    """SEC-01: 预检异常 fail-open 时持久化告警，确保运维可审计。

    计数器快照在锁内读取后释放锁，再做 IO（避免持锁写库）。
    与重置线程可能有微小窗口的竞态，但告警目的是可观测性而非精确计数，可接受。
    """
    fail_threshold = _get_billing_config("precheck_fail_threshold", _DEFAULT_PRECHECK_FAIL_THRESHOLD)
    try:
        from django.core.cache import cache as _alert_cache
        counter_snapshot = int(_alert_cache.get(_FAILOPEN_REDIS_COUNTER_KEY) or 0)
    except Exception:
        with _precheck_fail_lock:
            counter_snapshot = _precheck_fail_counter
    try:
        from apps.services.billing.models import BillingAnomalyAlert
        from django.core.cache import cache

        dedup_key = f"precheck:failopen:alert:{organization_id or user_id}"
        if cache.get(dedup_key):
            return
        cache.set(dedup_key, 1, 300)

        BillingAnomalyAlert.objects.create(
            alert_type="pattern",
            severity="warning",
            organization_id=organization_id or "",
            user_id=user_id or "",
            metric_name="precheck_failopen",
            current_value=counter_snapshot,
            baseline_value=fail_threshold,
            message=(
                f"余额预检异常 fail-open 放行: user={user_id[:8]}... "
                f"organization={organization_id[:8] if organization_id else 'N/A'}... "
                f"count={counter_snapshot}/{fail_threshold} "
                f"error={str(exc)[:200]}"
            ),
        )
    except Exception as alert_exc:
        logger.debug("[BalanceCheck] fail-open 告警写入失败: %s", alert_exc)


class InsufficientBalanceError(BillingError):
    """余额不足，请求被拦截。"""

    def __init__(self, user_id: str, organization_id: str, reason: str = ""):
        from apps.i18n import _
        self.user_id = user_id
        self.organization_id = organization_id
        self.reason = reason or _("billing.insufficient_credits")
        super().__init__(self.reason, code="INSUFFICIENT_CREDITS")


def check_balance_before_request(
    user_id: str,
    organization_id: str = "",
    *,
    model_instance=None,
) -> Optional[dict]:
    """请求前余额预检。

    当有 organization_id 时，根据 llm_billing_mode 分模式判断：
    - quota_only:    月度预算剩余 > 0 即放行
    - quota_then_paygo: 月度预算剩余 > 0 **或** 钱包余额 >= 0.01 即放行
    - paygo_only:    钱包余额 >= 0.01 即放行

    无 organization_id 时直接返回 blocked dict(error_category='missing_organization_id'),
    避免扣费环节才拦截导致的延迟错误体验(W0-fix:让 view 层能即时渲染中文气泡)。

    SF-1: 当 model_instance 指向 BYOK 渠道（scope='user' 或 'organization'）时，
    直接放行，因为请求走用户自带 Key，不消耗平台余额。

    Returns:
        None — 余额充足或 BYOK 豁免，允许继续。
        dict  — 需要拦截，包含 ``{'success': False, 'blocked': True, 'error_code': ...,
                'error_category': 'insufficient_credits', ...}``（WAL-23: 与 build_precheck_error 格式统一）。
    """
    if not user_id:
        return None

    # SF-1: BYOK 渠道（用户/组织自配 Key）跳过余额预检
    if model_instance is not None:
        try:
            from apps.services.llm.services.billing import _is_byok_provider
            if _is_byok_provider(model_instance):
                logger.debug(
                    "[BalanceCheck] BYOK 豁免: scope=%s provider=%s user=%s",
                    getattr(getattr(model_instance, "provider", None), "scope", ""),
                    getattr(getattr(model_instance, "provider", None), "name", ""),
                    user_id[:8] if user_id else "",
                )
                return None
        except Exception:
            pass

    try:
        if organization_id:
            result = _check_organization_balance(user_id, organization_id, model_instance=model_instance)
        else:
            return {
                "success": False,
                "blocked": True,
                "reason": "missing_organization_id",
                "error": "[missing_organization_id] 缺少组织信息",
                "error_code": "MISSING_ORGANIZATION_ID",
                "error_category": "missing_organization_id",
            }

        _reset_precheck_failures()
        return result

    except Exception as exc:
        if _record_precheck_failure():
            logger.error(
                "[BalanceCheck] 连续预检异常超过阈值(%d)，拒绝请求: %s",
                _PRECHECK_FAIL_THRESHOLD, exc,
            )
            return _blocked_response()
        # P2-01: 检查 fail-open 累计金额上限
        if _is_failopen_amount_exceeded():
            logger.error(
                "[BalanceCheck] fail-open 累计金额超限(%s 点券)，拒绝请求: %s",
                _FAILOPEN_MAX_CUMULATIVE_CREDITS, exc,
            )
            return _blocked_response()
        logger.warning("[BalanceCheck] 预检异常，本次放行: %s", exc)
        _record_failopen_amount()
        _alert_precheck_failopen(user_id, organization_id, exc)
        return None


def _check_organization_balance(user_id: str, organization_id: str, *, model_instance=None) -> Optional[dict]:
    """有 organization_id 时的预检：按 llm_billing_mode 分模式判断。"""
    llm_billing_mode = _get_llm_billing_mode(organization_id)

    if model_instance is not None and _provider_credit_funding_enabled():
        # Provider + Monthly 已能覆盖预估时，不能再因 Wallet 为空而误拦。
        if _estimate_wallet_freeze_credits(organization_id, model_instance) <= 0:
            return None

    has_quota_remaining = False
    if llm_billing_mode in ("quota_then_paygo", "quota_only"):
        has_quota_remaining = _has_organization_quota_remaining(organization_id)

    if llm_billing_mode == "quota_only":
        #  扣费瀑布：① 月度配额剩余 或 ② 持久点券钱包可用 任一 > 0 即放行。
        # _has_wallet_balance 内部已包含 post-charge 余额不足短期阻断的判定。
        if has_quota_remaining:
            return None
        if _has_wallet_balance(user_id, organization_id, model_instance=model_instance):
            return None
        # ①② 均耗尽（或零头不足以支撑本次请求）→ ③ 现金自动补充买点券进钱包（有月上限）。
        # 传入本次所需 required，避免卡在「零头 > 阈值但 < 单次成本」的死区。
        # not_needed 表示锁内复查发现组合余额确实够用（预检缓存过期），直接放行。
        from apps.services.billing.services.llm_topup_service import LlmQuotaTopupService

        required = _estimate_wallet_freeze_credits(organization_id, model_instance)
        topup = LlmQuotaTopupService.try_auto_topup(
            organization_id, trigger="balance_precheck", required_credits=required,
        )
        if topup.get("topped_up") or topup.get("reason") == "not_needed":
            return None
        return _blocked_response(organization=True, topup_reason=str(topup.get("reason", "")))

    if llm_billing_mode == "paygo_only":
        # BIL-15: paygo_only 只查 OrganizationWallet
        if _has_wallet_balance(user_id, organization_id, model_instance=model_instance):
            return None
        return _blocked_response(organization=True)

    # quota_then_paygo: 团队共享月度额度优先；只有预估超出额度的部分才要求团队钱包覆盖。
    paygo_required = _estimate_wallet_freeze_credits(organization_id, model_instance)
    if paygo_required <= 0:
        return None
    if _has_wallet_balance(
        user_id,
        organization_id,
        model_instance=model_instance,
        required_credits=paygo_required,
    ):
        return None
    return _blocked_response(organization=True)


def _get_llm_billing_mode(organization_id: str) -> str:
    """获取组织的 LLM 计费模式，异常时返回默认值。"""
    try:
        from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
        policy = OrganizationBillingPolicyService.get_effective_policy(organization_id)
        return policy.get("llm_billing_mode", OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE)
    except Exception as exc:
        logger.debug("[BalanceCheck] Failed to get llm_billing_mode (using default): %s", exc)
        return "quota_only"


def _get_organization_quota_remaining_credits(organization_id: str) -> Optional[Decimal]:
    """Return remaining shared monthly LLM quota for a organization.

    None means the quota lookup failed and callers should preserve the existing
    fail-open behavior for transient billing infrastructure issues.
    """
    try:
        from apps.services.billing.services.llm_budget_service import OrganizationLlmBudgetService
        return OrganizationLlmBudgetService.get_remaining_quota_credits(organization_id)
    except Exception as exc:
        logger.warning("[BalanceCheck] Monthly budget check exception (allowing per D1): %s", exc)
        return None


def _has_organization_quota_remaining(organization_id: str) -> bool:
    """检查组织月度预算是否有剩余（只读，不加锁）。

    D1: 异常时默认放行，与 check_balance_before_request 异常策略对齐。
    """
    remaining = _get_organization_quota_remaining_credits(organization_id)
    if remaining is None:
        return True
    return remaining > Decimal("0")


def _estimate_wallet_freeze_credits(organization_id: str, model_instance=None) -> Decimal:
    """Estimate only the part of this request that should be covered by wallet.

    Business rule:
    - quota_only: wallet is not used for LLM, so no wallet freeze.
    - paygo_only: all estimated cost is wallet exposure.
    - quota_then_paygo: shared monthly quota covers the request first; only the
      estimated remainder is frozen from the organization wallet.
    """
    estimated = _estimate_freeze_credits(model_instance)
    if not (organization_id or "").strip() or estimated <= 0:
        return Decimal("0")

    mode = _get_llm_billing_mode(organization_id)
    provider_available = _get_provider_credit_available(
        organization_id,
        model_instance,
    )
    estimated_after_provider = max(
        Decimal("0"),
        estimated - provider_available,
    )
    if mode == "paygo_only":
        return estimated_after_provider

    # ：quota_only 现在也会在月度配额耗尽后扣持久点券钱包，
    # 与 quota_then_paygo 同口径——只冻结超出月度配额剩余的钱包部分，防止并发超扣。
    remaining = _get_organization_quota_remaining_credits(organization_id)
    if remaining is None:
        return Decimal("0")
    return max(
        Decimal("0"),
        estimated_after_provider - Decimal(str(remaining or 0)),
    )


def _provider_credit_funding_enabled() -> bool:
    from apps.services.billing.services.provider_credit_service import (
        provider_credit_funding_enabled,
    )

    return provider_credit_funding_enabled()


def _get_provider_credit_available(
    organization_id: str,
    model_instance=None,
) -> Decimal:
    """只按 canonical provider_key + LLMModel UUID 查询可用赠送额度。

    与低余额预警共用 ``resolve_model_provider_credits``，保证冻结估算与告警判定
    对「当前模型还有多少定向点券」是同一个答案。
    """
    from apps.services.billing.services.provider_credit_service import (
        resolve_model_provider_credits,
    )

    return resolve_model_provider_credits(organization_id, model_instance)


def _organization_has_post_charge_insufficient_block(
    organization_id: str,
    *,
    model_instance: Any = None,
) -> bool:
    try:
        from apps.users.wallet.models import OrganizationWallet

        ws_wallet = OrganizationWallet.objects.filter(organization_id=organization_id).first()
        balance = ws_wallet.get_available_credits_precise() if ws_wallet else Decimal("0")
        return _has_post_charge_insufficient_block(
            organization_id,
            balance,
            model_instance=model_instance,
        )
    except Exception:
        return False


def _has_wallet_balance(
    user_id: str,
    organization_id: str,
    *,
    model_instance=None,
    required_credits: Optional[Decimal] = None,
) -> bool:
    """检查 OrganizationWallet 余额是否达到预检放行阈值。

    BIL-16: 仅检查团队钱包；个人钱包不参与团队 LLM 预检。
    """
    from apps.users.wallet.models import OrganizationWallet

    threshold = Decimal(str(
        _get_billing_config("min_balance_threshold", _DEFAULT_MIN_BALANCE_THRESHOLD)
    ))
    if required_credits is not None:
        threshold = max(threshold, Decimal(str(required_credits or 0)))
    elif model_instance is not None:
        try:
            threshold = max(threshold, _estimate_wallet_freeze_credits(organization_id, model_instance))
        except Exception:
            pass

    if organization_id:
        ws_wallet = OrganizationWallet.objects.filter(organization_id=organization_id).first()
        if ws_wallet:
            balance = ws_wallet.get_available_credits_precise()
            if balance >= threshold:
                _maybe_notify_low_balance(organization_id, model_instance=model_instance)
                return True

    return False


def _maybe_notify_low_balance(organization_id: str, *, model_instance=None) -> None:
    """BIL-16: 余额偏低时提前提醒管理员。

    是否触发 / 分级（warning/critical）/ 去重 / 可消耗点券口径全部交给
    LowBalanceAlertService 统一判定，避免预检与扣费后两条链路各算一套。
    Best-effort：失败不影响主流程。
    """
    try:
        from apps.services.billing.services.low_balance_alert_service import (
            LowBalanceAlertService,
        )
        LowBalanceAlertService.check_organization_and_notify(
            organization_id,
            model_instance=model_instance,
            source="agent_conversation",
        )
    except Exception:
        pass


def _blocked_response(*, organization: bool = False, topup_reason: str = "") -> dict:
    """WAL-23: 统一预检失败返回格式。

    BIL-16: organization=True 时返回团队专属错误码，前端据此切换 CTA
    （引导至团队钱包充值而非个人钱包）。
    topup_reason: 点券用尽被拦时自动补充的失败原因
    （auto_topup_disabled / wallet_insufficient / monthly_cap_reached / topup_error），
    前端据此区分引导文案（开启自动补充 / 去充值 / 调整上限）。
    """
    from apps.i18n import _
    if organization:
        # topup_reason 存在 = quota_only「点券用尽」口径，与旧的「钱包余额不足」区分文案
        message = (
            _("wallet.organization_llm_quota_exhausted")
            if topup_reason
            else _("wallet.organization_credits_insufficient")
        )
        blocked: dict = {
            "success": False,
            "blocked": True,
            "reason": "organization_insufficient_credits",
            "error": f"[organization_insufficient_credits] {message}",
            "error_code": "ORGANIZATION_INSUFFICIENT_CREDITS",
            "error_category": "organization_insufficient_credits",
        }
        if topup_reason:
            blocked["topup_reason"] = topup_reason
        return blocked
    return {
        "success": False,
        "blocked": True,
        "reason": "insufficient_credits",
        "error": f"[insufficient_credits] {_('billing.insufficient_credits')}",
        "error_code": "INSUFFICIENT_CREDITS",
        "error_category": "insufficient_credits",
    }


def _report_call_to_runtime(
    llm_service,
    *,
    success: bool,
    response_time: Optional[float] = None,
    error_message: str = "",
) -> None:
    """将 LLM 调用结果汇报给 provider runtime，驱动熔断/恢复判断。

    Best-effort：失败仅 debug 日志，不影响主流程。
    """
    try:
        from .runtime import report_provider_call_result

        model_instance = getattr(llm_service, "model", None)
        provider = getattr(model_instance, "provider", None) if model_instance else None
        if not provider:
            provider = getattr(llm_service, "provider", None)
        if not provider:
            return

        report_provider_call_result(
            provider,
            success=success,
            latency_seconds=response_time,
            error_message=error_message,
        )
    except Exception as exc:
        logger.debug("[billed_call] Runtime feedback failed (non-blocking): %s", exc)


def _estimate_freeze_credits(model_instance) -> Decimal:
    """WAL-07: 估算 billed_llm_call 的预扣费冻结金额。

    基于模型单价和保守的 token 预估量计算，
    模型信息不可用时使用固定 fallback 值。
    """
    fallback = Decimal(str(
        _get_billing_config("freeze_fallback_credits", _DEFAULT_FREEZE_FALLBACK_CREDITS)
    ))
    try:
        from .billing import _safe_decimal
        from django.conf import settings

        if not model_instance:
            return fallback

        input_price = _safe_decimal(getattr(model_instance, "input_price_per_1k", 0))
        output_price = _safe_decimal(getattr(model_instance, "output_price_per_1k", 0))

        if input_price <= 0 and output_price <= 0:
            return fallback

        est_input = int(_get_billing_config("freeze_est_input_tokens", _DEFAULT_FREEZE_ESTIMATED_INPUT_TOKENS))
        est_output = int(_get_billing_config("freeze_est_output_tokens", _DEFAULT_FREEZE_ESTIMATED_OUTPUT_TOKENS))

        estimated_cost = (
            Decimal(est_input) * input_price
            + Decimal(est_output) * output_price
        ) / Decimal("1000")

        credits_rate = int(getattr(settings, "CREDITS_PER_YUAN", 100))
        estimated_credits = estimated_cost * Decimal(credits_rate)

        return max(estimated_credits, fallback)
    except Exception:
        return fallback


def _release_freeze_safely(freeze_id: Optional[str], organization_id: str) -> None:
    """WAL-07: Best-effort 释放冻结，失败不影响主流程。"""
    if not freeze_id or not organization_id:
        return
    try:
        from apps.users.wallet.services.credits_service import CreditsService
        CreditsService.release_frozen_credits(organization_id, freeze_id)
    except Exception as exc:
        logger.warning(
            "[billed_call] WAL-07 冻结释放失败（不影响主流程）: freeze_id=%s err=%s",
            freeze_id, exc,
        )


def _settle_freeze_safely(
    freeze_id: Optional[str],
    organization_id: str,
    model_instance,
    usage: Optional[dict],
) -> None:
    """WAL-07: Best-effort 结算冻结，失败不影响主流程。"""
    if not freeze_id or not organization_id:
        return
    try:
        from apps.users.wallet.services.credits_service import CreditsService
        actual_credits = _estimate_actual_credits(model_instance, usage)
        CreditsService.settle_frozen_credits(organization_id, freeze_id, actual_credits)
    except Exception as exc:
        logger.warning(
            "[billed_call] WAL-07 冻结结算失败（不影响主流程）: freeze_id=%s err=%s",
            freeze_id, exc,
        )


def _estimate_actual_credits(model_instance, usage: Optional[dict]) -> Decimal:
    """粗略估算 LLM 调用的实际 credits 消费，用于冻结结算审计记录。"""
    if not usage:
        return Decimal("0")
    try:
        from .billing import _safe_decimal
        from django.conf import settings

        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)

        input_price = (
            _safe_decimal(getattr(model_instance, "input_price_per_1k", 0))
            if model_instance else Decimal("0")
        )
        output_price = (
            _safe_decimal(getattr(model_instance, "output_price_per_1k", 0))
            if model_instance else Decimal("0")
        )

        cost = (
            Decimal(input_tokens) * input_price
            + Decimal(output_tokens) * output_price
        ) / Decimal("1000")
        credits_rate = int(getattr(settings, "CREDITS_PER_YUAN", 100))
        return cost * Decimal(credits_rate)
    except Exception:
        return Decimal("0")


def safe_charge_usage(
    *,
    llm_service,
    result: dict,
    user_id: str,
    organization_id: str = "",
    source: str,
    biz_id: str = "",
    idempotency_key: str = "",
    scene_key: Optional[str] = None,
) -> bool:
    """计费安全封装：失败仅记日志，不中断主流程。

    适用于不使用 billed_llm_call 的场景（如流式调用、重试循环、并发线程池），
    在 LLM 调用成功后手动调用此函数执行计费。

    Args:
        idempotency_key: 幂等键，防止重试导致重复扣费。建议传入稳定的业务标识。
        scene_key: v0.1 §2.3 LLMUsageFact.scene_key。空时按 source 兜底映射，
            未识别的 source 走 '_main_chat'（主对话兜底）。caller 应尽量显式传入
            正确的 scene_key（4 个 system scene 之一）。

    Returns:
        True — 计费成功；False — 跳过或失败。
    """
    if not user_id or not isinstance(result, dict) or not result.get("success"):
        logger.debug(
            "[%s] Skip billing: user_id=%s, result_type=%s, success=%s",
            source,
            bool(user_id),
            type(result).__name__,
            result.get("success") if isinstance(result, dict) else "N/A",
        )
        return False

    if not (organization_id or "").strip():
        logger.warning(
            "[%s] safe_charge_usage 跳过：organization_id 为空，LLM 已执行但无法计费 "
            "(billing gap): user=%s",
            source, (user_id or "")[:8],
        )
        try:
            from apps.services.billing.services.usage_service import BillingUsageService
            from decimal import Decimal
            _usage = result.get("usage", {}) if isinstance(result, dict) else {}
            _input_t = int(_usage.get('input_tokens', 0) or _usage.get('prompt_tokens', 0) or 0)
            _output_t = int(_usage.get('output_tokens', 0) or _usage.get('completion_tokens', 0) or 0)
            BillingUsageService.record_event(
                organization_id="",
                meter_key="llm.tokens",
                quantity=Decimal(str(_input_t + _output_t)),
                unit="token",
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                user_id=user_id or "",
                biz_type="charge_skipped",
                biz_id=f"safe_charge:no_wt:{source}:{uuid.uuid4()}",
                scene_key=_resolve_billed_scene_key(scene_key, source),
                idempotency_key=f"skipped:no_wt:safe:{idempotency_key or uuid.uuid4()}",
                metadata={"error": "missing_organization_id", "source": source, "path": "safe_charge_usage"},
            )
        except Exception:
            pass
        return False

    # Provider 运行态反馈（best-effort，仅成功路径走到此处）
    _report_call_to_runtime(
        llm_service,
        success=True,
        response_time=result.get("response_time"),
    )

    # T-2: LLM 已执行完毕，即使余额不足也必须记录计费，否则产生免费使用漏洞。
    # 余额预检仅用于标记 charge_failed，不再跳过后续计费流程。
    _balance_insufficient = False
    precheck_block = check_balance_before_request(
        user_id, organization_id,
        model_instance=getattr(llm_service, "model", None),
    )
    if precheck_block:
        logger.warning(
            "[%s] 余额预检失败但 LLM 已执行，继续计费: user=%s wt=%s",
            source, user_id[:8] if user_id else "", (organization_id or "")[:8],
        )
        _balance_insufficient = True

    try:
        from .billing import charge_llm_usage
        effective_biz_id = biz_id or f"{source}:{uuid.uuid4()}"
        stable_key = idempotency_key or effective_biz_id
        req_id = f"sc:{stable_key}"
        charge_llm_usage(
            user_id=user_id,
            organization_id=organization_id,
            model_instance=getattr(llm_service, "model", None),
            usage=result.get("usage"),
            request_id=req_id,
            source=source,
            biz_id=effective_biz_id,
            idempotency_key=stable_key,
            scene_key=_resolve_billed_scene_key(scene_key, source),
        )
        _record_usage_fact_for_billed_call(
            request_id=req_id,
            user_id=user_id,
            organization_id=organization_id,
            model_instance=getattr(llm_service, "model", None),
            usage=result.get("usage"),
            scene_key=_resolve_billed_scene_key(scene_key, source),
            capability_domain="chat",
        )
        return True
    except Exception as exc:
        logger.warning("[%s] Billing failed (non-blocking): %s", source, exc)
        try:
            from apps.services.billing.services.usage_service import BillingUsageService
            from decimal import Decimal
            _req_id = f"safe_charge:{source}:{uuid.uuid4()}"
            _usage = result.get("usage", {}) if isinstance(result, dict) else {}
            _input_t = int(_usage.get('input_tokens', 0) or _usage.get('prompt_tokens', 0) or 0)
            _output_t = int(_usage.get('output_tokens', 0) or _usage.get('completion_tokens', 0) or 0)
            BillingUsageService.record_event(
                organization_id=organization_id or "",
                meter_key="llm.tokens",
                quantity=Decimal(str(_input_t + _output_t)),
                unit="token",
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                user_id=user_id or "",
                biz_type="charge_failed",
                biz_id=biz_id or _req_id,
                scene_key=_resolve_billed_scene_key(scene_key, source),
                idempotency_key=f"failed:safe_charge:{idempotency_key or _req_id}",
                metadata={
                    "error": str(exc)[:500],
                    "source": source,
                    "path": "safe_charge_usage",
                    "input_tokens": _input_t,
                    "output_tokens": _output_t,
                },
            )
        except Exception:
            pass
        try:
            from apps.services.billing.services.degradation_tracker import track_billing_degradation
            track_billing_degradation(meter_key="llm.billing", organization_id=organization_id or "", biz_type=source, error=str(exc))
        except Exception:
            pass
        return False


def billed_llm_call(
    *,
    llm_service,
    messages: List[Dict[str, Any]],
    user_id: str,
    organization_id: str = "",
    source: str = "billed_call",
    biz_id: str = "",
    idempotency_key: str = "",
    skip_billing: bool = False,
    skip_precheck: bool = False,
    scene_key: Optional[str] = None,
    **chat_kwargs,
) -> Dict[str, Any]:
    """统一的"预检 → 调用 → 计费"封装。

    Args:
        llm_service: BaseLLMService 实例（已通过 get_llm_service 创建）。
        messages: 标准消息列表。
        user_id: 发起调用的用户 ID。
        organization_id: 工作空间 ID（强烈建议提供）。
        source: 计费来源标识，如 ``"chat_default"`` / ``"summarization"``。
        biz_id: 业务 ID，用于计费追踪。
        idempotency_key: 幂等键，防止重复扣费。
        skip_billing: 设为 True 跳过计费（仅限健康检查等内部场景）。
        skip_precheck: 设为 True 跳过内部的 budget+balance 预检（当调用方已通过
            ``billing_precheck()`` 完成四层预检时使用，避免重复检查）。
        scene_key: v0.1 §2.3 LLMUsageFact.scene_key。空时按 source 兜底映射到
            4 个 system scene 之一（未识别 → '_main_chat'）。
        **chat_kwargs: 透传给 ``llm_service.chat()`` 的参数。

    Returns:
        dict — 正常时为 llm_service.chat() 的原始返回值，额外注入 ``billing_result`` 键。
        余额不足时返回 ``build_precheck_error()`` 结构（含 error_code=INSUFFICIENT_CREDITS）；
        预算超限时返回 ``build_budget_error()`` 结构（含 error_code=BUDGET_EXCEEDED）。
        调用方应通过 ``result.get("success")`` 或 ``result.get("error_code")`` 判断结果。
    """
    # T1: 兼容旧参数名 skip_balance_check → skip_precheck
    if "skip_balance_check" in chat_kwargs:
        skip_precheck = skip_precheck or chat_kwargs.pop("skip_balance_check")

    from .billing import charge_llm_usage, check_budget_before_request, BudgetExceededException

    if not skip_billing and not (organization_id or "").strip():
        logger.warning(
            "[billed_llm_call] organization_id 为空，拒绝 LLM 调用: user=%s source=%s",
            (user_id or "")[:8], source,
        )
        return build_precheck_error(
            error="[missing_organization_id] 缺少组织信息，无法执行 LLM 调用",
            error_code="MISSING_ORGANIZATION_ID",
            error_category="missing_organization_id",
        )

    request_id = str(uuid.uuid4())

    _provider_key = ""
    _model_name = ""
    try:
        _model_obj = getattr(llm_service, "model", None)
        if _model_obj:
            _provider_key = getattr(getattr(_model_obj, "provider", None), "provider_key", "") or ""
            _model_name = getattr(_model_obj, "model_name", "") or ""
    except Exception:
        pass

    # ── 0. 设置 LLM 请求上下文（贯穿 chat → _do_chat → Provider） ──
    from apps.services.llm.context import set_llm_request_context, reset_llm_request_context

    agent_trace_id = None
    try:
        from apps.services.common.observability.trace import get_current_trace_id
        _tid = get_current_trace_id()
        if _tid:
            agent_trace_id = str(_tid)
    except Exception:
        pass

    ctx_tokens = set_llm_request_context(
        request_id=request_id,
        trace_id=agent_trace_id,
        source=source,
    )
    try:
        # ── 1. 预检 ──
        if not skip_billing and not skip_precheck:
            budget_block = check_budget_before_request(
                organization_id,
                model_instance=getattr(llm_service, "model", None),
            )
            if budget_block:
                llm_calls_total.labels(provider=_provider_key, model_family=_model_to_family(_model_name), source=source, status="budget_blocked").inc()
                return build_budget_error(billing_result=budget_block)

            balance_block = check_balance_before_request(
                user_id, organization_id,
                model_instance=getattr(llm_service, "model", None),
            )
            if balance_block:
                llm_calls_total.labels(provider=_provider_key, model_family=_model_to_family(_model_name), source=source, status="balance_blocked").inc()
                return build_precheck_error(billing_result=balance_block)

        # ── 1.5 BYOK 防护 ──
        model_instance = getattr(llm_service, "model", None)
        _is_byok = False
        if model_instance and not skip_billing:
            from .billing import _is_byok_provider
            if _is_byok_provider(model_instance):
                _is_byok = True
                from .byok_guard import check_byok_rate_limit
                byok_block = check_byok_rate_limit(
                    user_id=user_id,
                    organization_id=organization_id,
                    provider_key=getattr(
                        getattr(model_instance, "provider", None),
                        "provider_key", "",
                    ),
                )
                if byok_block:
                    return byok_block

        # ── 1.8 WAL-07: 预扣费冻结 ──
        _freeze_id = None
        _freeze_organization_id = None
        if not skip_billing and not skip_precheck and not _is_byok and organization_id:
            _estimated_credits = _estimate_wallet_freeze_credits(organization_id, model_instance)
            _candidate_freeze_id = f"freeze:billed:{request_id}"
            try:
                from apps.users.wallet.services.credits_service import CreditsService as _FreezeCS
                _frozen = True
                if _estimated_credits > 0:
                    _frozen = _FreezeCS.freeze_credits_for_llm(
                        organization_id, _estimated_credits, _candidate_freeze_id,
                    )
                if _frozen:
                    if _estimated_credits > 0:
                        _freeze_id = _candidate_freeze_id
                        _freeze_organization_id = organization_id
                else:
                    #  冻结兜底：quota_only 下先尝试现金自动补充一档再重试一次
                    # 冻结，覆盖「预检通过后钱包被并发耗尽 / 实际预估高于预检口径」的
                    # 竞态；非 quota_only / 未开自动补充 / 补充失败则维持 freeze_blocked。
                    from apps.services.billing.services.llm_topup_service import LlmQuotaTopupService

                    _topup = LlmQuotaTopupService.try_auto_topup(
                        organization_id, trigger="freeze_retry", required_credits=_estimated_credits,
                    )
                    if _topup.get("topped_up") and _FreezeCS.freeze_credits_for_llm(
                        organization_id, _estimated_credits, _candidate_freeze_id,
                    ):
                        _freeze_id = _candidate_freeze_id
                        _freeze_organization_id = organization_id
                    else:
                        llm_calls_total.labels(
                            provider=_provider_key,
                            model_family=_model_to_family(_model_name),
                            source=source,
                            status="freeze_blocked",
                        ).inc()
                        return build_precheck_error()
            except Exception as _freeze_exc:
                logger.warning(
                    "[billed_llm_call][%s] WAL-07 冻结异常（放行）: %s",
                    request_id, _freeze_exc,
                )

        # ── 2. LLM 调用 ──
        _call_start = time.perf_counter()
        try:
            result = llm_service.chat(messages=messages, **chat_kwargs)
        except Exception as exc:
            _call_elapsed = time.perf_counter() - _call_start
            llm_call_duration_seconds.labels(provider=_provider_key, model_family=_model_to_family(_model_name)).observe(_call_elapsed)
            llm_calls_total.labels(provider=_provider_key, model_family=_model_to_family(_model_name), source=source, status="error").inc()
            llm_errors_total.labels(provider=_provider_key, model_family=_model_to_family(_model_name), error_category="exception").inc()
            _report_call_to_runtime(
                llm_service,
                success=False,
                response_time=_call_elapsed,
                error_message=str(exc)[:500],
            )
            _release_freeze_safely(_freeze_id, _freeze_organization_id)
            raise

        # ── 2.1 Provider 运行态反馈 + Prometheus ──
        _is_success = bool(result.get("success"))
        _call_elapsed = time.perf_counter() - _call_start
        llm_call_duration_seconds.labels(provider=_provider_key, model_family=_model_to_family(_model_name)).observe(_call_elapsed)
        llm_calls_total.labels(
            provider=_provider_key, model_family=_model_to_family(_model_name), source=source,
            status="success" if _is_success else "failed",
        ).inc()
        _report_call_to_runtime(
            llm_service,
            success=_is_success,
            response_time=result.get("response_time"),
            error_message=(result.get("error") or "")[:500] if not _is_success else "",
        )

        # ── 3. 计费 + 用量记录 ──
        model_instance = getattr(llm_service, "model", None)
        if skip_billing:
            billing_result = {"charged": False, "skipped": True, "reason": "skip_billing", "request_id": request_id}
            _release_freeze_safely(_freeze_id, _freeze_organization_id)
        elif not result.get("success"):
            billing_result = {"charged": False, "skipped": True, "reason": "llm_call_failed", "request_id": request_id}
            _release_freeze_safely(_freeze_id, _freeze_organization_id)
            try:
                _record_usage_fact_for_billed_call(
                    request_id=request_id,
                    user_id=user_id,
                    organization_id=organization_id,
                    model_instance=model_instance,
                    usage=result.get("usage"),
                    scene_key=_resolve_billed_scene_key(scene_key, source),
                    capability_domain="chat",
                    status="failed",
                    error_code=result.get("error_code") or "",
                )
            except Exception:
                pass
        else:
            billing_result = {"charged": False, "request_id": request_id}

        if not skip_billing and result.get("success"):
            usage = result.get("usage")
            try:
                charge_result = charge_llm_usage(
                    user_id=user_id,
                    organization_id=organization_id,
                    model_instance=model_instance,
                    usage=usage,
                    request_id=request_id,
                    source=source,
                    biz_id=biz_id or f"{source}:{request_id}",
                    idempotency_key=idempotency_key or f"{source}:{request_id}",
                    billing_metadata=(
                        {"freeze_id": _freeze_id} if _freeze_id else None
                    ),
                    scene_key=_resolve_billed_scene_key(scene_key, source),
                )
                if not charge_result:
                    raise RuntimeError("charge_llm_usage returned empty result")
                billing_result = {"charged": bool(charge_result), "request_id": request_id}
                _record_usage_fact_for_billed_call(
                    request_id=request_id,
                    user_id=user_id,
                    organization_id=organization_id,
                    model_instance=model_instance,
                    usage=usage,
                    scene_key=_resolve_billed_scene_key(scene_key, source),
                    capability_domain="chat",
                )
                _settle_freeze_safely(_freeze_id, _freeze_organization_id, model_instance, usage)
            except BudgetExceededException as exc:
                logger.warning(
                    "[billed_llm_call][%s] Budget exceeded post-call, blocking result: %s",
                    request_id, exc,
                )
                _release_freeze_safely(_freeze_id, _freeze_organization_id)
                return build_budget_error(
                    billing_result={"blocked_post_call": True, "request_id": request_id},
                )
            except Exception as exc:
                logger.warning(
                    "[billed_llm_call][%s] Billing failed (non-blocking): %s",
                    request_id, exc,
                )
                _release_freeze_safely(_freeze_id, _freeze_organization_id)
                try:
                    from apps.services.billing.services.degradation_tracker import track_billing_degradation
                    track_billing_degradation(meter_key="llm.billing", organization_id=organization_id, biz_type=source, error=str(exc))
                except Exception:
                    pass
                billing_result = {"charged": False, "error": str(exc), "request_id": request_id}
                try:
                    _record_usage_fact_for_billed_call(
                        request_id=request_id,
                        user_id=user_id,
                        organization_id=organization_id,
                        model_instance=model_instance,
                        usage=usage,
                        scene_key=_resolve_billed_scene_key(scene_key, source),
                        capability_domain="chat",
                        status="failed",
                        error_code="BILLING_CHARGE_FAILED",
                    )
                except Exception:
                    pass
                return {
                    "success": False,
                    "error": "[billing_charge_failed] LLM 调用已完成但扣费失败，结果未交付。请稍后重试。",
                    "error_code": "BILLING_CHARGE_FAILED",
                    "error_category": "billing_charge_failed",
                    "request_id": request_id,
                    "billing_result": {
                        **billing_result,
                        "error_code": "BILLING_CHARGE_FAILED",
                        "error_category": "billing_charge_failed",
                    },
                }

        result["billing_result"] = billing_result
        return result
    finally:
        reset_llm_request_context(ctx_tokens)


def _record_usage_fact_for_billed_call(
    *,
    request_id: str,
    user_id: str,
    organization_id: str,
    model_instance,
    usage: Optional[dict],
    scene_key: str = "_main_chat",
    capability_domain: str = "chat",
    status: str = "completed",
    error_code: str = "",
    context_tier_id: Optional[str] = None,
) -> None:
    """将 LLM 调用结果写入 LLMUsageFact，供 safe_charge_usage / billed_llm_call 使用。

    失败调用（status != "completed"）仅记录 token 用量、不计入成本，
    用于统计失败率和 provider 健康状况。

    宪法 v0.1 §5.6 / §6 必填字段（v0.1 修复 Wave B2）：
        - scene_key（默认 '_main_chat' 主对话路径，proxy_service 应显式覆盖）
        - capability_domain（默认 'chat'）
        - effective_provider_scope（从 model.provider.scope 取）
        - cost_status（按 BYOK 状态推算）
    """
    try:
        from decimal import Decimal
        from .usage_tracking import (
            derive_scope_and_cost_status,
            record_usage_fact_from_dict_safely,
        )
        from .billing import (
            _safe_decimal,
            compute_tier_token_cost,
            resolve_tiered_pricing,
        )

        usage = usage or {}
        model_id = str(getattr(model_instance, "id", "") or "") or None
        provider_obj = getattr(model_instance, "provider", None) if model_instance else None

        _input_tokens = int(usage.get("input_tokens") or 0)
        _output_tokens = int(usage.get("output_tokens") or 0)
        _total_tokens = int(usage.get("total_tokens") or 0)
        _cache_read = int(usage.get("cache_read_input_tokens") or 0)
        _cache_write = int(usage.get("cache_creation_input_tokens") or 0)

        input_cost = Decimal("0")
        output_cost = Decimal("0")
        _is_byok_for_cost = False
        if model_instance:
            from .billing import _is_byok_provider
            _is_byok_for_cost = _is_byok_provider(model_instance)

        # 宪法 §4.2 + §5.6：BYOK 路径 LLMUsageFact.total_cost 仍记"等价平台定价"
        # （AdminDash /ai-ops/usage 节省 panel 用 SUM(total_cost) WHERE
        # cost_status='byok_self_paid' 直接计算节省金额）。是否真扣钱包由
        # cost_status 决定，与 input_cost / output_cost 计算无关。
        # 因此 BYOK + completed 路径也要走完整价格计算（model.input_price_per_1k
        # 等单价就是平台等价定价）。
        if model_instance and status == "completed":
            input_price = _safe_decimal(getattr(model_instance, "input_price_per_1k", 0))
            output_price = _safe_decimal(getattr(model_instance, "output_price_per_1k", 0))

            custom_billing_config = getattr(model_instance, "custom_billing_config", {}) or {}
            base_input = max(_input_tokens - _cache_read - _cache_write, 0)
            billable_input = base_input + _cache_read + _cache_write

            tier = resolve_tiered_pricing(
                custom_billing_config, billable_input, tier_id=context_tier_id,
            )
            if tier:
                input_price = _safe_decimal(tier.get("input_price_per_1k"), default=input_price)
                output_price = _safe_decimal(tier.get("output_price_per_1k"), default=output_price)

            cache_read_price = _safe_decimal(
                (tier or {}).get("cache_hit_price_per_1k")
                or custom_billing_config.get("cache_read_input_price_per_1k"),
                default=input_price,
            )
            cache_write_price = _safe_decimal(
                (tier or {}).get("cache_creation_price_per_1k")
                or custom_billing_config.get("cache_write_input_price_per_1k"),
                default=input_price,
            )

            # 档内分裂（applies_above_tokens + over_*_price）：input/output 走精确分段
            split_input_cost: Optional[Decimal] = None
            split_output_cost: Optional[Decimal] = None
            if tier and tier.get("applies_above_tokens") is not None and (
                tier.get("over_input_price_per_1k") is not None
                or tier.get("over_output_price_per_1k") is not None
            ):
                split_input_cost = compute_tier_token_cost(
                    tier, base_input, direction="input", fallback_price=input_price,
                )
                split_output_cost = compute_tier_token_cost(
                    tier, _output_tokens, direction="output", fallback_price=output_price,
                )

            if split_input_cost is not None:
                input_cost = (
                    split_input_cost
                    + (Decimal(_cache_read) * cache_read_price) / Decimal("1000")
                    + (Decimal(_cache_write) * cache_write_price) / Decimal("1000")
                )
            else:
                input_cost = (
                    Decimal(base_input) * input_price
                    + Decimal(_cache_read) * cache_read_price
                    + Decimal(_cache_write) * cache_write_price
                ) / Decimal("1000")

            if split_output_cost is not None:
                output_cost = split_output_cost
            else:
                output_cost = (Decimal(_output_tokens) * output_price) / Decimal("1000")

        scope, cost_status = derive_scope_and_cost_status(model_instance, status)
        # BYOK 路径 total_cost 仍记录"等价平台定价"（节省 panel 用），
        # 但 cost_status='byok_self_paid' 标记不真实扣钱包。
        record_usage_fact_from_dict_safely(
            request_id=request_id,
            scene_key=scene_key,
            capability_domain=capability_domain,
            effective_provider_scope=scope,
            cost_status=cost_status,
            user_id=user_id,
            organization_id=organization_id,
            model_id=model_id,
            provider_key=getattr(provider_obj, "provider_key", "") or "",
            model_name=getattr(model_instance, "model_name", "") or "",
            input_tokens=_input_tokens,
            output_tokens=_output_tokens,
            total_tokens=_total_tokens,
            cache_read_input_tokens=_cache_read,
            cache_creation_input_tokens=_cache_write,
            input_cost=input_cost,
            output_cost=output_cost,
            total_cost=input_cost + output_cost,
            status=status,
            error_code=error_code,
            usage_estimated=bool(usage.get("estimated") or usage.get("usage_estimated")),
        )

        if status == "completed" and model_instance and _is_byok_for_cost:
            from .byok_guard import record_byok_token_usage
            _effective_total = _total_tokens or (_input_tokens + _output_tokens)
            record_byok_token_usage(user_id, organization_id, _effective_total)

        # ── Prometheus 用量指标 ──
        try:
            _pk = getattr(provider_obj, "provider_key", "") or ""
            _mn = getattr(model_instance, "model_name", "") or ""
            _mf = _model_to_family(_mn)
            if _input_tokens > 0:
                llm_tokens_total.labels(provider=_pk, model_family=_mf, direction="input").inc(_input_tokens)
            if _output_tokens > 0:
                llm_tokens_total.labels(provider=_pk, model_family=_mf, direction="output").inc(_output_tokens)
            if _cache_read > 0:
                llm_cache_tokens_total.labels(provider=_pk, model=_mn, type="read").inc(_cache_read)
            if _cache_write > 0:
                llm_cache_tokens_total.labels(provider=_pk, model=_mn, type="write").inc(_cache_write)
            # llm_cost_credits_total 仅累计真实平台扣费金额：BYOK 路径
            # cost_status='byok_self_paid' 不真实扣钱包，应排除以避免指标虚高。
            if not _is_byok_for_cost:
                _tc = float(input_cost + output_cost)
                if _tc > 0:
                    llm_cost_credits_total.labels(provider=_pk, model=_mn).inc(_tc)
            if status == "failed" and error_code:
                from .usage_tracking import classify_error_category
                _ecat = classify_error_category(error_code, "")
                if _ecat:
                    llm_errors_total.labels(provider=_pk, model_family=_mf, error_category=_ecat).inc()
        except Exception:
            pass

    except Exception as exc:
        logger.warning("[billed_call] Failed to record LLMUsageFact: %s", exc)
        try:
            from apps.services.billing.services.degradation_tracker import track_billing_degradation
            track_billing_degradation(
                meter_key="llm.usage_fact",
                organization_id=organization_id or "",
                biz_type="billed_call",
                error=str(exc),
            )
        except Exception:
            pass
