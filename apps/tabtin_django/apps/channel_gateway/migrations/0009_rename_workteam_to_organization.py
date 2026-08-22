"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('channel_gateway', '0008_converge_execution_agent_id'),
    ]

    operations = [
        migrations.RenameField(model_name='channelbinding', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='channelaccount', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='channelruntimestatus', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='channelinboundmessagelog', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='channeloutboundmessagerecord', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='channelallowlistentry', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='channelpairingrequest', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameIndex(model_name='channelbinding', old_name='cg_bind_workteam_idx', new_name='cg_bind_organization_idx'),
        migrations.RenameIndex(model_name='channelaccount', old_name='cg_account_workteam_idx', new_name='cg_account_organization_idx'),
        migrations.RenameIndex(model_name='channelruntimestatus', old_name='cg_runtime_workteam_idx', new_name='cg_runtime_organization_idx'),
        migrations.RenameIndex(model_name='channelinboundmessagelog', old_name='cg_inbound_workteam_idx', new_name='cg_inbound_organization_idx'),
        migrations.RenameIndex(model_name='channeloutboundmessagerecord', old_name='cg_outbox_workteam_idx', new_name='cg_outbox_organization_idx'),
        migrations.RenameIndex(model_name='channelallowlistentry', old_name='cg_allow_workteam_idx', new_name='cg_allow_organization_idx'),
        migrations.RenameIndex(model_name='channelpairingrequest', old_name='cg_pair_workteam_status_idx', new_name='cg_pair_organization_st_idx'),
    ]
