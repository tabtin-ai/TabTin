from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0088_sessionshare_card_refresh_status"),
    ]

    operations = [
        migrations.AddField(
            model_name="sessionshareresourcegrant",
            name="granted_permission",
            field=models.CharField(
                choices=[
                    ("viewer", "只读"),
                    ("editor", "可编辑"),
                    ("admin", "管理员"),
                    ("owner", "所有者"),
                ],
                default="viewer",
                help_text="该共享来源要求的资源权限；由 SessionShare 权限档位派生。",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="sessionshareresourcegrant",
            name="independent_permission",
            field=models.CharField(
                blank=True,
                choices=[
                    ("viewer", "只读"),
                    ("editor", "可编辑"),
                    ("admin", "管理员"),
                    ("owner", "所有者"),
                ],
                help_text="共享来源之外已确认的资源权限，用于撤销后恢复而非一律失活。",
                max_length=16,
                null=True,
            ),
        ),
    ]
