"""Django 启动入口（与 ``apps/services/agent_engine/permissions/tests/conftest.py`` 同构）。

CLI 测试模块（``test_audit.py`` / ``test_a5_install.py`` 等）
依赖 Django ORM（``CliAuditEvent`` model + PG 路由等），需要
``django.setup()`` 已运行。

**实际生效的 ``DJANGO_SETTINGS_MODULE`` 优先级**（已实测）：

1. shell 环境变量 —— 显式 ``export`` 时最高优先级
2. ``apps/tabtin_django/pytest.ini`` 的 ``DJANGO_SETTINGS_MODULE = tabtin.settings``
   —— 通过 ``pytest`` 入口跑时由 ``pytest-django`` 在插件 init 写入 ``os.environ``，
   早于本 conftest 加载，因此本文件的 ``setdefault`` 不会覆盖
3. 本 conftest 的 ``setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings_cli_audit_test")``
   —— 仅在前两条都未设置时（如 ``python -c "from … import conftest"`` 直接 import）兜底

**典型 case**：

- ``pytest apps/services/agent_engine/cli/tests/test_parser.py -q``（不 export）
  → 实际用 ``tabtin.settings``（来自 pytest.ini），能跑绿
- ``DJANGO_SETTINGS_MODULE=tabtin.settings_cli_audit_test pytest …``
  → 用轻量 SQLite settings 跑全量 cli DB 测试
- 直接 ``python -m apps.services.agent_engine.cli.tabtin_cli …``
  → 走 ``cli.py`` 内部的 ``_ensure_django(settings_module=…)``，与本 conftest 无关

> v3.1（2026-04-19）：原默认 ``setdefault`` 指向 ``tabtin.settings_c3_connect_test``，
> 该 settings 文件已随 Connect 模型整体删除（方向锚 H2）；本文件 fallback 默认改为
> 仍存在的 ``tabtin.settings_cli_audit_test``，避免裸 import 时抛 ModuleNotFoundError。
"""

import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings_cli_audit_test")
django.setup()
