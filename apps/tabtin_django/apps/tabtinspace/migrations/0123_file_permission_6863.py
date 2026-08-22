"""#6863：云盘裸文件 FilePermission 资源级 ACL。"""

import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("tabtinspace", "0122_workspace_custom_rules_execution_limits_6903"),
    ]

    operations = [
        migrations.CreateModel(
            name="FilePermission",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                (
                    "subject_type",
                    models.CharField(
                        choices=[("user", "User"), ("role", "Role"), ("agent", "Agent")],
                        max_length=20,
                        verbose_name="权限主体类型",
                    ),
                ),
                ("subject_id", models.CharField(max_length=64, verbose_name="权限主体 ID")),
                (
                    "permission",
                    models.CharField(
                        choices=[
                            ("viewer", "Viewer"),
                            ("editor", "Editor"),
                            ("admin", "Admin"),
                            ("owner", "Owner"),
                        ],
                        default="viewer",
                        max_length=20,
                        verbose_name="权限级别",
                    ),
                ),
                ("is_active", models.BooleanField(default=True, verbose_name="是否生效")),
                (
                    "granted_by",
                    models.CharField(blank=True, default="", max_length=64, verbose_name="授权人 ID"),
                ),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "file_record_id",
                    models.UUIDField(
                        db_index=True,
                        help_text="对应 services_oss_file_record.id / ContextItem.resource_id（item_type=tabfiles）",
                        verbose_name="OSS FileRecord ID",
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="tabfiles_permissions_created",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="授权创建者",
                    ),
                ),
            ],
            options={
                "verbose_name": "云盘文件权限",
                "verbose_name_plural": "云盘文件权限",
                "db_table": "tabtinspace_file_permission",
            },
        ),
        migrations.AddConstraint(
            model_name="filepermission",
            constraint=models.UniqueConstraint(
                fields=("file_record_id", "subject_type", "subject_id"),
                name="tabfiles_perm_unique_subject",
            ),
        ),
        migrations.AddIndex(
            model_name="filepermission",
            index=models.Index(
                fields=["file_record_id", "is_active"],
                name="tabfiles_perm_file_active_idx",
            ),
        ),
        migrations.AddIndex(
            model_name="filepermission",
            index=models.Index(
                fields=["subject_type", "subject_id"],
                name="tabfiles_perm_subject_idx",
            ),
        ),
    ]
