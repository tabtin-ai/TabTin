"""
OSS admin API 测试专用 settings。

基于 billing 最小测试环境，仅切换 ROOT_URLCONF 到 OSS admin 测试路由，
避免完整项目 URL 在最小 INSTALLED_APPS 下导入失败。
"""

from .settings_billing_test import *  # noqa: F401,F403

ROOT_URLCONF = "apps.services.oss.admin_test_urls"
