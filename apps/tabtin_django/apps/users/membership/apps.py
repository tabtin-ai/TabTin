"""
会员体系应用配置
"""

from django.apps import AppConfig


class MembershipConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.users.membership'
    verbose_name = '会员体系'
