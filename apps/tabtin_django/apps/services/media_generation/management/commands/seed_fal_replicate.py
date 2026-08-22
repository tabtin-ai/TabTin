"""
初始化 fal.ai / Replicate 媒体生成 Provider 和 Model 配置

将 API Key 写入 LLMProvider（媒体工厂主路径的配置源），
并创建对应的 LLMModel 记录。

用法:
    python manage.py seed_fal_replicate
    python manage.py seed_fal_replicate --fal-key <KEY> --replicate-token <TOKEN>
    python manage.py seed_fal_replicate --dry-run
"""

from django.core.management.base import BaseCommand


_FAL_MODELS = [
    {
        "model_name": "fal-ai/flux/dev",
        "display_name": "FLUX Dev (fal)",
        "mode": "image_generation",
        "billing_type": "image_count",
        "description": "Black Forest Labs FLUX.dev 图片生成",
        "capabilities_config": {
            "default_task_type": "text2image",
            "supported_sizes": ["1024*1024", "1024*1536", "1536*1024"],
            "supports_negative_prompt": True,
            "poll_interval_seconds": 5,
            "max_poll_count": 60,
        },
    },
    {
        "model_name": "fal-ai/flux/schnell",
        "display_name": "FLUX Schnell (fal)",
        "mode": "image_generation",
        "billing_type": "image_count",
        "description": "Black Forest Labs FLUX.schnell 快速图片生成",
        "capabilities_config": {
            "default_task_type": "text2image",
            "supported_sizes": ["1024*1024", "1024*1536", "1536*1024"],
            "poll_interval_seconds": 3,
            "max_poll_count": 40,
        },
    },
    {
        "model_name": "fal-ai/kling-video/v1/standard",
        "display_name": "Kling Video Standard (fal)",
        "mode": "video_generation",
        "billing_type": "video_seconds",
        "description": "Kling 标准视频生成",
        "capabilities_config": {
            "default_task_type": "text2video",
            "supported_durations": [5, 10],
            "poll_interval_seconds": 15,
            "max_poll_count": 120,
        },
    },
    {
        "model_name": "fal-ai/minimax-video",
        "display_name": "MiniMax Video (fal)",
        "mode": "video_generation",
        "billing_type": "video_seconds",
        "description": "MiniMax 视频生成",
        "capabilities_config": {
            "default_task_type": "text2video",
            "supported_durations": [5, 10],
            "poll_interval_seconds": 15,
            "max_poll_count": 120,
        },
    },
]

_REPLICATE_MODELS = [
    {
        "model_name": "black-forest-labs/flux-schnell",
        "display_name": "FLUX Schnell (Replicate)",
        "mode": "image_generation",
        "billing_type": "image_count",
        "description": "Black Forest Labs FLUX Schnell 图片生成",
        "capabilities_config": {
            "default_task_type": "text2image",
            "supported_sizes": ["1024*1024"],
            "poll_interval_seconds": 5,
            "max_poll_count": 60,
        },
    },
    {
        "model_name": "black-forest-labs/flux-1.1-pro",
        "display_name": "FLUX 1.1 Pro (Replicate)",
        "mode": "image_generation",
        "billing_type": "image_count",
        "description": "Black Forest Labs FLUX 1.1 Pro 高质量图片生成",
        "capabilities_config": {
            "default_task_type": "text2image",
            "supported_sizes": ["1024*1024", "1024*1536", "1536*1024"],
            "poll_interval_seconds": 8,
            "max_poll_count": 60,
        },
    },
    {
        "model_name": "bytedance/seedance-1-pro",
        "display_name": "Seedance Pro (Replicate)",
        "mode": "video_generation",
        "billing_type": "video_seconds",
        "description": "字节 Seedance Pro 视频生成",
        "capabilities_config": {
            "default_task_type": "text2video",
            "supported_durations": [5, 10],
            "poll_interval_seconds": 20,
            "max_poll_count": 90,
        },
    },
    {
        "model_name": "luma/ray",
        "display_name": "Luma Ray (Replicate)",
        "mode": "video_generation",
        "billing_type": "video_seconds",
        "description": "Luma Ray 视频生成",
        "capabilities_config": {
            "default_task_type": "text2video",
            "supported_durations": [5],
            "poll_interval_seconds": 15,
            "max_poll_count": 120,
        },
    },
]


class Command(BaseCommand):
    help = '初始化 fal.ai / Replicate 的 LLMProvider 和 LLMModel 配置'

    def add_arguments(self, parser):
        parser.add_argument(
            '--fal-key', type=str, default='',
            help='fal.ai API Key（格式: key_id:key_secret）',
        )
        parser.add_argument(
            '--replicate-token', type=str, default='',
            help='Replicate API Token',
        )
        parser.add_argument(
            '--dry-run', action='store_true',
            help='仅预览将要创建的数据',
        )

    def handle(self, *args, **options):
        # v0.1.x：本命令在 v0.1.0 (migration 0022) 之后就已经坏了——下面 _FAL_MODELS / _REPLICATE_MODELS
        # 仍在用 v0.1.0 之前的字段（mode / is_active / max_tokens），Phase 2.5 又新增
        # 了必填 base_url，全部需要重写。当前已确认运营不再依赖（fal/replicate 走 AdminDash
        # 手动配 Provider + Model），先 fail-fast 提示，避免运营误执行导致 TypeError 后扔出
        # 一堆 deprecated 字段错误。下个 PR 整段重写或直接删除。
        self.stdout.write(self.style.ERROR(
            "[seed_fal_replicate] 此命令已在 v0.1.x 弃用——内部使用了多个已删字段\n"
            "（mode / is_active / max_tokens / base_url），无法运行。\n"
            "请在 AdminDash → /ai/providers 手动创建 fal / replicate Provider，\n"
            "然后在 /ai/models 给每个模型配 endpoint。"
        ))
        return

        # 以下为 v0.1.0 历史代码，保留供后续重写参考；当前不会执行
        from django.conf import settings  # noqa: F401  # pragma: no cover
        from apps.services.llm.models import LLMProvider, LLMModel  # noqa: F401  # pragma: no cover

        fal_key = options['fal_key'] or getattr(settings, 'FAL_API_KEY', '')
        replicate_token = options['replicate_token'] or getattr(settings, 'REPLICATE_API_TOKEN', '')
        dry_run = options['dry_run']

        if dry_run:
            self.stdout.write(self.style.WARNING('== DRY RUN 模式 ==\n'))

        created_providers = 0
        created_models = 0
        skipped = 0

        for provider_name, api_key, base_url, display_name, models_list in [
            ("fal", fal_key, "https://queue.fal.run", "fal.ai", _FAL_MODELS),
            ("replicate", replicate_token, "https://api.replicate.com/v1", "Replicate", _REPLICATE_MODELS),
        ]:
            if not api_key:
                self.stdout.write(self.style.WARNING(
                    f"[跳过] {display_name}: 未提供 API Key（可通过 --{provider_name.replace('_', '-')}-key 或环境变量传入）"
                ))
                continue

            provider, p_created = (None, False)
            if not dry_run:
                provider, p_created = LLMProvider.objects.update_or_create(
                    name=provider_name,
                    scope="global",
                    organization_id=None,
                    user_id=None,
                    defaults={
                        "display_name": display_name,
                        "base_url": base_url,
                        "api_key": api_key,
                        "provider_key": provider_name,
                        "capability_domain": "image_gen",
                        "is_active": True,
                        "priority": 10,
                        "rate_limit": 30,
                    },
                )

            action = "待创建" if dry_run else ("创建" if p_created else "更新")
            self.stdout.write(self.style.SUCCESS(
                f"[{action}] LLMProvider: {display_name} (name={provider_name}, "
                f"api_key={api_key[:8]}...{api_key[-4:]})"
            ))
            if p_created:
                created_providers += 1

            for model_def in models_list:
                if not dry_run:
                    _, m_created = LLMModel.objects.update_or_create(
                        provider=provider,
                        model_name=model_def["model_name"],
                        defaults={
                            "display_name": model_def["display_name"],
                            "mode": model_def["mode"],
                            "billing_type": model_def.get("billing_type", "request"),
                            "description": model_def.get("description", ""),
                            "capabilities_config": model_def.get("capabilities_config", {}),
                            "is_active": True,
                            "max_tokens": 1,
                            "max_output_tokens": 0,
                        },
                    )
                    if m_created:
                        created_models += 1
                        self.stdout.write(self.style.SUCCESS(
                            f"  [创建] LLMModel: {model_def['display_name']} ({model_def['model_name']})"
                        ))
                    else:
                        skipped += 1
                        self.stdout.write(self.style.WARNING(
                            f"  [更新] LLMModel: {model_def['display_name']} ({model_def['model_name']})"
                        ))
                else:
                    self.stdout.write(self.style.SUCCESS(
                        f"  [待创建] LLMModel: {model_def['display_name']} ({model_def['model_name']}, mode={model_def['mode']})"
                    ))

        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS(
            f"完成: 创建 {created_providers} 个提供商, "
            f"{created_models} 个模型, "
            f"更新/跳过 {skipped} 个已存在模型"
        ))
