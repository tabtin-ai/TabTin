from django.apps import AppConfig


class EmailConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.services.email'
    verbose_name = '邮件服务'
