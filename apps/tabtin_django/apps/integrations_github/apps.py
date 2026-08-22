from django.apps import AppConfig


class IntegrationsGithubConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.integrations_github"
    label = "integrations_github"
    verbose_name = "GitHub OAuth（MCP 连接器）"
