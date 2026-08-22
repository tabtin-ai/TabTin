"""`apps.fts` 测试套件的 Django 启动脚本。

与 `apps/tabmemo/tests/conftest.py` 同构：在 pytest 采集前确保
Django `setup()` 已运行，否则 `test_client.py` 等直接 `from
django.conf import settings` 会报 `ImproperlyConfigured`。

额外处理：本套件包含真实 ORM 写入测试（test_outbox.py），必须
让 settings 在 pytest 下走 SQLite 测试库。项目 settings.py 通过
`RUNNING_TESTS = 'test' in sys.argv` 判定（历史约定，其他 app
测试都用 SimpleTestCase 规避），这里在 Django 启动前注入 'test'
参数，保持全局一致，避免 pytest 误打真 MySQL 并请求 `CREATE DATABASE`
权限。
"""

import os
import sys

if "test" not in sys.argv:
    # 插入在脚本名之后，保持其余 pytest 参数顺序不变
    sys.argv.insert(1, "test")

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
os.environ.setdefault("USE_SQLITE_FOR_TESTS", "1")
os.environ.setdefault("USE_IN_MEMORY_CACHE", "1")
os.environ.setdefault("USE_IN_MEMORY_CHANNEL_LAYER", "1")

import django  # noqa: E402 — 必须在环境变量就绪后再导入

django.setup()
