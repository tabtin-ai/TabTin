# ：合并双 0104 分叉。
#
# - 0104_project_real_table_3266 → … → 0111（本 PR Space 退役链）
# - 0104_workspace_home_per_organization（release  HOME 唯一约束）
# 二者同挂 0103，无 merge 时 makemigrations 会报多 leaf。本迁移无 schema 变更。

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0104_workspace_home_per_organization'),
        ('tabtinspace', '0111_backfill_workspace_agent_3266'),
    ]

    operations = []
