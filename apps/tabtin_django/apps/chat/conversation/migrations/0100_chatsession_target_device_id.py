from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0098_merge_20260811_1945"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatsession",
            name="target_device_id",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Daemon Control 设备 ID；创建会话后冻结，空值沿用 Workspace 绑定路由。",
                max_length=64,
                verbose_name="目标设备 ID",
            ),
        ),
        migrations.AddField(
            model_name="chatsession",
            name="target_device_installation_id",
            field=models.CharField(
                blank=True,
                default="",
                help_text="Daemon Control 解析出的 Gateway 路由 ID；仅供 Django 定向投递。",
                max_length=255,
                verbose_name="目标设备安装 ID",
            ),
        ),
    ]
