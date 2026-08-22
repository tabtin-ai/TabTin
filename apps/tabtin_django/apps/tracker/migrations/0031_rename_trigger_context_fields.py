"""Module D 收尾（2026-05-26）：TrackerRun.trigger_context 存量数据字段改名。

== 背景 ==

Module C migration 0030 改了 ``Tracker.trigger_config['goal_id']`` →
``['tracker_id']``（trigger 配置），但**漏迁** ``TrackerRun.trigger_context``
JSONB 中的：

- ``source: "goal_completed"`` → ``source: "tracker_completed"``
- ``completed_goal_id`` → ``completed_tracker_id``

这两个字段在 Module C 已经一刀切到 ``tracker_completed`` / ``completed_tracker_id``
代码层，但**存量 TrackerRun 数据**还含旧字段值——历史 Run 注入 LLM 时（通过
``context-injector``）会看到老字段名，造成 wire format 内部不一致。

Module D 补这一笔，与代码层完全对齐。

== 变更 ==

1. ``TrackerRun.objects.filter(trigger_context__source='goal_completed')`` 逐条把：
   - ``trigger_context['source']`` 改 ``'tracker_completed'``
   - ``trigger_context['completed_goal_id']`` rename ``'completed_tracker_id'``

== 双库约束 ==

TrackerRun 路由到 ``postgresql``（apps.tracker.db_router）。
RunPython 用 ``schema_editor.connection.alias`` 守卫，仅 PG 跑数据。

== 回滚 ==

reverse 完整对称：``tracker_completed`` → ``goal_completed`` +
``completed_tracker_id`` → ``completed_goal_id``。
"""

from django.db import migrations


def _forward(apps, schema_editor):
    """正向：trigger_context.source goal_completed → tracker_completed, completed_goal_id → completed_tracker_id。"""
    if schema_editor.connection.alias != "postgresql":
        return
    TrackerRun = apps.get_model("tracker", "TrackerRun")

    # JSONField 在 PG 上可以用 `__contains` 查询，但为了兼容性这里全表扫
    # （Tracker run 数量级在 dev/prod 通常 < 1M，全表扫一次性数据迁移可接受）
    for run in TrackerRun.objects.using("postgresql").iterator(chunk_size=500):
        ctx = run.trigger_context or {}
        if not isinstance(ctx, dict):
            continue
        changed = False
        if ctx.get("source") == "goal_completed":
            ctx["source"] = "tracker_completed"
            changed = True
        if "completed_goal_id" in ctx:
            ctx["completed_tracker_id"] = ctx.pop("completed_goal_id")
            changed = True
        if changed:
            run.trigger_context = ctx
            run.save(update_fields=["trigger_context"])


def _reverse(apps, schema_editor):
    """反向：tracker_completed → goal_completed, completed_tracker_id → completed_goal_id。"""
    if schema_editor.connection.alias != "postgresql":
        return
    TrackerRun = apps.get_model("tracker", "TrackerRun")

    for run in TrackerRun.objects.using("postgresql").iterator(chunk_size=500):
        ctx = run.trigger_context or {}
        if not isinstance(ctx, dict):
            continue
        changed = False
        if ctx.get("source") == "tracker_completed":
            ctx["source"] = "goal_completed"
            changed = True
        if "completed_tracker_id" in ctx:
            ctx["completed_goal_id"] = ctx.pop("completed_tracker_id")
            changed = True
        if changed:
            run.trigger_context = ctx
            run.save(update_fields=["trigger_context"])


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0030_rename_goal_completed_trigger"),
    ]

    operations = [
        migrations.RunPython(_forward, _reverse),
    ]
