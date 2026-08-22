"""W1b-fix · Block C1:wire.system_message_style 字符串规范化。

W1b-fix 范围(harness W1b-fix 任务定义书 Block C1):

* 0016 MiniMax v2 patch 把 ``wire.system_message_style`` 写成
  ``"anthropic_top_level"``,但 wire_adapter ``_normalize_system`` 只识别
  ``"top_level_system_field"`` / ``"unsupported"`` / ``"minimax_user_system_role"``
  三个字符串,默认走透传分支。结果:MiniMax 的 system message 永远不被 hoist
  到 top-level ``system`` 字段,Anthropic SDK 路径(D7 白名单 W2 启用)上
  system 提示完全失效。

* 同样问题:0017 ``_sync_field_pairs`` 用"新字段权威"规则把 ``system_placement``
  也对齐到 ``"anthropic_top_level"``,2 个 MiniMax model 现在两边都是错值。

* 这是 W1a sub-wave F12+F14 教训三度复发的同款病灶:总控 § 5/§ 6 没列字段
  enum 表 → migration 字符串与 helper 识别不对齐 → 测试 fixture 与 migration
  各唱各的(test_capability_fill_v2 line 81 / test_w1a_fix_2 line 153 都用了
  错值做 fixture,所以测试假绿)。

字符串规范化策略(单源真理):

* 唯一权威值:``request_adapter._normalize_system`` 识别的字符串
  - ``"top_level_system_field"`` → Anthropic 风,从 messages[0] hoist 到 top-level system
  - ``"messages_first_role_system"`` → 默认 OpenAI 风,透传(也是 helper 隐式默认分支)
  - ``"unsupported"`` → 删除 system message
  - ``"minimax_user_system_role"`` → W2 范围,W1b 透传

* 已知 alias 映射(本 migration 处理):
  - ``"anthropic_top_level"`` → ``"top_level_system_field"``(0016 MiniMax 误用)
  - 其他错串 → 留 admin 排查(本 migration 不擅自改)

设计原则:

* 修字符串值,不修 helper 别名识别(单源真理优于多 alias)。
* 同时同步 ``system_message_style`` 和 ``system_placement``(0017 让两者一致,
  0018 让两者一致地等于 ``"top_level_system_field"``)。
* idempotent:多次 apply 不会越改越偏。
"""

from __future__ import annotations

from django.db import migrations


# wire.system_message_style 别名映射:错串 → 权威串
SYSTEM_STYLE_ALIAS_MAP = {
    "anthropic_top_level": "top_level_system_field",
}

# wire.system_placement 同步映射(0017 已做新字段权威同步,这里追同步到正确串)
SYSTEM_PLACEMENT_ALIAS_MAP = dict(SYSTEM_STYLE_ALIAS_MAP)


def canonicalize_system_style(apps, schema_editor):
    """把 wire.system_message_style / system_placement 的非权威字符串映射到权威值。

    步骤:

    1. 遍历所有 ``is_active=True`` 且 chat-capable 的 model。
    2. 读 ``capabilities_config["wire_adapter"]["wire"]``,若
       ``system_message_style`` 命中 alias map → 替换;
       若 ``system_placement`` 命中 alias map → 替换。
    3. 保存。

    idempotent:权威值不在 alias map 里,不会被 re-write。
    """
    LLMModel = apps.get_model("llm", "LLMModel")

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
            continue
        wire = wa.get("wire")
        if not isinstance(wire, dict):
            continue

        changed = False
        sms = wire.get("system_message_style")
        if sms in SYSTEM_STYLE_ALIAS_MAP:
            wire["system_message_style"] = SYSTEM_STYLE_ALIAS_MAP[sms]
            changed = True
        sp = wire.get("system_placement")
        if sp in SYSTEM_PLACEMENT_ALIAS_MAP:
            wire["system_placement"] = SYSTEM_PLACEMENT_ALIAS_MAP[sp]
            changed = True

        if changed:
            wa["wire"] = wire
            existing_config["wire_adapter"] = wa
            model.capabilities_config = existing_config
            model.save(update_fields=["capabilities_config"])


def reverse_canonicalize(apps, schema_editor):
    """回滚:把权威串改回 alias 串(只针对 0018 写入的 MiniMax model)。

    保守降级:仅 provider=minimax 的 model 回滚为 alias,其他 provider
    若用了权威串(本就是对的)不动。
    """
    LLMModel = apps.get_model("llm", "LLMModel")
    reverse_map = {v: k for k, v in SYSTEM_STYLE_ALIAS_MAP.items()}

    minimax_models = LLMModel.objects.filter(
        provider__name="minimax",
        is_active=True,
    )
    for model in minimax_models:
        existing_config = dict(model.capabilities_config or {})
        wa = existing_config.get("wire_adapter")
        if not isinstance(wa, dict):
            continue
        wire = wa.get("wire")
        if not isinstance(wire, dict):
            continue

        changed = False
        sms = wire.get("system_message_style")
        if sms in reverse_map:
            wire["system_message_style"] = reverse_map[sms]
            changed = True
        sp = wire.get("system_placement")
        if sp in reverse_map:
            wire["system_placement"] = reverse_map[sp]
            changed = True

        if changed:
            wa["wire"] = wire
            existing_config["wire_adapter"] = wa
            model.capabilities_config = existing_config
            model.save(update_fields=["capabilities_config"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0017_llm_wire_adapter_field_sync"),
    ]

    operations = [
        migrations.RunPython(
            canonicalize_system_style,
            reverse_canonicalize,
        ),
    ]
