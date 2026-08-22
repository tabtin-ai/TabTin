import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("users_auth", "0019_keep_only_super_admin_system_role"),
        ("tabtinspace", "0082_backfill_team_space_tabdoc_assets"),
    ]

    operations = [
        migrations.CreateModel(
            name="WorkteamControlPolicy",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("is_suspended", models.BooleanField(db_index=True, default=False, verbose_name="是否暂停团队")),
                ("is_readonly", models.BooleanField(db_index=True, default=False, verbose_name="是否只读")),
                ("ai_disabled", models.BooleanField(db_index=True, default=False, verbose_name="是否禁用 AI")),
                ("resource_write_disabled", models.BooleanField(db_index=True, default=False, verbose_name="是否禁用资源写入")),
                ("app_tool_disabled", models.BooleanField(db_index=True, default=False, verbose_name="是否禁用 App/Tool")),
                ("invite_disabled", models.BooleanField(db_index=True, default=False, verbose_name="是否禁用邀请")),
                ("member_join_disabled", models.BooleanField(db_index=True, default=False, verbose_name="是否禁用成员加入")),
                ("reason_snapshot", models.CharField(blank=True, default="", max_length=500, verbose_name="最近控制原因")),
                ("metadata_json", models.JSONField(blank=True, default=dict, verbose_name="扩展元数据")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                (
                    "updated_by_admin_account",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="updated_workteam_control_policies",
                        to="users_auth.adminaccount",
                        verbose_name="最近更新后台账号",
                    ),
                ),
                (
                    "workteam",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="control_policy",
                        to="tabtinspace.workteam",
                        verbose_name="工作团队",
                    ),
                ),
            ],
            options={
                "verbose_name": "Workteam 控制策略",
                "verbose_name_plural": "Workteam 控制策略",
                "db_table": "tabtinspace_workteam_control_policy",
            },
        ),
        migrations.AddIndex(
            model_name="workteamcontrolpolicy",
            index=models.Index(fields=["workteam", "updated_at"], name="ctx_wtcp_wt_updated_idx"),
        ),
    ]
