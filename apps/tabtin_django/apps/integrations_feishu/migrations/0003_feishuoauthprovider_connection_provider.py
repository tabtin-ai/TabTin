from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid

import apps.extensions.fields


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("integrations_feishu", "0002_feishuimportjob_documents"),
        ("tabtinspace", "0138_merge_20260803_1125"),
    ]

    operations = [
        migrations.CreateModel(
            name="FeishuOAuthProvider",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("app_id", models.CharField(max_length=255)),
                ("credentials", apps.extensions.fields.EncryptedJSONField(default=dict)),
                ("secret_fingerprint", models.CharField(editable=False, max_length=64)),
                (
                    "credential_version",
                    models.PositiveBigIntegerField(default=1, editable=False),
                ),
                ("tenant_key", models.CharField(blank=True, default="", max_length=255)),
                (
                    "status",
                    models.CharField(
                        choices=[("active", "已验证"), ("invalid", "验证失败")],
                        db_index=True,
                        default="active",
                        max_length=32,
                    ),
                ),
                ("verified_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_feishu_oauth_providers",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "organization",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="feishu_oauth_provider",
                        to="tabtinspace.organization",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="updated_feishu_oauth_providers",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={"db_table": "integrations_feishu_oauth_provider"},
        ),
        migrations.AddField(
            model_name="feishuoauthconnection",
            name="provider",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="connections",
                to="integrations_feishu.feishuoauthprovider",
            ),
        ),
    ]
