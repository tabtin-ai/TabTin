# Wave 3 G5：SaveBlacklistEntry — "不为此网站保存"黑名单（PD-8 后端持久化）
#
# 与 UserCredential 同库（MySQL default），表名 credential_vault_save_blacklist。
# unique(user, domain) 保证同一用户对同一 domain 只有一条记录。
from __future__ import annotations

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("credential_vault", "0003_add_app_login_category"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="SaveBlacklistEntry",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                (
                    "domain",
                    models.CharField(
                        help_text=(
                            "完整域名（小写、去前导点），如 google.com / login.example.com"
                        ),
                        max_length=253,
                    ),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "user",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="save_blacklist_entries",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "db_table": "credential_vault_save_blacklist",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="saveblacklistentry",
            index=models.Index(
                fields=["user", "domain"],
                name="cred_save_bl_user_domain_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="saveblacklistentry",
            constraint=models.UniqueConstraint(
                fields=["user", "domain"],
                name="uq_save_blacklist_user_domain",
            ),
        ),
    ]
