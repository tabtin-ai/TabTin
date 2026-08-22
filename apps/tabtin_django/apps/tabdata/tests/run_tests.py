#!/usr/bin/env python3
"""
TabData PostgreSQL 烟测入口

使用 tabtin.settings_tabdata_test（PostgreSQL + 单库 MIRROR），运行
核心回归测试：undo/redo、history events、native consistency。

用法：
    # 默认烟测（undo_redo + history_events + native_read）
    python apps/tabtin_django/apps/tabdata/tests/run_tests.py

    # 指定模块
    python apps/tabtin_django/apps/tabdata/tests/run_tests.py \\
        apps.tabdata.tests.test_undo_redo

    # 全量 TabData 测试
    python apps/tabtin_django/apps/tabdata/tests/run_tests.py --all
"""

import os
import sys

_here = os.path.abspath(os.path.dirname(__file__))
# _here = .../apps/tabtin_django/apps/tabdata/tests
django_root = os.path.dirname(os.path.dirname(os.path.dirname(_here)))  # .../apps/tabtin_django
project_root = os.path.dirname(os.path.dirname(django_root))  # .../TabTinAgent
sys.path.insert(0, project_root)
sys.path.insert(0, django_root)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings_tabdata_test")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.test.utils import get_runner  # noqa: E402

DEFAULT_SMOKE_LABELS = [
    "apps.tabdata.tests.test_undo_redo",
    "apps.tabdata.tests.test_history_events",
    "apps.tabdata.tests.test_native_read",
]


def main():
    import argparse

    parser = argparse.ArgumentParser(description="TabData PostgreSQL 烟测")
    parser.add_argument("tests", nargs="*", help="要运行的测试标签")
    parser.add_argument(
        "-v", "--verbosity", type=int, default=2, choices=[0, 1, 2, 3]
    )
    parser.add_argument("--no-interactive", action="store_true")
    parser.add_argument("--all", action="store_true", help="跑全量 tabdata 测试")
    parser.add_argument("--keepdb", action="store_true", help="复用已存在的测试库")
    args = parser.parse_args()

    if args.tests:
        labels = args.tests
    elif args.all:
        labels = ["apps.tabdata.tests"]
    else:
        labels = DEFAULT_SMOKE_LABELS

    print(f"Settings : {os.environ['DJANGO_SETTINGS_MODULE']}")
    print(f"DB engine: {settings.DATABASES['default']['ENGINE']}")
    print(f"Test DB  : {settings.DATABASES['default'].get('TEST', {}).get('NAME', '(default)')}")
    print(f"Labels   : {', '.join(labels)}")
    print("-" * 60)

    from django.db import connections

    TestRunner = get_runner(settings)
    runner = TestRunner(
        verbosity=args.verbosity,
        interactive=not args.no_interactive,
        keepdb=args.keepdb,
    )
    try:
        failures = runner.run_tests(labels)
    finally:
        connections.close_all()

    if failures:
        print(f"\n❌ {failures} 个测试用例失败")
        sys.exit(1)
    else:
        print("\n✅ 烟测通过")
        sys.exit(0)


if __name__ == "__main__":
    main()
