"""
LLM 计费服务
"""

from __future__ import annotations

from typing import Any, Dict, Optional
from decimal import Decimal, InvalidOperation
import logging

from django.db import DatabaseError, OperationalError, models

from django.conf import settings as _settings

from apps.services.billing.exceptions import BillingError
from apps.services.billing.models import BillingBudgetPolicy
from apps.services.llm.models import LLMModel

logger = logging.getLogger(__name__)

USAGE_SOURCE_PROVIDER_FINAL = "provider_final"
USAGE_SOURCE_PROVIDER_PARTIAL = "provider_partial"
USAGE_SOURCE_ESTIMATED_INTERRUPTED = "estimated_interrupted"

_BUDGET_ALERT_DEDUP_TTL = {
    "critical": getattr(_settings, "BILLING_BUDGET_ALERT_DEDUP_TTL_CRITICAL", 3600),
    "warning": getattr(_settings, "BILLING_BUDGET_ALERT_DEDUP_TTL_WARNING", 14400),
}

try:
    from apps.users.wallet.exceptions import InsufficientCreditsError as _InsufficientCreditsErrorType
except ImportError:
    _InsufficientCreditsErrorType = type(None)


_PROVIDER_CACHE_DISCOUNT: Dict[str, Dict[str, Decimal]] = {
    "anthropic": {"cache_read_ratio": Decimal("0.1"), "cache_write_ratio": Decimal("1.25")},
    "claude": {"cache_read_ratio": Decimal("0.1"), "cache_write_ratio": Decimal("1.25")},
    "openai": {"cache_read_ratio": Decimal("0.5"), "cache_write_ratio": Decimal("1.0")},
    "google": {"cache_read_ratio": Decimal("0.25"), "cache_write_ratio": Decimal("1.0")},
    "gemini": {"cache_read_ratio": Decimal("0.25"), "cache_write_ratio": Decimal("1.0")},
    "deepseek": {"cache_read_ratio": Decimal("0.1"), "cache_write_ratio": Decimal("1.0")},
}


class BudgetExceededException(BillingError):
    """预算超限异常，当工作空间达到严重阈值且启用硬阻断时抛出。"""

    def __init__(self, organization_id: str, budget_status: str):
        self.organization_id = organization_id
        self.budget_status = budget_status
        super().__init__(
            f"工作空间 {organization_id} 已达预算严重阈值，请求被阻断",
            code="BUDGET_EXCEEDED",
        )


def _notify_budget_alert(
    organization_id: str,
    level: str,
    usage_percent: Decimal,
    budget_limit: Decimal,
    *,
    blocking: bool = False,
    wallet_paygo_available: bool = False,
) -> None:
    """异步触发预算告警通知，同级别同月内仅通知一次（R11: 加月份维度防跨月去重误杀）。"""
    try:
        from django.core.cache import cache
        from django.utils import timezone as _tz

        _month_tag = _tz.now().strftime("%Y%m")
        dedup_key = f"llm:budget_notified:{organization_id}:{level}:{_month_tag}"
        if cache.get(dedup_key):
            return
        ttl = _BUDGET_ALERT_DEDUP_TTL.get(level, 7200)
        cache.set(dedup_key, True, ttl)

        from apps.extensions.event_bus import Event, EventBus

        EventBus.emit(Event(
            source="billing",
            event_type=f"billing.budget_{level}",
            organization_id=organization_id,
            payload={
                "level": level,
                "usage_percent": float(usage_percent),
                "budget_limit": float(budget_limit),
                "blocking": blocking,
                "wallet_paygo_available": wallet_paygo_available,
                "message": (
                    f"工作空间预算已使用 {float(usage_percent):.1f}%"
                    f"（预算上限 {float(budget_limit)} credits），"
                    + (
                        "套餐内额度已用完，后续将从组织钱包扣费。"
                        if wallet_paygo_available and not blocking
                        else (
                            "后续 LLM 请求将被阻断，请立即调整预算或充值！"
                            if level == "critical"
                            else "建议关注用量趋势，及时调整预算。"
                        )
                    )
                ),
            },
        ))

        try:
            from apps.services.billing.ws_events import publish_billing_event
            publish_billing_event(organization_id, f"budget_{level}", {
                "usage_percent": float(usage_percent),
                "budget_limit": float(budget_limit),
                "blocking": blocking,
                "wallet_paygo_available": wallet_paygo_available,
            })
        except Exception as ws_exc:
            logger.warning("[Budget] WS 推送 budget_%s 失败: %s", level, ws_exc)

        logger.info(
            "[Budget] 已发送 %s 级别告警通知 organization=%s usage=%.1f%%",
            level, organization_id, usage_percent,
        )
    except Exception as exc:
        logger.warning("[Budget] 告警通知发送失败: %s", exc)


def invalidate_budget_policy_cache(organization_id: str) -> None:
    """主动清除指定工作空间的预算策略缓存。

    适用场景：
    - 管理员修改 BillingBudgetPolicy 时（通过 post_save 信号调用）
    - 管理员修改 OrganizationLlmMonthlyBudget 时
    - 充值成功后立即解除预算阻断

    不会引发异常，缓存服务不可用时静默忽略。
    """
    if not organization_id:
        return
    try:
        from django.core.cache import cache
        cache.delete_many([
            f"llm:budget_policy:{organization_id}",
            f"llm:block_on_critical:{organization_id}",
        ])
        logger.info("[Budget] 已清除 organization=%s 的预算策略缓存（budget_policy + block_on_critical）", organization_id)
    except Exception as exc:
        logger.warning("[Budget] 清除预算策略缓存失败: %s", exc)


def check_budget_policy(organization_id: str) -> Optional[str]:
    """
    检查工作空间的 LLM 用量预算策略。

    Returns:
        None: 未超预算
        'warning': 达到预警阈值
        'critical': 达到严重阈值

    缓存策略：
    - critical: 5s（管理员调整策略后调用 invalidate_budget_policy_cache 可立即生效）
    - warning: 30s
    - 未超限: 60s

    BILLING_BUDGET_ALERTS_ENABLED=False 时整条告警链路短路（不发 WS、不建告警、不硬阻断）。
    """
    if not organization_id:
        return None

    from django.conf import settings as django_settings

    if not getattr(django_settings, "BILLING_BUDGET_ALERTS_ENABLED", False):
        return None

    try:
        from django.core.cache import cache
        from django.utils import timezone

        cache_key = f"llm:budget_policy:{organization_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached if cached != '__none__' else None

        policy = BillingBudgetPolicy.objects.filter(
            organization_id=organization_id,
            is_active=True,
        ).first()

        if not policy:
            cache.set(cache_key, '__none__', 300)
            return None

        from datetime import date as _date
        from apps.services.billing.models import OrganizationLlmMonthlyBudget

        now = timezone.now()
        cycle_month = _date(now.year, now.month, 1)
        budget_record = OrganizationLlmMonthlyBudget.objects.filter(
            organization_id=organization_id,
            cycle_month=cycle_month,
        ).first()

        if not budget_record:
            cache.set(cache_key, '__none__', 300)
            return None

        consumed_credits = budget_record.consumed_credits or Decimal('0')

        # XM-16: 优先使用 BillingBudgetPolicy.budget_limit_credits 作为预算分母，
        # 解决 free tier included_credits=0 时预算告警永不触发的问题。
        budget_limit = Decimal('0')
        explicit_limit = getattr(policy, 'budget_limit_credits', None)
        if explicit_limit is not None and Decimal(str(explicit_limit)) > 0:
            budget_limit = Decimal(str(explicit_limit))
        else:
            budget_limit = budget_record.included_credits or Decimal('0')

        if budget_limit <= 0:
            cache.set(cache_key, '__none__', 300)
            return None

        usage_percent = (consumed_credits / budget_limit) * 100

        result = None
        if usage_percent >= policy.critical_threshold_percent:
            result = 'critical'
            logger.warning(
                "[Budget] 工作空间 %s 达到严重阈值: %.1f%% (阈值: %s%%)",
                organization_id, usage_percent, policy.critical_threshold_percent,
            )
        elif usage_percent >= policy.warning_threshold_percent:
            result = 'warning'
            logger.info(
                "[Budget] 工作空间 %s 达到预警阈值: %.1f%% (阈值: %s%%)",
                organization_id, usage_percent, policy.warning_threshold_percent,
            )

        wallet_positive = False
        wallet_paygo_available = False
        blocking = False
        if result == 'critical':
            try:
                from apps.services.billing.services.guard_service import BillingGuardService
                wallet_positive = BillingGuardService._wallet_has_positive_balance(organization_id)
                wallet_paygo_available = (
                    wallet_positive
                    and _get_llm_billing_mode(organization_id) != "quota_only"
                )
                blocking = bool(policy.block_on_critical) and not wallet_paygo_available
                if wallet_positive:
                    logger.info(
                        "[Budget] 工作空间 %s 达到 critical 但钱包余额充足，跳过创建 blocking alert",
                        organization_id,
                    )
                else:
                    from apps.services.billing.models import BillingAnomalyAlert
                    existing = BillingAnomalyAlert.objects.filter(
                        organization_id=organization_id,
                        alert_type='pattern',
                        metric_name='budget_critical',
                        severity='critical',
                        is_resolved=False,
                    ).first()
                    if not existing:
                        BillingAnomalyAlert.objects.create(
                            alert_type='pattern',
                            severity='critical',
                            organization_id=organization_id,
                            metric_name='budget_critical',
                            current_value=usage_percent,
                            baseline_value=budget_limit,
                            threshold_ratio=policy.critical_threshold_percent,
                            message=(
                                f"工作空间 {organization_id} LLM 预算已使用 "
                                f"{float(usage_percent):.1f}%，"
                                f"达到严重阈值 {policy.critical_threshold_percent}%"
                            ),
                        )
            except Exception as alert_exc:
                logger.warning("[Budget] 创建预算 critical 告警失败: %s", alert_exc)

        if result:
            _notify_budget_alert(
                organization_id,
                result,
                usage_percent,
                budget_limit,
                blocking=blocking,
                wallet_paygo_available=wallet_paygo_available,
            )

        _prev_alert_key = f"llm:budget_last_alert_level:{organization_id}"
        previous_alert_level = cache.get(_prev_alert_key)

        if result in ('warning', 'critical'):
            cache.set(_prev_alert_key, result, 7200)
        elif previous_alert_level in ('warning', 'critical'):
            cache.delete(_prev_alert_key)
            try:
                from apps.services.billing.services.guard_service import BillingGuardService
                BillingGuardService.publish_budget_resolved(
                    organization_id,
                    previous_level=previous_alert_level,
                    current_percent=float(usage_percent) if budget_limit > 0 else 0,
                )
            except Exception as resolve_exc:
                logger.warning("[Budget] publish_budget_resolved 失败: %s", resolve_exc)

        if result == 'critical':
            cache.set(cache_key, result, 5)
        elif result == 'warning':
            cache.set(cache_key, result, 30)
        else:
            cache.set(cache_key, '__none__', 60)
        return result

    except (DatabaseError, OperationalError) as exc:
        logger.error("[Budget] 数据库异常，预算检查降级放行: %s", exc)
        try:
            from apps.services.billing.services.degradation_tracker import track_billing_degradation
            track_billing_degradation(meter_key="budget.check", error=str(exc))
        except Exception:
            pass
        return None
    except Exception as exc:
        logger.warning("[Budget] 预算策略检查异常: %s", exc)
        return None


def _get_block_on_critical_cached(organization_id: str) -> bool:
    """获取工作空间 BillingBudgetPolicy.block_on_critical，带 30s 缓存。

    LLM-26: 避免 check_budget_before_request 和 charge_llm_usage
    各自重复查询 BillingBudgetPolicy 全表。
    """
    if not organization_id:
        return False
    try:
        from django.core.cache import cache
        cache_key = f"llm:block_on_critical:{organization_id}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached is True
        policy = BillingBudgetPolicy.objects.filter(
            organization_id=organization_id,
            is_active=True,
        ).only("block_on_critical").first()
        result = bool(policy and policy.block_on_critical)
        cache.set(cache_key, result, 30)
        return result
    except Exception as exc:
        logger.warning("[Budget] _get_block_on_critical_cached 异常: %s", exc)
        return False


def _get_llm_billing_mode(organization_id: str) -> str:
    """Return the effective LLM billing mode for the organization."""
    try:
        from apps.services.billing.services.policy_service import OrganizationBillingPolicyService
        policy = OrganizationBillingPolicyService.get_effective_policy(organization_id)
        return str(policy.get("llm_billing_mode") or OrganizationBillingPolicyService.DEFAULT_LLM_BILLING_MODE)
    except Exception as exc:
        logger.debug("[Budget] 获取 llm_billing_mode 失败，使用默认 quota_only: %s", exc)
        return "quota_only"


def _can_continue_with_paygo_wallet(organization_id: str, *, model_instance=None) -> bool:
    """Whether a critical budget can fall through to wallet paygo billing.

    In quota_then_paygo/paygo_only modes, monthly budget exhaustion is a warning
    boundary, not a hard stop, as long as the organization wallet can cover the same
    estimated freeze amount used by the later balance/freeze checks.
    """
    if not (organization_id or "").strip():
        return False
    if _get_llm_billing_mode(organization_id) == "quota_only":
        return False
    try:
        from apps.services.llm.services.billed_call import _has_wallet_balance
        return _has_wallet_balance("", organization_id, model_instance=model_instance)
    except Exception as exc:
        logger.warning("[Budget] 检查 paygo 钱包余额失败: %s", exc)
        return False


def _build_guard_block_payload(guard_block) -> dict:
    """Build a semantic budget-precheck payload from BillingGuardService block."""
    block_type = getattr(guard_block, "block_type", "") or "billing_guard_blocked"
    reason = getattr(guard_block, "reason", "") or "billing_guard_blocked"
    if block_type == "membership_expired":
        error_code = "MEMBERSHIP_EXPIRED"
        error_category = "membership_expired"
    else:
        error_code = "BILLING_GUARD_BLOCKED"
        error_category = block_type
    return {
        'blocked': True,
        'reason': block_type,
        'budget_status': 'critical',
        'detail': reason,
        'block_type': block_type,
        'error_code': error_code,
        'error_category': error_category,
    }


def check_budget_before_request(
    organization_id: str,
    *,
    skip_guard: bool = False,
    model_instance=None,
) -> Optional[dict]:
    """在发起 LLM 请求前检查预算状态，用于 API 端点的前置拦截。

    同时检查 BillingGuardService（异常告警联动阻断）和预算百分比策略。

    Args:
        organization_id: 组织 ID。
        skip_guard: 跳过 BillingGuardService 检查。当调用方已在上层
            执行过 Guard 检查时传 True，避免双重查询。

    Returns:
        None: 允许继续请求
        dict: 需要阻断，包含 ``{'blocked': True, 'reason': ..., 'budget_status': ...}``
    """
    if not (organization_id or "").strip():
        return {
            'blocked': True,
            'reason': 'missing_organization_id',
            'budget_status': 'unknown',
        }

    if not skip_guard:
        try:
            from apps.services.billing.services.guard_service import BillingGuardService, BillingBlockedError
            guard_block = None
            try:
                BillingGuardService.check_organization_billing_guard(organization_id, raise_on_block=True)
            except BillingBlockedError as guard_exc:
                guard_block = guard_exc

            if guard_block:
                if (
                    guard_block.block_type == "billing_guard_alert"
                    and _can_continue_with_paygo_wallet(organization_id, model_instance=model_instance)
                ):
                    BillingGuardService.clear_guard_cache(
                        organization_id,
                        trigger="paygo_wallet_available",
                    )
                    retry_reason = BillingGuardService.check_organization_billing_guard(
                        organization_id,
                        raise_on_block=False,
                    )
                    if not retry_reason:
                        logger.info(
                            "[Budget] 工作空间 %s guard alert 已因 paygo 钱包可用而解除，放行",
                            organization_id,
                        )
                    else:
                        logger.warning(
                            "[Budget] 工作空间 %s 被 BillingGuardService 阻断: %s",
                            organization_id, guard_block.reason,
                        )
                        return _build_guard_block_payload(guard_block)
                else:
                    logger.warning(
                        "[Budget] 工作空间 %s 被 BillingGuardService 阻断: %s",
                        organization_id, guard_block.reason,
                    )
                    return _build_guard_block_payload(guard_block)
        except Exception as exc:
            logger.warning("[Budget] BillingGuardService 检查异常: %s", exc)

    budget_status = check_budget_policy(organization_id)
    if budget_status != 'critical':
        return None

    try:
        # LLM-26: 使用带缓存的辅助函数，避免重复查 BillingBudgetPolicy 全表
        block_on_critical = _get_block_on_critical_cached(organization_id)
        if block_on_critical:
            if _can_continue_with_paygo_wallet(organization_id, model_instance=model_instance):
                logger.info(
                    "[Budget] 工作空间 %s 预算 critical 但 paygo 钱包可覆盖本次冻结，放行",
                    organization_id,
                )
                return None
            logger.warning(
                "[Budget] 工作空间 %s 预算硬阻断前置拦截，拒绝发起 LLM 请求",
                organization_id,
            )
            return {
                'blocked': True,
                'reason': 'budget_critical',
                'budget_status': budget_status,
            }
    except Exception as exc:
        logger.warning("[Budget] 预算前置检查异常: %s", exc)

    return None


def _validate_tiered_pricing(tiers: list) -> Optional[str]:
    """校验 tiered_pricing.tiers 配置合法性。

    Returns:
        None — 校验通过。
        str  — 校验失败原因。
    """
    if not isinstance(tiers, list):
        return "tiers 必须是列表"

    seen_ids: set[str] = set()
    default_count = 0
    prev_min = -1
    for idx, tier in enumerate(tiers):
        if not isinstance(tier, dict):
            return f"tiers[{idx}] 不是字典"

        tier_id = tier.get("id")
        if tier_id is not None:
            if not isinstance(tier_id, str) or not tier_id.strip():
                return f"tiers[{idx}].id 必须是非空字符串"
            if tier_id in seen_ids:
                return f"tiers[{idx}].id 重复: {tier_id}"
            seen_ids.add(tier_id)

        if tier.get("is_default") is True:
            default_count += 1

        extra_headers = tier.get("extra_headers")
        if extra_headers is not None and not isinstance(extra_headers, dict):
            return f"tiers[{idx}].extra_headers 必须是字典"

        min_tokens = tier.get("min_tokens")
        if min_tokens is not None:
            if not isinstance(min_tokens, (int, float)) or min_tokens < 0:
                return f"tiers[{idx}].min_tokens 必须为非负整数，实际值: {min_tokens}"
            if int(min_tokens) <= prev_min:
                return (
                    f"tiers[{idx}].min_tokens ({int(min_tokens)}) "
                    f"必须大于前一档 ({prev_min})，区间不可重叠"
                )
            prev_min = int(min_tokens)

        for price_key in (
            "input_price_per_1k",
            "output_price_per_1k",
            "over_input_price_per_1k",
            "over_output_price_per_1k",
            "cache_creation_price_per_1k",
            "cache_hit_price_per_1k",
        ):
            price = tier.get(price_key)
            if price is None:
                continue
            try:
                if float(price) < 0:
                    return f"tiers[{idx}].{price_key} 不能为负: {price}"
            except (TypeError, ValueError):
                return f"tiers[{idx}].{price_key} 不是有效数字: {price}"

        applies_above = tier.get("applies_above_tokens")
        if applies_above is not None:
            if not isinstance(applies_above, (int, float)) or applies_above < 0:
                return (
                    f"tiers[{idx}].applies_above_tokens 必须为非负整数，"
                    f"实际值: {applies_above}"
                )

    if default_count > 1:
        return f"tiers 中 is_default=true 的档位最多只能有一个（当前 {default_count} 个）"

    return None


def _format_tokens_label(max_input_tokens: object) -> Optional[str]:
    """根据 max_input_tokens 生成人类可读的 label。

    真实数据里 token 数混用两套单位：
      * **二进制（1024 基）**：131072=128K、262144=256K、1048576=1M
        Gemini / Qwen 等模型常见（源自张量 shape 的 2 次方）
      * **十进制（1000 基）**：200000=200K、1000000=1M
        Anthropic / OpenAI 公开的 context_window 常见

    策略（先 binary 再 decimal，取误差 <5% 的那个）：
      * 先尝试 1024 / 1024² 整除 → 得到 "128K" / "1M"
      * 否则尝试 1000 / 1000² 整除 → 得到 "200K" / "1M"
      * 都不行 → 小数形式 "1.5M" / "500K"
      * 非法 / 非正值 → None（上层兜底到 "档位 N"）

    示例：
      * 200_000       → "200K"
      * 131_072       → "128K"
      * 262_144       → "256K"
      * 1_000_000     → "1M"
      * 1_048_576     → "1M"
      * 500_000       → "500K"
      * 1_500_000     → "1.5M"
    """
    try:
        n = int(max_input_tokens)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None

    # 辅助：算出 n/divisor 整数吸附的候选。若 rel_err < 5% 返回 (rounded, rel_err)，
    # 否则返回 None。两个单位（binary/decimal）都算，**选 rel_err 最小的**，
    # 避免 200_000 被 1024 吸附成 "195K"（真实误差 0.16% 看起来也 <5% 但不如 "200K" 精确）。
    def _best_round(divisor_binary: int, divisor_decimal: int) -> Optional[int]:
        candidates: list[tuple[float, int]] = []
        for divisor in (divisor_binary, divisor_decimal):
            ratio = n / divisor
            rounded = round(ratio)
            if rounded <= 0:
                continue
            rel_err = abs(ratio - rounded) / rounded
            if rel_err < 0.05:
                candidates.append((rel_err, rounded))
        if not candidates:
            return None
        candidates.sort()  # rel_err 最小的排第一
        return candidates[0][1]

    # M 级：仅当 n >= 1_000_000 才考虑（否则 500_000 会被写成 "0.5M"，
    # 宁可走 K 分支变成 "500K"）
    if n >= 1_000_000:
        m = _best_round(1024 * 1024, 1_000_000)
        if m is not None:
            return f"{m}M"
        # 小数 M（保留 1 位，去尾 0）
        return f"{n / 1_000_000:.1f}M".replace(".0M", "M")

    # K 级
    if n >= 1000:
        k = _best_round(1024, 1000)
        if k is not None:
            return f"{k}K"
        return f"{n / 1000:.1f}K".replace(".0K", "K")

    return str(n)


def _normalize_tiers(tiers: list) -> list:
    """补齐 tier 的 id/label 默认值，让旧数据无 id 时也可访问。

    不改变原对象，返回浅拷贝列表。原序保留。

    Label 兜底策略（按优先级）：
      1. tier["label"] 非空 → 原样用
      2. max_input_tokens 可解析 → 智能生成（'200K'、'1M'）
      3. 否则 → f'档位 {idx+1}'（最后的兜底，不应该走到这）

    注意：label 仅作为 UI 展示兜底；运营在 AdminDash 显式填 label 时会覆盖。
    这里的改进是为了让 **从未配过 Context Tier 机制、只配了旧阶梯计价** 的
    模型（如 Gemini/Qwen）在 UI 上也能有可读的 label，而不是无意义的"档位 1"。
    """
    normalized: list = []
    for idx, tier in enumerate(tiers):
        if not isinstance(tier, dict):
            normalized.append(tier)
            continue
        new_tier = dict(tier)
        if not new_tier.get("id"):
            new_tier["id"] = f"tier_{idx}"
        if not new_tier.get("label"):
            smart_label = _format_tokens_label(new_tier.get("max_input_tokens"))
            new_tier["label"] = smart_label or f"档位 {idx + 1}"
        normalized.append(new_tier)
    return normalized


def get_model_context_tiers(custom_billing_config: dict) -> list[dict]:
    """从 custom_billing_config 中提取上下文档位列表（已规范化补全 id/label）。

    无配置或校验失败时返回空列表，调用方应据此回退到模型基础单价 / 默认 header。
    """
    tiered = (custom_billing_config or {}).get("tiered_pricing")
    if not tiered or not isinstance(tiered, dict):
        return []
    tiers = tiered.get("tiers")
    if not tiers or not isinstance(tiers, list):
        return []
    if _validate_tiered_pricing(tiers):
        return []
    return _normalize_tiers(tiers)


def resolve_default_tier(custom_billing_config: dict) -> Optional[dict]:
    """返回默认档位：优先 is_default=True，其次第一档；都没有时返回 None。"""
    tiers = get_model_context_tiers(custom_billing_config)
    if not tiers:
        return None
    for tier in tiers:
        if tier.get("is_default") is True:
            return tier
    return tiers[0]


def resolve_tier_by_id(
    custom_billing_config: dict,
    tier_id: Optional[str],
) -> Optional[dict]:
    """按 tier_id 显式查找档位；未提供或未命中时返回 None。"""
    if not tier_id:
        return None
    for tier in get_model_context_tiers(custom_billing_config):
        if tier.get("id") == tier_id:
            return tier
    return None


def resolve_tiered_pricing(
    custom_billing_config: dict,
    total_input_tokens: int,
    *,
    tier_id: Optional[str] = None,
) -> Optional[dict]:
    """
    匹配上下文档位 / 阶梯计费档位。

    Args:
        custom_billing_config: 模型的 custom_billing_config JSON
        total_input_tokens: 本次请求的总输入 token 数（含 cache）
        tier_id: 显式锁定的档位 id（用户主动选档的场景，
                 如「长上下文 1M」）。提供且命中时优先生效，
                 不再做按用量自动选档。

    Returns:
        匹配的档位字典（含 input/output/cache 价格、extra_headers 等），
        无阶梯配置或未命中时返回 None。
    """
    tiers = get_model_context_tiers(custom_billing_config)
    if not tiers:
        return None

    if tier_id:
        for tier in tiers:
            if tier.get("id") == tier_id:
                return tier
        logger.debug(
            "[TieredPricing] 显式 tier_id=%s 未命中，回退到按用量选档",
            tier_id,
        )

    sorted_tiers = sorted(tiers, key=lambda t: t.get("max_input_tokens", 0))
    for tier in sorted_tiers:
        max_tokens = tier.get("max_input_tokens", 0)
        if total_input_tokens <= max_tokens:
            return tier

    return sorted_tiers[-1]


def compute_tier_token_cost(
    tier: dict,
    base_tokens: int,
    *,
    direction: str,
    fallback_price: Decimal,
) -> Decimal:
    """根据档位配置计算指定方向（input / output）的 token 成本。

    支持 ZenMux 风格的「档内分裂」：若档位配置了 applies_above_tokens
    + over_<direction>_price_per_1k，则 ≤ 阈值部分按基础价、超出部分按
    over 价；否则整段按基础价（input_price_per_1k / output_price_per_1k）。

    Args:
        tier: 档位字典
        base_tokens: 该方向待计费 token 数
        direction: 'input' 或 'output'
        fallback_price: 档位未配置该方向价时的回退单价

    Returns:
        Decimal — 该方向的总成本（金额）
    """
    if base_tokens <= 0:
        return Decimal("0")

    base_price_key = f"{direction}_price_per_1k"
    over_price_key = f"over_{direction}_price_per_1k"

    base_price = _safe_decimal(tier.get(base_price_key), default=fallback_price)
    over_price_raw = tier.get(over_price_key)
    applies_above_raw = tier.get("applies_above_tokens")

    try:
        applies_above = (
            int(applies_above_raw) if applies_above_raw is not None else None
        )
    except (TypeError, ValueError):
        applies_above = None

    if (
        applies_above is not None
        and applies_above >= 0
        and over_price_raw is not None
        and base_tokens > applies_above
    ):
        over_price = _safe_decimal(over_price_raw, default=base_price)
        within = Decimal(applies_above)
        beyond = Decimal(base_tokens - applies_above)
        return (within * base_price + beyond * over_price) / Decimal("1000")

    return Decimal(base_tokens) * base_price / Decimal("1000")


def _safe_int(value: object, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_decimal(value: object, default: Decimal = Decimal("0")) -> Decimal:
    try:
        if value is None:
            return default
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return default


def _safe_bool(value: object) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return None


def _is_byok_provider(model_instance: Optional[LLMModel]) -> bool:
    """判断模型是否来自用户自带 Key 的渠道（非全局 scope）。

    DB 异常时安全降级为 False（按收费处理），防止因 lazy load
    失败导致计费链路中断。
    """
    if not model_instance:
        return False
    try:
        provider = model_instance.provider
    except Exception:
        return False
    if not provider:
        return False
    scope = getattr(provider, "scope", "global")
    return scope in ("user", "organization")


def _update_llm_usage_attempt_metadata(
    *,
    idempotency_key: str,
    logical_billing_key: str,
    attempt_index: Optional[int],
    usage_source: str,
) -> None:
    if not idempotency_key:
        return
    updates = {"usage_source": (usage_source or "").strip() or "provider_final"}
    if logical_billing_key:
        updates["logical_billing_key"] = logical_billing_key
    if attempt_index is not None:
        updates["attempt_index"] = attempt_index
    try:
        from apps.services.billing.models import BillingUsageEvent

        events = BillingUsageEvent.objects.filter(idempotency_key=idempotency_key)
        if updates["usage_source"] == USAGE_SOURCE_ESTIMATED_INTERRUPTED:
            events = events.exclude(charge_status__in=["charged", "aggregated"])
        events.update(**updates)
    except Exception as exc:
        logger.warning(
            "[charge_llm_usage] usage attempt metadata update failed: key=%s err=%s",
            idempotency_key,
            exc,
        )


def _is_estimated_usage(usage: Optional[dict]) -> bool:
    return bool((usage or {}).get("estimated") or (usage or {}).get("usage_estimated"))


def _record_estimated_llm_usage_audit(
    *,
    user_id: Optional[str],
    organization_id: Optional[str],
    model_instance: Optional[LLMModel],
    usage: dict,
    request_id: str,
    source: str,
    biz_id: Optional[str],
    idempotency_key: Optional[str],
    billing_metadata: Optional[Dict[str, Any]],
    scene_key: str,
    logical_billing_key: str,
    attempt_index: Optional[int],
    usage_source: str,
) -> Dict[str, Any]:
    input_tokens = _safe_int(usage.get("input_tokens"))
    output_tokens = _safe_int(usage.get("output_tokens"))
    total_tokens = _safe_int(usage.get("total_tokens")) or input_tokens + output_tokens
    provider = model_instance.provider if model_instance else None
    provider_key = str(getattr(provider, "provider_key", "") or getattr(provider, "name", "") or "")
    model_name = str(getattr(model_instance, "model_name", "") or "")
    event_biz_id = (biz_id or "").strip() or f"{source}:{request_id}"
    event_idempotency_key = (idempotency_key or "").strip() or event_biz_id
    metadata: Dict[str, Any] = {
        **(billing_metadata or {}),
        "status": "not_charged",
        "reason": "estimated_usage_not_charged",
        "estimated": True,
        "source": source,
        "request_id": request_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }
    try:
        from apps.services.billing.services.usage_service import BillingUsageService

        BillingUsageService.record_event(
            organization_id=(organization_id or "").strip(),
            meter_key="llm.tokens",
            quantity=Decimal(total_tokens),
            unit="tokens",
            unit_price=Decimal("0"),
            amount=Decimal("0"),
            currency="CREDITS",
            user_id=user_id or "",
            provider_key=provider_key,
            model_name=model_name,
            biz_type="llm_call",
            biz_id=event_biz_id,
            scene_key=scene_key or "",
            idempotency_key=event_idempotency_key,
            logical_billing_key=logical_billing_key,
            attempt_index=attempt_index,
            usage_source=usage_source or USAGE_SOURCE_ESTIMATED_INTERRUPTED,
            metadata=metadata,
            charge_status="pending",
        )
    except Exception as exc:
        logger.warning(
            "[%s] estimated usage audit record failed: %s",
            request_id,
            exc,
            exc_info=True,
        )
    return {
        "charged": False,
        "reason": "estimated_usage_not_charged",
        "credits_consumed_precise": Decimal("0.0000"),
        "quota_covered_credits_precise": Decimal("0.0000"),
        "overflow_credits_precise": Decimal("0.0000"),
        "usage_source": usage_source or USAGE_SOURCE_ESTIMATED_INTERRUPTED,
    }


def charge_llm_usage(
    *,
    user_id: Optional[str],
    organization_id: Optional[str],
    model_instance: Optional[LLMModel],
    usage: Optional[dict],
    request_id: str,
    source: str = "llm_api",
    biz_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
    billing_metadata: Optional[Dict[str, Any]] = None,
    context_tier_id: Optional[str] = None,
    scene_key: str = "",
    logical_billing_key: str = "",
    attempt_index: Optional[int] = None,
    usage_source: str = "provider_final",
) -> Optional[Dict[str, Any]]:
    """
    按 token 用量执行点券扣减。

    自带 Key（scope=user/organization）的渠道免收平台费，
    仅记录用量事实用于统计和预算监控。

    Returns:
        dict: 扣减成功，含 credits_consumed_precise 等字段
        {"byok_exempt": True}: BYOK 渠道免计费（正常流程，非失败），
            调用方应据此跳过 LLMUsageFact 成本写入，并把 cost_status 设成
            'byok_self_paid'（v0.1 §5.6 + §3 BYOK 边界）。
        None: 扣减失败（异常 / 余额不足）
        注意：历史调用方可能用 bool(result) 判断——dict truthy, None falsy，兼容。
    """
    logical_billing_key = (logical_billing_key or "").strip()
    usage_source = (usage_source or "").strip() or USAGE_SOURCE_PROVIDER_FINAL

    # BYOK 豁免：用户/工作空间自配渠道不收平台费
    if _is_byok_provider(model_instance):
        logger.info(
            "[%s] BYOK 渠道免计费: scope=%s provider=%s model=%s source=%s",
            request_id,
            getattr(model_instance.provider, "scope", ""),
            getattr(model_instance.provider, "name", ""),
            getattr(model_instance, "model_name", ""),
            source,
        )
        try:
            from .llm_metrics import llm_byok_calls_total
            llm_byok_calls_total.labels(
                provider=getattr(getattr(model_instance, "provider", None), "provider_key", "") or "",
                model=getattr(model_instance, "model_name", "") or "",
                source=source or "",
            ).inc()
        except Exception:
            pass
        return {"byok_exempt": True}

    if not user_id:
        logger.warning("[%s] user_id 为空，拒绝计费: source=%s", request_id, source)
        return None

    if not (organization_id or "").strip():
        logger.warning(
            "[%s] organization_id 为空，拒绝计费: user=%s source=%s",
            request_id, str(user_id)[:8], source,
        )
        try:
            from apps.services.billing.services.usage_service import BillingUsageService
            BillingUsageService.record_event(
                organization_id="",
                meter_key="llm.tokens",
                quantity=Decimal(0),
                unit="token",
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                user_id=str(user_id)[:36],
                biz_type="charge_skipped",
                biz_id=f"{source}:{request_id}",
                scene_key=scene_key or "",
                idempotency_key=f"skipped:no_ws:{request_id}",
                logical_billing_key=logical_billing_key,
                attempt_index=attempt_index,
                usage_source=usage_source,
                metadata={"error": "missing_organization_id", "source": source},
            )
        except Exception:
            pass
        return None

    if _is_estimated_usage(usage):
        estimated_usage_source = USAGE_SOURCE_ESTIMATED_INTERRUPTED
        return _record_estimated_llm_usage_audit(
            user_id=user_id,
            organization_id=organization_id,
            model_instance=model_instance,
            usage=usage or {},
            request_id=request_id,
            source=source,
            biz_id=biz_id,
            idempotency_key=idempotency_key,
            billing_metadata=billing_metadata,
            scene_key=scene_key,
            logical_billing_key=logical_billing_key,
            attempt_index=attempt_index,
            usage_source=estimated_usage_source,
        )

    usage_data = usage or {}
    input_tokens = _safe_int(usage_data.get("input_tokens"))
    output_tokens = _safe_int(usage_data.get("output_tokens"))
    cache_read_input_tokens = _safe_int(usage_data.get("cache_read_input_tokens"))
    cache_write_input_tokens = _safe_int(usage_data.get("cache_creation_input_tokens"))
    input_tokens_include_cache = _safe_bool(usage_data.get("input_tokens_include_cache"))
    if input_tokens_include_cache is None:
        exclude_flag = _safe_bool(usage_data.get("input_tokens_excludes_cache"))
        if exclude_flag is not None:
            input_tokens_include_cache = not exclude_flag
    if input_tokens_include_cache is None:
        prompt_tokens = usage_data.get("prompt_tokens")
        if prompt_tokens is not None:
            try:
                input_tokens_include_cache = int(prompt_tokens) == int(input_tokens)
            except (TypeError, ValueError):
                input_tokens_include_cache = None
    if input_tokens_include_cache is None:
        input_tokens_include_cache = True

    if input_tokens_include_cache:
        base_input_tokens = max(input_tokens - cache_read_input_tokens - cache_write_input_tokens, 0)
        billable_input_tokens = input_tokens
        if cache_read_input_tokens + cache_write_input_tokens > input_tokens:
            logger.warning(
                "[%s] cache tokens 超过 input_tokens（异常数据，已兜底）: "
                "cache_read=%d cache_write=%d input=%d",
                request_id, cache_read_input_tokens, cache_write_input_tokens, input_tokens,
            )
    else:
        base_input_tokens = input_tokens
        billable_input_tokens = input_tokens + cache_read_input_tokens + cache_write_input_tokens

    if billable_input_tokens <= 0 and output_tokens <= 0:
        return None

    subject_organization_id = (organization_id or "").strip()
    billing_event_metadata: Dict[str, Any] = dict(billing_metadata or {})

    model_config: dict = {}
    try:
        # LLM-25: 此处是 charge_llm_usage 内的安全网检查，
        # 即使调用方（billed_llm_call）已在上游做过预检，
        # standalone 调用路径（safe_charge_usage 等）仍需此保护。
        # check_budget_policy 结果已缓存，重复调用不产生 DB 查询。
        budget_status = check_budget_policy(subject_organization_id) if subject_organization_id else None
        if budget_status == 'critical':
            # LLM-26: 避免重复查 BillingBudgetPolicy；
            # check_budget_policy 已缓存 status，
            # block_on_critical 通过独立短 TTL 缓存获取，减少一次冗余 DB 查询。
            block_on_critical = _get_block_on_critical_cached(subject_organization_id)
            if block_on_critical:
                if not _can_continue_with_paygo_wallet(
                    subject_organization_id,
                    model_instance=model_instance,
                ):
                    logger.warning(
                        "[%s] 工作空间 %s 已达严重预算阈值且硬阻断已启用，拒绝扣费",
                        request_id, subject_organization_id,
                    )
                    raise BudgetExceededException(
                        organization_id=subject_organization_id,
                        budget_status=budget_status,
                    )
                logger.info(
                    "[%s] 工作空间 %s 预算 critical 但 paygo 钱包可覆盖本次扣费，继续扣费",
                    request_id, subject_organization_id,
                )
            logger.warning(
                "[%s] 工作空间 %s 已达严重预算阈值，硬阻断未启用，继续扣减",
                request_id, subject_organization_id,
            )
        from apps.users.wallet.services.credits_service import CreditsService

        # R6: organization-only 模式下跳过 User 查询和旧个人钱包创建，
        # 直接传 user_id 字符串给 consume_credits_for_llm
        if subject_organization_id:
            user_or_id = user_id
        else:
            from apps.users.auth.models import User
            user_or_id = User.objects.filter(id=user_id).first()
            if not user_or_id:
                return None

        provider = model_instance.provider if model_instance else None
        provider_key = ""
        provider_name = ""
        if provider:
            provider_key = str(getattr(provider, "provider_key", "") or "").strip()
            provider_name = str(getattr(provider, "name", "") or "").strip()

        custom_billing_config = (
            (getattr(model_instance, "custom_billing_config", {}) or {})
            if model_instance else {}
        )

        # 阶梯计费：根据输入 token 总量匹配档位，覆盖基础单价和 cache 价格
        base_input_price = _safe_decimal(
            model_instance.input_price_per_1k if model_instance else 0
        )
        base_output_price = _safe_decimal(
            model_instance.output_price_per_1k if model_instance else 0
        )

        tier = resolve_tiered_pricing(
            custom_billing_config,
            billable_input_tokens,
            tier_id=context_tier_id,
        )
        if tier:
            # 简化路径：直接取 tier 的 input_price / output_price 作为基础单价。
            # 若 tier 还配了 applies_above_tokens + over_*_price_per_1k，则下面
            # 通过 compute_tier_token_cost 重新计算「档内分裂」精确成本，再反算
            # 等效平均单价覆盖 base_input_price / base_output_price，保证
            # CreditsService 计费链路下游不需要懂分段。
            tier_input = _safe_decimal(
                tier.get("input_price_per_1k"), default=base_input_price,
            )
            tier_output = _safe_decimal(
                tier.get("output_price_per_1k"), default=base_output_price,
            )

            # ZenMux 风格档内分裂：仅当配置了 applies_above_tokens + over 单价时生效
            if tier.get("applies_above_tokens") is not None and (
                tier.get("over_input_price_per_1k") is not None
                or tier.get("over_output_price_per_1k") is not None
            ):
                if base_input_tokens > 0:
                    split_input_cost = compute_tier_token_cost(
                        tier, base_input_tokens, direction="input",
                        fallback_price=tier_input,
                    )
                    base_input_price = (
                        split_input_cost * Decimal("1000") / Decimal(base_input_tokens)
                    )
                else:
                    base_input_price = tier_input
                if output_tokens > 0:
                    split_output_cost = compute_tier_token_cost(
                        tier, output_tokens, direction="output",
                        fallback_price=tier_output,
                    )
                    base_output_price = (
                        split_output_cost * Decimal("1000") / Decimal(output_tokens)
                    )
                else:
                    base_output_price = tier_output
            else:
                base_input_price = tier_input
                base_output_price = tier_output

            logger.debug(
                "[%s] 上下文档位计费: tier_id=%s, input_tokens=%d, tier_max=%s, "
                "input_price=%s, output_price=%s, applies_above=%s",
                request_id, tier.get("id"), billable_input_tokens,
                tier.get("max_input_tokens"), base_input_price, base_output_price,
                tier.get("applies_above_tokens"),
            )

        # P1-05: 零价格模型告警（每 10 分钟去重，避免高频调用时告警风暴）
        if base_input_price == 0 and base_output_price == 0:
            _zp_provider = provider_key or provider_name
            _zp_model = str(model_instance.model_name or "") if model_instance else ""
            _zp_cache_key = f"billing:zero_price_alert:{_zp_provider}:{_zp_model}"
            try:
                from django.core.cache import cache as _zp_cache
                if _zp_cache.add(_zp_cache_key, True, 600):
                    logger.warning(
                        "[%s] 模型 %s/%s 价格为零，可能未配置定价",
                        request_id, _zp_provider, _zp_model,
                    )
                    from apps.services.billing.models import BillingAnomalyAlert
                    BillingAnomalyAlert.objects.create(
                        alert_type="zero_price_model",
                        severity="warning",
                        organization_id=subject_organization_id or "",
                        metric_name="zero_price_model",
                        current_value=Decimal("0"),
                        baseline_value=Decimal("0"),
                        message=(
                            f"模型 {_zp_provider}/{_zp_model} 输入/输出价格均为零，"
                            f"可能未配置定价（input_tokens={billable_input_tokens}, "
                            f"output_tokens={output_tokens}）"
                        ),
                    )
            except Exception as _zp_exc:
                logger.debug("[charge_llm_usage] 零价格告警创建失败: %s", _zp_exc)

        model_config = {
            "provider_key": provider_key or provider_name,
            "canonical_provider_key": provider_key,
            "model_name": str(model_instance.model_name or "") if model_instance else "",
            "model_id": str(getattr(model_instance, "id", "") or ""),
            "provider_id": str(getattr(model_instance, "provider_id", "") or ""),
            "input_price_per_1k": str(base_input_price),
            "output_price_per_1k": str(base_output_price),
            "organization_id": subject_organization_id,
        }

        # cache token 差异化计费：折算为有效 input 单价，兼容现有 CreditsService 入参协议。
        # P1-06: 优先 tier → custom_billing_config → Provider 默认折扣率 → base_input_price
        if model_instance:
            _provider_discount = _PROVIDER_CACHE_DISCOUNT.get(provider_key.lower(), {})

            _tier_cache_read = (tier or {}).get("cache_hit_price_per_1k")
            _custom_cache_read = custom_billing_config.get("cache_read_input_price_per_1k")
            if _tier_cache_read is not None:
                cache_read_price = _safe_decimal(_tier_cache_read, default=base_input_price)
            elif _custom_cache_read is not None:
                cache_read_price = _safe_decimal(_custom_cache_read, default=base_input_price)
            else:
                cache_read_price = base_input_price * _provider_discount.get(
                    "cache_read_ratio", Decimal("1"),
                )

            _tier_cache_write = (tier or {}).get("cache_creation_price_per_1k")
            _custom_cache_write = custom_billing_config.get("cache_write_input_price_per_1k")
            if _tier_cache_write is not None:
                cache_write_price = _safe_decimal(_tier_cache_write, default=base_input_price)
            elif _custom_cache_write is not None:
                cache_write_price = _safe_decimal(_custom_cache_write, default=base_input_price)
            else:
                cache_write_price = base_input_price * _provider_discount.get(
                    "cache_write_ratio", Decimal("1"),
                )

            if billable_input_tokens > 0:
                effective_input_cost = (
                    Decimal(base_input_tokens) * base_input_price
                    + Decimal(cache_read_input_tokens) * cache_read_price
                    + Decimal(cache_write_input_tokens) * cache_write_price
                )
                effective_input_price = effective_input_cost / Decimal(billable_input_tokens)
                model_config["input_price_per_1k"] = str(effective_input_price)

                if base_input_price > 0:
                    model_config["cache_read_price_ratio"] = str(
                        cache_read_price / base_input_price
                    )
                    model_config["cache_write_price_ratio"] = str(
                        cache_write_price / base_input_price
                    )
                model_config["base_input_tokens"] = base_input_tokens

            model_config["cache_read_input_tokens"] = cache_read_input_tokens
            model_config["cache_write_input_tokens"] = cache_write_input_tokens
            model_config["input_tokens_include_cache"] = input_tokens_include_cache
            model_config["effective_input_price_computed"] = True

        default_biz_id = f"{source}:{request_id}"
        event_biz_id = (biz_id or "").strip() or default_biz_id
        event_idempotency_key = (idempotency_key or "").strip() or default_biz_id
        from apps.services.billing.services.gateway import BillingGateway

        consume_result = BillingGateway.settle_llm_usage(
            organization_id=subject_organization_id,
            user_id=str(getattr(user_or_id, "id", user_or_id) or ""),
            actual_tokens=billable_input_tokens + output_tokens,
            model_id=str(getattr(model_instance, "id", "") or ""),
            provider_id=str(getattr(model_instance, "provider_id", "") or ""),
            idempotency_key=event_idempotency_key,
            model_config=model_config,
            input_tokens=billable_input_tokens,
            output_tokens=output_tokens,
            context={
                **(billing_event_metadata or {}),
                "biz_id": event_biz_id,
                "request_id": request_id,
                "scene_key": scene_key,
                "source": source,
            },
        )
        _update_llm_usage_attempt_metadata(
            idempotency_key=event_idempotency_key,
            logical_billing_key=logical_billing_key,
            attempt_index=attempt_index,
            usage_source=usage_source,
        )

        # 成员级用量计数器递增（advisory，失败不阻断主流程）
        # 必须统计「本次实际消耗的总点券」= 配额覆盖 + 免费溢出 + 钱包实扣，
        # 而不是只统计钱包实扣的 paygo（credits_consumed_precise）。
        # quota_only 模式下钱包实扣恒为 0，若仅按 paygo 累加，成员计数器永远停在 0，
        # L5 成员日/月上限的分子恒为 0，限额将永不触发（quota_then_paygo 也仅在配额
        # 耗尽后才累加，同样漏统计配额内消耗）。幂等命中/零 token 时下述字段缺省为 0，
        # 天然不重复计数。
        if user_id and subject_organization_id:
            actual_credits = (
                _safe_decimal(consume_result.get("provider_credit_credits_precise"))
                + _safe_decimal(consume_result.get("quota_covered_credits_precise"))
                + _safe_decimal(consume_result.get("overflow_credits_precise"))
                + _safe_decimal(consume_result.get("credits_consumed_precise"))
            )
            if actual_credits > 0:
                _increment_member_usage_counter(
                    subject_organization_id, user_id, actual_credits,
                )

            # P1-6: 模型等级安全网——扣费后检查模型是否在成员允许范围内
            _check_model_tier_safety_net(
                subject_organization_id, user_id, model_instance, request_id,
            )

        # 扣费成功后清除预算缓存，确保下次检查触发实时阈值计算
        # 加分布式锁（5s 窗口）防止高并发下 DB 查询风暴
        try:
            from django.core.cache import cache as _cache
            _cache.delete(f"llm:budget_policy:{subject_organization_id}")
            _lock_key = f"llm:budget_check_lock:{subject_organization_id}"
            if _cache.add(_lock_key, True, 5):
                _post_charge_budget_check(subject_organization_id)
        except Exception:
            pass

        # 低余额提醒：按「钱包可用 + 月度套餐剩余 + 本次模型定向点券」可消耗点券判定，
        # 交给 LowBalanceAlertService 统一按配置阈值分级（warning/critical）+ 分级去重，
        # 同时下发移动端 WS toast 与 Electron Owner 铃铛。
        # 这里是 Agent 对话真实扣费后的检查点，标记 source 让 Electron 只在对话链路弹 toast。
        try:
            from apps.services.billing.services.low_balance_alert_service import (
                LowBalanceAlertService as _LowBalanceAlertService,
            )
            _LowBalanceAlertService.check_organization_and_notify(
                subject_organization_id,
                model_instance=model_instance,
                source="agent_conversation",
            )
        except Exception:
            pass

        return consume_result
    except BudgetExceededException:
        try:
            from apps.services.billing.services.usage_service import BillingUsageService
            BillingUsageService.record_event(
                organization_id=subject_organization_id or "",
                meter_key="llm.tokens",
                quantity=Decimal(billable_input_tokens + output_tokens),
                unit="token",
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                user_id=user_id,
                biz_type="charge_failed",
                biz_id=(biz_id or "").strip() or f"{source}:{request_id}",
                # 计费收尾：审计行保留 scene_key，确保失败记录仍可按场景归集。
                scene_key=scene_key or "",
                idempotency_key=f"failed:budget:{(idempotency_key or '').strip() or request_id}",
                logical_billing_key=logical_billing_key,
                attempt_index=attempt_index,
                usage_source=usage_source,
                metadata={
                    **billing_event_metadata,
                    "error": "budget_exceeded",
                    "source": source,
                    "input_tokens": billable_input_tokens,
                    "output_tokens": output_tokens,
                },
            )
        except Exception:
            pass
        raise
    except _InsufficientCreditsErrorType as ice:
        # BIL-16: 团队钱包余额不足（竞态窗口：预检时够、扣费时被其他请求耗尽）
        logger.warning(
            "[%s] 团队钱包余额不足，扣费失败（LLM 调用已完成）: organization=%s required=%s current=%s",
            request_id, subject_organization_id,
            getattr(ice, "required", "?"), getattr(ice, "current", "?"),
        )
        try:
            from .billed_call import mark_post_charge_insufficient_balance
            mark_post_charge_insufficient_balance(
                subject_organization_id or "",
                required=getattr(ice, "required", Decimal("0")),
                current=getattr(ice, "current", Decimal("0")),
                model_instance=model_instance,
            )
        except Exception:
            pass
        try:
            from apps.services.billing.ws_events import publish_billing_blocked_deduped
            publish_billing_blocked_deduped(
                subject_organization_id,
                "organization_insufficient_credits",
                request_id=request_id,
                extra={
                    "required": str(getattr(ice, "required", "")),
                    "current": str(getattr(ice, "current", "")),
                },
            )
        except Exception:
            pass
        try:
            from apps.services.billing.services.usage_service import BillingUsageService
            BillingUsageService.record_event(
                organization_id=subject_organization_id or "",
                meter_key="llm.tokens",
                quantity=Decimal(billable_input_tokens + output_tokens),
                unit="token",
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                user_id=user_id,
                provider_key=model_config.get("provider_key", ""),
                model_name=model_config.get("model_name", ""),
                biz_type="charge_failed",
                biz_id=(biz_id or "").strip() or f"{source}:{request_id}",
                scene_key=scene_key or "",
                idempotency_key=f"failed:ws_balance:{(idempotency_key or '').strip() or request_id}",
                logical_billing_key=logical_billing_key,
                attempt_index=attempt_index,
                usage_source=usage_source,
                metadata={
                    **billing_event_metadata,
                    "error": "organization_insufficient_credits",
                    "source": source,
                    "input_tokens": billable_input_tokens,
                    "output_tokens": output_tokens,
                    "required": str(getattr(ice, "required", "")),
                    "current": str(getattr(ice, "current", "")),
                },
            )
        except Exception:
            pass
        # 余额不足属「硬阻断」，已由上方 publish_billing_blocked_deduped 发出
        # billing_blocked 信号；低余额「预警」铃铛只由扣费成功 / 预检路径发出（那里携带
        # 真实余额）。此处不再补发，避免与阻断信号重复，也避免此前传硬编码 0
        # 导致铃铛显示误导性的「余额 0.00」。
        return None
    except Exception as exc:
        logger.warning("[%s] 点券扣减失败: %s", request_id, exc, exc_info=True)
        from apps.users.wallet.exceptions import BillingEventUpdateError
        if isinstance(exc, BillingEventUpdateError):
            try:
                from apps.services.billing.models import BillingAnomalyAlert
                BillingAnomalyAlert.objects.create(
                    alert_type="event_update_failed",
                    severity="critical",
                    organization_id=subject_organization_id or "",
                    user_id=user_id or "",
                    metric_name="wal28_event_update",
                    current_value=Decimal("0"),
                    message=(
                        f"WAL-28 占位记录更新失败，事务已回滚。"
                        f"key={getattr(exc, 'idempotency_key', '')}, "
                        f"request_id={request_id}, err={exc.__cause__}"
                    ),
                )
            except Exception:
                logger.warning("[%s] BillingAnomalyAlert 写入失败", request_id, exc_info=True)
        # 关键：兜底审计**必须**在主异常之外的独立 connection 上执行。
        # 如果主异常本身就是 connection level（OperationalError / 4031 / 2013），
        # 复用同一个死 connection 写 BillingUsageEvent 会**确定性失败**——
        # 这种场景兜底事件不落库，会直接丢失失败计费的审计证据。
        # 详见 support/go-live/llm-billing-charge-resilience-go-live-checklist.md §1.2。
        try:
            from django.db import close_old_connections
            close_old_connections()
        except Exception as conn_exc:
            logger.warning("[%s] 兜底前刷新连接失败（继续尝试）: %s", request_id, conn_exc)
        try:
            from apps.services.billing.services.usage_service import BillingUsageService
            BillingUsageService.record_event(
                organization_id=subject_organization_id or "",
                meter_key="llm.tokens",
                quantity=Decimal(billable_input_tokens + output_tokens),
                unit="token",
                unit_price=Decimal("0"),
                amount=Decimal("0"),
                user_id=user_id,
                provider_key=model_config.get("provider_key", ""),
                model_name=model_config.get("model_name", ""),
                biz_type="charge_failed",
                biz_id=(biz_id or "").strip() or f"{source}:{request_id}",
                scene_key=scene_key or "",
                idempotency_key=f"failed:{(idempotency_key or '').strip() or request_id}",
                logical_billing_key=logical_billing_key,
                attempt_index=attempt_index,
                usage_source=usage_source,
                metadata={
                    **billing_event_metadata,
                    "error": str(exc)[:500],
                    "source": source,
                    "input_tokens": billable_input_tokens,
                    "output_tokens": output_tokens,
                    "model_config": {
                        "provider_key": model_config.get("provider_key", ""),
                        "model_name": model_config.get("model_name", ""),
                        "input_price_per_1k": str(model_config.get("input_price_per_1k", "")),
                        "output_price_per_1k": str(model_config.get("output_price_per_1k", "")),
                    },
                },
            )
        except Exception as audit_exc:
            logger.error("[%s] 计费失败审计记录写入也失败: %s", request_id, audit_exc)
        # 通知降级追踪器：连续失败 N 次后触发 BillingAnomalyAlert，
        # Guard 检测到 alert 后会阻断后续 LLM 请求，而不立即中断本次请求。
        try:
            from apps.services.billing.services.degradation_tracker import track_billing_degradation
            track_billing_degradation(
                meter_key="llm.billing",
                organization_id=subject_organization_id or "",
                biz_type=source,
                error=str(exc)[:300],
            )
        except Exception:
            pass
        return None


def _increment_member_usage_counter(
    organization_id: str, user_id: str, credits: Decimal,
) -> None:
    """原子递增成员用量计数器（月度 + 日度），并失效缓存。

    使用原始 SQL ``INSERT ... ON CONFLICT ... DO UPDATE`` 一条语句完成
    upsert+递增，避免两步操作的竞态丢数。冲突目标列对应模型上的
    唯一约束 ``uniq_member_usage_counter``。``updated_at`` 以参数传入
    （不用 ``NOW()``）以保持 PostgreSQL/SQLite 可移植。外层 try/except
    保证失败仅 warning，不阻断主扣费流程（依赖定时对账修正）。
    """
    try:
        import uuid as _uuid
        from django.db import connection, transaction
        from django.core.cache import cache
        from django.utils import timezone
        from apps.services.billing.constants import BILLING_TZ

        now = timezone.now().astimezone(BILLING_TZ)
        today = now.date()
        month_start = today.replace(day=1)
        credits_str = str(credits)

        sql = (
            "INSERT INTO services_billing_member_usage_counter "
            "(id, organization_id, user_id, cycle_date, cycle_type, consumed_credits, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (organization_id, user_id, cycle_date, cycle_type) DO UPDATE SET "
            "consumed_credits = services_billing_member_usage_counter.consumed_credits "
            "+ EXCLUDED.consumed_credits, updated_at = EXCLUDED.updated_at"
        )
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(sql, [
                    _uuid.uuid4().hex, organization_id, user_id,
                    month_start.isoformat(), "monthly", credits_str, now,
                ])
                cursor.execute(sql, [
                    _uuid.uuid4().hex, organization_id, user_id,
                    today.isoformat(), "daily", credits_str, now,
                ])

        for _cyc_key, _cyc_date, _cyc_type in (
            (f"member_budget:monthly:{organization_id}:{user_id}:{month_start}", month_start, "monthly"),
            (f"member_budget:daily:{organization_id}:{user_id}:{today}", today, "daily"),
        ):
            _old = cache.get(_cyc_key)
            if _old is not None:
                cache.set(_cyc_key, str(Decimal(str(_old)) + credits), 30)
            else:
                cache.delete(_cyc_key)

        _check_member_budget_threshold(organization_id, user_id, today, month_start)
    except Exception as exc:
        logger.warning(
            "[MemberBudget] 计数器递增失败（不阻断）: wt=%s user=%s err=%s",
            organization_id, user_id[:8] if user_id else "", exc,
        )


def _check_member_budget_threshold(
    organization_id: str, user_id: str, today, month_start,
) -> None:
    """检查成员用量是否达到月度/日度 80% / 100% 阈值，达到则推送 WS 事件。

    B7: 策略查询复用 MemberBudgetService.get_effective_policy，
        配合 resolve_user_role 获取角色以正确匹配角色策略。
    R8: 增加日度限额阈值检查，payload 含 budget_type 区分月度/日度。
    """
    try:
        from django.core.cache import cache
        from apps.services.billing.models import MemberLlmUsageCounter
        from apps.services.billing.services.member_budget_service import MemberBudgetService

        user_role = MemberBudgetService.resolve_user_role(organization_id, user_id)
        policy = MemberBudgetService.get_effective_policy(
            organization_id, user_id, user_role=user_role,
        )
        if not policy:
            return

        from apps.services.billing.ws_events import publish_billing_event

        # ── 月度阈值检查 ──
        monthly_limit = policy.monthly_credits_limit
        if monthly_limit and monthly_limit > 0:
            monthly_consumed = MemberLlmUsageCounter.objects.filter(
                organization_id=organization_id, user_id=user_id,
                cycle_date=month_start, cycle_type="monthly",
            ).values_list("consumed_credits", flat=True).first()

            if monthly_consumed is not None:
                monthly_pct = (monthly_consumed / monthly_limit) * 100

                dedup_key_m100 = f"member_budget:alert:100:{organization_id}:{user_id}:{month_start}"
                dedup_key_m80 = f"member_budget:alert:80:{organization_id}:{user_id}:{month_start}"

                if monthly_pct >= 100 and not cache.get(dedup_key_m100):
                    cache.set(dedup_key_m100, True, 86400)
                    publish_billing_event(organization_id, "member_budget_exhausted", {
                        "user_id": user_id,
                        "consumed": str(monthly_consumed),
                        "limit": str(monthly_limit),
                        "budget_type": "monthly",
                    })
                elif monthly_pct >= 80 and not cache.get(dedup_key_m80):
                    cache.set(dedup_key_m80, True, 86400)
                    publish_billing_event(organization_id, "member_budget_warning", {
                        "user_id": user_id,
                        "consumed": str(monthly_consumed),
                        "limit": str(monthly_limit),
                        "usage_percent": float(round(monthly_pct, 1)),
                        "budget_type": "monthly",
                    })

        # ── 日度阈值检查 (R8) ──
        daily_limit = policy.daily_credits_limit
        if daily_limit and daily_limit > 0:
            daily_consumed = MemberLlmUsageCounter.objects.filter(
                organization_id=organization_id, user_id=user_id,
                cycle_date=today, cycle_type="daily",
            ).values_list("consumed_credits", flat=True).first()

            if daily_consumed is not None:
                daily_pct = (daily_consumed / daily_limit) * 100

                dedup_key_d100 = f"member_budget:alert:100:{organization_id}:{user_id}:daily:{today}"
                dedup_key_d80 = f"member_budget:alert:80:{organization_id}:{user_id}:daily:{today}"

                if daily_pct >= 100 and not cache.get(dedup_key_d100):
                    cache.set(dedup_key_d100, True, 86400)
                    publish_billing_event(organization_id, "member_budget_exhausted", {
                        "user_id": user_id,
                        "consumed": str(daily_consumed),
                        "limit": str(daily_limit),
                        "budget_type": "daily",
                    })
                elif daily_pct >= 80 and not cache.get(dedup_key_d80):
                    cache.set(dedup_key_d80, True, 86400)
                    publish_billing_event(organization_id, "member_budget_warning", {
                        "user_id": user_id,
                        "consumed": str(daily_consumed),
                        "limit": str(daily_limit),
                        "usage_percent": float(round(daily_pct, 1)),
                        "budget_type": "daily",
                    })
    except Exception as exc:
        logger.debug("[MemberBudget] 阈值检查失败: %s", exc)


def _check_model_tier_safety_net(
    organization_id: str, user_id: str, model_instance, request_id: str,
) -> None:
    """P1-6: 模型等级安全网——扣费后检查模型是否在成员允许范围内。

    API 层过滤可能被绕过（Agent 内部调用链直接指定 model_id），
    在扣费侧二次验证。不阻断（LLM 已调用完毕），仅记录 warning。
    """
    try:
        from apps.services.billing.services.member_budget_service import MemberBudgetService

        model_tier = MemberBudgetService.compute_model_cost_tier(model_instance)

        policy = MemberBudgetService.get_effective_policy(organization_id, user_id)
        if not policy:
            return
        if policy.max_model_tier == "enterprise":
            return

        _TIER = MemberBudgetService.MODEL_TIER_ORDER
        policy_val = _TIER.get(policy.max_model_tier, 3)
        model_val = _TIER.get(model_tier, 1)
        if model_val > policy_val:
            logger.warning(
                "[%s] P1-6 模型等级安全网: 模型 %s 等级(%s)超出成员策略(%s), "
                "wt=%s user=%s (LLM 已调用，仅记录)",
                request_id,
                getattr(model_instance, "model_name", ""),
                model_tier, policy.max_model_tier,
                organization_id[:8], user_id[:8],
            )
    except Exception as exc:
        logger.debug("[MemberBudget] P1-6 safety net check failed: %s", exc)


def _post_charge_budget_check(organization_id: str) -> None:
    """扣费后立即重新评估预算阈值，确保 warning/critical 事件不被缓存跳过。"""
    if not organization_id:
        return
    try:
        check_budget_policy(organization_id)
    except Exception as exc:
        logger.debug("[Budget] post-charge check failed: %s", exc)


def notify_balance_low(organization_id: str, current_balance: Decimal, threshold: Decimal = Decimal("10")) -> None:
    """[DEPRECATED] 低余额提醒薄壳，委托给 ``LowBalanceAlertService.check_and_notify``。

    历史上此函数用硬编码阈值 10 单级判定 + 单出口。现已收敛：检测 / 分级
    （warning/critical）/ 分级去重 / 双出口（移动端 WS toast + Electron Owner 铃铛）
    全部由 ``LowBalanceAlertService`` 统一负责，阈值读 per-organization 配置。

    ``threshold`` 参数保留仅为向后兼容，**不再生效**（阈值由配置决定）。
    保留本壳是为兜底任何隐藏调用方；新代码请直接调用 ``check_and_notify``。
    """
    if not organization_id:
        return
    try:
        from apps.services.billing.services.low_balance_alert_service import (
            LowBalanceAlertService,
        )
        LowBalanceAlertService.check_and_notify(organization_id, current_balance)
    except Exception as exc:
        logger.debug("[Budget] 低余额通知失败: %s", exc)
