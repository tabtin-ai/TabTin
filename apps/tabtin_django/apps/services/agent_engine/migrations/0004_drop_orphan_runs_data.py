"""W12 决策 3：清空 SubtaskRun / ExecutionRun 存量

Agent 执行已经全部迁到客户端 runtime（@tabtin/agent-runtime），
Django 侧不再有生产路径写入这两张表，6 个相关 cleanup Celery task
也已随本 Wave 一并移除。这里对存量历史做一次性清空，防止表无限增长。

模型本身保留——``SubtaskRun`` 仍被 collab 回滚、``ExecutionRun`` 仍被
``RunService.get_latest_run`` / scheduler 取消流程读取，删表会破坏
这些读路径的优雅降级（read-empty → 返回 None）。
"""

from __future__ import annotations

from django.db import migrations


def _drop_data(apps, schema_editor):
    # 用当前迁移自身的连接 alias，而非硬编码 'postgresql'：single_pg 下迁移跑在
    # 'default'(PG)，硬编码 'postgresql' 会无谓开第二条连接（同一物理库）。
    alias = schema_editor.connection.alias
    SubtaskRun = apps.get_model("agent_engine", "SubtaskRun")
    ExecutionRun = apps.get_model("agent_engine", "ExecutionRun")
    for model in (SubtaskRun, ExecutionRun):
        try:
            model.objects.using(alias).all().delete()
        except Exception:
            # 若表因历史原因不存在于当前环境（例如未执行过 0001 migration），
            # 无需阻塞：后续 runserver / migrate 会按 0001 正常建表，
            # 新建表里本就没有存量。
            pass


def _noop_reverse(apps, schema_editor):
    # 清空操作不可逆——存量仅为历史记录，回滚无需恢复。
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0003_cli_audit_workteam_domain_verb_indexes"),
    ]

    operations = [
        migrations.RunPython(_drop_data, _noop_reverse),
    ]
