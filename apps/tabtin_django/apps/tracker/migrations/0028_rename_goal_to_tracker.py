"""Tracker 模块改名波次 3a（2026-05-20）：Goal/GoalRun → Tracker/TrackerRun。

== 背景 ==

Tracker 模块收敛 plan §波次 3a：把 model class 名与 DB 表名统一到产品名 Tracker。

== 变更 ==

1. model class rename:
   - ``Goal`` → ``Tracker``
   - ``GoalRun`` → ``TrackerRun``

2. ``TrackerRun.goal`` ForeignKey 字段 → ``tracker``（对应 column ``goal_id`` → ``tracker_id``）

3. DB table rename:
   - ``goal`` → ``tracker``
   - ``goal_run`` → ``tracker_run``

4. 反向 related_name 同步：
   - ``Tracker.workteam.related_name`` ``goals`` → ``trackers``
   - ``Tracker.space.related_name`` ``goals`` → ``trackers``
   - ``Tracker.agent.related_name`` ``goals`` → ``trackers``
   - ``Tracker.created_by.related_name`` ``created_goals`` → ``created_trackers``

== 不在本 migration 范围 ==

- Django ``app_label`` 当时仍是 ``scheduler``（INSTALLED_APPS / db_router /
  migration deps 不动）—— 已在后续波次 3b 完成改名，现 app_label=``tracker``
- ``ScheduledJob`` / ``ScheduledJobRun`` 不动（独立子系统）
- 历史 HTTP 路径命名遗留、Celery queue ``scheduler_agent``、WS topic
  历史 legacy WS topic 不动 —— 波次 4

== 依赖 ==

scheduler 0027 是上一次（drop tabagenda）的终点。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0027_drop_tabagenda_models"),
    ]

    operations = [
        # 1. rename model class
        migrations.RenameModel(old_name="Goal", new_name="Tracker"),
        migrations.RenameModel(old_name="GoalRun", new_name="TrackerRun"),
        # 2. rename ForeignKey field on TrackerRun: goal → tracker
        #    DB column 自动从 goal_id 变成 tracker_id（Django RenameField 标准行为）
        migrations.RenameField(
            model_name="TrackerRun",
            old_name="goal",
            new_name="tracker",
        ),
        # 3. rename DB tables: goal → tracker, goal_run → tracker_run
        migrations.AlterModelTable(name="Tracker", table="tracker"),
        migrations.AlterModelTable(name="TrackerRun", table="tracker_run"),
    ]
