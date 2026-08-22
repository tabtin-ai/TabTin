"""TS-6 + TS-15：Tracker 软删（归档）支持。

== 背景 ==

删除 Tracker 历史是物理硬删（``TrackerService.delete_tracker`` 调
``tracker.delete()``），而 ``TrackerRun.tracker`` 外键 ``on_delete=CASCADE`` →
删 Tracker 时所有 TrackerRun 运行历史被物理删除。这与 models.py TrackerRun
「运行历史是审计资产，独立保留不连带删」的注释自相矛盾（TS-15）。

改为软删：删除即归档（``status='archived'`` + ``archived_at``），保留全部
TrackerRun 审计历史与其 ``chat_session_id``。

== 变更 ==

1. 新增 ``Tracker.archived_at``（DateTimeField, null=True）—— 归档时间戳。
2. ``Tracker.status`` choices 新增 ``archived``（已归档）。

两项都是纯 schema 变更，无数据迁移（存量 Tracker 的 archived_at 默认 NULL，
status 不变）。

== 双库约束 ==

Tracker 路由到 ``postgresql``（apps.tracker.db_router）。本迁移仅 DDL，
真实 DDL 须用 ``bash scripts/backend/migrate-all.sh`` / ``safe_migrate`` 在主线执行
（带 ``--database=postgresql``），不能只跑裸 ``migrate``（详见 backend-django.mdc）。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0031_rename_trigger_context_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="tracker",
            name="archived_at",
            field=models.DateTimeField(
                blank=True,
                help_text="软删（归档）时间。NULL 表示未归档；非 NULL 即 status=archived 的归档时刻（TS-6）。",
                null=True,
                verbose_name="归档时间",
            ),
        ),
        migrations.AlterField(
            model_name="tracker",
            name="status",
            field=models.CharField(
                choices=[
                    ("draft", "草案"),
                    ("active", "已激活"),
                    ("paused", "已暂停"),
                    ("disabled", "已禁用"),
                    ("archived", "已归档"),
                ],
                default="draft",
                max_length=16,
                verbose_name="Tracker 状态",
            ),
        ),
    ]
