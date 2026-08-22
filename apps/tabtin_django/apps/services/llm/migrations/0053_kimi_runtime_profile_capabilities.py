"""为 Moonshot Kimi chat 模型补齐 runtime_profile.thinking + context。

只 deep-merge ``runtime_profile`` 的 thinking / context 轴，不覆盖整份
capabilities_config，不改 wire_adapter / billing / tools / runtime_controls，
不写入 ``runtime_profile.performance``（无真实 performance API）。

DB 存储走能力层字段（effort_levels / default_effort / user_selectable /
off_supported / forced）；Catalog 对外再序列化为 modes / default_mode。

产品语言（brief）→ 能力层编码见模块注释与
``docs/model-runtime/kimi-runtime-profile-capability-report-v2.md``：
``standard``/``deep`` 是 thinking_mode，不是 EFFORT_LADDER；
K2.x 二进制 thinking 用单一 canonical ``medium`` 表达「on」，
避免伪造厂商 low/medium/high 枚举。
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Optional

from django.db import migrations

TAG = "0053_kimi_runtime_profile_capabilities"
PROVIDER_KEY = "moonshot"

# model_name → runtime_profile.thinking（能力层形状，供 read_model_capability）
#
# 与产品 brief 对齐要点：
# - kimi-k3：reasoning_effort low/high/max；不可关；max 不进 thinking_mode
# - kimi-k2.5 / k2.6：thinking enabled/disabled；standard/deep 均表示 on
# - kimi-k2.7-code：forced thinking；无 off
# - 全系：不声明 runtime_profile.performance
KIMI_THINKING_PROFILES: Dict[str, Dict[str, Any]] = {
    "kimi-k3": {
        "supported": True,
        "off_supported": False,
        "effort_levels": ["low", "high", "max"],
        "default_effort": "max",
        "user_selectable": ["standard", "deep"],
    },
    "kimi-k2.6": {
        "supported": True,
        "off_supported": True,
        # 单一 on 档：产品 standard/deep 都经 Resolver→wire 折叠为 thinking.enabled
        "effort_levels": ["medium"],
        "default_effort": "medium",
        "user_selectable": ["off", "standard", "deep"],
    },
    "kimi-k2.5": {
        "supported": True,
        "off_supported": True,
        "effort_levels": ["medium"],
        "default_effort": "medium",
        "user_selectable": ["off", "standard", "deep"],
    },
    "kimi-k2.7-code": {
        "supported": True,
        "off_supported": False,
        "forced": True,
        # 始终思考；产品 standard/deep 均表示 on（无厂商 effort 枚举）
        "effort_levels": ["medium"],
        "default_effort": "medium",
        "user_selectable": ["standard", "deep"],
    },
    # 与 k2.7-code 同声明；行不存在则跳过
    "kimi-k2.7-code-highspeed": {
        "supported": True,
        "off_supported": False,
        "forced": True,
        "effort_levels": ["medium"],
        "default_effort": "medium",
        "user_selectable": ["standard", "deep"],
    },
}

# 矩阵 context；migrate 时若行上 context_window_tokens>0 则覆盖 window_tokens
KIMI_CONTEXT_PROFILES: Dict[str, Dict[str, Any]] = {
    "kimi-k3": {"supported": True, "window_tokens": 1048576},
    "kimi-k2.6": {"supported": True, "window_tokens": 262144},
    "kimi-k2.5": {"supported": True, "window_tokens": 262144},
    "kimi-k2.7-code": {"supported": True, "window_tokens": 262144},
    "kimi-k2.7-code-highspeed": {"supported": True, "window_tokens": 262144},
}


def merge_runtime_profile(
    capabilities_config: Optional[Dict[str, Any]],
    *,
    thinking: Optional[Dict[str, Any]] = None,
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Deep-merge ``runtime_profile.thinking`` / ``.context``，保留其它键。

    - 顶层 capabilities_config 其它字段（wire_adapter / billing / …）原样保留
    - ``runtime_profile`` 兄弟键（如 output_budget）保留
    - thinking / context 内已有键被本次声明覆盖；未出现在声明里的旧键保留
    - 永不写入 ``performance`` / ``performance_profile``
    - 不触碰 ``runtime_controls`` / ``wire_adapter``
    """
    cfg = copy.deepcopy(capabilities_config) if isinstance(capabilities_config, dict) else {}
    runtime_profile = dict(cfg.get("runtime_profile") or {})

    if thinking is not None:
        existing_thinking = runtime_profile.get("thinking")
        if isinstance(existing_thinking, dict):
            merged_thinking = dict(existing_thinking)
            merged_thinking.update(copy.deepcopy(thinking))
        else:
            merged_thinking = copy.deepcopy(thinking)
        runtime_profile["thinking"] = merged_thinking

    if context is not None:
        existing_context = runtime_profile.get("context")
        if isinstance(existing_context, dict):
            merged_context = dict(existing_context)
            merged_context.update(copy.deepcopy(context))
        else:
            merged_context = copy.deepcopy(context)
        runtime_profile["context"] = merged_context

    # 防御：能力声明阶段不落 performance 轴
    runtime_profile.pop("performance", None)
    runtime_profile.pop("performance_profile", None)
    cfg["runtime_profile"] = runtime_profile
    return cfg


def merge_runtime_profile_thinking(
    capabilities_config: Optional[Dict[str, Any]],
    thinking: Dict[str, Any],
) -> Dict[str, Any]:
    """兼容旧测试入口：仅 merge thinking。"""
    return merge_runtime_profile(capabilities_config, thinking=thinking)


def _context_for_row(model, declared: Dict[str, Any]) -> Dict[str, Any]:
    ctx = copy.deepcopy(declared)
    window = getattr(model, "context_window_tokens", None)
    try:
        parsed = int(window) if window is not None else 0
    except (TypeError, ValueError):
        parsed = 0
    if parsed > 0:
        ctx["window_tokens"] = parsed
        ctx["supported"] = True
    return ctx


def declare_kimi_runtime_profiles(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")

    updated = skipped = 0
    for model_name, thinking in KIMI_THINKING_PROFILES.items():
        qs = LLMModel.objects.filter(
            provider__provider_key=PROVIDER_KEY,
            model_name=model_name,
        )
        count = qs.count()
        if count == 0:
            print(
                f"[{TAG}] ⚠ 未找到 provider_key={PROVIDER_KEY!r} "
                f"model_name={model_name!r}，跳过"
            )
            skipped += 1
            continue

        context = KIMI_CONTEXT_PROFILES.get(model_name)
        for model in qs:
            before = model.capabilities_config or {}
            after = merge_runtime_profile(
                before,
                thinking=thinking,
                context=_context_for_row(model, context) if context else None,
            )
            if before == after:
                continue
            model.capabilities_config = after
            model.save(update_fields=["capabilities_config", "updated_at"])
            updated += 1
            print(
                f"[{TAG}] merged runtime_profile.thinking+context "
                f"provider_key={PROVIDER_KEY} model={model_name} id={model.id}"
            )

    print(f"[{TAG}] done updated={updated} missing_models={skipped}")


def clear_kimi_runtime_profiles(apps, schema_editor):
    """回滚：仅移除本 migration 写入的 runtime_profile.thinking / context。"""
    LLMModel = apps.get_model("llm", "LLMModel")

    for model_name in KIMI_THINKING_PROFILES:
        for model in LLMModel.objects.filter(
            provider__provider_key=PROVIDER_KEY,
            model_name=model_name,
        ):
            cfg = copy.deepcopy(model.capabilities_config or {})
            runtime_profile = cfg.get("runtime_profile")
            if not isinstance(runtime_profile, dict):
                continue
            runtime_profile.pop("thinking", None)
            runtime_profile.pop("context", None)
            if runtime_profile:
                cfg["runtime_profile"] = runtime_profile
            else:
                cfg.pop("runtime_profile", None)
            model.capabilities_config = cfg
            model.save(update_fields=["capabilities_config", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0052_merge_20260803_1125"),
    ]

    operations = [
        migrations.RunPython(
            declare_kimi_runtime_profiles,
            clear_kimi_runtime_profiles,
        ),
    ]
