"""SceneRegistry 中央枚举 — 38 个 scene 全集。

capability_requirements 逐字段对齐。
validate_registry_at_startup() 在 Django LLMConfig.ready() 中调用。
"""

from __future__ import annotations

import logging
import sys
from apps.services.common.db_router import postgres_app_db_alias
from pathlib import Path
from typing import Optional

from .types import (
    FallbackPolicy,
    FundingPolicy,
    ModelSource,
    ScenePayer,
    ScenePolicy,
    SceneSpec,
)

logger = logging.getLogger(__name__)

BUNDLED_DIR = Path(__file__).resolve().parent / "bundled"
_DB_BINDING_MANAGEMENT_COMMANDS = frozenset({
    "migrate",
    "safe_migrate",
    "makemigrations",
    "audit_docparse_duplicates",
    "seed_scene_bindings",
    "tabtin_bootstrap",
})


def _platform_policy(scene_key: str, *, execution_key: str | None = None) -> ScenePolicy:
    return ScenePolicy(
        scene_key=scene_key,
        enabled_default=True,
        payer=ScenePayer.PLATFORM,
        allowed_model_sources=frozenset({ModelSource.OFFICIAL}),
        funding_policy=FundingPolicy.NONE,
        fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
        execution_key=execution_key or scene_key,
    )


def _user_selectable_policy(scene_key: str, *, enabled: bool = True) -> ScenePolicy:
    return ScenePolicy(
        scene_key=scene_key,
        enabled_default=enabled,
        payer=ScenePayer.USER,
        allowed_model_sources=frozenset({ModelSource.OFFICIAL, ModelSource.BYOK}),
        funding_policy=FundingPolicy.EXISTING_USER_FUNDING,
        fallback_policy=FallbackPolicy.PRESERVE_SELECTED_SOURCE,
        execution_key=scene_key,
    )


def _user_official_policy(scene_key: str, *, enabled: bool = False) -> ScenePolicy:
    return ScenePolicy(
        scene_key=scene_key,
        enabled_default=enabled,
        payer=ScenePayer.USER,
        allowed_model_sources=frozenset({ModelSource.OFFICIAL}),
        funding_policy=FundingPolicy.EXISTING_USER_FUNDING,
        fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
        execution_key=scene_key,
    )

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SCENES 字典 — 39 个 scene 中央注册
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCENES: dict[str, SceneSpec] = {

    # ─── chat domain 系统 scene（4 个）────────────────────────────────

    "_main_chat": SceneSpec(
        scene_key="_main_chat",
        display_name="主对话 ReAct 主循环",
        description="agent-runtime 主循环 LLM 调用（含子 Agent fork-query）",
        capability_domain="chat",
        is_system=True,
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": True,
            "min_context_tokens": 131_072,
            "max_output_tokens": 16_384,
            "latency_class": "realtime",
            "cost_class": "user_choice",
        },
        default_params={
            "temperature": None,
            "max_tokens": 16384,
            "response_format": {"type": "text"},
            "tool_choice": "auto",
            "timeout_sec": 120,
            "stream": True,
        },
        policy=_user_selectable_policy("_main_chat"),
    ),

    "_compact": SceneSpec(
        scene_key="_compact",
        display_name="上下文压缩",
        description="主对话上下文压力升高时触发压缩（含全部 7 种 compact 策略）",
        capability_domain="chat",
        is_system=True,
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 131_072,
            "max_output_tokens": 8192,
            "latency_class": "interactive",
            "cost_class": "premium",
        },
        default_params={
            "temperature": 0.3,
            "max_tokens": 8192,
            "response_format": {"type": "text"},
            "timeout_sec": 120,
        },
    ),

    "_summary_judge": SceneSpec(
        scene_key="_summary_judge",
        display_name="摘要质量评判",
        description="incremental summary reuse 路径采样后用 LLM 评分",
        capability_domain="chat",
        is_system=True,
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 16_000,
            "max_output_tokens": 256,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.0,
            "max_tokens": 256,
            "response_format": {"type": "json_object"},
            "timeout_sec": 30,
        },
    ),

    "_sub_agent": SceneSpec(
        scene_key="_sub_agent",
        display_name="子 Agent ReAct 主循环",
        description="主 Agent 通过 dispatch_subagent 开子 Agent 任务",
        capability_domain="chat",
        is_system=True,
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": True,
            "min_context_tokens": 131_072,
            "max_output_tokens": 16_384,
            "latency_class": "interactive",
            "cost_class": "user_choice",
        },
        default_params={
            "temperature": None,
            "max_tokens": 16384,
            "response_format": {"type": "text"},
            "tool_choice": "auto",
            "timeout_sec": 120,
            "stream": True,
        },
    ),

    # ─── chat domain 业务 scene（17 个）────────────────────────────────

    "title_generation": SceneSpec(
        scene_key="title_generation",
        display_name="会话标题生成",
        description="用户首条消息持久化后异步生成 ≤20 字会话标题",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 2000,
            "max_output_tokens": 100,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.7,
            "max_tokens": 50,
            "response_format": {"type": "text"},
            "timeout_sec": 30,
            "thinking": {"type": "disabled"},
        },
        policy=_user_selectable_policy("title_generation"),
    ),

    "commit_message_generation": SceneSpec(
        scene_key="commit_message_generation",
        display_name="Commit 信息生成",
        description="根据已暂存 diff 摘要生成一条 Conventional Commit 提交信息",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 8000,
            "max_output_tokens": 150,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "max_tokens": 80,
            "response_format": {"type": "text"},
            "timeout_sec": 30,
            "thinking": {"type": "disabled"},
            "use_model_default_sampling": True,
        },
        policy=_user_selectable_policy("commit_message_generation"),
    ),

    "summarization": SceneSpec(
        scene_key="summarization",
        display_name="Django 对话摘要",
        description="用户主动 compact 或上下文超限时压缩历史消息为 ≤800 token 摘要",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 32_000,
            "max_output_tokens": 1000,
            "latency_class": "interactive",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 800,
            "response_format": {"type": "text"},
            "timeout_sec": 60,
            "keep_last_messages": 20,
        },
        policy=_user_selectable_policy("summarization"),
    ),

    "mail_ai_summarize": SceneSpec(
        scene_key="mail_ai_summarize",
        display_name="邮件摘要",
        description="邮件一句话摘要",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 8000,
            "max_output_tokens": 200,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.3,
            "max_tokens": 200,
            "response_format": {"type": "text"},
            "timeout_sec": 30,
            "max_input_chars": 16000,
        },
    ),

    "mail_ai_classify": SceneSpec(
        scene_key="mail_ai_classify",
        display_name="邮件分类",
        description="邮件分类（category / priority / labels / confidence / reasoning），JSON 输出",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 8000,
            "max_output_tokens": 400,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 300,
            "response_format": {"type": "json_object"},
            "timeout_sec": 30,
            "max_input_chars": 16000,
        },
    ),

    "mail_ai_extract_reply": SceneSpec(
        scene_key="mail_ai_extract_reply",
        display_name="邮件回复/引用/签名分离",
        description="把邮件正文拆成回复/引用/签名三段（JSON）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 16_000,
            "max_output_tokens": 2500,
            "latency_class": "interactive",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 2000,
            "response_format": {"type": "json_object"},
            "timeout_sec": 60,
        },
    ),

    "mail_ai_extract_data": SceneSpec(
        scene_key="mail_ai_extract_data",
        display_name="邮件结构化提取",
        description="从邮件中提取结构化数据（dates / amounts / contacts / action_items / links / key_points）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 8000,
            "max_output_tokens": 1800,
            "latency_class": "interactive",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 1500,
            "response_format": {"type": "json_object"},
            "timeout_sec": 60,
        },
    ),

    "memo_generation": SceneSpec(
        scene_key="memo_generation",
        display_name="TabMemo 自动标签",
        description="用户写完 TabMemo 后台异步打 1-5 个中文标签",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 4000,
            "max_output_tokens": 300,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.3,
            "max_tokens": 200,
            "response_format": {"type": "json_object"},
            "timeout_sec": 100,
            "min_content_length": 30,
            "max_input_chars": 2000,
        },
    ),

    "user_portrait_distill": SceneSpec(
        scene_key="user_portrait_distill",
        display_name="用户画像蒸馏",
        description="基于用户 TabMemo + organization 上下文生成 5 段叙事用户画像（Markdown）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 65_536,
            "max_output_tokens": 4096,
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.4,
            "max_tokens": 4096,
            "response_format": {"type": "text"},
            "timeout_sec": 300,
            "max_input_chars": 60000,
            "max_memos": 200,
        },
        policy=_user_selectable_policy("user_portrait_distill"),
    ),

    "memory_capture": SceneSpec(
        scene_key="memory_capture",
        display_name="记忆捕获",
        description="从对话中抽取记忆碎片（auto/selective 双 mode）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 32_000,
            "max_output_tokens": 4096,
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.1,
            "max_tokens": 4096,
            "response_format": {"type": "json_object"},
            "timeout_sec": 120,
            "max_input_chars": 30000,
        },
        policy=_user_selectable_policy("memory_capture"),
    ),

    "memory_flush": SceneSpec(
        scene_key="memory_flush",
        display_name="记忆 flush",
        description="从对话内容中提取长期记忆/偏好/约束",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 16_000,
            "max_output_tokens": 1000,
            "latency_class": "interactive",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 800,
            "response_format": {"type": "text"},
            "timeout_sec": 60,
        },
        policy=_user_selectable_policy("memory_flush", enabled=False),
    ),

    "task_summary": SceneSpec(
        scene_key="task_summary",
        display_name="任务摘要",
        description="从对话生成任务级摘要（title + diary + outcome + emotion + pitfalls，JSON）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 32_000,
            "max_output_tokens": 2500,
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 2048,
            "response_format": {"type": "json_object"},
            "timeout_sec": 120,
            "max_input_chars": 30000,
        },
        policy=_user_selectable_policy("task_summary"),
    ),

    "diary_distill": SceneSpec(
        scene_key="diary_distill",
        display_name="每日 Agent 日记蒸馏",
        description="从同一 Agent 当日会话小结生成一条用户可读的工作日记（JSON）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 16_000,
            "max_output_tokens": 1200,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 1024,
            "response_format": {"type": "json_object"},
            "timeout_sec": 120,
            "max_input_chars": 30000,
        },
        policy=_user_selectable_policy("diary_distill"),
    ),

    "memory_compaction": SceneSpec(
        scene_key="memory_compaction",
        display_name="记忆合并",
        description="把多个相似记忆碎片合并成更高阶的记忆（JSON）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 16_000,
            "max_output_tokens": 1500,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.2,
            "max_tokens": 1024,
            "response_format": {"type": "json_object"},
            "timeout_sec": 120,
            "min_group_size": 2,
            "max_groups_per_run": 5,
        },
        policy=_user_selectable_policy("memory_compaction"),
    ),

    "checkpoint_intent_summary": SceneSpec(
        scene_key="checkpoint_intent_summary",
        display_name="Checkpoint 意图摘要",
        description="用一句话（15-30 字）总结 checkpoint 时刻的用户意图",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": False,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 4000,
            "max_output_tokens": 100,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.3,
            "max_tokens": 60,
            "response_format": {"type": "text"},
            "timeout_sec": 25,
        },
        policy=_platform_policy(
            "checkpoint_intent_summary",
            execution_key="checkpoint_summary",
        ),
    ),

    "checkpoint_decision_summary": SceneSpec(
        scene_key="checkpoint_decision_summary",
        display_name="Checkpoint 决策摘要",
        description="一次生成 checkpoint 意图、决策与未决项的 composite JSON",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 8000,
            "max_output_tokens": 500,
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.3,
            "max_tokens": 300,
            "response_format": {"type": "json_object"},
            "timeout_sec": 25,
        },
        policy=_platform_policy(
            "checkpoint_decision_summary",
            execution_key="checkpoint_summary",
        ),
    ),

    "tool_risk_classify": SceneSpec(
        scene_key="tool_risk_classify",
        display_name="AI 工具风险分类",
        description="在工具决策时同步判断该工具调用是否安全（safe / confidence / reason，JSON）",
        capability_domain="chat",
        capability_requirements={
            "requires_json_mode": True,
            "requires_vision": False,
            "requires_function_calling": False,
            "min_context_tokens": 4000,
            "max_output_tokens": 300,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "temperature": 0.0,
            "max_tokens": 256,
            "response_format": {"type": "json_object"},
            "timeout_sec": 15,
        },
        policy=_platform_policy("tool_risk_classify"),
    ),

    # ─── embedding domain（8 个）──────────────────────────────────────

    "rag_index_table": SceneSpec(
        scene_key="rag_index_table",
        display_name="TabData 表格行向量化",
        description="TabData 表格行向量化",
        capability_domain="embedding",
        capability_requirements={
            "embedding_dimensions": 1024,
            "max_input_tokens": 8192,
            "max_batch_size": 50,
            "requires_dimensions_reduction": True,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "encoding_format": "float",
            "use_cache": True,
            "cache_ttl_seconds": 172800,
        },
    ),

    "rag_index_record": SceneSpec(
        scene_key="rag_index_record",
        display_name="TabData 单条记录向量化",
        description="TabData 单条记录向量化",
        capability_domain="embedding",
        capability_requirements={
            "embedding_dimensions": 1024,
            "max_input_tokens": 8192,
            "max_batch_size": 50,
            "requires_dimensions_reduction": True,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "encoding_format": "float",
            "use_cache": True,
            "cache_ttl_seconds": 172800,
        },
    ),

    "rag_index_document": SceneSpec(
        scene_key="rag_index_document",
        display_name="TabDoc 文档向量化",
        description="TabDoc 文档向量化",
        capability_domain="embedding",
        capability_requirements={
            "embedding_dimensions": 1024,
            "max_input_tokens": 8192,
            "max_batch_size": 50,
            "requires_dimensions_reduction": True,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "encoding_format": "float",
            "use_cache": True,
            "cache_ttl_seconds": 172800,
        },
    ),

    "rag_index_skill": SceneSpec(
        scene_key="rag_index_skill",
        display_name="Skill 向量化",
        description="Skill 向量化",
        capability_domain="embedding",
        capability_requirements={
            "embedding_dimensions": 1024,
            "max_input_tokens": 8192,
            "max_batch_size": 10,
            "requires_dimensions_reduction": True,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "encoding_format": "float",
            "use_cache": True,
            "cache_ttl_seconds": 172800,
        },
    ),

    "rag_index_tool": SceneSpec(
        scene_key="rag_index_tool",
        display_name="Tool 向量化",
        description="Tool 向量化（系统级）",
        capability_domain="embedding",
        capability_requirements={
            "embedding_dimensions": 1024,
            "max_input_tokens": 8192,
            "max_batch_size": 10,
            "requires_dimensions_reduction": True,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "encoding_format": "float",
            "use_cache": True,
            "cache_ttl_seconds": 172800,
        },
    ),

    "rag_index_mail": SceneSpec(
        scene_key="rag_index_mail",
        display_name="邮件向量化",
        description="邮件向量化",
        capability_domain="embedding",
        capability_requirements={
            "embedding_dimensions": 1024,
            "max_input_tokens": 8192,
            "max_batch_size": 50,
            "requires_dimensions_reduction": True,
            "latency_class": "batch",
            "cost_class": "cheap",
        },
        default_params={
            "encoding_format": "float",
            "use_cache": True,
            "cache_ttl_seconds": 172800,
        },
    ),

    "rag_search_query": SceneSpec(
        scene_key="rag_search_query",
        display_name="搜索 query 向量化",
        description="用户搜索 query 向量化（含缓存）",
        capability_domain="embedding",
        capability_requirements={
            "embedding_dimensions": 1024,
            "max_input_tokens": 8192,
            "max_batch_size": 1,
            "requires_dimensions_reduction": True,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "encoding_format": "float",
            "use_cache": True,
            "cache_ttl_seconds": 3600,
        },
    ),

    # ─── vision domain（1 个）─────────────────────────────────────────

    "vision_parse_document": SceneSpec(
        scene_key="vision_parse_document",
        display_name="VLM 文档解析",
        description="解析 PDF / PPTX / Word 等文档页面图片为结构化 JSON",
        capability_domain="vision",
        capability_requirements={
            "requires_json_mode": True,
            "min_context_tokens": 16_000,
            "max_output_tokens": 8192,
            "max_image_edge_px": 1600,
            "max_images_per_request": 1,
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "temperature": 0.1,
            "max_tokens": 8192,
            "response_format": {"type": "json_object"},
            "image_detail": "high",
            "timeout_sec": 120,
        },
        policy=_user_selectable_policy("vision_parse_document"),
    ),

    # ─── asr domain（3 个）────────────────────────────────────────────

    "asr_recognize_flash": SceneSpec(
        scene_key="asr_recognize_flash",
        display_name="短音频同步识别",
        description="短音频同步识别（≤2h）",
        capability_domain="asr",
        capability_requirements={
            "requires_streaming": False,
            "requires_speaker_diarization": False,
            "requires_word_timestamps": True,
            "max_audio_duration_sec": 7200,
            "supported_languages": ("zh", "en"),
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "language_hint": "",
            "audio_format": "mp3",
            "enable_punctuation": True,
            "enable_inverse_text_normalization": True,
            "enable_disfluency_correction": True,
            "show_utterances": True,
            "enable_speaker_diarization": False,
            "enable_word_timestamps": True,
            "timeout_sec": 30,
        },
        policy=_user_official_policy("asr_recognize_flash"),
    ),

    "asr_transcribe_standard": SceneSpec(
        scene_key="asr_transcribe_standard",
        display_name="长音频异步识别",
        description="长音频异步识别（≤5h）",
        capability_domain="asr",
        capability_requirements={
            "requires_streaming": False,
            "requires_speaker_diarization": True,
            "requires_word_timestamps": True,
            "max_audio_duration_sec": 18000,
            "supported_languages": ("zh", "en"),
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "language_hint": "",
            "audio_format": "mp3",
            "enable_punctuation": True,
            "enable_inverse_text_normalization": True,
            "enable_disfluency_correction": True,
            "show_utterances": True,
            "enable_speaker_diarization": True,
            "enable_word_timestamps": True,
            "timeout_sec": 300,
        },
        policy=_user_official_policy("asr_transcribe_standard"),
    ),

    "asr_realtime_stream": SceneSpec(
        scene_key="asr_realtime_stream",
        display_name="实时流式识别",
        description="实时流式识别",
        capability_domain="asr",
        capability_requirements={
            "requires_streaming": True,
            "requires_speaker_diarization": False,
            "requires_word_timestamps": True,
            "max_audio_duration_sec": 0,
            "supported_languages": ("zh", "en"),
            "latency_class": "realtime",
            "cost_class": "standard",
        },
        default_params={
            "language_hint": "",
            "audio_format": "pcm",
            "enable_punctuation": True,
            "enable_inverse_text_normalization": True,
            "enable_disfluency_correction": False,
            "show_utterances": True,
            "enable_speaker_diarization": False,
            "enable_word_timestamps": True,
            "timeout_sec": 0,
        },
        policy=_user_official_policy("asr_realtime_stream"),
    ),

    # ─── tts domain（2 个）────────────────────────────────────────────

    "tts_synthesize_http": SceneSpec(
        scene_key="tts_synthesize_http",
        display_name="HTTP 合成",
        description="HTTP 合成",
        capability_domain="tts",
        capability_requirements={
            "requires_streaming": False,
            "requires_emotion": True,
            "requires_voice_cloning": False,
            "supported_formats": ("mp3", "wav", "ogg", "pcm"),
            "supported_sample_rates": (24000,),
            "max_text_chars": 50000,
            "latency_class": "interactive",
            "cost_class": "cheap",
        },
        default_params={
            "speaker": "zh_female_vv_uranus_bigtts",
            "output_format": "mp3",
            "sample_rate": 24000,
            "speed_ratio": 1.0,
            "volume_ratio": 1.0,
            "pitch": 0,
            "emotion": "",
            "enable_timestamp": False,
            "timeout_sec": 60,
        },
        policy=_user_official_policy("tts_synthesize_http"),
    ),

    "tts_synthesize_stream": SceneSpec(
        scene_key="tts_synthesize_stream",
        display_name="WS 流式合成",
        description="WS bidirectional 流式合成",
        capability_domain="tts",
        capability_requirements={
            "requires_streaming": True,
            "requires_emotion": True,
            "requires_voice_cloning": False,
            "supported_formats": ("pcm", "mp3"),
            "supported_sample_rates": (24000,),
            "max_text_chars": 50000,
            "latency_class": "realtime",
            "cost_class": "cheap",
        },
        default_params={
            "speaker": "zh_female_vv_uranus_bigtts",
            "output_format": "pcm",
            "sample_rate": 24000,
            "speed_ratio": 1.0,
            "volume_ratio": 1.0,
            "pitch": 0,
            "emotion": "",
            "enable_timestamp": True,
            "timeout_sec": 0,
        },
        policy=_user_official_policy("tts_synthesize_stream"),
    ),

    # ─── image_gen / video_gen / audio_gen（3 个）─────────────────────

    "media_image_generate": SceneSpec(
        scene_key="media_image_generate",
        display_name="文生图 / 图生图",
        description="根据 prompt 生成图片",
        capability_domain="image_gen",
        capability_requirements={
            "requires_negative_prompt": False,
            "requires_image_to_image": False,
            "requires_seed_control": True,
            "supported_sizes": ("1024*1024", "1280*720", "720*1280"),
            "max_n_per_request": 4,
            "max_prompt_chars": 1500,
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "size": "1024*1024",
            "n": 1,
            "seed": None,
            "prompt_extend": True,
            "negative_prompt": "",
            "timeout_sec": 300,
            "poll_interval_sec": 5,
            "extra_params": {},
        },
        policy=_user_official_policy("media_image_generate", enabled=True),
    ),

    "media_video_generate": SceneSpec(
        scene_key="media_video_generate",
        display_name="文生视频 / 图生视频",
        description="根据 prompt 生成视频",
        capability_domain="video_gen",
        capability_requirements={
            "requires_image_to_video": True,
            "requires_audio_input": False,
            "requires_seed_control": True,
            "supported_sizes": ("1280*720", "720*1280", "1920*1080"),
            "supported_durations_sec": (2, 3, 5, 10, 15),
            "max_prompt_chars": 1500,
            "latency_class": "batch",
            "cost_class": "premium",
        },
        default_params={
            "task_type": "text2video",
            "size": "1280*720",
            "duration_sec": 5,
            "seed": None,
            "prompt_extend": True,
            "negative_prompt": "",
            "input_image_url": "",
            "input_audio_url": "",
            "timeout_sec": 600,
            "poll_interval_sec": 10,
        },
        policy=_user_official_policy("media_video_generate"),
    ),

    "media_bgm_generate": SceneSpec(
        scene_key="media_bgm_generate",
        display_name="BGM 生成",
        description="根据 prompt 生成背景音乐（BGM）",
        capability_domain="audio_gen",
        capability_requirements={
            "requires_lyrics": True,
            "requires_style_preset": True,
            "max_target_duration_sec": 300,
            "output_formats": ("wav", "mp3"),
            "latency_class": "batch",
            "cost_class": "standard",
        },
        default_params={
            "target_duration_sec": 60.0,
            "style": "",
            "bpm": None,
            "output_format": "wav",
            "output_dir": None,
            "timeout_sec": 600,
            "extra_params": {},
        },
        policy=_user_official_policy("media_bgm_generate"),
    ),
}

assert len(SCENES) == 37, f"SCENES 应有 37 个 scene，实际 {len(SCENES)}"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 公共 API
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def get_scene_spec(scene_key: str) -> SceneSpec:
    try:
        return SCENES[scene_key]
    except KeyError:
        from .exceptions import SceneNotRegistered
        raise SceneNotRegistered(
            f"scene_key={scene_key} 未在 SCENES 注册",
            scene_key=scene_key,
        )


def list_scenes(
    *,
    capability_domain: Optional[str] = None,
    include_system: bool = False,
) -> list[SceneSpec]:
    return [
        spec for spec in SCENES.values()
        if (capability_domain is None or spec.capability_domain == capability_domain)
        and (include_system or not spec.is_system)
    ]


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 启动期校验
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def validate_registry_at_startup() -> None:
    """启动期三向 SSoT 校验：SCENES dict ⇄ SCENE.md frontmatter ⇄ LLMSceneBinding (DB)。

    任一失败 → ImportError 阻止 Django 启动（按宪法 v0.1 §1.4）。

    校验项：
      1. 业务 chat / vision scene 必须有 SCENE.md bundle
      2. bundle 目录必须在 SCENES 注册（无孤立目录）
      3. SCENES.capability_requirements ⇄ SCENE.md frontmatter 一致
      4. 业务 scene 必须有 LLMSceneBinding 行 + capability_domain / capability_requirements 一致
      5. LLMModel.capability_domain == LLMProvider.capability_domain（无漂移）

    例外：
      - rag/asr/tts/image_gen/video_gen/audio_gen 14 个 scene 不需要 SCENE.md（domain 没有 prompt 概念）
      - DB 表全空（fresh deploy）时第 4-5 步只发 warning，提示运营跑 seed_scene_bindings
      - DB 还没 migrate 时第 4-5 步整体跳过（OperationalError 兜底）
    """
    from .loader import load_all_scene_md_frontmatters

    frontmatters = load_all_scene_md_frontmatters()

    # 1. 非 system + 非 (embedding / asr / tts / image_gen / video_gen / audio_gen) scene 必须有 SCENE.md
    NO_BUNDLE_DOMAINS = {"embedding", "asr", "tts", "image_gen", "video_gen", "audio_gen"}
    for scene_key, spec in SCENES.items():
        if spec.is_system:
            continue
        if spec.capability_domain in NO_BUNDLE_DOMAINS:
            continue
        if scene_key not in frontmatters:
            raise ImportError(f"E18_PROMPT_BUNDLE_MISSING: scene={scene_key}")

    # 2. bundle 目录必须在 SCENES 注册（无孤立目录）
    for scene_key in frontmatters:
        if scene_key not in SCENES:
            raise ImportError(f"E19_SCENE_NOT_REGISTERED: orphan bundle {scene_key}")

    # 3. SCENES.capability_requirements ⇄ SCENE.md frontmatter
    for scene_key in frontmatters:
        spec = SCENES[scene_key]
        fm = frontmatters[scene_key]
        if fm.get("capability_domain") != spec.capability_domain:
            raise ImportError(
                f"capability_domain mismatch: SCENES[{scene_key}]={spec.capability_domain} "
                f"vs SCENE.md={fm.get('capability_domain')}"
            )
        fm_reqs = fm.get("capability_requirements", {})
        if fm_reqs != spec.capability_requirements:
            raise ImportError(
                f"capability_requirements drift: SCENES[{scene_key}] vs SCENE.md"
            )

    if _is_db_binding_management_command():
        logger.warning(
            "[SceneRegistry] DB binding startup validation skipped for management command: %s",
            _current_management_command(),
        )
        return

    # 4-5. DB 校验（业务 scene binding + LLMModel/Provider domain 一致）
    _validate_db_bindings_at_startup()

    logger.info("[SceneRegistry] 启动校验通过：%d 个 scene 注册", len(SCENES))


def _current_management_command() -> str:
    return sys.argv[1] if len(sys.argv) > 1 else ""


def _is_db_binding_management_command() -> bool:
    return _current_management_command() in _DB_BINDING_MANAGEMENT_COMMANDS


def _canonicalize_requirements(value):
    """递归把 tuple/list 都归一为 tuple，dict 保持，标量返回自身。

    用途：JSONField 序列化把 tuple 变 list；SCENES 里是 tuple。比较前归一化避免假漂移。
    """
    if isinstance(value, dict):
        return {k: _canonicalize_requirements(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return tuple(_canonicalize_requirements(v) for v in value)
    return value


def _validate_db_bindings_at_startup() -> None:
    """启动期 DB 三向校验（第 4-5 步）。

    单独抽出来便于：
      - 命令 / shell / runserver 都跑同一份逻辑
      - 容忍 fresh DB（binding 全空时给出 actionable warning，不阻塞首次启动）
      - 容忍 DB 还没 migrate（OperationalError 兜底）
    """
    try:
        from django.db.models import F
        from ..models import LLMModel, LLMSceneBinding
    except ImportError as exc:
        logger.warning("[SceneRegistry] LLMSceneBinding/LLMModel 模型导入失败: %s", exc)
        return

    # 防御：DB 还没 migrate 或不可达时，整体跳过 DB 校验（不能让它阻止 makemigrations / migrate）
    # 只兜底真正"DB 还没准备好"的场景（OperationalError=连接/服务不可达；
    # ProgrammingError=表/列不存在），其他业务/编程异常仍按 fail-fast 抛上去（反例集 A.15）
    from django.db.utils import OperationalError, ProgrammingError
    try:
        binding_count = LLMSceneBinding.objects.count()
    except (OperationalError, ProgrammingError) as exc:
        logger.warning(
            "[SceneRegistry] LLMSceneBinding 表查询失败（DB 可能尚未 migrate 或不可达）: %s",
            exc,
        )
        return

    from django.conf import settings
    is_community = getattr(settings, "TABTIN_EDITION", "saas") == "community"

    if binding_count == 0 and not is_community:
        # fresh deploy：放过，给运营 actionable hint
        logger.warning(
            "[SceneRegistry] LLMSceneBinding 表为空。"
            "首次部署请运行：python manage.py seed_scene_bindings"
        )
        return

    if binding_count == 0:
        logger.info(
            "[SceneRegistry] Community AI 尚未配置；零 Scene Binding 为合法状态"
        )

    # 严格模式：业务 scene 必须有 binding，且 capability_domain / capability_requirements 一致
    missing: list[str] = []
    for scene_key, spec in SCENES.items():
        if spec.is_system:
            continue
        try:
            binding = LLMSceneBinding.objects.get(scene_key=scene_key)
        except LLMSceneBinding.DoesNotExist:
            if not is_community:
                missing.append(scene_key)
            continue
        if binding.capability_domain != spec.capability_domain:
            raise ImportError(
                f"binding capability_domain drift: scene={scene_key} "
                f"binding={binding.capability_domain} vs SCENES={spec.capability_domain}"
            )
        # JSONField 把 tuple 序列化成 list；SCENES 内是 tuple。比较前归一化
        binding_reqs = _canonicalize_requirements(binding.capability_requirements or {})
        scene_reqs = _canonicalize_requirements(spec.capability_requirements or {})
        if binding_reqs != scene_reqs:
            raise ImportError(
                f"binding capability_requirements drift: scene={scene_key} "
                f"vs SCENES（请重跑 seed_scene_bindings 或在 AdminDash 同步）"
            )

    if missing and not is_community:
        raise ImportError(
            f"E14_SCENE_BINDING_UNAVAILABLE: 业务 scene 缺失 binding：{missing}。"
            "请运行：python manage.py seed_scene_bindings"
        )

    # 5. LLMModel.capability_domain ∈ LLMProvider.capability_domains（无漂移）
    # 用原生 SQL 让 PG ANY() 表达式在数据库内完成比对，避免 Python 循环全表扫描；
    # 同时用独立事务隔离 ProgrammingError（DB 尚未 apply 0024 migration），
    # 防止"外层事务 abort + 后续 cursor close 抛 InvalidCursorName"把整个启动 fail。
    #
    # v0.1.x Phase 2.5 中间态保护：0024 应用、0025 还没跑那段窗口，所有 provider 的
    # capability_domains 都是默认 []，`= ANY([])` 恒 false → 此 SQL 会把全表 LLMModel
    # 视作漂移。`AND p.capability_domains IS NOT NULL AND cardinality(p.capability_domains) > 0`
    # 把空集合的 provider 视作"未初始化"跳过——0025 backfill 后会自动恢复严格校验。
    from django.db import connections as _db_conns, transaction as _db_tx
    drift_ids: list = []
    try:
        with _db_tx.atomic(using=postgres_app_db_alias()):
            with _db_conns["postgresql"].cursor() as _cur:
                _cur.execute(
                    """
                    SELECT m.id::text
                    FROM services_llm_model m
                    JOIN services_llm_provider p ON m.provider_id = p.id
                    WHERE p.capability_domains IS NOT NULL
                      AND cardinality(p.capability_domains) > 0
                      AND NOT (m.capability_domain = ANY(p.capability_domains))
                    LIMIT 20
                    """
                )
                drift_ids = [row[0] for row in _cur.fetchall()]
    except (OperationalError, ProgrammingError) as exc:
        logger.warning(
            "[SceneRegistry] LLMModel × LLMProvider.capability_domains drift 校验跳过 "
            "（DB 尚未 apply 0024_llmprovider_capability_domains migration）: %s",
            exc,
        )
        drift_ids = []
    if drift_ids:
        raise ImportError(
            f"LLMModel.capability_domain drift（model.domain ∉ provider.capability_domains）: {drift_ids}"
        )

    # 6. v0.1.x Phase 2.5：所有非孤儿 LLMModel 必须有非空 base_url（Provider.base_url 已删）
    # 启动期就把"配错了"的 model 揪出来，避免运行时报"缺少必需字段: base_url"
    empty_base_url_ids: list = []
    try:
        with _db_tx.atomic(using=postgres_app_db_alias()):
            with _db_conns["postgresql"].cursor() as _cur:
                _cur.execute(
                    """
                    SELECT m.id::text
                    FROM services_llm_model m
                    WHERE m.base_url IS NULL OR m.base_url = ''
                    LIMIT 20
                    """
                )
                empty_base_url_ids = [row[0] for row in _cur.fetchall()]
    except (OperationalError, ProgrammingError) as exc:
        logger.warning(
            "[SceneRegistry] LLMModel.base_url 校验跳过 "
            "（DB 尚未 apply 0027_llmmodel_base_url migration）: %s",
            exc,
        )
        empty_base_url_ids = []
    if empty_base_url_ids:
        raise ImportError(
            f"LLMModel.base_url 为空（v0.1.x Phase 2.5 要求每个 model 自带 endpoint）: "
            f"{empty_base_url_ids}。请在 AdminDash → /ai/models 编辑这些模型补 endpoint。"
        )

    logger.info("[SceneRegistry] DB 校验通过：%d 个 binding 一致", binding_count)
