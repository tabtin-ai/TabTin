"""Django 启动入口（与 apps/capabilities/tests/conftest.py 同构）。

确保在 pytest 采集 ``test_cli_engine.py`` 等模块前 ``django.setup()`` 已运行；
否则 ``from apps.services.agent_engine.permissions.cli_engine import ...`` 等
模块级 import 会因 settings 未就绪报错。
"""

import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
django.setup()
