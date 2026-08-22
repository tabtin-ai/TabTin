from django.apps import AppConfig


class ClientErrorsConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.client_errors'
    verbose_name = '客户端错误监控'
