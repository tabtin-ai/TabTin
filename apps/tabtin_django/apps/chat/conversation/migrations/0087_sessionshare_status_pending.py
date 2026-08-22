from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0086_alter_chatsession_model_param_overrides"),
    ]

    operations = [
        migrations.AlterField(
            model_name="sessionshare",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "待生效"),
                    ("active", "生效中"),
                    ("revoked", "已撤销"),
                ],
                default="active",
                help_text="pending=发卡确认前；active=授权生效；revoked=已停止。",
                max_length=16,
                verbose_name="共享状态",
            ),
        ),
    ]
