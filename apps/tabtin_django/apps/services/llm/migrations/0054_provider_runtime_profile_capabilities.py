"""为 Doubao / OpenAI / Qwen 补齐 runtime_profile.thinking + context。

依据 ``docs/model-runtime/provider-runtime-capability-matrix.md``：

- 有真实 thinking API（wire / 官方请求参数）才声明 thinking
- 无真实 performance API → **不**写入 performance
- 禁止把 reasoning_effort / thinking_budget / enable_thinking 映射为 performance
- merge 仅触碰 runtime_profile.thinking / context；不覆盖 runtime_controls / wire_adapter

Qwen（test RDS）：qwen3.6/3.7-plus 官方有 enable_thinking，但当前库无 wire
reasoning → **只声明 context，不声明 thinking**（避免 Catalog 露出无法出网的控件）。
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional, Tuple

from django.db import migrations

TAG = "0054_provider_runtime_profile_capabilities"

# Doubao 官方（方舟「深度思考」docs/82379/1449737，模型列表 docs/82379/1330310）：
# - 开关：thinking.type = enabled（默认）| disabled（本批型号不支持 auto）
# - 强度：reasoning_effort = minimal(关思考) | low | medium | high | …
# - evolving / 2.1-pro / 2.1-turbo：reasoning_effort 默认 high
# - seed-2-0-lite：支持 effort；未列入「默认 high」→ 按文档通用默认 medium
# 能力层：off 对应关思考；不把 effort 映射为 performance。
DOUBAO_THINKING_HIGH_DEFAULT: Dict[str, Any] = {
    "supported": True,
    "off_supported": True,
    "effort_levels": ["low", "medium", "high"],
    "default_effort": "high",
    "user_selectable": ["off", "standard", "deep"],
}

DOUBAO_THINKING_MEDIUM_DEFAULT: Dict[str, Any] = {
    "supported": True,
    "off_supported": True,
    "effort_levels": ["low", "medium", "high"],
    "default_effort": "medium",
    "user_selectable": ["off", "standard", "deep"],
}

# 兼容旧测试名
DOUBAO_THINKING = DOUBAO_THINKING_HIGH_DEFAULT

GPT54_THINKING: Dict[str, Any] = {
    "supported": True,
    # none → off；xhigh 不进 EFFORT_LADDER，能力层只声明 low/medium/high
    "off_supported": True,
    "effort_levels": ["low", "medium", "high"],
    "default_effort": "medium",
    "user_selectable": ["off", "standard", "deep"],
}

# thinking 目标：(provider_key, model_name, thinking|None, context_window_hint)
#
# gpt-4.1-mini：无 reasoning API → thinking=None，仅 context
THINKING_AND_CONTEXT_TARGETS: List[Tuple[str, str, Optional[Dict[str, Any]], int]] = [
    # context hint 对齐官方模型列表：evolving 1024k；2.1 / 2.0-lite-260428 256k
    ("volcengine", "doubao-seed-evolving", DOUBAO_THINKING_HIGH_DEFAULT, 1048576),
    ("volcengine_doubao", "doubao-seed-2-1-pro-260628", DOUBAO_THINKING_HIGH_DEFAULT, 262144),
    ("volcengine_doubao", "doubao-seed-2-1-turbo-260628", DOUBAO_THINKING_HIGH_DEFAULT, 262144),
    ("volcengine", "doubao-seed-2-0-lite-260428", DOUBAO_THINKING_MEDIUM_DEFAULT, 262144),
    ("openai-local", "gpt-5.4-mini", GPT54_THINKING, 128000),
    # OpenAI gpt-4.1-mini：无 thinking；覆盖 RDS 全名 + 短名（若存在）
    ("openai", "gpt-4.1-mini-2025-04-14", None, 20481),
    ("openai", "gpt-4.1-mini", None, 20481),
]

# Qwen 审计：仅 context（无 wire → 不声明 thinking）
# glm-5 / kimi-k2.5 挂在 qwen provider 下但不是 DashScope 思考型号声明对象 → 仍补 context
QWEN_CONTEXT_TARGETS: List[Tuple[str, str, int]] = [
    ("qwen", "qwen3.6-plus", 1048576),
    ("qwen", "qwen3.7-plus", 1048576),
    ("dashscope_coding_plan", "qwen3.6-plus", 1048576),
    ("dashscope_coding_plan", "qwen3.7-plus", 1048576),
    ("qwen", "glm-5", 200000),
    ("qwen", "kimi-k2.5", 262144),
]


def merge_runtime_profile(
    capabilities_config: Optional[Dict[str, Any]],
    *,
    thinking: Optional[Dict[str, Any]] = None,
    context: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Deep-merge runtime_profile.thinking / context；剥离 performance 键。"""
    cfg = copy.deepcopy(capabilities_config) if isinstance(capabilities_config, dict) else {}
    runtime_profile = dict(cfg.get("runtime_profile") or {})

    if thinking is not None:
        existing = runtime_profile.get("thinking")
        if isinstance(existing, dict):
            merged = dict(existing)
            merged.update(copy.deepcopy(thinking))
        else:
            merged = copy.deepcopy(thinking)
        runtime_profile["thinking"] = merged

    if context is not None:
        existing = runtime_profile.get("context")
        if isinstance(existing, dict):
            merged = dict(existing)
            merged.update(copy.deepcopy(context))
        else:
            merged = copy.deepcopy(context)
        runtime_profile["context"] = merged

    runtime_profile.pop("performance", None)
    runtime_profile.pop("performance_profile", None)
    cfg["runtime_profile"] = runtime_profile
    return cfg


def _context_block(model, window_hint: int) -> Dict[str, Any]:
    window = getattr(model, "context_window_tokens", None)
    try:
        parsed = int(window) if window is not None else 0
    except (TypeError, ValueError):
        parsed = 0
    tokens = parsed if parsed > 0 else int(window_hint)
    return {"supported": True, "window_tokens": tokens}


def _apply_targets(
    LLMModel,
    targets: List[Tuple[str, str, Optional[Dict[str, Any]], int]],
) -> Tuple[int, int]:
    updated = skipped = 0
    for provider_key, model_name, thinking, window_hint in targets:
        qs = LLMModel.objects.filter(
            provider__provider_key=provider_key,
            model_name=model_name,
        )
        if qs.count() == 0:
            print(
                f"[{TAG}] ⚠ 未找到 provider_key={provider_key!r} "
                f"model_name={model_name!r}，跳过"
            )
            skipped += 1
            continue
        for model in qs:
            before = model.capabilities_config or {}
            # 防御：声明体本身不得带 performance
            safe_thinking = None
            if thinking is not None:
                safe_thinking = {
                    k: v
                    for k, v in thinking.items()
                    if k not in ("performance", "performance_profile")
                }
            after = merge_runtime_profile(
                before,
                thinking=safe_thinking,
                context=_context_block(model, window_hint),
            )
            if before == after:
                continue
            model.capabilities_config = after
            model.save(update_fields=["capabilities_config", "updated_at"])
            updated += 1
            axis = "thinking+context" if safe_thinking else "context-only"
            print(
                f"[{TAG}] merged runtime_profile ({axis}) "
                f"provider_key={provider_key} model={model_name} id={model.id}"
            )
    return updated, skipped


def declare_provider_runtime_profiles(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")

    updated_a, skipped_a = _apply_targets(LLMModel, THINKING_AND_CONTEXT_TARGETS)

    qwen_targets: List[Tuple[str, str, Optional[Dict[str, Any]], int]] = [
        (pk, name, None, window) for pk, name, window in QWEN_CONTEXT_TARGETS
    ]
    updated_b, skipped_b = _apply_targets(LLMModel, qwen_targets)

    print(
        f"[{TAG}] done updated={updated_a + updated_b} "
        f"missing_models={skipped_a + skipped_b}"
    )


def clear_provider_runtime_profiles(apps, schema_editor):
    """回滚：移除本 migration 目标行上的 thinking/context（若由本任务写入）。"""
    LLMModel = apps.get_model("llm", "LLMModel")
    keys = {(pk, name) for pk, name, _, _ in THINKING_AND_CONTEXT_TARGETS}
    keys |= {(pk, name) for pk, name, _ in QWEN_CONTEXT_TARGETS}

    for provider_key, model_name in sorted(keys):
        for model in LLMModel.objects.filter(
            provider__provider_key=provider_key,
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
        ("llm", "0053_kimi_runtime_profile_capabilities"),
    ]

    operations = [
        migrations.RunPython(
            declare_provider_runtime_profiles,
            clear_provider_runtime_profiles,
        ),
    ]
