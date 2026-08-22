"""
支付服务应用配置
"""

from django.apps import AppConfig


class PaymentConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.services.payment'
    verbose_name = '支付服务'
