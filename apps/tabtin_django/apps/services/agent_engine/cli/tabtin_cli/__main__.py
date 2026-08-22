"""``python -m apps.services.agent_engine.cli.tabtin_cli`` 入口。

Django 必须先初始化（auditing / 执行前 verify / HITL stub 都依赖 Django ORM）。
本模块在 ``main()`` 内部按需 ``django.setup()``，避免 import 副作用。
"""

from __future__ import annotations

import sys

from apps.services.agent_engine.cli.tabtin_cli.cli import main


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
