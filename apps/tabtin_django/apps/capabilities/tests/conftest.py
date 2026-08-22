"""Django 启动入口（与 apps/tabmemo/tests/conftest.py 同构）。

确保在 pytest 采集前 `django.setup()` 已运行，否则 `from apps.fts.schemas
import SearchParams` 等模块级导入会因 settings 未就绪报错。
"""

import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
django.setup()
