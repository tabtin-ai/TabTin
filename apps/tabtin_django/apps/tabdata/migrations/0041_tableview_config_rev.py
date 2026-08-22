"""TableView.config_rev：视图配置单调版本号，用于协作回退防护。

== 背景 ==

多维表视图配置（filters/sorts/groups/config/列显隐等）在 Y.Doc / PostgreSQL /
前端 store 三个来源间同步。协作重连或快照合并时，config_rev 更低的旧快照可能把
客户端刚写入的新配置覆盖回退（「设置分层后回退」、「编辑视图配置后回退」）。

本迁移新增 ``config_rev`` 整数列（默认 0）。每次配置维度写入时 +1，
collab-live 合并与 collab_service 持久化按单调性拒绝更低版本覆盖。

== 步骤 ==

新增 ``config_rev`` IntegerField(default=0)。纯加列、有默认值、无需回填，
对现有大表安全（不锁表读、无长事务）。
"""
from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdata", "0040_tablewebhook_workteam_id_alter_tablewebhook_space_id_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="tableview",
            name="config_rev",
            field=models.IntegerField(default=0, verbose_name="视图配置版本号"),
        ),
    ]
