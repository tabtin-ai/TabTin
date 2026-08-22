"""Declare user-facing reasoning-effort controls in model capabilities.

Catalog must not infer selectable request parameters from wire_adapter internals.
Models that want controls in the client model menu declare them explicitly in
``capabilities_config.runtime_controls``.
"""

from __future__ import annotations

import copy

from django.db import migrations


VOLCENGINE_REASONING_EFFORT_CONTROL = {
    "key": "reasoning_effort",
    "label": "思考强度",
    "description": (
        "火山方舟官方：reasoning_effort（Chat API）用于调节思考长度/思维链长度，"
        "以平衡效果、时延和成本；Chat API 默认值为 medium。"
    ),
    "kind": "select",
    "param_path": "reasoning_effort",
    "default_value": None,
    "visibility": "model_menu",
    "options": [
        {
            "value": None,
            "label": "默认",
            "description": "不传 reasoning_effort，使用火山方舟 Chat API 默认值 medium。",
        },
        {
            "value": "low",
            "label": "低",
            "description": "将 reasoning_effort 设为 low；降低思考深度通常响应更快、思考 token 更少。",
        },
        {
            "value": "medium",
            "label": "中",
            "description": "将 reasoning_effort 设为 medium；这是火山方舟 Chat API 默认值。",
        },
        {
            "value": "high",
            "label": "高",
            "description": "将 reasoning_effort 设为 high，提高模型可使用的思考工作量。",
        },
    ],
}


KIMI_K3_REASONING_EFFORT_CONTROL = {
    "key": "reasoning_effort",
    "label": "思考强度",
    "description": (
        "Kimi 官方：K3 始终进行推理；通过顶层 reasoning_effort 配置 reasoning effort，"
        "支持 low/high/max，默认 max。"
    ),
    "kind": "select",
    "param_path": "reasoning_effort",
    "default_value": None,
    "visibility": "model_menu",
    "options": [
        {
            "value": None,
            "label": "默认",
            "description": "不传 reasoning_effort，使用 Kimi K3 官方默认值 max。",
        },
        {
            "value": "low",
            "label": "低",
            "description": "将 Kimi K3 顶层 reasoning_effort 设为 low。",
        },
        {
            "value": "high",
            "label": "高",
            "description": "将 Kimi K3 顶层 reasoning_effort 设为 high。",
        },
        {
            "value": "max",
            "label": "最高",
            "description": "将 Kimi K3 顶层 reasoning_effort 设为 max；这是官方默认值。",
        },
    ],
}


DEEPSEEK_REASONING_EFFORT_CONTROL = {
    "key": "reasoning_effort",
    "label": "思考强度",
    "description": (
        "DeepSeek 官方：V4 Pro 支持 high/max 两档 reasoning_effort；"
        "仅在思考模式开启时生效。"
    ),
    "kind": "select",
    "param_path": "reasoning_effort",
    "default_value": None,
    "visibility": "model_menu",
    "options": [
        {
            "value": None,
            "label": "默认",
            "description": "不传 reasoning_effort，使用 DeepSeek 默认思考强度。",
        },
        {
            "value": "high",
            "label": "高",
            "description": "发送 reasoning_effort=high。",
        },
        {
            "value": "max",
            "label": "最高",
            "description": "发送 reasoning_effort=max，允许模型投入更多推理工作量。",
        },
    ],
}


OPENAI_REASONING_EFFORT_CONTROL = {
    "key": "reasoning_effort",
    "label": "思考强度",
    "description": (
        "OpenAI 官方：GPT-5.4 mini 在 Chat Completions 请求中通过 "
        "reasoning_effort 调节推理工作量，"
        "支持 none/low/medium/high/xhigh，默认 none。"
    ),
    "kind": "select",
    "param_path": "reasoning_effort",
    "default_value": "none",
    "visibility": "model_menu",
    "options": [
        {
            "value": "none",
            "label": "无",
            "description": "使用 reasoning_effort=none；这是模型默认值。",
        },
        {
            "value": "low",
            "label": "低",
            "description": "使用较低推理工作量，侧重响应速度。",
        },
        {
            "value": "medium",
            "label": "中",
            "description": "使用中等推理工作量。",
        },
        {
            "value": "high",
            "label": "高",
            "description": "使用较高推理工作量。",
        },
        {
            "value": "xhigh",
            "label": "最高",
            "description": "使用 GPT-5.4 mini 支持的最高推理工作量。",
        },
    ],
}


MODEL_RUNTIME_CONTROLS = {
    # 测试 DB 尚未支持 Kimi K3，先保留调研结果但不启用能力声明。
    # "moonshot": {
    #     "kimi-k3": [KIMI_K3_REASONING_EFFORT_CONTROL],
    # },
    "openai": {
        "deepseek-v4-pro": [DEEPSEEK_REASONING_EFFORT_CONTROL],
    },
    "openai-local": {
        "gpt-5.4-mini": [OPENAI_REASONING_EFFORT_CONTROL],
    },
    "volcengine": {
        "doubao-seed-2-0-lite-260428": [VOLCENGINE_REASONING_EFFORT_CONTROL],
    },
    "volcengine_doubao": {
        "doubao-seed-2-1-pro-260628": [VOLCENGINE_REASONING_EFFORT_CONTROL],
        "doubao-seed-2-1-turbo-260628": [VOLCENGINE_REASONING_EFFORT_CONTROL],
    },
}


MODEL_REASONING_PATCHES = {
    ("openai", "deepseek-v4-pro"): {
        "enabled": True,
        "surface": "delta_reasoning_content",
        "format": "reasoning_content_field",
        "budget_param": "reasoning_effort",
        "param_path": "reasoning_effort",
        "visible_to_client": True,
    },
    ("openai-local", "gpt-5.4-mini"): {
        "enabled": True,
        "surface": "hidden",
        "format": "hidden",
        "budget_param": "reasoning_effort",
        "param_path": "reasoning_effort",
        "visible_to_client": False,
    },
    ("volcengine", "doubao-seed-2-0-lite-260428"): {
        "enabled": True,
        "param_path": "reasoning_effort",
    },
    ("volcengine_doubao", "doubao-seed-2-1-pro-260628"): {
        "enabled": True,
        "param_path": "reasoning_effort",
    },
    ("volcengine_doubao", "doubao-seed-2-1-turbo-260628"): {
        "enabled": True,
        "param_path": "reasoning_effort",
    },
}

MODEL_CAPABILITY_PATCHES = {
    ("openai", "deepseek-v4-pro"): {
        "supports_reasoning": True,
    },
    ("openai-local", "gpt-5.4-mini"): {
        "supports_reasoning": True,
    },
}


def _supported_global_chat_models(LLMModel, provider_key, model_name):
    """Limit the data migration to models already supported by the catalog."""
    return LLMModel.objects.filter(
        provider__provider_key=provider_key,
        provider__scope="global",
        provider__organization_id__isnull=True,
        provider__user_id__isnull=True,
        model_name=model_name,
        capability_domain="chat",
        wave_status="ready",
    )


def declare_runtime_controls(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")

    for provider_key, model_controls in MODEL_RUNTIME_CONTROLS.items():
        for model_name, controls in model_controls.items():
            for model in _supported_global_chat_models(
                LLMModel,
                provider_key,
                model_name,
            ):
                cfg = dict(model.capabilities_config or {})
                next_controls = copy.deepcopy(controls)
                changed = cfg.get("runtime_controls") != next_controls
                cfg["runtime_controls"] = next_controls

                reasoning_patch = MODEL_REASONING_PATCHES.get(
                    (provider_key, model_name)
                )
                if reasoning_patch:
                    wire_adapter = copy.deepcopy(cfg.get("wire_adapter") or {})
                    reasoning = copy.deepcopy(
                        wire_adapter.get("reasoning") or {}
                    )
                    next_reasoning = {
                        **reasoning,
                        **copy.deepcopy(reasoning_patch),
                    }
                    if reasoning != next_reasoning:
                        reasoning = next_reasoning
                        wire_adapter["reasoning"] = reasoning
                        cfg["wire_adapter"] = wire_adapter
                        changed = True
                capability_patch = MODEL_CAPABILITY_PATCHES.get(
                    (provider_key, model_name),
                    {"supports_reasoning": True},
                )
                next_cfg = {
                    **cfg,
                    **copy.deepcopy(capability_patch),
                }
                if cfg != next_cfg:
                    cfg = next_cfg
                    changed = True

                if not changed:
                    continue
                model.capabilities_config = cfg
                model.save(update_fields=["capabilities_config", "updated_at"])


def clear_runtime_controls(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")

    for provider_key, model_controls in MODEL_RUNTIME_CONTROLS.items():
        for model_name in model_controls:
            for model in _supported_global_chat_models(
                LLMModel,
                provider_key,
                model_name,
            ):
                cfg = dict(model.capabilities_config or {})
                cfg.pop("runtime_controls", None)

                model_key = (provider_key, model_name)
                wire_adapter = copy.deepcopy(cfg.get("wire_adapter") or {})
                reasoning = copy.deepcopy(wire_adapter.get("reasoning") or {})
                if model_key in {
                    ("openai", "deepseek-v4-pro"),
                    ("openai-local", "gpt-5.4-mini"),
                }:
                    wire_adapter.pop("reasoning", None)
                    cfg.pop("supports_reasoning", None)
                elif reasoning:
                    reasoning["param_path"] = "thinking"
                    wire_adapter["reasoning"] = reasoning
                if wire_adapter:
                    cfg["wire_adapter"] = wire_adapter
                else:
                    cfg.pop("wire_adapter", None)

                model.capabilities_config = cfg
                model.save(update_fields=["capabilities_config", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0049_clear_moonshot_v1_document_input"),
    ]

    operations = [
        migrations.RunPython(declare_runtime_controls, clear_runtime_controls),
    ]
