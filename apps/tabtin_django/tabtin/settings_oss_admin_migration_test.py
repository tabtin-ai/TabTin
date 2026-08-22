"""
OSS admin API 迁移验证专用 settings。

基于 OSS admin 最小测试环境，但启用真实 migrations，
用于校验新增 oss schema/migration 可以正常建表。
"""

from .settings_oss_admin_test import *  # noqa: F401,F403

MIGRATION_MODULES = {}
