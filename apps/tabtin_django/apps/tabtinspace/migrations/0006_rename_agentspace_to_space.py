# Phase 2A: AgentSpace → Space model rename
# db_table stays the same, so all model renames are state-only.
# Field renames with explicit db_column are also state-only.

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0005_contextitem_cleanup_fail_count"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        # Ensure all migrations referencing AgentSpace are applied BEFORE renaming
        ("tracker", "0008_goalstep_model_preference_choices"),
        ("conversation", "0005_chatglobalconfig_engine_context_guard_features"),
    ]

    operations = [
        # ── Phase 1: State-only model renames (same db_table) ──
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RenameModel("AgentSpace", "Space"),
                migrations.RenameModel("AgentSpaceAppSettings", "SpaceAppSettings"),
                migrations.RenameModel("AgentSpaceMembership", "SpaceMembership"),
                migrations.RenameModel("AgentSpacePermission", "SpacePermission"),
                migrations.RenameModel("AgentSpaceShare", "SpaceShare"),
            ],
            database_operations=[],
        ),

        # ── Phase 2: Drop old constraints/indexes before field renames ──
        migrations.AlterUniqueTogether(
            name="spacemembership", unique_together=set(),
        ),
        migrations.AlterUniqueTogether(
            name="spaceappsettings", unique_together=set(),
        ),
        # Drop old indexes that reference renamed fields
        migrations.RemoveIndex(model_name="contextitem", name="ctx_item_as_type_idx"),
        migrations.RemoveIndex(model_name="contextitem", name="ctx_item_as_archived_idx"),
        migrations.RemoveIndex(model_name="contextitem", name="ctx_item_as_order_idx"),
        migrations.RemoveIndex(model_name="delegationgrant", name="ctx_dg_as_status_idx"),
        migrations.RemoveIndex(model_name="spaceadminactionlog", name="ctx_admin_as_time_idx"),
        # SpaceMembership old indexes
        migrations.RemoveIndex(model_name="spacemembership", name="ctx_asm_as_role_idx"),
        migrations.RemoveIndex(model_name="spacemembership", name="ctx_asm_agent_joined_idx"),
        # SpaceAppSettings old indexes
        migrations.RemoveIndex(model_name="spaceappsettings", name="ctx_as_app_user_idx"),
        # SpacePermission old indexes + constraint
        migrations.RemoveConstraint(model_name="spacepermission", name="ctx_asp_unique_subject"),
        migrations.RemoveIndex(model_name="spacepermission", name="ctx_asp_as_active_idx"),
        migrations.RemoveIndex(model_name="spacepermission", name="ctx_asp_subject_idx"),
        # SpaceShare old indexes
        migrations.RemoveIndex(model_name="spaceshare", name="ctx_ass_as_status_idx"),
        migrations.RemoveIndex(model_name="spaceshare", name="ctx_ass_to_status_idx"),

        # ── Phase 3: State-only field renames (db_column preserves old name) ──
        # RenameField alone doesn't set db_column, so we also AlterField to fix column mapping.
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RenameField("contextitem", "agent_space", "space"),
                migrations.AlterField(
                    model_name="contextitem", name="space",
                    field=models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="context_items", to="tabtinspace.space",
                        verbose_name="所属 Space", db_column="agent_space_id",
                    ),
                ),
                migrations.RenameField("spacepermission", "agent_space", "space"),
                migrations.AlterField(
                    model_name="spacepermission", name="space",
                    field=models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="permissions", to="tabtinspace.space",
                        db_column="agent_space_id",
                    ),
                ),
                migrations.RenameField("spaceadminactionlog", "agent_space_id", "space_id"),
                migrations.AlterField(
                    model_name="spaceadminactionlog", name="space_id",
                    field=models.UUIDField(
                        blank=True, db_column="agent_space_id", db_index=True,
                        null=True, verbose_name="Space ID",
                    ),
                ),
                migrations.RenameField("workspace", "agent_space_count", "space_count"),
                migrations.AlterField(
                    model_name="workspace", name="space_count",
                    field=models.IntegerField(
                        db_column="agent_space_count", default=0,
                        help_text="由 signal 维护的非规范化计数，实际数以 Space 查询为准。",
                        verbose_name="Space 数量",
                    ),
                ),
            ],
            database_operations=[],
        ),

        # ── Phase 4: Real field renames (column name changes in DB) ──
        migrations.RenameField("delegationgrant", "agent_space", "space"),
        migrations.RenameField("spacemembership", "agent_space", "space"),
        migrations.RenameField("spaceappsettings", "agent_space", "space"),
        migrations.RenameField("spaceshare", "agent_space", "space"),

        # ── Phase 5: Add genuinely new fields ──
        # Space: type, last_activity_at
        migrations.AddField(
            model_name="space",
            name="type",
            field=models.CharField(
                choices=[("bot", "Bot"), ("group", "Group"), ("dm", "DM"), ("team", "Team")],
                default="bot", max_length=20, verbose_name="Space 类型",
            ),
        ),
        migrations.AddField(
            model_name="space",
            name="last_activity_at",
            field=models.DateTimeField(
                blank=True, db_index=True, null=True,
                help_text="由各子系统通过信号统一更新，用于列表排序",
                verbose_name="最后活跃时间",
            ),
        ),
        # Agent: fields moved from Space (deprecated there, new on Agent)
        migrations.AddField(
            model_name="agent",
            name="persona_prompt",
            field=models.TextField(
                blank=True, default="",
                help_text='自定义 Agent 身份描述，如"你是一个资深前端工程师"。',
                verbose_name="身份设定",
            ),
        ),
        migrations.AddField(
            model_name="agent",
            name="custom_rules",
            field=models.TextField(blank=True, default="", verbose_name="自定义规则"),
        ),
        migrations.AddField(
            model_name="agent",
            name="goal",
            field=models.TextField(blank=True, default="", verbose_name="Agent 目标"),
        ),
        migrations.AddField(
            model_name="agent",
            name="keywords",
            field=models.JSONField(default=list, verbose_name="关键词列表"),
        ),
        migrations.AddField(
            model_name="agent",
            name="tags",
            field=models.JSONField(default=list, verbose_name="标签"),
        ),
        migrations.AddField(
            model_name="agent",
            name="crawl_config",
            field=models.JSONField(default=dict, verbose_name="抓取配置"),
        ),
        migrations.AddField(
            model_name="agent",
            name="agent_config",
            field=models.JSONField(default=dict, verbose_name="Agent 安全配置"),
        ),
        migrations.AddField(
            model_name="agent",
            name="bound_device",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name="bound_agents", to="tabtinspace.device",
                verbose_name="绑定设备",
            ),
        ),
        # SpaceMembership: user FK (new)
        migrations.AddField(
            model_name="spacemembership",
            name="user",
            field=models.ForeignKey(
                blank=True, db_constraint=False, null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name="space_memberships",
                to=settings.AUTH_USER_MODEL, verbose_name="User 身份",
            ),
        ),

        # ── Phase 6: AlterField for changed choices/options ──
        migrations.AlterField(
            model_name="space",
            name="status",
            field=models.CharField(
                choices=[
                    ("active", "进行中"), ("paused", "暂停"), ("completed", "已完成"),
                    ("archived", "已归档"), ("trashed", "已删除"),
                ],
                default="active", max_length=20, verbose_name="状态",
            ),
        ),
        migrations.AlterField(
            model_name="agent",
            name="type",
            field=models.CharField(
                choices=[("human", "人类"), ("system", "系统"), ("bot", "AI 助手")],
                default="human", max_length=20, verbose_name="Agent 类型",
            ),
        ),
        migrations.AlterField(
            model_name="spaceadminactionlog",
            name="action_type",
            field=models.CharField(
                choices=[
                    ("workspace_create", "创建工作空间"), ("workspace_update", "更新工作空间"),
                    ("workspace_delete", "删除工作空间"), ("space_create", "创建 Space"),
                    ("space_update", "更新 Space"), ("space_archive", "归档 Space"),
                    ("space_restore", "恢复 Space"), ("space_delete", "删除 Space"),
                    ("member_add", "添加成员"), ("member_remove", "移除成员"),
                    ("member_role_change", "变更成员角色"), ("invitation_create", "创建邀请"),
                    ("invitation_accept", "接受邀请"), ("invitation_cancel", "取消邀请"),
                    ("ownership_transfer", "转让所有权"), ("permission_grant", "授予权限"),
                    ("permission_revoke", "撤销权限"), ("resource_create", "创建资源"),
                    ("resource_update", "更新资源"), ("resource_delete", "删除资源"),
                    ("resource_share", "共享资源"), ("user_delete_cleanup", "用户删除跨库清理"),
                ],
                db_index=True, max_length=64, verbose_name="动作类型",
            ),
        ),
        migrations.AlterField(
            model_name="spaceadminactionlog",
            name="target_type",
            field=models.CharField(
                choices=[
                    ("workspace", "工作空间"), ("space", "协作空间"), ("member", "成员"),
                    ("invitation", "邀请"), ("table", "表格"), ("document", "文档"),
                    ("slide", "幻灯片"), ("permission", "权限"), ("user", "用户"),
                ],
                db_index=True, max_length=32, verbose_name="目标类型",
            ),
        ),

        # ── Phase 7: Recreate indexes with new names ──
        # ContextItem
        migrations.AddIndex(
            model_name="contextitem",
            index=models.Index(fields=["space", "item_type"], name="ctx_item_space_type_idx"),
        ),
        migrations.AddIndex(
            model_name="contextitem",
            index=models.Index(fields=["space", "is_archived"], name="ctx_item_space_archived_idx"),
        ),
        migrations.AddIndex(
            model_name="contextitem",
            index=models.Index(fields=["space", "order"], name="ctx_item_space_order_idx"),
        ),
        # DelegationGrant
        migrations.AddIndex(
            model_name="delegationgrant",
            index=models.Index(fields=["space", "status"], name="ctx_dg_space_status_idx"),
        ),
        # SpaceAdminActionLog
        migrations.AddIndex(
            model_name="spaceadminactionlog",
            index=models.Index(fields=["space_id", "created_at"], name="ctx_admin_space_time_idx"),
        ),
        # SpaceMembership
        migrations.AddIndex(
            model_name="spacemembership",
            index=models.Index(fields=["space", "role"], name="ctx_sm_space_role_idx"),
        ),
        migrations.AddIndex(
            model_name="spacemembership",
            index=models.Index(fields=["agent", "joined_at"], name="ctx_sm_agent_joined_idx"),
        ),
        migrations.AddIndex(
            model_name="spacemembership",
            index=models.Index(fields=["user", "joined_at"], name="ctx_sm_user_joined_idx"),
        ),
        migrations.AddConstraint(
            model_name="spacemembership",
            constraint=models.CheckConstraint(
                check=models.Q(
                    models.Q(("agent__isnull", False), ("user__isnull", True)),
                    models.Q(("agent__isnull", True), ("user__isnull", False)),
                    _connector="OR",
                ),
                name="ctx_sm_one_identity",
            ),
        ),
        # SpaceAppSettings
        migrations.AddIndex(
            model_name="spaceappsettings",
            index=models.Index(fields=["space", "user"], name="ctx_space_app_user_idx"),
        ),
        migrations.AlterUniqueTogether(
            name="spaceappsettings", unique_together={("space", "user")},
        ),
        # SpacePermission
        migrations.AddIndex(
            model_name="spacepermission",
            index=models.Index(fields=["space", "is_active"], name="ctx_sp_space_active_idx"),
        ),
        migrations.AddIndex(
            model_name="spacepermission",
            index=models.Index(fields=["subject_type", "subject_id"], name="ctx_sp_subject_idx"),
        ),
        migrations.AddConstraint(
            model_name="spacepermission",
            constraint=models.UniqueConstraint(
                fields=("space", "subject_type", "subject_id"), name="ctx_sp_unique_subject",
            ),
        ),
        # SpaceShare
        migrations.AddIndex(
            model_name="spaceshare",
            index=models.Index(fields=["space", "status"], name="ctx_ss_space_status_idx"),
        ),
        migrations.AddIndex(
            model_name="spaceshare",
            index=models.Index(fields=["to_agent", "status"], name="ctx_ss_to_status_idx"),
        ),
        # Space: new indexes
        migrations.AddIndex(
            model_name="space",
            index=models.Index(fields=["workspace", "type"], name="ctx_space_ws_type_idx"),
        ),
        migrations.AddIndex(
            model_name="space",
            index=models.Index(fields=["workspace", "last_activity_at"], name="ctx_space_ws_activity_idx"),
        ),
    ]
