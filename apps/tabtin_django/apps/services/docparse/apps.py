from django.apps import AppConfig


class DocparseConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.services.docparse'
    verbose_name = '文档解析服务'
