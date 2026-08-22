from django.db import migrations, models
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("tabslide", "0003_add_trash_fields"),
    ]

    operations = [
        migrations.CreateModel(
            name="SlideAdminActionLog",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "action_type",
                    models.CharField(
                        choices=[
                            ("batch_archive", "批量归档"),
                            ("batch_restore", "批量恢复"),
                            ("single_archive", "单文稿归档"),
                            ("single_restore", "单文稿恢复"),
                        ],
                        db_index=True,
                        max_length=64,
                        verbose_name="动作类型",
                    ),
                ),
                (
                    "operator_id",
                    models.UUIDField(blank=True, db_index=True, null=True, verbose_name="操作人 ID"),
                ),
                (
                    "operator_name",
                    models.CharField(blank=True, default="", max_length=255, verbose_name="操作人展示名"),
                ),
                (
                    "target_slide_ids",
                    models.JSONField(default=list, help_text="治理动作影响的演示文稿 ID 列表", verbose_name="目标演示文稿 ID 列表"),
                ),
                (
                    "target_slide_ids_text",
                    models.TextField(
                        blank=True,
                        default="",
                        help_text="格式: |slide_id_1|slide_id_2|，用于模糊检索",
                        verbose_name="目标演示文稿检索文本",
                    ),
                ),
                ("requested_count", models.PositiveIntegerField(default=0, verbose_name="请求总数")),
                ("updated_count", models.PositiveIntegerField(default=0, verbose_name="成功处理数")),
                ("skipped_count", models.PositiveIntegerField(default=0, verbose_name="跳过数")),
                ("dry_run", models.BooleanField(default=False, verbose_name="是否 dry-run")),
                ("success", models.BooleanField(db_index=True, default=True, verbose_name="是否成功")),
                ("result_message", models.TextField(blank=True, default="", verbose_name="结果信息")),
                ("error_message", models.TextField(blank=True, default="", verbose_name="错误信息")),
                ("request_payload", models.JSONField(default=dict, verbose_name="请求快照")),
                ("result_payload", models.JSONField(default=dict, verbose_name="结果快照")),
                (
                    "trace_id",
                    models.CharField(blank=True, db_index=True, default="", max_length=128, verbose_name="链路追踪 ID"),
                ),
                ("ip_address", models.GenericIPAddressField(blank=True, null=True, verbose_name="IP 地址")),
                ("user_agent", models.TextField(blank=True, default="", verbose_name="User-Agent")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
            ],
            options={
                "verbose_name": "演示文稿后台治理动作日志",
                "verbose_name_plural": "演示文稿后台治理动作日志",
                "db_table": "tabslide_admin_action_log",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="slideadminactionlog",
            index=models.Index(fields=["action_type", "created_at"], name="slideadm_action_created_idx"),
        ),
        migrations.AddIndex(
            model_name="slideadminactionlog",
            index=models.Index(fields=["operator_id", "created_at"], name="slideadm_operator_created_idx"),
        ),
        migrations.AddIndex(
            model_name="slideadminactionlog",
            index=models.Index(fields=["success", "created_at"], name="slideadm_success_created_idx"),
        ),
        migrations.AddIndex(
            model_name="slideadminactionlog",
            index=models.Index(fields=["dry_run", "created_at"], name="slideadm_dryrun_created_idx"),
        ),
    ]
