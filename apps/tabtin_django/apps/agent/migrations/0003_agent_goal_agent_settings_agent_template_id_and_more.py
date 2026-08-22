from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("agent", "0002_restore_agent_indexes"),
    ]

    operations = [
        migrations.AddField(
            model_name="agent",
            name="template_id",
            field=models.CharField(
                blank=True,
                default="",
                help_text="平台 Agent 模板 slug；空字符串表示用户自建 Agent。",
                max_length=64,
                verbose_name="来源模板 ID",
            ),
        ),
        migrations.AddField(
            model_name="agent",
            name="template_version",
            field=models.CharField(
                blank=True,
                default="",
                help_text="实例化时冻结的模板版本，仅用于溯源。",
                max_length=32,
                verbose_name="来源模板版本",
            ),
        ),
    ]
