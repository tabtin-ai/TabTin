from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("integrations_feishu", "0003_feishuoauthprovider_connection_provider"),
    ]

    operations = [
        migrations.AlterField(
            model_name="feishuoauthconnection",
            name="status",
            field=models.CharField(
                choices=[
                    ("connected", "已连接"),
                    ("revoked", "已撤销"),
                    ("reauthorization_required", "需重新授权"),
                ],
                db_index=True,
                default="connected",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="feishuoauthconnection",
            name="credential_version",
            field=models.PositiveBigIntegerField(blank=True, editable=False, null=True),
        ),
        migrations.AddField(
            model_name="feishuoauthconnection",
            name="granted_scopes",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="feishuoauthconnection",
            name="refresh_token_expires_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
