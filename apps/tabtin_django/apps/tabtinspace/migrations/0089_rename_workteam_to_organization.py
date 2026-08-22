"""
workteam → organization 重命名迁移（tabtinspace app，）

参照 0015_workspace_to_workteam_rename 的反向套路：
- RenameModel: Workteam/WorkteamControlPolicy/WorkteamMember/WorkteamAppInstall/
  WorkteamInvitation/WorkteamActivity → Organization*
- RenameField: 同 app 内 workteam FK → organization，workteam_id → organization_id
- AlterModelTable: tabtinspace_workteam* → tabtinspace_organization*

历史索引/约束名（ctx_mcp_workteam_name_unique、ctx_wai_workteam_app_unique、
ctx_wm_workspace_role_idx 等）按 RENAME-SPEC §3.4 保持原名，不追加改名 SQL。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0088_merge_device_admin_governance_project_workspace'),
        # 以下历史迁移的 RunPython 用 apps.get_model('tabtinspace','Workteam') 或按
        # workteam 字段查询本 app 模型。历史迁移不可改，这里反向 pin 依赖，保证全新库/
        # 测试库重放时它们先于本 RenameModel 执行（否则历史 registry 已无 Workteam）。
        ('tabchat', '0013_backfill_team_space_default_channels'),
        ('wallet', '0011_retire_user_wallet'),
        ('tabdata', '0040_tablewebhook_workteam_id_alter_tablewebhook_space_id_and_more'),
    ]

    operations = [
        # ── Step 1: RenameModel ──────────────────────────────────────────────
        migrations.RenameModel(
            old_name='Workteam',
            new_name='Organization',
        ),
        migrations.RenameModel(
            old_name='WorkteamControlPolicy',
            new_name='OrganizationControlPolicy',
        ),
        migrations.RenameModel(
            old_name='WorkteamMember',
            new_name='OrganizationMember',
        ),
        migrations.RenameModel(
            old_name='WorkteamAppInstall',
            new_name='OrganizationAppInstall',
        ),
        migrations.RenameModel(
            old_name='WorkteamInvitation',
            new_name='OrganizationInvitation',
        ),
        migrations.RenameModel(
            old_name='WorkteamActivity',
            new_name='OrganizationActivity',
        ),
        # ── Step 2: RenameField FK workteam → organization ──────────────────
        migrations.RenameField(
            model_name='organizationcontrolpolicy',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='organizationmember',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='device',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='securecredential',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='mcpconnection',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='agent',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='space',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='organizationappinstall',
            old_name='workteam',
            new_name='organization',
        ),
        migrations.RenameField(
            model_name='organizationinvitation',
            old_name='workteam',
            new_name='organization',
        ),
        # ── Step 3: RenameField UUIDField workteam_id → organization_id ─────
        migrations.RenameField(
            model_name='deviceappinstallsnapshot',
            old_name='workteam_id',
            new_name='organization_id',
        ),
        migrations.RenameField(
            model_name='organizationactivity',
            old_name='workteam_id',
            new_name='organization_id',
        ),
        migrations.RenameField(
            model_name='spaceadminactionlog',
            old_name='workteam_id',
            new_name='organization_id',
        ),
        migrations.RenameField(
            model_name='spaceactivityevent',
            old_name='workteam_id',
            new_name='organization_id',
        ),
        # ── Step 4: AlterModelTable（更新数据库表名）────────────────────────
        migrations.AlterModelTable(
            name='organization',
            table='tabtinspace_organization',
        ),
        migrations.AlterModelTable(
            name='organizationcontrolpolicy',
            table='tabtinspace_organization_control_policy',
        ),
        migrations.AlterModelTable(
            name='organizationmember',
            table='tabtinspace_organization_member',
        ),
        migrations.AlterModelTable(
            name='organizationappinstall',
            table='tabtinspace_organization_app_install',
        ),
        migrations.AlterModelTable(
            name='organizationinvitation',
            table='tabtinspace_organization_invitation',
        ),
        migrations.AlterModelTable(
            name='organizationactivity',
            table='tabtinspace_organization_activity',
        ),
    ]
