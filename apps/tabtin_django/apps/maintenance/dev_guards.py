"""开发环境专用 maintenance 命令的硬门控（防误触生产库 / 生产配置）。"""
from __future__ import annotations

import os

from django.conf import settings
from django.core.management.base import CommandError

DEV_DB_NAME_WHITELIST = frozenset({'tabtin_single', 'test_tabtin_single'})
DEV_DB_HOST_WHITELIST = frozenset({'localhost', '127.0.0.1', '::1'})
PROD_ENV_MARKERS = frozenset({'production', 'prod'})


def assert_dev_provision_allowed() -> None:
    """provision_dev_agent_ready：DEBUG 或显式 TABTIN_DEV_AUTO_PROVISION=1。"""
    if settings.DEBUG:
        return
    if os.getenv('TABTIN_DEV_AUTO_PROVISION', '').strip() == '1':
        return
    raise CommandError(
        '拒绝执行：非 DEBUG 环境且未设置 TABTIN_DEV_AUTO_PROVISION=1。'
    )


def assert_dev_mock_recharge_allowed() -> dict[str, str]:
    """dev_mock_recharge 多重防线；通过则返回当前 default 库的 host/name。"""
    if not settings.DEBUG:
        raise CommandError('拒绝执行：settings.DEBUG 必须为 True。')

    default_db = settings.DATABASES.get('default', {})
    db_host = str(default_db.get('HOST', '')).strip().lower()
    db_name = str(default_db.get('NAME', '')).strip()

    if db_host not in DEV_DB_HOST_WHITELIST:
        raise CommandError(
            f'拒绝执行：数据库 HOST={db_host!r} 不在开发白名单 '
            f'{sorted(DEV_DB_HOST_WHITELIST)}。'
        )
    if db_name not in DEV_DB_NAME_WHITELIST:
        raise CommandError(
            f'拒绝执行：数据库 NAME={db_name!r} 不在开发白名单 '
            f'{sorted(DEV_DB_NAME_WHITELIST)}。'
        )

    for var in ('ENVIRONMENT', 'DJANGO_ENV', 'TABTIN_ENV'):
        val = os.getenv(var, '').strip().lower()
        if val in PROD_ENV_MARKERS:
            raise CommandError(f'拒绝执行：{var}={val!r} 含生产环境标记。')

    settings_module = os.getenv('DJANGO_SETTINGS_MODULE', '').strip().lower()
    if any(marker in settings_module for marker in PROD_ENV_MARKERS):
        raise CommandError(
            f'拒绝执行：DJANGO_SETTINGS_MODULE={settings_module!r} 指向生产配置。'
        )

    return {'host': db_host, 'name': db_name}
