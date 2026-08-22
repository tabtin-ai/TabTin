"""
批量初始化 LLM 模型 Token 限制字段。
"""

from django.core.management.base import BaseCommand

from apps.services.llm.models import LLMModel


class Command(BaseCommand):
    help = "批量初始化 max_input_tokens / max_output_tokens（仅填充空值）"

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

    def handle(self, *args, **options):
        apply_changes = options["apply"]
        provider_filter = options["provider"]
        model_filter = options["model"]

        queryset = LLMModel.objects.select_related("provider")
        if provider_filter:
            queryset = queryset.filter(provider__name=provider_filter)
        if model_filter:
            queryset = queryset.filter(model_name__icontains=model_filter)

        total = 0
        updated = 0

        for model in queryset:
            total += 1
            defaults = self._resolve_defaults(model)
            if not defaults:
                continue

            update_fields = []
            if model.max_output_tokens is None and defaults.get("max_output_tokens") is not None:
                model.max_output_tokens = defaults["max_output_tokens"]
                update_fields.append("max_output_tokens")

            if model.max_input_tokens is None and defaults.get("max_input_tokens") is not None:
                model.max_input_tokens = defaults["max_input_tokens"]
                update_fields.append("max_input_tokens")

            if not update_fields:
                continue

            updated += 1
            self.stdout.write(
                f"- {model.provider.name}/{model.model_name}: "
                f"max_input={model.max_input_tokens}, max_output={model.max_output_tokens}"
            )

            if apply_changes:
                model.save(update_fields=update_fields)

        mode = "已写入" if apply_changes else "预览"
        self.stdout.write(self.style.SUCCESS(f"{mode}完成：匹配 {total} 条，更新 {updated} 条。"))
        if not apply_changes:
            self.stdout.write("如需写入数据库，请加 --apply。")

    def _resolve_defaults(self, model: LLMModel) -> dict:
        context_window = model.context_window_tokens
        if not context_window:
            return {}

        provider = (model.provider.name or "").lower()

        provider_output_defaults = {
            "openai": 2000,
            "moonshot": 2000,
            "minimax": 4096,
            "claude": 4096,
            "qwen": 4000,
            "gemini": 2000,
        }

        max_output = provider_output_defaults.get(provider, 2000)
        max_output = min(max_output, context_window)

        max_input = max(1, context_window - max_output)

        return {
            "max_output_tokens": max_output,
            "max_input_tokens": max_input,
        }
