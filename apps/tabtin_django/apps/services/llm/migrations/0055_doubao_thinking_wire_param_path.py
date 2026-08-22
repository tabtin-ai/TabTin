"""Doubao Seed：wire ``param_path`` 改为 ``thinking+reasoning_effort``。

只改 ``capabilities_config.wire_adapter.reasoning.param_path``，不覆盖
wire 其它字段、不改 runtime_profile / runtime_controls / billing。

出网语义由 ``request_adapter._normalize_doubao_thinking_and_effort`` 实现：
off → thinking.type=disabled（无 reasoning_effort）；
on  → thinking.type=enabled + reasoning_effort=low|medium|high。
"""

from __future__ import annotations

import copy

from django.db import migrations

TAG = "0055_doubao_thinking_wire_param_path"
NEW_PARAM_PATH = "thinking+reasoning_effort"
OLD_PARAM_PATH = "reasoning_effort"

# (provider_key, model_name) — 与官方深度思考支持列表 / test RDS 对齐
DOUBAO_WIRE_TARGETS = (
    ("volcengine", "doubao-seed-evolving"),
    ("volcengine", "doubao-seed-2-0-lite-260428"),
    ("volcengine_doubao", "doubao-seed-2-1-pro-260628"),
    ("volcengine_doubao", "doubao-seed-2-1-turbo-260628"),
)


def _set_reasoning_param_path(cfg, param_path: str):
    """Deep-merge 仅改 reasoning.param_path；其余 wire / 顶层字段保留。"""
    out = copy.deepcopy(cfg) if isinstance(cfg, dict) else {}
    wire = dict(out.get("wire_adapter") or {})
    reasoning = dict(wire.get("reasoning") or {})
    reasoning["param_path"] = param_path
    wire["reasoning"] = reasoning
    out["wire_adapter"] = wire
    return out


def declare_doubao_thinking_wire(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")
    updated = skipped = 0

    for provider_key, model_name in DOUBAO_WIRE_TARGETS:
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
            wire = before.get("wire_adapter") if isinstance(before, dict) else None
            reasoning = (
                wire.get("reasoning") if isinstance(wire, dict) else None
            )
            if not isinstance(reasoning, dict) or reasoning.get("enabled") is not True:
                print(
                    f"[{TAG}] ⚠ 无 enabled reasoning，跳过 "
                    f"provider_key={provider_key} model={model_name} id={model.id}"
                )
                continue
            if reasoning.get("param_path") == NEW_PARAM_PATH:
                continue
            after = _set_reasoning_param_path(before, NEW_PARAM_PATH)
            model.capabilities_config = after
            model.save(update_fields=["capabilities_config", "updated_at"])
            updated += 1
            print(
                f"[{TAG}] param_path → {NEW_PARAM_PATH!r} "
                f"provider_key={provider_key} model={model_name} id={model.id}"
            )

    print(f"[{TAG}] done updated={updated} missing_models={skipped}")


def revert_doubao_thinking_wire(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")
    for provider_key, model_name in DOUBAO_WIRE_TARGETS:
        for model in LLMModel.objects.filter(
            provider__provider_key=provider_key,
            model_name=model_name,
        ):
            before = model.capabilities_config or {}
            wire = (before or {}).get("wire_adapter")
            if not isinstance(wire, dict):
                continue
            reasoning = wire.get("reasoning")
            if not isinstance(reasoning, dict):
                continue
            if reasoning.get("param_path") != NEW_PARAM_PATH:
                continue
            after = _set_reasoning_param_path(before, OLD_PARAM_PATH)
            model.capabilities_config = after
            model.save(update_fields=["capabilities_config", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0054_provider_runtime_profile_capabilities"),
    ]

    operations = [
        migrations.RunPython(
            declare_doubao_thinking_wire,
            revert_doubao_thinking_wire,
        ),
    ]
