from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabmemo", "0022_alter_memorecordstyle_enabled_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="memo",
            name="agent_id",
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text="Agent 层记忆归属。task_summary 可作为来源线索，diary 必填。",
                null=True,
                verbose_name="关联 Agent",
            ),
        ),
        migrations.AlterField(
            model_name="memo",
            name="memo_type",
            field=models.CharField(
                choices=[
                    ("note", "笔记"),
                    ("bookmark", "书签"),
                    ("about_you", "关于你"),
                    ("insight", "洞察"),
                    ("task_summary", "任务摘要"),
                    ("diary", "工作日记"),
                ],
                db_index=True,
                default="note",
                help_text="碎片类型: note/bookmark/about_you/insight/task_summary/diary",
                max_length=30,
                verbose_name="碎片类型",
            ),
        ),
        migrations.AddIndex(
            model_name="memo",
            index=models.Index(
                condition=models.Q(agent_id__isnull=False),
                fields=["organization_id", "agent_id", "memo_type", "status", "-created_at"],
                name="tm_org_agent_type_status_idx",
            ),
        ),
    ]
