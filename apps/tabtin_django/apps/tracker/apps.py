from django.apps import AppConfig


class TrackerConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.tracker"
    label = "tracker"
    verbose_name = "Tracker"

    def ready(self):
        # 加载跨库 cascade 维护信号（v0.1 宪法 §5.1：TrackerRun.chat_session 软引用配套）
        from apps.tracker import signals  # noqa: F401

