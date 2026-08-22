"""纠正 Kimi K2.5 / K2.6 / K2.7-code 的 runtime_profile.thinking 声明。

0053 把二进制 thinking（enabled/disabled）错误编码成
``effort_levels=["medium"]`` + ``user_selectable`` 含 ``deep``，导致：

- UI 展示伪「深度」档
- deep→high→medium 触发 effort_level_unavailable 降级横幅
- wire ``param_path=thinking`` 注入 Claude 式 ``budget_tokens``

本 migration 只 deep-merge 目标模型的 ``runtime_profile.thinking`` 键，
保留 capabilities_config 其它字段与 thinking 内未知键；不改 wire_adapter /
billing / runtime_controls / 价格。

官方能力（SoT）:

- k2.5 / k2.6：支持思考；可开关；无 reasoning_effort 档位
- k2.7-code：始终思考；不可关；无 effort 档位；UI 不暴露可点控件
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Optional

from django.db import migrations

TAG = "0056_kimi_k2x_binary_thinking_correction"
PROVIDER_KEY = "moonshot"

# 纠正后的能力层形状（供 read_model_capability）
#
# - effort_levels=[]：无厂商强度梯子（≠ 不支持思考）
# - user_selectable=["off","standard"]：UI 仅 关闭/开启
# - k2.7：user_selectable=[] + off_supported=False → Catalog always_on
KIMI_K2X_THINKING_CORRECTIONS: Dict[str, Dict[str, Any]] = {
    "kimi-k2.5": {
        "supported": True,
        "off_supported": True,
        "forced": False,
        "effort_levels": [],
        "default_effort": None,
        "user_selectable": ["off", "standard"],
    },
    "kimi-k2.6": {
        "supported": True,
        "off_supported": True,
        "forced": False,
        "effort_levels": [],
        "default_effort": None,
        "user_selectable": ["off", "standard"],
    },
    "kimi-k2.7-code": {
        "supported": True,
        "off_supported": False,
        "forced": True,
        "effort_levels": [],
        "default_effort": None,
        "user_selectable": [],
    },
    "kimi-k2.7-code-highspeed": {
        "supported": True,
        "off_supported": False,
        "forced": True,
        "effort_levels": [],
        "default_effort": None,
        "user_selectable": [],
    },
}

# reverse：回到 0053 写入的形状（仅 thinking 轴）
_KIMI_K2X_THINKING_ROLLBACK: Dict[str, Dict[str, Any]] = {
    "kimi-k2.5": {
        "supported": True,
        "off_supported": True,
        "effort_levels": ["medium"],
        "default_effort": "medium",
        "user_selectable": ["off", "standard", "deep"],
    },
    "kimi-k2.6": {
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
        "effort_levels": ["medium"],
        "default_effort": "medium",
        "user_selectable": ["standard", "deep"],
    },
    "kimi-k2.7-code-highspeed": {
        "supported": True,
        "off_supported": False,
        "forced": True,
        "effort_levels": ["medium"],
        "default_effort": "medium",
        "user_selectable": ["standard", "deep"],
    },
}


def merge_thinking_correction(
    capabilities_config: Optional[Dict[str, Any]],
    thinking: Dict[str, Any],
) -> Dict[str, Any]:
    """Deep-merge ``runtime_profile.thinking``，保留未知键与兄弟字段。"""
    cfg = copy.deepcopy(capabilities_config) if isinstance(capabilities_config, dict) else {}
    runtime_profile = dict(cfg.get("runtime_profile") or {})
    existing = runtime_profile.get("thinking")
    if isinstance(existing, dict):
        merged = dict(existing)
        merged.update(copy.deepcopy(thinking))
    else:
        merged = copy.deepcopy(thinking)
    # default_effort=None 必须显式落库（覆盖 0053 的 "medium"）
    if "default_effort" in thinking and thinking["default_effort"] is None:
        merged["default_effort"] = None
    if "effort_levels" in thinking:
        merged["effort_levels"] = list(thinking["effort_levels"])
    if "user_selectable" in thinking:
        merged["user_selectable"] = list(thinking["user_selectable"])
    runtime_profile["thinking"] = merged
    runtime_profile.pop("performance", None)
    runtime_profile.pop("performance_profile", None)
    cfg["runtime_profile"] = runtime_profile
    return cfg


def apply_kimi_k2x_thinking_corrections(apps, schema_editor):
    LLMModel = apps.get_model("llm", "LLMModel")
    updated = skipped = 0
    for model_name, thinking in KIMI_K2X_THINKING_CORRECTIONS.items():
        qs = LLMModel.objects.filter(
            provider__provider_key=PROVIDER_KEY,
            model_name=model_name,
        )
        if qs.count() == 0:
            print(
                f"[{TAG}] ⚠ 未找到 provider_key={PROVIDER_KEY!r} "
                f"model_name={model_name!r}，跳过"
            )
            skipped += 1
            continue
        for model in qs:
            before = model.capabilities_config or {}
            after = merge_thinking_correction(before, thinking)
            if before == after:
                continue
            model.capabilities_config = after
            model.save(update_fields=["capabilities_config", "updated_at"])
            updated += 1
            print(
                f"[{TAG}] corrected runtime_profile.thinking "
                f"provider_key={PROVIDER_KEY} model={model_name} id={model.id}"
            )
    print(f"[{TAG}] done updated={updated} missing_models={skipped}")


def rollback_kimi_k2x_thinking_corrections(apps, schema_editor):
    """回滚到 0053 形状（仅本批模型 thinking 轴）。"""
    LLMModel = apps.get_model("llm", "LLMModel")
    for model_name, thinking in _KIMI_K2X_THINKING_ROLLBACK.items():
        for model in LLMModel.objects.filter(
            provider__provider_key=PROVIDER_KEY,
            model_name=model_name,
        ):
            before = model.capabilities_config or {}
            after = merge_thinking_correction(before, thinking)
            if before == after:
                continue
            model.capabilities_config = after
            model.save(update_fields=["capabilities_config", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0055_doubao_thinking_wire_param_path"),
    ]

    operations = [
        migrations.RunPython(
            apply_kimi_k2x_thinking_corrections,
            rollback_kimi_k2x_thinking_corrections,
        ),
    ]
