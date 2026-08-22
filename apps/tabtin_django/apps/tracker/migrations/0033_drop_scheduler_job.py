"""Drop ScheduledJob / ScheduledJobRun（2026-05-28）。

将 ``table_automation`` 子系统整体收编进 ``Tracker.trigger_type='table_event'`` —
ScheduledJob model + scheduler_job / scheduler_job_run 两张表全部下线，
相关 service / executor / dispatch / Celery 任务一并删除。

产品未上线，无数据归档（``scheduler_job`` / ``scheduler_job_run`` 两表
里的存量行直接随表 drop）。后续 ``Tracker.trigger_type='table_event'``
通过 EventBus（``tabdata.record.*``）+ ``trigger_by_table_event`` 接管。

依赖：``0032_tracker_soft_delete_archived``（同事 TS-6 软删，archived_at +
status=archived；本 migration 不碰 Tracker / TrackerRun，仅 drop ScheduledJob）。

数据库路由：``tracker`` app 走 ``postgresql`` alias（见 ``apps/tracker/db_router.py``）。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0032_tracker_soft_delete_archived"),
    ]

    operations = [
        migrations.DeleteModel(name="ScheduledJobRun"),
        migrations.DeleteModel(name="ScheduledJob"),
        # 兜底：若历史 migration 在某些环境下没把 DB 表清掉（state 与 schema
        # 不一致），显式 DROP；reverse 留空（产品未上线，不支持回滚）。
        migrations.RunSQL(
            sql=(
                "DROP TABLE IF EXISTS scheduler_job_run CASCADE; "
                "DROP TABLE IF EXISTS scheduler_job CASCADE;"
            ),
            reverse_sql=migrations.RunSQL.noop,
        ),
    ]
