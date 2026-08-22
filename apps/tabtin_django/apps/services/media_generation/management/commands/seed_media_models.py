"""
初始化媒体生成的默认提供商和模型配置

用法:
    python manage.py seed_media_models --api-key sk-xxx
    python manage.py seed_media_models --dry-run
"""

from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = '初始化媒体生成的默认提供商和模型配置 (DashScope 图片/视频)'

    def add_arguments(self, parser):
        parser.add_argument(
            '--api-key',
            type=str,
            default='',
            help='DashScope API Key (如不提供则使用占位符，需后续在管理后台更新)',
        )
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='仅预览将要创建的数据，不实际写入',
        )

    def handle(self, *args, **options):
        from apps.services.media_generation.seed_data import seed_default_data

        api_key = options['api_key']
        dry_run = options['dry_run']

        if dry_run:
            self.stdout.write(self.style.WARNING('== DRY RUN 模式 ==\n'))

        result = seed_default_data(api_key=api_key, dry_run=dry_run)

        for line in result['details']:
            if line.startswith('[创建]') or line.startswith('[待创建]'):
                self.stdout.write(self.style.SUCCESS(line))
            elif line.startswith('[跳过]'):
                self.stdout.write(self.style.WARNING(line))
            else:
                self.stdout.write(line)

        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS(
            f"完成: 创建 {result['created_providers']} 个提供商, "
            f"{result['created_models']} 个模型, "
            f"跳过 {result['skipped_models']} 个已存在模型"
        ))
