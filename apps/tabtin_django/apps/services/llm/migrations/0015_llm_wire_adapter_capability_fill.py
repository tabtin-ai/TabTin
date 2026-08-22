"""W1a: 6 家 chat-capable provider 的 ResolvedCapabilities 初值预填。

把 6 家(openai/claude/gemini/moonshot/qwen/minimax)在 LLMModel 表里所有
``is_active=True`` 的 chat 模型的 ``capabilities_config["wire_adapter"]`` 子键
预填为对应初值。子键写入,**不动**已有的其他子键(litellm_sync 未来若引入也
不冲突)。

字段值依据(harness LLM WireAdapter 总控 § 1.4 6 家真实 spec + 6 家 service.py
当前 ``CAPABILITIES`` dict + dogfood 验证 fact):

- **OpenAI**:base64 + URL + file_id;system 用 messages role;tool_choice 全模式;
  parallel 默认 ON;reasoning hidden;json_schema strict;automatic_implicit cache
  ≥1024 token;usage 含 prompt_tokens_details.cached_tokens。
- **Claude**:base64 + URL + file_id 但 ``request_shape="anthropic_image_source"``;
  system 是 top_level field;tool_choice 全模式;parallel 默认 ON 反向参数;
  reasoning thinking_block + thinking.budget_tokens;json_schema 通过
  output_config;explicit cache_control;input_tokens / cache_read_input_tokens
  顶层。
- **Gemini**:文档只用 base64;系统消息 OpenAI 风(Gemini OpenAI 兼容层);
  reasoning extra_body.google.thinking_config;支持 token_estimate;
  context_cache。
- **Moonshot/Kimi K2.5**:**dogfood verify base64 only**(https URL 拒绝);file_id
  形式 ``ms://...``;reasoning delta.reasoning_content;automatic_implicit + 显
  式 ``prompt_cache_key``;cached_tokens 顶层;parallel 默认 ON;支持 token_estimate。
- **Qwen**:URL + base64;QwQ/QVQ 系列 system 不生效(SystemQuirk);**parallel
  默认 OFF 必须显式开**;reasoning delta.reasoning_content;**不支持 json_schema**
  (text/json_object);Context Cache(自动)。
- **MiniMax**(W2 pending):OpenAI 兼容端**无 image / 无 document**;Anthropic SDK
  路径(``request_protocol="anthropic_messages"``);专属 ``user_system`` /
  ``group`` 角色(SystemQuirk MINIMAX_EXTRA_ROLES_PASSTHROUGH);reasoning
  ``<think>`` tag inline;extra_metrics ``total_characters``。

注意:本 migration 仅按 ``provider.name`` 批量预填,**不针对单 model 名做差异化**
— 例如 Qwen 下的 QwQ-Plus 应该比 qwen3.5-plus 多 SystemQuirk QWQ_STRIP_TO_USER,
但 W1a 不做这一级,留 W2 admin 手工细调或基于 model_name 关键词识别。MiniMax
作为整体 provider 设 W2-pending(0014 migration 已 handled wave_status),
0015 仍然预填 wire_adapter 子键供 W2 复用,确保 from_json 不空。
"""

from django.db import migrations


# ---------------------------------------------------------------------------
# 6 家 ResolvedCapabilities 初值 dict(JSON 形态,直接对照 to_json schema)
# ---------------------------------------------------------------------------

OPENAI_CAPS = {
    "image": {
        "enabled": True,
        "input_via": ["base64", "url", "file_id"],
        "formats": ["jpeg", "png", "webp", "gif"],
        "max_count_per_request": 10,
        "max_size_bytes": 20 * 1024 * 1024,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none", "specific"],
        "parallel_default": True,
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
    },
    "wire": {
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        "system_quirks": [],
        "stream_supported": True,
    },
    "caching": {
        "mode": "automatic_implicit",
        "min_tokens_for_cache": 1024,
        "cache_ttl_param": None,
    },
    "json_mode": {
        "mode": "json_schema",
        "strict_supported": True,
    },
    "reasoning": {
        "enabled": False,
        "surface": "hidden",
        "budget_param": "reasoning_effort",
    },
    "usage": {
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cache_read_field": "prompt_tokens_details.cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
    },
    "limits": {
        "context_window_tokens": None,
        "max_output_tokens": None,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
    },
    "wave_status": "ready",
    "is_configured": True,
}

CLAUDE_CAPS = {
    "image": {
        "enabled": True,
        "input_via": ["base64", "url", "file_id"],
        "formats": ["jpeg", "png", "webp", "gif"],
        "max_count_per_request": 20,
        "max_size_bytes": 5 * 1024 * 1024,
        "request_shape": "anthropic_image_source",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none", "specific"],
        "parallel_default": True,
        "parallel_param_name": "disable_parallel_tool_use",
        "parallel_param_inverted": True,
    },
    "wire": {
        "request_protocol": "anthropic_messages",
        "response_protocol": "anthropic_messages",
        "system_placement": "top_level_system_field",
        "system_quirks": [],
        "stream_supported": True,
    },
    "caching": {
        "mode": "explicit_cache_control",
        "min_tokens_for_cache": 1024,
        "cache_ttl_param": "cache_control.ttl",
    },
    "json_mode": {
        "mode": "json_schema",
        "strict_supported": True,
    },
    "reasoning": {
        "enabled": True,
        "surface": "thinking_block",
        "budget_param": "thinking.budget_tokens",
    },
    "usage": {
        "input_tokens_field": "input_tokens",
        "output_tokens_field": "output_tokens",
        "cache_read_field": "cache_read_input_tokens",
        "cache_write_field": "cache_creation_input_tokens",
        "extra_metrics": [],
    },
    "limits": {
        "context_window_tokens": None,
        "max_output_tokens": None,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
    },
    "wave_status": "ready",
    "is_configured": True,
}

GEMINI_CAPS = {
    "image": {
        "enabled": True,
        "input_via": ["base64"],
        "formats": ["jpeg", "png", "webp", "gif"],
        "max_count_per_request": 16,
        "max_size_bytes": 20 * 1024 * 1024,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none"],
        "parallel_default": False,
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
    },
    "wire": {
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        "system_quirks": [],
        "stream_supported": True,
    },
    "caching": {
        "mode": "context_cache",
        "min_tokens_for_cache": None,
        "cache_ttl_param": "extra_body.cached_content",
    },
    "json_mode": {
        "mode": "json_schema",
        "strict_supported": False,
    },
    "reasoning": {
        "enabled": True,
        "surface": "extra_body_thinking_config",
        "budget_param": "extra_body.google.thinking_config.thinking_budget",
    },
    "usage": {
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cache_read_field": "prompt_tokens_details.cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
    },
    "limits": {
        "context_window_tokens": None,
        "max_output_tokens": None,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
    },
    "wave_status": "ready",
    "is_configured": True,
}

MOONSHOT_CAPS = {
    "image": {
        "enabled": True,
        # Kimi K2.5 dogfood verified:base64 only(https URL 拒绝)。
        # ``ms://file_id`` 形式归到 file_id 集合。
        "input_via": ["base64", "file_id"],
        "formats": ["jpeg", "png", "webp", "gif"],
        "max_count_per_request": 10,
        "max_size_bytes": 20 * 1024 * 1024,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none"],
        "parallel_default": True,
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
    },
    "wire": {
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        "system_quirks": [],
        "stream_supported": True,
    },
    "caching": {
        "mode": "automatic_implicit",
        "min_tokens_for_cache": None,  # Kimi 自动 cache 无明确 minimum
        "cache_ttl_param": "prompt_cache_key",
    },
    "json_mode": {
        "mode": "json_schema",
        "strict_supported": False,
    },
    "reasoning": {
        "enabled": True,
        "surface": "delta_reasoning_content",
        "budget_param": None,
    },
    "usage": {
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        # Moonshot 把 cached_tokens 放在 usage 顶层,不在 prompt_tokens_details 里
        "cache_read_field": "cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
    },
    "limits": {
        "context_window_tokens": None,
        "max_output_tokens": None,
        "max_documents_per_request": 20,
        "max_tool_recursion_depth": None,
    },
    "wave_status": "ready",
    "is_configured": True,
}

QWEN_CAPS = {
    "image": {
        "enabled": True,  # qwen-vl 系列(具体能力按 model 区分,W1a 默认放开)
        "input_via": ["url", "base64"],
        "formats": ["jpeg", "png", "webp"],
        "max_count_per_request": 10,
        "max_size_bytes": 10 * 1024 * 1024,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none"],
        # 关键差异:Qwen DashScope 默认 OFF,必须显式开
        "parallel_default": False,
        "parallel_param_name": "parallel_tool_calls",
        "parallel_param_inverted": False,
    },
    "wire": {
        "request_protocol": "openai_chat_completions",
        "response_protocol": "openai_chat_completions",
        "system_placement": "messages_first_role_system",
        # QwQ/QVQ 系列实际还需要 quirks,W1a 留 admin 手工细调
        "system_quirks": [],
        "stream_supported": True,
    },
    "caching": {
        "mode": "context_cache",
        "min_tokens_for_cache": None,
        "cache_ttl_param": None,
    },
    "json_mode": {
        # Qwen 不支持 json_schema,只支持 json_object
        "mode": "json_object",
        "strict_supported": False,
    },
    "reasoning": {
        "enabled": True,
        "surface": "delta_reasoning_content",
        "budget_param": None,
    },
    "usage": {
        "input_tokens_field": "prompt_tokens",
        "output_tokens_field": "completion_tokens",
        "cache_read_field": "prompt_tokens_details.cached_tokens",
        "cache_write_field": None,
        "extra_metrics": [],
    },
    "limits": {
        "context_window_tokens": None,
        "max_output_tokens": None,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
    },
    "wave_status": "ready",
    "is_configured": True,
}

MINIMAX_CAPS = {
    "image": {
        # MiniMax OpenAI 兼容端无 image,Anthropic 端 W2 才接通
        "enabled": False,
        "input_via": [],
        "formats": [],
        "max_count_per_request": None,
        "max_size_bytes": None,
        "request_shape": "openai_image_url",
    },
    "tool": {
        "enabled": True,
        "choice_modes": ["auto", "required", "none"],
        "parallel_default": False,
        "parallel_param_name": "disable_parallel_tool_use",
        "parallel_param_inverted": True,
    },
    "wire": {
        # MiniMax 走 anthropic_messages 协议(W2 完整接入),W1a 先记下 wire 形态
        "request_protocol": "anthropic_messages",
        "response_protocol": "anthropic_messages",
        "system_placement": "minimax_user_system_role",
        "system_quirks": ["minimax_extra_roles_passthrough"],
        "stream_supported": True,
    },
    "caching": {
        "mode": "automatic_implicit",
        "min_tokens_for_cache": None,
        "cache_ttl_param": None,
    },
    "json_mode": {
        "mode": "none",  # MiniMax 兼容端无 json_schema
        "strict_supported": False,
    },
    "reasoning": {
        "enabled": True,
        "surface": "think_tag_inline",
        "budget_param": None,
    },
    "usage": {
        "input_tokens_field": "input_tokens",
        "output_tokens_field": "output_tokens",
        "cache_read_field": "cache_read_input_tokens",
        "cache_write_field": "cache_creation_input_tokens",
        "extra_metrics": ["total_characters"],
    },
    "limits": {
        "context_window_tokens": None,
        "max_output_tokens": None,
        "max_documents_per_request": None,
        "max_tool_recursion_depth": None,
    },
    # 注:wave_status 实际还会被 0014 migration 的 init_minimax_wave_status
    # 二次覆盖为 'w2_pending'(后跑的 0015 不应该回退它)。这里写 ready 仅作
    # 默认值,fill_wire_capabilities 函数会保留 model.wave_status 原值。
    "wave_status": "w2_pending",
    "is_configured": True,
}


PROVIDER_CAPS_MAP = {
    "openai": OPENAI_CAPS,
    "claude": CLAUDE_CAPS,
    "gemini": GEMINI_CAPS,
    "moonshot": MOONSHOT_CAPS,
    "qwen": QWEN_CAPS,
    "minimax": MINIMAX_CAPS,
}


def fill_wire_capabilities(apps, schema_editor):
    """把 6 家 chat-capable provider 下所有 active model 的 wire_adapter 子键预填。

    保护规则:

    1. 只 deep-merge ``capabilities_config["wire_adapter"]`` 子键,不动其他子键
       (litellm_sync 未来若启用也安全)。
    2. ``wave_status`` 子键值优先取 model 字段(0014 migration 已 set MiniMax 为
       w2_pending),不要回退覆盖。
    3. 若 model.capabilities_config["wire_adapter"] 已存在,跳过(admin 手工
       配过的不要覆盖)。
    """
    LLMModel = apps.get_model("llm", "LLMModel")

    for provider_name, caps_template in PROVIDER_CAPS_MAP.items():
        models_qs = LLMModel.objects.filter(
            provider__name=provider_name,
            is_active=True,
        )
        for model in models_qs:
            existing_config = dict(model.capabilities_config or {})
            if existing_config.get("wire_adapter"):
                # admin 已手工配过,跳过保护
                continue

            # Deep-copy template,然后用 model.wave_status 覆盖 wave_status 字段
            import copy
            caps_to_write = copy.deepcopy(caps_template)
            # 0014 已 set 的 wave_status 优先(MiniMax 应该是 w2_pending)
            model_wave_status = getattr(model, "wave_status", None) or "ready"
            caps_to_write["wave_status"] = model_wave_status

            existing_config["wire_adapter"] = caps_to_write
            model.capabilities_config = existing_config
            model.save(update_fields=["capabilities_config"])


def reverse_fill_wire_capabilities(apps, schema_editor):
    """回滚:删 ``capabilities_config["wire_adapter"]`` 子键(保留其他子键)。"""
    LLMModel = apps.get_model("llm", "LLMModel")

    for provider_name in PROVIDER_CAPS_MAP.keys():
        models_qs = LLMModel.objects.filter(
            provider__name=provider_name,
        )
        for model in models_qs:
            existing_config = dict(model.capabilities_config or {})
            if "wire_adapter" not in existing_config:
                continue
            existing_config.pop("wire_adapter", None)
            model.capabilities_config = existing_config
            model.save(update_fields=["capabilities_config"])


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0014_llm_wire_adapter_fields"),
    ]

    operations = [
        migrations.RunPython(
            fill_wire_capabilities,
            reverse_fill_wire_capabilities,
        ),
    ]
