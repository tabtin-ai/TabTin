"""
Seed default LLMSceneBinding for all 38 scenes（除 4 个 system scene）。

第一次部署（或 fresh DB）时使用：
  python manage.py seed_scene_bindings

幂等语义（v0.1 修复版）：反复跑都安全，行为分支：
  - binding 不存在 → 完整创建（含 placeholder primary_model）
  - binding 已存在 → 仅同步元数据（display_name / description / capability_domain
    / capability_requirements / default_params），保护运营在 AdminDash 切到真模型的 primary_model
  - 仅当带 `--reset-primary-model` flag 时才把已存在 binding 的 primary_model 重置回 placeholder
  - 每条 binding 写完跑一次 binding.full_clean() 兜底，placeholder 漂移立刻可见

数据底盘（v0.1.x —— 一个 Provider 多 capability_domain）：
  - 3 个 baseline LLMProvider（routing_enabled=False，真 key 仍由运营注入）：
      moonshot         → capability_domains = chat（产品基线：Kimi K2.6）
      qwen_default     → capability_domains = embedding/vision/image_gen/video_gen/audio_gen
      bytedance_default → capability_domains = asr/tts
    Chat 基线固定为 Kimi K2.6；阿里云 / 字节仍按 1 Provider × N domain
    覆盖非 chat 能力，避免旧设计分别填 8 份 key 的遗漏风险。
  - 8 个 baseline LLMModel（每个 domain 1 个 model；model.capability_domain 仍单值）
    capabilities_config 必须够宽松，覆盖该 domain 下所有 scene 的 capability_requirements，
    保证 LLMSceneBinding.clean() 不抛 E16_CAPABILITY_MISMATCH。
  - 34 个 LLMSceneBinding（38 scene - 4 system scene）

运营接管（v0.1.x 简化为 2 步）：
  - AdminDash → Providers → **编辑** moonshot / qwen_default / bytedance_default
    （注意：是「编辑」而不是「新建」。新建额外 Provider 会成为孤儿，SceneBinding
    仍指向 placeholder，运行时静默失败。详见 docs/agent-rag-billing 章节）
  - AdminDash → Providers → 把 api_key 改成真值 + routing_enabled=True
  - 完成后即可跑真 chat / embedding / vision / asr / tts / image_gen / video_gen / audio_gen

注：本命令幂等，重复跑安全。从 v0.1.0（8 个 qwen_default_* Provider）升级到 v0.1.x
（合并为 1 个 qwen_default）请先执行：
  python manage.py merge_legacy_providers
"""

from __future__ import annotations

import logging

from django.core.management.base import BaseCommand
from django.db import transaction
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)


PLACEHOLDER_API_KEY = "<INSERT_VIA_ADMIN>"
PLACEHOLDER_BASE_URL = "https://example.com/api/v1"


def _jsonable(value):
    """递归把 tuple/list 转成 list、其他类型保持，以便写 JSONField 后跟 DB 读回值一致。

    SCENES 里的 capability_requirements / default_params 含 tuple（如 supported_languages）。
    JSONField 写入时会被 json.dumps 自动转 list；读出来也是 list。让 seed 显式转一次，
    避免"写入 tuple, 读回 list, 字段比较看起来像 drift"的歧义。
    """
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def _merge_capabilities_config(existing: dict, spec: dict) -> dict:
    """对 placeholder model 的 capabilities_config 做 deep-merge。

    保持已存在的运营注入字段不被覆盖（关键场景：ASR/TTS 域 placeholder
    的 app_id / secret_key / resource_ids 等运行凭证只能放在 capabilities_config 里，
    seed 重跑时不能清掉），同时补齐 spec 新增的字段。

    合并规则：
    - dict + dict 递归合并；同 key 冲突时保留 existing（运营已设置的值）
    - 其他类型（list / scalar）: 保留 existing；spec 的值仅当 existing 缺失时填补
    """
    if not isinstance(existing, dict) or not isinstance(spec, dict):
        return existing if existing else spec
    merged = dict(existing)
    for key, spec_val in spec.items():
        if key not in merged:
            merged[key] = _jsonable(spec_val)
            continue
        cur_val = merged[key]
        if isinstance(cur_val, dict) and isinstance(spec_val, dict):
            merged[key] = _merge_capabilities_config(cur_val, spec_val)
    return merged


# v0.1.x：非 chat provider 仍按一个 Provider 同时提供多 capability_domain；
# chat 的产品基线单独固定到 Moonshot / Kimi K2.6。
# v0.1.x Phase 2.5：base_url 已从 Provider 下沉到 Model；每个 Model 自带 endpoint，
# Provider 不再有 base_url 字段。
# (provider_key, name, display_name, capability_domains)
DEFAULT_PROVIDERS = [
    (
        "moonshot",
        "moonshot",
        "Moonshot / Kimi",
        ["chat"],
    ),
    (
        "qwen_default",
        "qwen",
        "阿里云 Qwen（占位）",
        ["embedding", "vision", "image_gen", "video_gen", "audio_gen"],
    ),
    (
        "bytedance_default",
        "bytedance",
        "字节 Speech（占位）",
        ["asr", "tts"],
    ),
]


# 历史 v0.1.0 placeholder provider_key → v0.1.x 新 provider_key 的映射表。
# 用于 ``merge_legacy_providers`` 数据迁移以及 seed 时的兼容性提示。
LEGACY_PROVIDER_KEY_MAP = {
    "qwen_default_chat": "qwen_default",
    "qwen_default_embedding": "qwen_default",
    "qwen_default_vision": "qwen_default",
    "qwen_default_image_gen": "qwen_default",
    "qwen_default_video_gen": "qwen_default",
    "qwen_default_audio_gen": "qwen_default",
    "bytedance_default_asr": "bytedance_default",
    "bytedance_default_tts": "bytedance_default",
}


# placeholder 模型 capabilities_config —— 必须能满足该 domain 下所有 scene 的 capability_requirements
# 单一 placeholder 模型为该 domain 全部 scene 兜底。
#
# 注意：本表刻意不填若干 max_* 上限字段（asr.max_audio_length_sec / tts.max_text_chars /
# image_gen.max_n_per_request / image_gen.max_prompt_chars / video_gen.max_prompt_chars），
# 依赖 capability_check._check_*() 里的 truthy 短路语义（model_max 为 falsy 时跳过比较）。
# 这是 v0.1 placeholder 的明确 trade-off：运营接管前 capability_match 兜底通过，
# 真生产模型录入时 AdminDash UI 会按 LiteLLM 元数据补齐这些字段。
# 如果未来 SCENES 收紧要求或 capability_check 取消短路语义，这里同步补全。
DEFAULT_MODELS = [
    {
        "provider_key": "moonshot",
        "model_name": "kimi-k2.6",
        "display_name": "Kimi K2.6",
        "capability_domain": "chat",
        "base_url": "https://api.moonshot.cn/v1",
        "context_window_tokens": 262_144,
        "max_input_tokens": 262_144,
        "max_output_tokens": 32_768,
        "capabilities_config": {
            "json_mode": {"modes": ["json_object", "json_schema"]},
            "image": {"enabled": True},
            "tool": {"enabled": True, "supports_parallel": True},
            "wire": {"stream_supported": True},
            "supports_streaming": True,
            "supports_function_calling": True,
            "supports_parallel_function_calling": True,
            "supports_tool_choice": True,
            "supports_json_mode": True,
            "supports_vision": True,
            "supports_reasoning": True,
            "supports_prompt_caching": True,
            "supports_document_input": True,
            "supports_token_estimate": True,
            "is_configured": True,
            "wave_status": "ready",
            "wire_adapter": {
                "wire": {
                    "request_protocol": "openai_chat_completions",
                    "response_protocol": "openai_chat_completions",
                    "stream_supported": True,
                    "streaming_protocol": "openai_delta",
                    "streaming_emits_usage": True,
                    "upstream_path": "/chat/completions",
                    "system_placement": "messages_first_role_system",
                    "system_message_style": "messages_first_role_system",
                    "system_quirks": [],
                },
                "tool": {
                    "enabled": True,
                    "max_tools": 128,
                    "param_field": "parameters",
                    "choice_modes": ["auto", "required", "none"],
                    "parallel_default": True,
                    "parallel_param_name": "parallel_tool_calls",
                    "parallel_param_inverted": False,
                },
                "image": {
                    "enabled": True,
                    "formats": ["jpeg", "png", "webp", "gif"],
                    "input_via": ["base64", "file_id"],
                    "request_shape": "openai_image_url",
                    "max_count_per_request": 10,
                    "max_size_mb": 20,
                    "max_size_bytes": 20_971_520,
                },
                "usage": {
                    "input_field": "prompt_tokens",
                    "output_field": "completion_tokens",
                    "input_tokens_field": "prompt_tokens",
                    "output_tokens_field": "completion_tokens",
                    "cached_path": "cached_tokens",
                    "cache_read_field": "cached_tokens",
                    "cache_write_field": None,
                    "cache_creation_path": None,
                    "extra_fields": [],
                    "extra_metrics": [],
                },
                "limits": {
                    "context_window": 256_000,
                    "context_window_tokens": 256_000,
                    "max_output_tokens": None,
                    "request_payload_max_mb": 25,
                    "max_documents_per_request": 20,
                    "silent_drop_params": [],
                    "extra_routing_headers": {},
                    "max_tool_recursion_depth": None,
                },
                "caching": {
                    "mode": "automatic_implicit",
                    "cache_ttl_param": "prompt_cache_key",
                    "cache_control_strip": False,
                    "min_tokens": None,
                    "min_tokens_for_cache": None,
                },
                "json_mode": {
                    "mode": "json_schema",
                    "modes": ["json_schema", "json_object"],
                    "schema_field": "response_format.json_schema.schema",
                    "schema_fallback": False,
                    "strict_supported": False,
                },
                "reasoning": {
                    "enabled": True,
                    "format": "reasoning_content_field",
                    "surface": "delta_reasoning_content",
                    "param_path": "thinking",
                    "budget_param": None,
                    "visible_to_client": True,
                },
            },
        },
    },
    {
        "provider_key": "qwen_default",
        "model_name": "text-embedding-v4",
        "display_name": "Qwen Embedding V4（占位）",
        "capability_domain": "embedding",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "context_window_tokens": 8192,
        "max_input_tokens": 8192,
        "max_output_tokens": None,
        "capabilities_config": {
            "embedding": {
                "dimensions": 1024,
                "supports_dimensions_reduction": True,
                "max_batch_size": 50,
                "max_input_tokens_per_text": 8192,
            },
            "wire": {"stream_supported": False},
        },
    },
    {
        "provider_key": "qwen_default",
        "model_name": "qwen-vl-max",
        "display_name": "Qwen VL Max（占位）",
        "capability_domain": "vision",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "context_window_tokens": 32_000,
        "max_input_tokens": 24_000,
        "max_output_tokens": 8192,
        "capabilities_config": {
            "json_mode": {"modes": ["json_object"]},
            "image": {"enabled": True, "max_edge_px": 4096},
            "wire": {"stream_supported": False},
        },
    },
    {
        "provider_key": "bytedance_default",
        # 字节豆包大模型语音识别（流式版）。原 seed 写的 "paraformer-realtime-v2"
        # 是阿里达摩院 ASR 的型号，挂在字节 Provider 下属于复制 qwen 时漏改的笔误。
        "model_name": "doubao-asr",
        "display_name": "字节豆包 ASR（占位）",
        "capability_domain": "asr",
        "base_url": "https://openspeech.bytedance.com",
        "context_window_tokens": 1,
        "max_input_tokens": None,
        "max_output_tokens": None,
        "capabilities_config": {
            "resource_ids": {
                "flash": "volc.bigasr.auc_turbo",
                "standard": "volc.bigasr.auc",
                "streaming": "volc.bigasr.sauc.duration",
            },
            "ws_endpoint": "bigmodel_async",
            "speech": {
                "supports_timestamps": True,
                "supports_diarization": True,
                "supports_emotion": False,
                "supported_resource_ids": [
                    "volc.bigasr.auc_turbo",
                    "volc.bigasr.auc",
                    "volc.bigasr.sauc.duration",
                ],
                "supported_languages": ["zh", "en"],
            },
            "wire": {"stream_supported": True},
        },
    },
    {
        "provider_key": "bytedance_default",
        # 字节豆包语音合成 Seed-TTS。原 seed 写的 "cosyvoice-v1" 是阿里通义 TTS 的型号，
        # 挂在字节 Provider 下属于复制 qwen 时漏改的笔误。
        "model_name": "seed-tts-3.0",
        "display_name": "字节豆包 Seed-TTS 3.0（占位）",
        "capability_domain": "tts",
        "base_url": "https://openspeech.bytedance.com",
        "context_window_tokens": 1,
        "max_input_tokens": None,
        "max_output_tokens": None,
        "capabilities_config": {
            "resource_ids": {
                "http": "seed-tts-3.0",
                "ws_bidirectional": "seed-tts-3.0",
            },
            "resource_id": "seed-tts-3.0",
            "default_speaker": "zh_female_vv_uranus_bigtts",
            "speech": {
                "supports_emotion": True,
                "supports_voice_cloning": False,
                "supported_resource_ids": ["seed-tts-2.0", "seed-tts-3.0"],
                "supported_formats": ["mp3", "wav", "ogg", "pcm"],
                "supported_sample_rates": [24000],
            },
            "wire": {"stream_supported": True},
        },
    },
    {
        "provider_key": "qwen_default",
        "model_name": "wanx-v1-t2i",
        "display_name": "Wanx V1 文生图（占位）",
        "capability_domain": "image_gen",
        "base_url": "https://dashscope.aliyuncs.com/api/v1",
        "context_window_tokens": 1,
        "max_input_tokens": None,
        "max_output_tokens": None,
        "capabilities_config": {
            "media_gen": {
                "supports_seed": True,
                "supports_negative_prompt": True,
                "supports_image_to_image": True,
                "supported_sizes": ["1024*1024", "1280*720", "720*1280"],
            },
        },
    },
    {
        "provider_key": "qwen_default",
        "model_name": "wanx-v1-t2v",
        "display_name": "Wanx V1 文生视频（占位）",
        "capability_domain": "video_gen",
        "base_url": "https://dashscope.aliyuncs.com/api/v1",
        "context_window_tokens": 1,
        "max_input_tokens": None,
        "max_output_tokens": None,
        "capabilities_config": {
            "media_gen": {
                "supports_seed": True,
                "supports_seed_image": True,
                "supports_audio_input": False,
                "supported_sizes": ["1280*720", "720*1280", "1920*1080"],
                "supported_durations_sec": [2, 3, 5, 10, 15],
            },
        },
    },
    {
        "provider_key": "qwen_default",
        "model_name": "audio-melody-v1",
        "display_name": "Audio Melody V1（占位）",
        "capability_domain": "audio_gen",
        "base_url": "https://dashscope.aliyuncs.com/api/v1",
        "context_window_tokens": 1,
        "max_input_tokens": None,
        "max_output_tokens": None,
        "capabilities_config": {
            "media_gen": {
                "supports_lyrics": True,
                "supports_style_preset": True,
                "max_target_duration_sec": 300,
                "output_formats": ["wav", "mp3"],
            },
        },
    },
]


class Command(BaseCommand):
    help = (
        "为 SCENES 中所有非 system scene 创建 LLMSceneBinding（含必要 placeholder "
        "LLMProvider / LLMModel）。幂等，可反复跑。"
    )
    requires_system_checks = []

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="仅打印计划，不写 DB",
        )
        parser.add_argument(
            "--reset-primary-model",
            action="store_true",
            help=(
                "对已存在的 binding 也强制把 primary_model 重置回 placeholder。"
                "默认（不带本 flag）只在 binding 不存在时写 primary_model；"
                "已存在的 binding 仅同步 capability_requirements / default_params 等元数据，"
                "保护运营在 AdminDash 已切到真模型的生产配置。"
            ),
        )
        parser.add_argument(
            "--if-empty",
            action="store_true",
            help=(
                "兜底模式：仅当 LLMSceneBinding 已覆盖全部非 system scene 时才跳过；"
                "只要有 scene 缺 binding（fresh 库 / 新增 scene 后的存量库）就继续幂等 seed 补齐。"
                "供 dev 启动脚本（db-prepare.sh）兜底调用：fresh 库自动建占位、全覆盖库秒过、"
                "新增 scene 后自动补上缺失 binding（避免 E14_SCENE_BINDING_UNAVAILABLE 拦启动，）。"
                "与 --reset-primary-model 互斥语义：带 --reset-primary-model 时本 flag 不生效。"
            ),
        )

    def handle(self, *args, **options):
        from django.conf import settings

        if getattr(settings, "TABTIN_EDITION", "saas") == "community":
            if options.get("dry_run"):
                self.stdout.write(
                    self.style.WARNING(
                        "[dry-run] Community compatibility path would initialize "
                        "only the system Scene Catalog; no database rows were changed."
                    )
                )
                return

            from apps.maintenance.community_bootstrap import (
                ExistingCommunityDataError,
                apply_community_bootstrap,
            )

            try:
                result = apply_community_bootstrap()
            except ExistingCommunityDataError:
                if not options.get("if_empty"):
                    raise
                self.stdout.write(
                    self.style.WARNING(
                        "Community compatibility bootstrap skipped: existing user data "
                        "and historical AI defaults were preserved."
                    )
                )
                return
            self.stdout.write(
                self.style.SUCCESS(
                    "Community compatibility path initialized the system Scene Catalog; "
                    "no Provider, Model, credential, or Scene Binding was created "
                    f"(revision={result.revision})."
                )
            )
            return

        from apps.services.llm.scenes.registry import SCENES
        from apps.services.llm.models import (
            LLMModel,
            LLMProvider,
            LLMSceneBinding,
        )

        dry_run = bool(options.get("dry_run"))
        reset_primary = bool(options.get("reset_primary_model"))
        if_empty = bool(options.get("if_empty"))
        if dry_run:
            self.stdout.write(self.style.WARNING("[dry-run] 仅模拟，不写 DB"))
        if reset_primary:
            self.stdout.write(
                self.style.WARNING(
                    "[reset-primary-model] 已存在 binding 的 primary_model 也将被重置回 placeholder！"
                )
            )

        # --if-empty：dev 启动脚本兜底用——按 SCENES 覆盖度判断而非表是否为空。
        # 仅当已覆盖全部非 system scene 时才短路跳过（dump 恢复的全覆盖库秒过，省去写探测噪声）；
        # 只要有 scene 缺 binding（fresh 库 / 新增 scene 后的存量库）就继续走下面的幂等 seed 补齐，
        # 避免新增业务 scene 后存量 dev 库重启被 E14_SCENE_BINDING_UNAVAILABLE 拦死。
        # 带 --reset-primary-model 时表示运营要强制重置，本短路不生效。
        if if_empty and not reset_primary:
            business_scene_keys = {
                key for key, spec in SCENES.items() if not spec.is_system
            }
            existing_keys = set(
                LLMSceneBinding.objects.values_list("scene_key", flat=True)
            )
            missing_scene_keys = business_scene_keys - existing_keys
            if not missing_scene_keys:
                self.stdout.write(
                    self.style.SUCCESS(
                        f"✓ LLM 场景绑定已覆盖全部 {len(business_scene_keys)} 个业务 scene，跳过 seed"
                    )
                )
                return
            self.stdout.write(
                self.style.WARNING(
                    f"⚠ 检测到 {len(missing_scene_keys)} 个 scene 缺 binding"
                    f"（{sorted(missing_scene_keys)}），继续幂等 seed 补齐"
                )
            )

        # ─── Phase 1: seed providers ─────────────────────────────────
        # 升级提示：若 DB 还残留旧版 8 个 placeholder（qwen_default_*、bytedance_default_*），
        # 提示运营先跑 merge_legacy_providers，避免双库 Provider 状态混乱。
        legacy_residuals = LLMProvider.objects.filter(
            provider_key__in=list(LEGACY_PROVIDER_KEY_MAP.keys()),
        ).count()
        if legacy_residuals and not dry_run:
            self.stdout.write(
                self.style.WARNING(
                    f"⚠ 检测到 {legacy_residuals} 个 v0.1.0 旧版 placeholder Provider "
                    f"（{sorted(LEGACY_PROVIDER_KEY_MAP.keys())}）。\n"
                    "   建议先执行 `python manage.py merge_legacy_providers` 合并到 v0.1.x "
                    "（qwen_default / bytedance_default）。\n"
                    "   本次 seed 仍会按 v0.1.x 路径继续，但旧 Provider 会变成无指向的孤儿。"
                )
            )

        provider_by_key: dict[str, LLMProvider] = {}
        provider_created = 0
        for provider_key, name, display_name, capability_domains in DEFAULT_PROVIDERS:
            if dry_run:
                provider_by_key[provider_key] = None  # type: ignore[assignment]
                self.stdout.write(f"[dry-run] would seed provider provider_key={provider_key}")
                continue

            with transaction.atomic(using=postgres_app_db_alias()):
                existing = LLMProvider.objects.filter(
                    provider_key=provider_key,
                    organization_id__isnull=True,
                    user_id__isnull=True,
                ).first()
                if existing:
                    # v0.1.x：Provider 已存在时只做 union 补全缺失 domain，**不覆盖**运营在
                    # AdminDash 上手动调整的 capability_domains。如运营确实关闭了某个 domain
                    # （如阿里云欠费临时关 video_gen），seed 不该把它"还原"。
                    # 如需强制重置，使用 --reset-primary-model（也会重置 capabilities，
                    # 但 capability_domains 仍只做 union 不删——保护运营决策）。
                    current = list(existing.capability_domains or [])
                    missing = [d for d in capability_domains if d not in current]
                    if missing:
                        existing.capability_domains = current + missing
                        existing.save(using=postgres_app_db_alias(), update_fields=["capability_domains", "updated_at"])
                        self.stdout.write(
                            f"~ provider capability_domains expanded provider_key={provider_key} "
                            f"+{missing} -> {existing.capability_domains}"
                        )
                    else:
                        self.stdout.write(f"= provider exists provider_key={provider_key}")
                    provider_by_key[provider_key] = existing
                    continue

                provider = LLMProvider(
                    provider_key=provider_key,
                    name=name,
                    display_name=display_name,
                    # v0.1.x Phase 2.5：Provider.base_url 已删；每个 Model 自带 base_url
                    capability_domains=list(capability_domains),
                    scope="global",
                    organization_id=None,
                    user_id=None,
                    routing_enabled=False,
                    rate_limit=60,
                    priority=0,
                )
                # 占位 api key——运营必须在 AdminDash 真填后才能开 routing
                provider.api_key = PLACEHOLDER_API_KEY
                provider.save(using=postgres_app_db_alias())
                provider_by_key[provider_key] = provider
                provider_created += 1
                self.stdout.write(
                    self.style.SUCCESS(
                        f"+ provider created provider_key={provider_key} "
                        f"capability_domains={list(capability_domains)}"
                    )
                )

        # ─── Phase 2: seed models ────────────────────────────────────
        model_by_domain: dict[str, LLMModel] = {}
        model_created = 0
        for spec in DEFAULT_MODELS:
            provider_key = spec["provider_key"]
            domain = spec["capability_domain"]
            if dry_run:
                model_by_domain[domain] = None  # type: ignore[assignment]
                self.stdout.write(
                    f"[dry-run] would seed model "
                    f"provider_key={provider_key} model_name={spec['model_name']}"
                )
                continue

            provider = provider_by_key.get(provider_key)
            if not provider:
                self.stdout.write(
                    self.style.WARNING(
                        f"⚠ no provider for model provider_key={provider_key}, skip"
                    )
                )
                continue

            with transaction.atomic(using=postgres_app_db_alias()):
                existing = LLMModel.objects.filter(
                    provider=provider, model_name=spec["model_name"],
                ).first()
                if existing:
                    # 元数据字段（display_name / capability_domain / base_url / context_window_tokens / max_*）
                    # 跟随 spec 同步，让 capability_requirements 演进时模型规格自动跟上。
                    # capabilities_config 走 deep-merge：只补 spec 里 model 没有的字段，
                    # 不覆盖运营在 AdminDash 注入的运行时凭证（ASR/TTS 域的 app_id /
                    # secret_key / resource_ids 等都存在 capabilities_config 里）。
                    # 历史教训：旧版 seed 全字段重置 → ASR/TTS 域跑一次 seed 凭证全没。
                    update_fields = []
                    for fld in (
                        "display_name",
                        "capability_domain",
                        "base_url",
                        "context_window_tokens",
                        "max_input_tokens",
                        "max_output_tokens",
                    ):
                        new_val = spec.get(fld)
                        if getattr(existing, fld) != new_val:
                            setattr(existing, fld, new_val)
                            update_fields.append(fld)

                    merged_cfg = _merge_capabilities_config(
                        existing.capabilities_config or {},
                        spec.get("capabilities_config") or {},
                    )
                    if merged_cfg != (existing.capabilities_config or {}):
                        existing.capabilities_config = merged_cfg
                        update_fields.append("capabilities_config")

                    if update_fields:
                        existing.save(using=postgres_app_db_alias(), update_fields=update_fields + ["updated_at"])
                        self.stdout.write(
                            f"~ model updated model_name={spec['model_name']} fields={update_fields}"
                        )
                    else:
                        self.stdout.write(f"= model exists model_name={spec['model_name']}")
                    model_by_domain[domain] = existing
                    continue

                model = LLMModel.objects.create(
                    provider=provider,
                    model_name=spec["model_name"],
                    display_name=spec["display_name"],
                    capability_domain=spec["capability_domain"],
                    # v0.1.x Phase 2.5：base_url 必填，每个 model 自带 endpoint
                    base_url=spec["base_url"],
                    context_window_tokens=spec["context_window_tokens"],
                    max_input_tokens=spec.get("max_input_tokens"),
                    max_output_tokens=spec.get("max_output_tokens"),
                    capabilities_config=spec["capabilities_config"],
                    wave_status="ready",
                )
                model_by_domain[domain] = model
                model_created += 1
                self.stdout.write(
                    self.style.SUCCESS(
                        f"+ model created model_name={spec['model_name']} domain={domain}"
                    )
                )

        # ─── Phase 3: seed scene bindings ────────────────────────────
        seeded = 0
        skipped_system = 0
        skipped_no_model = 0
        for scene_key, spec in SCENES.items():
            if spec.is_system:
                skipped_system += 1
                continue

            model = model_by_domain.get(spec.capability_domain)
            if not model and not dry_run:
                self.stdout.write(
                    self.style.WARNING(
                        f"⚠ no placeholder model for scene={scene_key} "
                        f"domain={spec.capability_domain}, skip"
                    )
                )
                skipped_no_model += 1
                continue

            if dry_run:
                self.stdout.write(f"[dry-run] would bind scene_key={scene_key}")
                continue

            with transaction.atomic(using=postgres_app_db_alias()):
                existing = LLMSceneBinding.objects.filter(scene_key=scene_key).first()
                if existing is None:
                    # 新建 binding：写入完整 placeholder 配置
                    binding = LLMSceneBinding.objects.create(
                        scene_key=scene_key,
                        display_name=spec.display_name,
                        description=spec.description,
                        capability_domain=spec.capability_domain,
                        primary_model=model,
                        capability_requirements=_jsonable(spec.capability_requirements),
                        default_params=_jsonable(spec.default_params),
                    )
                    created = True
                else:
                    # 已存在：默认保护运营改过的 primary_model / fallback_models，
                    # 只同步元数据 + capability_requirements / default_params（这两项是 SCENES SSoT）
                    update_fields = []
                    for fld_name, new_val in (
                        ("display_name", spec.display_name),
                        ("description", spec.description),
                        ("capability_domain", spec.capability_domain),
                        ("capability_requirements", _jsonable(spec.capability_requirements)),
                        ("default_params", _jsonable(spec.default_params)),
                    ):
                        if getattr(existing, fld_name) != new_val:
                            setattr(existing, fld_name, new_val)
                            update_fields.append(fld_name)

                    if reset_primary and existing.primary_model_id != model.id:
                        existing.primary_model = model
                        update_fields.append("primary_model")

                    if update_fields:
                        existing.save(
                            using=postgres_app_db_alias(),
                            update_fields=update_fields + ["updated_at"],
                        )
                    binding = existing
                    created = False

                # 兜底：写完后跑一次 full_clean()，让 placeholder 数据漂移在 seed 阶段就被发现
                try:
                    binding.full_clean()
                except Exception as exc:
                    self.stdout.write(
                        self.style.ERROR(
                            f"⚠ binding scene_key={scene_key} clean() 校验失败: {exc}"
                        )
                    )

            seeded += 1
            verb = "+ created" if created else "~ updated"
            self.stdout.write(self.style.SUCCESS(f"{verb} binding scene_key={scene_key}"))

        self.stdout.write(self.style.SUCCESS("─" * 60))
        self.stdout.write(
            self.style.SUCCESS(
                f"providers: created={provider_created} | "
                f"models: created={model_created} | "
                f"bindings: seeded={seeded} skipped_system={skipped_system} "
                f"skipped_no_model={skipped_no_model}"
            )
        )
        self.stdout.write(
            self.style.WARNING(
                "提示：所有 placeholder provider 的 api_key 都是 <INSERT_VIA_ADMIN>，"
                "运营请在 AdminDash 真填后再开 routing_enabled。"
            )
        )
