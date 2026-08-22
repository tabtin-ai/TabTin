"""
workspace → workteam 重命名迁移（channel_gateway app，MySQL 数据库）

涵盖：
- RenameField: 所有模型的 workspace_id → workteam_id
- RenameIndex: workspace 索引 → workteam 索引
- AlterUniqueTogether: 更新唯一约束
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("channel_gateway", "0004_alter_channelaccount_config"),
    ]

    operations = [
        # ── RenameField ────────────────────────────────────────────────
        migrations.RenameField(
            model_name="channelbinding",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="channelaccount",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="channelruntimestatus",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="channelinboundmessagelog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="channeloutboundmessagerecord",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="channelallowlistentry",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="channelpairingrequest",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        # ── RenameIndex ────────────────────────────────────────────────
        migrations.RenameIndex(
            model_name="channelbinding",
            old_name="cg_bind_workspace_idx",
            new_name="cg_bind_workteam_idx",
        ),
        migrations.RenameIndex(
            model_name="channelaccount",
            old_name="cg_account_workspace_idx",
            new_name="cg_account_workteam_idx",
        ),
        migrations.RenameIndex(
            model_name="channelruntimestatus",
            old_name="cg_runtime_workspace_idx",
            new_name="cg_runtime_workteam_idx",
        ),
        migrations.RenameIndex(
            model_name="channelinboundmessagelog",
            old_name="cg_inbound_workspace_idx",
            new_name="cg_inbound_workteam_idx",
        ),
        migrations.RenameIndex(
            model_name="channeloutboundmessagerecord",
            old_name="cg_outbox_workspace_idx",
            new_name="cg_outbox_workteam_idx",
        ),
        migrations.RenameIndex(
            model_name="channelallowlistentry",
            old_name="cg_allow_workspace_idx",
            new_name="cg_allow_workteam_idx",
        ),
        migrations.RenameIndex(
            model_name="channelpairingrequest",
            old_name="cg_pair_workspace_status_idx",
            new_name="cg_pair_workteam_status_idx",
        ),
        # ── AlterUniqueTogether ────────────────────────────────────────
        migrations.AlterUniqueTogether(
            name="channelbinding",
            unique_together={("channel", "account_id", "peer_id", "workteam_id")},
        ),
        migrations.AlterUniqueTogether(
            name="channelaccount",
            unique_together={("channel", "account_id", "workteam_id")},
        ),
        migrations.AlterUniqueTogether(
            name="channelruntimestatus",
            unique_together={("channel", "account_id", "workteam_id")},
        ),
        migrations.AlterUniqueTogether(
            name="channelinboundmessagelog",
            unique_together={("channel", "account_id", "workteam_id", "peer_id", "message_id")},
        ),
    ]
