"""LLM 调用可观测 Prometheus 指标。

参照 billing_metrics.py 的 NullMetric 降级模式，
prometheus_client 不可用时所有指标静默降级为空操作。
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)


def _model_to_family(model_name: str) -> str:
    """将具体模型名收敛为模型族，控制 Prometheus 基数。

    例如：gpt-4o-2024-08-06 → gpt-4o
          claude-sonnet-4-20250514 → claude-sonnet-4
          qwen3-235b-a22b → qwen3-235b
    """
    if not model_name:
        return "unknown"
    name = re.sub(r'-\d{8}$', '', model_name)
    name = re.sub(r'-[a-f0-9]{4,8}$', '', name)
    return name


class _NullMetric:
    """prometheus_client 不可用时的静默降级。"""

    def labels(self, **kwargs):
        return self

    def inc(self, amount=1):
        pass

    def observe(self, value):
        pass

    def set(self, value):
        pass


def _null():
    return _NullMetric()


try:
    from prometheus_client import Counter, Gauge, Histogram

    llm_calls_total = Counter(
        "llm_calls_total",
        "LLM 调用总次数",
        ["provider", "model_family", "source", "status"],
    )

    llm_call_duration_seconds = Histogram(
        "llm_call_duration_seconds",
        "LLM 调用延迟（秒）",
        ["provider", "model_family"],
        buckets=[0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0],
    )

    llm_tokens_total = Counter(
        "llm_tokens_total",
        "LLM Token 消耗",
        ["provider", "model_family", "direction"],
    )

    llm_cache_tokens_total = Counter(
        "llm_cache_tokens_total",
        "Prompt Cache Token",
        ["provider", "model", "type"],
    )

    llm_cost_credits_total = Counter(
        "llm_cost_credits_total",
        "LLM 成本（点券）",
        ["provider", "model"],
    )

    llm_errors_total = Counter(
        "llm_errors_total",
        "LLM 错误分类",
        ["provider", "model_family", "error_category"],
    )

    llm_circuit_breaker_state = Gauge(
        "llm_circuit_breaker_state",
        "Provider 熔断状态 (0=healthy/unknown, 1=degraded, 2=unhealthy)",
        ["provider"],
    )

    llm_rate_limit_rejections_total = Counter(
        "llm_rate_limit_rejections_total",
        "渠道级限流拦截次数",
        ["provider"],
    )

    llm_byok_calls_total = Counter(
        "llm_byok_calls_total",
        "BYOK 渠道调用次数（免平台费）",
        ["provider", "model", "source"],
    )

    ai_scene_policy_shadow_total = Counter(
        "ai_scene_policy_shadow_total",
        "AI Scene Policy Shadow 比较结果",
        ["scene", "drift_type"],
    )

    ai_scene_invocation_total = Counter(
        "ai_scene_invocation_total",
        "AI Scene 业务调用次数",
        ["scene", "stable"],
    )

    ai_scene_attempt_total = Counter(
        "ai_scene_attempt_total",
        "AI Scene Provider 尝试次数",
        ["scene", "status"],
    )

    ai_scene_settlement_total = Counter(
        "ai_scene_settlement_total",
        "AI Scene 最终结算次数",
        ["scene", "status"],
    )

    ai_scene_legacy_identity_total = Counter(
        "ai_scene_legacy_identity_total",
        "仍使用 legacy request identity 的 AI Scene 调用次数",
        ["scene"],
    )

    ai_scene_byok_resolution_total = Counter(
        "ai_scene_byok_resolution_total",
        "AI Scene BYOK 精确解析结果",
        ["scene", "status"],
    )

    ai_scene_background_execution_guard_total = Counter(
        "ai_scene_background_execution_guard_total",
        "后台 Scene 服务端执行能力阻断次数",
        ["scene", "reason", "runtime"],
    )

    ai_workspace_memory_execution_total = Counter(
        "ai_workspace_memory_execution_total",
        "Workspace Aggregate Memory 执行解析次数",
        ["scene", "workspace_scope", "model_source", "execution"],
    )

    # v0.1.x Phase 2.5：Provider 配置健康度。
    # 在 model_resolver._check_provider_readiness 每次判定时埋点；
    # reason 是固定枚举，基数受控（provider × capability × reason ≈ 几百）。
    #
    # reason 取值：
    #   - ready                 — 通过所有检查
    #   - routing_disabled      — provider.routing_enabled=False
    #   - placeholder_api_key   — api_key 为空或以 <INSERT 开头
    #   - empty_base_url        — model.base_url 为空（v0.1.x 后下沉到 model）
    #   - capability_mismatch   — provider.capability_domains 不含目标 domain
    llm_provider_readiness_check_total = Counter(
        "llm_provider_readiness_check_total",
        "Provider/Model 就绪性检查计数（路由热路径），按未就绪原因分类",
        ["provider", "capability_domain", "reason"],
    )

    # 运营盘点：周期性 cron 扫一次所有 routing_enabled=True 的 (provider, model)，
    # 按 readiness 状态写 Gauge。给 dashboard 看"当前有多少配置不就绪"。
    # 配套命令：apps/services/llm/management/commands/check_provider_readiness.py
    llm_provider_readiness_state = Gauge(
        "llm_provider_readiness_state",
        "Provider/Model 配置就绪盘点（按 reason 分类，周期 cron 写入）",
        ["reason"],
    )

except Exception as _exc:  # noqa: BLE001
    logger.warning("[LLMMetrics] prometheus_client 不可用，指标已降级为空操作: %s", _exc)
    llm_calls_total = _null()
    llm_call_duration_seconds = _null()
    llm_tokens_total = _null()
    llm_cache_tokens_total = _null()
    llm_cost_credits_total = _null()
    llm_errors_total = _null()
    llm_circuit_breaker_state = _null()
    llm_rate_limit_rejections_total = _null()
    llm_byok_calls_total = _null()
    ai_scene_policy_shadow_total = _null()
    ai_scene_invocation_total = _null()
    ai_scene_attempt_total = _null()
    ai_scene_settlement_total = _null()
    ai_scene_legacy_identity_total = _null()
    ai_scene_byok_resolution_total = _null()
    ai_scene_background_execution_guard_total = _null()
    ai_workspace_memory_execution_total = _null()
    llm_provider_readiness_check_total = _null()
    llm_provider_readiness_state = _null()
