from django.apps import AppConfig
from django.conf import settings


class JinbaoConfig(AppConfig):
    name = 'apps.services.jinbao'
    label = 'jinbao'
    verbose_name = '进宝 Echo Bot (dev)'

    def ready(self) -> None:
        # 关闭时完全不注册 signals，零开销；不需要 monkey-patch / 运行时判断。
        if not getattr(settings, 'ENABLE_JINBAO_BOT', False):
            return
        from . import signals  # noqa: F401  注册 signal handlers
