"""
workspace → workteam 重命名迁移（tabtinspace app，PostgreSQL 数据库）

涵盖：
- RenameModel: Workspace/WorkspaceMember/WorkspaceInvitation/WorkspaceActivity
- AlterModelTable: 更新数据库表名
- RenameField: 所有 workspace FK 字段 → workteam，workspace_id → workteam_id
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0014_collection_collectionsection_contextitem_collection"),
        ("tabtinspace", "0014_add_direct_invitation"),
    ]

    operations = [
        # ── Step 1: RenameModel ──────────────────────────────────────────────
        migrations.RenameModel(
            old_name="Workspace",
            new_name="Workteam",
        ),
        migrations.RenameModel(
            old_name="WorkspaceMember",
            new_name="WorkteamMember",
        ),
        migrations.RenameModel(
            old_name="WorkspaceInvitation",
            new_name="WorkteamInvitation",
        ),
        migrations.RenameModel(
            old_name="WorkspaceActivity",
            new_name="WorkteamActivity",
        ),
        # ── Step 2: AlterModelTable（更新数据库表名）────────────────────────
        migrations.AlterModelTable(
            name="workteam",
            table="tabtinspace_workteam",
        ),
        migrations.AlterModelTable(
            name="workteammember",
            table="tabtinspace_workteam_member",
        ),
        migrations.AlterModelTable(
            name="workteaminvitation",
            table="tabtinspace_workteam_invitation",
        ),
        migrations.AlterModelTable(
            name="workteamactivity",
            table="tabtinspace_workteam_activity",
        ),
        # ── Step 3: RenameField FK workspace → workteam ─────────────────────
        migrations.RenameField(
            model_name="workteammember",
            old_name="workspace",
            new_name="workteam",
        ),
        migrations.RenameField(
            model_name="workteaminvitation",
            old_name="workspace",
            new_name="workteam",
        ),
        migrations.RenameField(
            model_name="device",
            old_name="workspace",
            new_name="workteam",
        ),
        migrations.RenameField(
            model_name="securecredential",
            old_name="workspace",
            new_name="workteam",
        ),
        migrations.RenameField(
            model_name="agent",
            old_name="workspace",
            new_name="workteam",
        ),
        migrations.RenameField(
            model_name="space",
            old_name="workspace",
            new_name="workteam",
        ),
        # ── Step 4: RenameField UUIDField workspace_id → workteam_id ────────
        migrations.RenameField(
            model_name="workteamactivity",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="spaceadminactionlog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]
