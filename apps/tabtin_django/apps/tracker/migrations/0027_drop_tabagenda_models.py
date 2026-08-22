"""Tracker 模块收敛波次 1（2026-05-20）：删除 tabagenda 三表 + Goal.event_type 字段。

== 背景 ==

波次 1：彻底砍掉 tabagenda（日程）模块——日历功能未来独立立项重做，不再混在
Tracker 里。本次产品未上线，无任何数据兼容性顾虑，直接 DROP TABLE + drop column。

== DROP ==

- `scheduler_goal_agenda_meta`（GoalAgendaMeta）—— 日历元数据 1:1 扩展表
- `scheduler_goal_attendee`（GoalAttendee）—— 事件参与者
- `scheduler_goal_reminder_delivery`（GoalReminderDelivery）—— 提醒幂等记录
- `goal.event_type` column —— Tracker 不再区分 agent_task / event 两种语义，
  所有 Goal 都是 agent_task（即 Tracker）

== 依赖 ==

scheduler 0026 是上一次（chat_session UUID 软引用）的终点。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0026_goal_run_chat_session_to_uuid_softref"),
    ]

    operations = [
        # 1. drop 三个 tabagenda 专用 model
        migrations.DeleteModel(name="GoalReminderDelivery"),
        migrations.DeleteModel(name="GoalAttendee"),
        migrations.DeleteModel(name="GoalAgendaMeta"),
        # 2. drop Goal.event_type 字段
        migrations.RemoveField(
            model_name="goal",
            name="event_type",
        ),
    ]
