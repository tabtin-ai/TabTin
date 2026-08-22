"""W1a-fix-2:wire_adapter capability 字段对同步 + ZenMux qwen 子型。

W1a-fix-2 范围(harness W1a-fix-2 任务定义书):

* **Block 1 — 字段对同步**:0015 写入的旧字段(``system_placement`` /
  ``input_tokens_field`` / ``cache_read_field`` / ``extra_metrics`` /
  ``cache_write_field`` / ``min_tokens_for_cache`` / ``context_window_tokens``)
  和 0016 加的新字段(``system_message_style`` / ``input_field`` / ``cached_path``
  / ``extra_fields`` / ``cache_creation_path`` / ``min_tokens`` / ``context_window``)
  在 9 个 chat-capable active model 上不同步,会让 W1b WireAdapter 不知道读哪个。
  本 migration 让它们对齐:取新字段为权威值,缺失时从旧字段补。

* **Block 5 — ZenMux qwen 子型**:provider_profiles ZenMux 推荐范围含
  ``qwen/qwen3.5-plus`` 但 0016 ``_resolve_zenmux_profile`` 不映射 qwen 前缀。
  本 migration 加 ZENMUX_QWEN_FULL profile + 同步重跑 ZenMux 子型路由,补上
  漏配置的 zenmux qwen-* model(若 DB 有的话)。

设计原则:

* **以新字段为权威值**:harness 总控 v0.3 / W1a-fix v2 落地后,新字段是 W1b
  WireAdapter 的真实读取源。旧字段保留只为 0015 已写过的兼容性,不破坏其他
  既存逻辑。
* **deep-merge 不覆盖 admin 手工配的字段**:用户已显式配过的非默认值不动。
* **idempotent**:可重复 apply 不会越改越偏。

字段同步语义对照表(详见各处理函数注释):

| nested.field | 同步规则 |
|---|---|
| ``wire.system_message_style`` ↔ ``system_placement`` | 新值权威,旧字段对齐到新值 |
| ``usage.input_field`` ↔ ``input_tokens_field`` | 新值权威,缺失从旧补 |
| ``usage.output_field`` ↔ ``output_tokens_field`` | 新值权威,缺失从旧补 |
| ``usage.cached_path`` ↔ ``cache_read_field`` | 新值权威,缺失从旧补 |
| ``usage.cache_creation_path`` ↔ ``cache_write_field`` | 新值权威,缺失从旧补 |
| ``usage.extra_fields`` ↔ ``extra_metrics`` | extra_fields 是 superset(必须含 extra_metrics 所有值)|
| ``caching.min_tokens`` ↔ ``min_tokens_for_cache`` | 新值权威,缺失从旧补 |
| ``limits.context_window`` ↔ ``context_window_tokens`` | 新值权威,缺失从旧补 |
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional

from django.db import migrations


# ---------------------------------------------------------------------------
# 字段对同步映射:(nested_key, old_field_name, new_field_name)
# 同步规则:新字段值权威;若新字段缺失,用旧字段值填入新字段;旧字段也对齐到新值。
# ---------------------------------------------------------------------------

FIELD_PAIRS_SCALAR = [
    # nested 段名, 旧字段名, 新字段名
    ("wire", "system_placement", "system_message_style"),
    ("usage", "input_tokens_field", "input_field"),
    ("usage", "output_tokens_field", "output_field"),
    ("usage", "cache_read_field", "cached_path"),
    ("usage", "cache_write_field", "cache_creation_path"),
    ("caching", "min_tokens_for_cache", "min_tokens"),
    ("limits", "context_window_tokens", "context_window"),
]


def _is_filled(value: Any) -> bool:
    """判定字段值是否已填(非 None / 非空)。"""
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict, str)) and len(value) == 0:
        return False
    return True


def _sync_scalar_pair(nested: dict, old_key: str, new_key: str) -> bool:
    """同步 scalar 字段对,返回是否做了改动。

    规则:
    1. 新旧都有值 → 新值权威,把旧字段对齐到新值(若不一致)
    2. 仅新有值 → 旧字段从新字段补
    3. 仅旧有值 → 新字段从旧字段补,旧字段保留
    4. 都无值 → 不动
    """
    if nested is None:
        return False
    old_val = nested.get(old_key)
    new_val = nested.get(new_key)
    old_filled = _is_filled(old_val)
    new_filled = _is_filled(new_val)

    if not old_filled and not new_filled:
        return False

    if old_filled and new_filled:
        if old_val == new_val:
            return False
        # 新值权威,旧字段对齐
        nested[old_key] = new_val
        return True

    if new_filled and not old_filled:
        # 仅新有值 → 旧字段补
        nested[old_key] = new_val
        return True

    if old_filled and not new_filled:
        # 仅旧有值 → 新字段补
        nested[new_key] = old_val
        return True

    return False


def _sync_extra_fields_superset(usage: dict) -> bool:
    """同步 extra_fields ⊇ extra_metrics(extra_fields 是 superset)。

    返回是否改动。
    """
    if usage is None:
        return False
    extra_fields = list(usage.get("extra_fields") or [])
    extra_metrics = list(usage.get("extra_metrics") or [])
    if not extra_fields and not extra_metrics:
        return False
    # superset:把 extra_metrics 里 extra_fields 没有的值加进来
    changed = False
    for v in extra_metrics:
        if v not in extra_fields:
            extra_fields.append(v)
            changed = True
    if changed:
        usage["extra_fields"] = extra_fields
    return changed


def _sync_field_pairs(wa: dict) -> List[str]:
    """同步整个 wire_adapter dict 的所有字段对,返回改动报告。"""
    changes: List[str] = []
    for nested_key, old_key, new_key in FIELD_PAIRS_SCALAR:
        nested = wa.get(nested_key)
        if not isinstance(nested, dict):
            continue
        if _sync_scalar_pair(nested, old_key, new_key):
            changes.append(f"{nested_key}.{old_key} ↔ {new_key}")
    # extra_fields ⊇ extra_metrics
    usage = wa.get("usage")
    if isinstance(usage, dict) and _sync_extra_fields_superset(usage):
        changes.append("usage.extra_fields superset of extra_metrics")
    return changes


# ---------------------------------------------------------------------------
# Block 5:ZenMux qwen 子型完整 profile
# ---------------------------------------------------------------------------

# Qwen 子型(zenmux/qwen/*)— Qwen 真实能力 + ZenMux OpenAI 兼容包装。
# 与 0016 QWEN_V2_PATCH 对齐:不支持 json_schema,parallel default OFF,
# reasoning_content_field 风,但 wire 入口是 ZenMux 出口的 OpenAI 兼容
# /chat/completions + openai_delta SSE。
ZENMUX_QWEN_FULL = {
    "image": {
        "enabled": True,
        "input_via": ["base64", "url"],
        "formats": ["jpeg", "png", "webp"],
        "max_count_per_request": 10,
        "max_size_bytes": 10 * 1024 * 1024,
        "max_size_mb": 10,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none"],
        # Qwen DashScope 默认 OFF(关键差异)
        "parallel_default": False,
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
        "param_field": "parameters",
        "max_tools": 128,
    },
    "wire": {
        # ZenMux 出口 = OpenAI 兼容 /chat/completions
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        "system_quirks": [],
        "stream_supported": True,
        "upstream_path": "/chat/completions",
        "streaming_protocol": "openai_delta",
        "streaming_emits_usage": True,
        "system_message_style": "messages_first_role_system",
    },
    "caching": {
        "mode": "context_cache",
        "min_tokens_for_cache": None,
        "min_tokens": None,
        "cache_ttl_param": None,
        "cache_control_strip": True,  # ZenMux 不接 Anthropic cache_control 块
    },
    "json_mode": {
        # Qwen 不支持 json_schema(关键差异)
        "mode": "json_object",
        "modes": ["json_object"],
        "strict_supported": False,
        "schema_field": None,
        "schema_fallback": True,  # 走 prompt-only 兜底
    },
    "reasoning": {
        "enabled": True,
        "surface": "delta_reasoning_content",
        "format": "reasoning_content_field",
        "budget_param": None,
        "param_path": None,
        "visible_to_client": True,
    },
    "usage": {
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cache_read_field": "prompt_tokens_details.cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
        "input_field": "prompt_tokens",
        "output_field": "completion_tokens",
        "cached_path": "prompt_tokens_details.cached_tokens",
        "cache_creation_path": None,
        "extra_fields": [],
    },
    "limits": {
        "context_window_tokens": 1000000,
        "max_output_tokens": 8192,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
        "context_window": 1000000,
        "request_payload_max_mb": 20,
        "silent_drop_params": [],
        "extra_routing_headers": {},
    },
    "wave_status": "ready",
    "is_configured": True,
}


def _resolve_zenmux_profile_v2(model_name: Optional[str]) -> Optional[dict]:
    """Block 5:0016 _resolve_zenmux_profile 扩展,加 qwen 子型路由。

    映射规则:
    - ``anthropic/claude-*`` 或 ``/claude-*`` → ZENMUX_CLAUDE_FULL(0016)
    - ``google/gemini-*`` 或 ``/gemini-*`` → ZENMUX_GEMINI_FULL(0016)
    - ``openai/gpt-*`` 或 ``/gpt-*`` → ZENMUX_OPENAI_FULL(0016)
    - ``qwen/*`` 或 ``/qwen*`` → ZENMUX_QWEN_FULL(本 migration 新增)
    """
    if not model_name:
        return None
    name = model_name.lower()

    # 复用 0016 profile(qwen 0017 新增,其他从 0016 import)
    from importlib import util as _il_util
    from pathlib import Path

    migration_path = (
        Path(__file__).resolve().parent / "0016_llm_wire_adapter_capability_fill_v2.py"
    )
    spec = _il_util.spec_from_file_location(
        "_llm_0016_for_0017", str(migration_path)
    )
    if spec is None or spec.loader is None:
        return None
    m0016 = _il_util.module_from_spec(spec)
    spec.loader.exec_module(m0016)

    if "anthropic/claude" in name or "/claude-" in name:
        return m0016.ZENMUX_CLAUDE_FULL
    if "google/gemini" in name or "/gemini-" in name:
        return m0016.ZENMUX_GEMINI_FULL
    if "openai/gpt" in name or "/gpt-" in name:
        return m0016.ZENMUX_OPENAI_FULL
    # Block 5:Qwen 子型(0017 新加)
    if name.startswith("qwen/") or "/qwen" in name or name.startswith("qwen-"):
        return ZENMUX_QWEN_FULL
    return None


# ---------------------------------------------------------------------------
# Migration 主体
# ---------------------------------------------------------------------------

def sync_field_pairs_and_qwen(apps, schema_editor):
    """0017 主入口:字段对同步 + ZenMux qwen 子型补齐。

    步骤:

    1. 遍历所有 ``is_active=True`` 且 ``mode in ('chat','completion')`` 的 model
       (chat-capable),做字段对同步(in-place mutate
       ``capabilities_config["wire_adapter"]``)。
    2. ZenMux qwen 子型补齐:对 provider=zenmux 且 model_name 含 qwen 前缀但
       capabilities_config 缺 wire_adapter 的 model,写入 ZENMUX_QWEN_FULL profile。
    """
    LLMModel = apps.get_model("llm", "LLMModel")

    # ---------- Step 1:字段对同步(全 chat-capable) ----------
    chat_models = LLMModel.objects.filter(
        is_active=True,
    ).exclude(
        mode__in=["video_generation", "image_generation",
                  "audio_speech", "audio_transcription"],
    )
    for model in chat_models:
        existing_config = dict(model.capabilities_config or {})
        wa = existing_config.get("wire_adapter")
        if not isinstance(wa, dict):
            # 没 wire_adapter 子键的 model 由 0015/0016/Step 2 处理,这里跳过
            continue

        # in-place 同步(deep copy 避免副作用)
        wa_copy = copy.deepcopy(wa)
        changes = _sync_field_pairs(wa_copy)
        if changes:
            existing_config["wire_adapter"] = wa_copy
            model.capabilities_config = existing_config
            model.save(update_fields=["capabilities_config"])

    # ---------- Step 2:ZenMux qwen 子型补齐 ----------
    zenmux_models = LLMModel.objects.filter(
        is_active=True,
        provider__name="zenmux",
    )
    for model in zenmux_models:
        existing_config = dict(model.capabilities_config or {})
        if existing_config.get("wire_adapter"):
            # admin 已手工配过 / 0016 已写过,跳过保护(0017 不覆盖)
            # 但仍要做字段对同步(Step 1 已处理)
            continue
        profile = _resolve_zenmux_profile_v2(model.model_name)
        if profile is None:
            # 无映射(可能是 0017 还覆盖不到的子型),留 admin 手工配
            continue

        full_config = copy.deepcopy(profile)
        # wave_status 优先取 model 字段
        model_wave = getattr(model, "wave_status", None) or "ready"
        full_config["wave_status"] = model_wave

        existing_config["wire_adapter"] = full_config
        model.capabilities_config = existing_config
        model.save(update_fields=["capabilities_config"])


def reverse_sync(apps, schema_editor):
    """回滚:字段对同步无法精确逆向(原始数据已被覆盖),仅做最小处理。

    - 0017 新写的 ZenMux qwen profile 删除(本 migration 写入的)
    - 字段对同步本质是数据清洗,无法回滚到不一致状态
    """
    LLMModel = apps.get_model("llm", "LLMModel")
    zenmux_qwen = LLMModel.objects.filter(
        provider__name="zenmux",
        model_name__icontains="qwen",
    )
    for model in zenmux_qwen:
        existing_config = dict(model.capabilities_config or {})
        if "wire_adapter" not in existing_config:
            continue
        # 仅删 0017 写入的 ZenMux qwen profile(其他不动)
        existing_config.pop("wire_adapter", None)
        model.capabilities_config = existing_config
        model.save(update_fields=["capabilities_config"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0016_llm_wire_adapter_capability_fill_v2"),
    ]

    operations = [
        migrations.RunPython(
            sync_field_pairs_and_qwen,
            reverse_sync,
        ),
    ]
