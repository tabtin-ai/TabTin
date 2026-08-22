from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0098_merge_release_and_sessionshare_v2"),
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
                help_text=(
                    "pending=待投递或待接收方加入；"
                    "active=授权生效；revoked=已停止。"
                ),
                max_length=16,
                verbose_name="共享状态",
            ),
        ),
    ]
