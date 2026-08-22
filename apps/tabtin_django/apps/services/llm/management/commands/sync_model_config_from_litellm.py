"""
从 LiteLLM 数据库同步模型配置

使用 LiteLLM 的公开数据库自动更新模型的 Token 限制、定价信息、模式和高级计费配置。
"""

from django.core.management.base import BaseCommand
from django.db import transaction
from decimal import Decimal

from apps.services.llm.models import LLMModel
from apps.services.llm.services.litellm_model_info import LiteLLMModelInfoService


class Command(BaseCommand):
    help = "从 LiteLLM 数据库同步模型配置（Token 限制、定价、模式、高级计费等）"

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply",
            action="store_true",
            help="实际写入数据库（默认仅预览）",
        )
        parser.add_argument(
            "--provider",
            type=str,
            default=None,
            help="仅处理指定 provider（如 openai/moonshot/minimax/qwen/claude/gemini）",
        )
        parser.add_argument(
            "--model",
            type=str,
            default=None,
            help="仅处理匹配 model_name 的模型（支持包含匹配）",
        )
        parser.add_argument(
            "--update-pricing",
            action="store_true",
            help="同时更新定价信息",
        )
        parser.add_argument(
            "--update-mode",
            action="store_true",
            help="同时更新模型模式（mode）",
        )
        parser.add_argument(
            "--update-advanced-billing",
            action="store_true",
            help="同时更新高级计费配置（custom_billing_config）",
        )
        parser.add_argument(
            "--clear-cache",
            action="store_true",
            help="清除 LiteLLM 缓存并重新获取",
        )

    def handle(self, *args, **options):
        apply_changes = options["apply"]
        provider_filter = options["provider"]
        model_filter = options["model"]
        update_pricing = options["update_pricing"]
        update_mode = options["update_mode"]
        update_advanced_billing = options["update_advanced_billing"]
        clear_cache = options["clear_cache"]

        if clear_cache:
            LiteLLMModelInfoService.clear_cache()
            self.stdout.write(self.style.SUCCESS("✅ 已清除 LiteLLM 缓存"))

        # 构建查询。v0.1：LLMModel.is_active 字段已删（0022），下线模型直接 DELETE，
        # 仅同步当前 routing_enabled 的 provider 下挂的模型。
        queryset = LLMModel.objects.select_related("provider").filter(provider__routing_enabled=True)
        if provider_filter:
            queryset = queryset.filter(provider__name=provider_filter)
        if model_filter:
            queryset = queryset.filter(model_name__icontains=model_filter)

        total = 0
        matched = 0
        updated = 0

        self.stdout.write("\n正在查询 LiteLLM 数据库...\n")

        for model in queryset:
            total += 1

            # 获取完整模型信息
            model_info = LiteLLMModelInfoService.get_model_info(model.model_name)

            if not model_info:
                self.stdout.write(
                    self.style.WARNING(
                        f"⚠️  {model.provider.name}/{model.model_name}: 未找到配置"
                    )
                )
                continue

            matched += 1

            # 检查是否需要更新
            update_fields = []
            changes = []

            # 1. Token 限制
            # v0.1：LLMModel.max_tokens 字段已重命名为 context_window_tokens（0022 RenameField）。
            context_window = model_info.get('max_tokens')
            max_input = model_info.get('max_input_tokens')
            max_output = model_info.get('max_output_tokens')

            if context_window and model.context_window_tokens != context_window:
                changes.append(f"context: {model.context_window_tokens} → {context_window}")
                model.context_window_tokens = context_window
                update_fields.append("context_window_tokens")

            if max_input and model.max_input_tokens != max_input:
                changes.append(f"max_input: {model.max_input_tokens} → {max_input}")
                model.max_input_tokens = max_input
                update_fields.append("max_input_tokens")

            if max_output and model.max_output_tokens != max_output:
                changes.append(f"max_output: {model.max_output_tokens} → {max_output}")
                model.max_output_tokens = max_output
                update_fields.append("max_output_tokens")

            # 2. 定价信息（可选）
            if update_pricing:
                input_cost_per_token = model_info.get('input_cost_per_token')
                output_cost_per_token = model_info.get('output_cost_per_token')

                if input_cost_per_token is not None:
                    input_price_per_1k = Decimal(str(input_cost_per_token * 1000))
                    if model.input_price_per_1k != input_price_per_1k:
                        changes.append(f"input_price: {model.input_price_per_1k} → {input_price_per_1k}")
                        model.input_price_per_1k = input_price_per_1k
                        update_fields.append("input_price_per_1k")

                if output_cost_per_token is not None:
                    output_price_per_1k = Decimal(str(output_cost_per_token * 1000))
                    if model.output_price_per_1k != output_price_per_1k:
                        changes.append(f"output_price: {model.output_price_per_1k} → {output_price_per_1k}")
                        model.output_price_per_1k = output_price_per_1k
                        update_fields.append("output_price_per_1k")

                prompt_cache_pricing = LiteLLMModelInfoService.extract_prompt_cache_pricing(model_info)
                if prompt_cache_pricing:
                    current_config = model.custom_billing_config or {}
                    merged_config = {**current_config, **prompt_cache_pricing}
                    if model.custom_billing_config != merged_config:
                        readable_items = ", ".join(
                            sorted(prompt_cache_pricing.keys())
                        )
                        changes.append(f"prompt_cache_pricing: {readable_items}")
                        model.custom_billing_config = merged_config
                        if "custom_billing_config" not in update_fields:
                            update_fields.append("custom_billing_config")

            # 3. 模型 capability_domain（可选）
            # v0.1：LLMModel.mode 字段已删（0022），改为 capability_domain（8 域）。
            if update_mode:
                litellm_mode = model_info.get('mode', 'chat')
                domain_mapping = {
                    'chat': 'chat',
                    'completion': 'chat',
                    'embedding': 'embedding',
                    'image_generation': 'image_gen',
                    'audio_transcription': 'asr',
                    'audio_speech': 'tts',
                }
                mapped_domain = domain_mapping.get(litellm_mode)
                if mapped_domain and model.capability_domain != mapped_domain:
                    changes.append(f"capability_domain: {model.capability_domain} → {mapped_domain}")
                    model.capability_domain = mapped_domain
                    update_fields.append("capability_domain")

            # 4. 高级计费配置（可选）
            if update_advanced_billing:
                advanced_billing = LiteLLMModelInfoService.extract_advanced_billing_config(model_info)

                if advanced_billing:
                    # 合并到现有的 custom_billing_config
                    current_config = model.custom_billing_config or {}
                    merged_config = {**current_config, **advanced_billing}

                    if model.custom_billing_config != merged_config:
                        changes.append(f"advanced_billing: {len(advanced_billing)} 个字段")
                        model.custom_billing_config = merged_config
                        update_fields.append("custom_billing_config")

            if not update_fields:
                continue

            updated += 1

            # 显示变更
            self.stdout.write(
                f"{'✅' if apply_changes else '📋'} {model.provider.name}/{model.model_name}:"
            )
            for change in changes:
                self.stdout.write(f"    {change}")

            # 写入数据库
            if apply_changes:
                with transaction.atomic():
                    model.save(update_fields=update_fields)

        # 总结
        self.stdout.write("\n" + "=" * 60)
        mode = "已写入" if apply_changes else "预览"
        self.stdout.write(
            self.style.SUCCESS(
                f"{mode}完成：总计 {total} 条，匹配 {matched} 条，更新 {updated} 条。"
            )
        )

        if not apply_changes and updated > 0:
            self.stdout.write("\n💡 如需写入数据库，请加 --apply 参数。")
