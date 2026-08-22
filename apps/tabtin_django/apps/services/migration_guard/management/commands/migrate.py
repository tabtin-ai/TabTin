"""migrate —— Tabtin wrapper，拦截直接 migrate，引导用 safe_migrate。

为什么 override 内置 migrate：
- TabTin 是 MySQL+PG 双库架构，靠 router 决定每个 app 落哪个库。
- 跑 default 时，router 会拦掉 PG-only app 的 DDL 执行，**但 MigrationRecorder
  仍在 default 的 django_migrations 表写"applied"影子记录**——这是 Django 设计
  上跨 app 依赖图（``check_consistent_history``）的必需机制，不是 bug。
- 直接跑 ``python manage.py migrate``（不带 ``--database=postgresql``）会让
  default 假落账、PG 真实数据/schema 完全没动。事后看 django_migrations 像是
  "已 applied"，但 PG 缺失。这种漂移历史上踩过 ≥2 次（最近一次是 yolo PR3 的
  0049 数据迁移卡在 default 假落账，导致 2 个 Agent 的 ``yolo_mode`` 字段没
  改名为 ``allow_yolo_mode``）。
- ``safe_migrate`` 已实现 default → postgresql 顺序双库跑 + 跑后自检；本
  wrapper 默认拒绝原生 migrate，强制走 safe_migrate。

逃生口（按使用频次倒序）：

1. **safe_migrate 内部调本命令** —— 通过环境变量
   ``_TABTIN_SAFE_MIGRATE_INVOKED=1`` 标记上层是 safe_migrate，wrapper 直接
   放行调 Django 原始 migrate（不递归拦截）。
2. **测试上下文** —— 检测到 ``pytest`` 已在 ``sys.modules`` 中，或
   ``manage.py test`` 正在运行。测试 runner 会调 ``call_command('migrate', ...)``
   创建 test DB，自动放行。test DB 是临时库（``test_*`` 前缀），跟生产
   default/postgresql 完全隔离，没有"假落账"风险（schema 用完即弃）。
3. **CI / 单库故障修复** —— 加 ``--allow-unsafe`` 显式承认；命令仍会跑，但顶部
   打 WARNING。

INSTALLED_APPS 里 ``migration_guard`` 在 LOCAL_APPS 末尾——按 Django
management command discovery 规则（后注册的 app 同名命令覆盖前面），本命令
会 override ``django.core.management.commands.migrate``。
"""

from __future__ import annotations

import os
import sys

from django.core.management.base import CommandError
from django.core.management.commands.migrate import Command as DjangoMigrateCommand


SAFE_MIGRATE_ENV = "_TABTIN_SAFE_MIGRATE_INVOKED"


class Command(DjangoMigrateCommand):
    help = (
        "（Tabtin wrapper）双库架构禁止直接跑 migrate；"
        "请用 `python manage.py safe_migrate`。极少数情况下加 --allow-unsafe 放行。"
    )

    def add_arguments(self, parser):
        super().add_arguments(parser)
        parser.add_argument(
            "--allow-unsafe",
            action="store_true",
            help=(
                "显式承认想跑原生 Django migrate，跳过 safe_migrate 拦截。"
                "仅适用于 CI / 测试 / 单库故障修复等明确知道单库目标的场景。"
            ),
        )

    def handle(self, *args, **options):
        if os.environ.get(SAFE_MIGRATE_ENV) == "1":
            options.pop("allow_unsafe", None)
            return super().handle(*args, **options)

        # 测试上下文（pytest-django / Django test runner 创建临时 test DB）自动放行：
        # test DB 是 'test_*' 前缀的临时库，跟生产 default/postgresql 完全隔离。
        if "pytest" in sys.modules or "test" in sys.argv:
            options.pop("allow_unsafe", None)
            return super().handle(*args, **options)

        if options.pop("allow_unsafe", False):
            self.stdout.write(
                self.style.WARNING(
                    "⚠️  跳过 safe_migrate 拦截（--allow-unsafe）；"
                    "请确认本次操作只针对单库且你了解 default 假落账风险。"
                )
            )
            return super().handle(*args, **options)

        raise CommandError(
            "TabTin 是 MySQL+PG 双库架构，禁止直接跑 `python manage.py migrate`——\n"
            "否则 default 库会写'假落账' applied 记录但 PG 真实数据/schema 不变，造成漂移。\n\n"
            "请改用：\n"
            "  python manage.py safe_migrate           # 按 default → postgresql 双库跑 + 跑后自检\n"
            "  bash scripts/backend/migrate-all.sh     # 同上的脚本入口\n"
            "  bash scripts/migrate-check.sh           # 只检查双库一致性，不写库\n\n"
            "如果你确实需要原生 migrate（CI / 测试 / 单库故障修复），加 --allow-unsafe 显式承认。\n"
            "详见 docs/agent/commands.md `双库迁移` 章节。"
        )
