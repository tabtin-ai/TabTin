# Generated for W7 / P1-1 — 跨库告警事件兜底持久化表 EventOutbox。
"""新增 ``package_registry_event_outbox`` 表持久化 emit 失败的告警事件,
由 ``process_event_outbox`` Celery 周期任务扫描重试,实现自愈闭环。

涉及 3 个事件:
- ``pkg.package.reverted_sync_failed``(_sync_managed_skill_version_pointer 失败)
- ``pkg.skill.upsert_failed``(_upsert_managed_skill_from_finalize 失败)
- ``pkg.gc.scheduling_failed``(_schedule_pr_gc 失败)

迁移命令:
    python manage.py migrate package_registry --database=postgresql
"""
import uuid

import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("package_registry", "0003_packageversion_init_files"),
    ]

    operations = [
        migrations.CreateModel(
            name="EventOutbox",
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
                ("event_type", models.CharField(db_index=True, max_length=128)),
                ("workteam_id", models.CharField(blank=True, default="", max_length=64)),
                ("payload", models.JSONField(default=dict)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("pending", "Pending"),
                            ("processing", "Processing"),
                            ("done", "Done"),
                            ("dead", "Dead"),
                        ],
                        default="pending",
                        max_length=16,
                    ),
                ),
                ("retry_count", models.IntegerField(default=0)),
                ("max_retries", models.IntegerField(default=5)),
                (
                    "next_retry_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("last_error", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "package_registry_event_outbox",
                "ordering": ["-created_at"],
                "indexes": [
                    models.Index(
                        fields=["status", "next_retry_at"],
                        name="pkg_outbox_status_retry_idx",
                    ),
                    models.Index(
                        fields=["event_type"],
                        name="pkg_outbox_event_type_idx",
                    ),
                ],
            },
        ),
    ]
