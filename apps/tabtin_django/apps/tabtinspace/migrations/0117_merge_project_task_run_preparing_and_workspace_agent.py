# 合并 Project Task Run preparing 状态与 Workspace.agent 退役链。
# 两条链分别由交付物工作流和 Workspace 终态迁移引入，无 schema 操作。

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0106_project_task_run_preparing'),
        ('tabtinspace', '0116_remove_workspace_agent_6198'),
    ]

    operations = []
