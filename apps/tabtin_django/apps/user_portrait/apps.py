from django.apps import AppConfig


class UserPortraitConfig(AppConfig):
    """用户画像 App（v0.2 per-Organization）。

    存放每个 (user, organization) 组合一份的"用户级画像"（USER 层）——由蒸馏 Agent
    从该 Organization 内的 TabMemo 中周期性整理出的叙事文档。

    决策依据：
      - 之前设计的"跨 Organization 共享"被产品判断为错误（人设隔离 / 隐私 / 计费三论点）
      - 现在改为 per-(user, organization) 独立画像

    Lifecycle hooks：
      - ready() 注册 signals.py 里的 post_delete 监听器，
        实现 Organization / OrganizationMember 删除时级联清理画像（决策 N3 / N4）
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.user_portrait"
    label = "user_portrait"
    verbose_name = "用户画像"

    def ready(self):
        # 注册 signal 监听器（级联清理画像）
        # 在 ready() 里 import 而非模块顶部——避免应用未加载时 import 副作用
        from apps.user_portrait import signals  # noqa: F401
