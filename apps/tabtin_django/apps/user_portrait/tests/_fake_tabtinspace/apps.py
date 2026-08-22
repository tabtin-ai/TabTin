from django.apps import AppConfig


class FakeTabtinspaceConfig(AppConfig):
    """注册 label="tabtinspace" 的最小 app，让 apps.get_model 能解析到 fake 模型。"""

    name = "apps.user_portrait.tests._fake_tabtinspace"
    label = "tabtinspace"
    verbose_name = "Fake Tabtinspace (test only)"
