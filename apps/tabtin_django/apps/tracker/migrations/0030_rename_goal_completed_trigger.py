"""Module C 收尾（2026-05-26）：goal_completed 触发器一刀切改名 tracker_completed。

== 背景 ==

Stage 1 / Stage 2 把 model class + Service 类 + 函数名都改成 Tracker 命名，
但 cascade trigger 链路的两层数据残留没改：

1. ``Tracker.trigger_type`` 枚举值 ``goal_completed`` —— DB 字符串字面量
2. ``Tracker.trigger_config`` JSON 中 ``goal_id`` 键 —— 上游 Tracker ID 引用

本 migration 把这两层数据一刀切改名，与代码层 ``trigger_by_tracker_completed``
+ ``trigger_config["tracker_id"]`` 对齐。产品未上线，无兼容性顾虑。

== 变更 ==

1. ``Tracker.objects.filter(trigger_type='goal_completed').update(trigger_type='tracker_completed')``
2. ``Tracker.objects.filter(trigger_type='tracker_completed')`` 逐条把 ``trigger_config['goal_id']``
   重命名为 ``trigger_config['tracker_id']``（保留其它字段）
3. ``Tracker.trigger_type`` 字段 choices 同步 schema 修改
   （constants.GOAL_TRIGGER_TYPE_CHOICES → TRACKER_TRIGGER_TYPE_CHOICES）

== 双库约束 ==

Tracker model 路由到 ``postgresql`` 库（apps.tracker.db_router）。
RunPython 用 ``schema_editor.connection.alias`` 守卫，仅在 postgresql 库执行
数据迁移；default 库无 Tracker 表，跑 RunPython 是 no-op。

AlterField 由 Django 自动按 router 路由（postgresql 真跑 DDL，default 写
"影子" django_migrations 记录但不动 schema）。

== 回滚 ==

reverse 操作把 ``tracker_completed`` 回滚成 ``goal_completed``，并把
``trigger_config['tracker_id']`` 回滚成 ``goal_id``。
"""

from django.db import migrations, models


def _forward_rename_data(apps, schema_editor):
    """正向：goal_completed → tracker_completed，trigger_config['goal_id'] → ['tracker_id']。"""
    if schema_editor.connection.alias != "postgresql":
        return
    Tracker = apps.get_model("tracker", "Tracker")

    # ── Step 1: trigger_type 字面量改名 ──
    Tracker.objects.using("postgresql").filter(
        trigger_type="goal_completed",
    ).update(trigger_type="tracker_completed")

    # ── Step 2: trigger_config JSON storage key 改名 ──
    # 仅扫描 tracker_completed 类型的 Tracker（其它 trigger_type 不可能有 goal_id 字段）。
    for tracker in Tracker.objects.using("postgresql").filter(
        trigger_type="tracker_completed",
    ):
        cfg = tracker.trigger_config or {}
        if not isinstance(cfg, dict) or "goal_id" not in cfg:
            continue
        cfg["tracker_id"] = cfg.pop("goal_id")
        tracker.trigger_config = cfg
        tracker.save(update_fields=["trigger_config"])


def _reverse_rename_data(apps, schema_editor):
    """反向：tracker_completed → goal_completed，trigger_config['tracker_id'] → ['goal_id']。"""
    if schema_editor.connection.alias != "postgresql":
        return
    Tracker = apps.get_model("tracker", "Tracker")

    for tracker in Tracker.objects.using("postgresql").filter(
        trigger_type="tracker_completed",
    ):
        cfg = tracker.trigger_config or {}
        if not isinstance(cfg, dict) or "tracker_id" not in cfg:
            continue
        cfg["goal_id"] = cfg.pop("tracker_id")
        tracker.trigger_config = cfg
        tracker.save(update_fields=["trigger_config"])

    Tracker.objects.using("postgresql").filter(
        trigger_type="tracker_completed",
    ).update(trigger_type="goal_completed")


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0029_alter_trackerrun_options_and_more"),
    ]

    operations = [
        # 1. 先迁数据再改 schema —— Django 标准做法（避免新 choices 拒绝旧值）。
        migrations.RunPython(_forward_rename_data, _reverse_rename_data),
        # 2. schema 层把 trigger_type choices 同步到新枚举值。
        migrations.AlterField(
            model_name="tracker",
            name="trigger_type",
            field=models.CharField(
                choices=[
                    ("manual", "手动触发"),
                    ("cron", "Cron 表达式"),
                    ("interval", "固定间隔"),
                    ("at", "一次性执行"),
                    ("extension_event", "Extension 事件触发"),
                    ("table_event", "表格事件触发"),
                    ("webhook", "Webhook 入站触发"),
                    ("tracker_completed", "上游 Tracker 完成后触发"),
                ],
                default="manual",
                max_length=32,
                verbose_name="触发类型",
            ),
        ),
    ]
