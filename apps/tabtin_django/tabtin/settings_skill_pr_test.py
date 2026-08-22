"""Skill → Package Registry 集成测试 settings。

策略：
- 继承 settings_package_registry_test（双 SQLite + syncdb）
- 保留 skills / tabtinspace / package_registry 全部表

使用方式：

    cd apps/tabtin_django && source venv/bin/activate
    python manage.py test apps.skills.tests.test_skill_package_registry \
        --settings=tabtin.settings_skill_pr_test --verbosity=2
"""
from __future__ import annotations

from .settings_package_registry_test import *  # noqa: F401,F403
