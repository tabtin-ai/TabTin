# Wave 5c T1：UserOnboardingState — 首次引导（PRD Story 1）跨设备状态。
#
# 与 SaveBlacklistEntry 同库（MySQL default），表名 credential_vault_onboarding_state。
# user_id 作 PK：一行一用户，onboarding 状态是个人级的。
from __future__ import annotations

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("credential_vault", "0005_user_credential_last_used_at"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="UserOnboardingState",
            fields=[
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        primary_key=True,
                        related_name="onboarding_state",
                        serialize=False,
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
                (
                    "onboarding_dismissed_at",
                    models.DateTimeField(blank=True, null=True),
                ),
                (
                    "browser_import_completed_at",
                    models.DateTimeField(blank=True, null=True),
                ),
                (
                    "browser_import_source",
                    models.CharField(blank=True, default="", max_length=32),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "credential_vault_onboarding_state",
            },
        ),
    ]
