"""
workspace → workteam 重命名迁移（billing app，MySQL 数据库）

涵盖：
- RenameModel: WorkspaceStorageUsage/WorkspaceLlmMonthlyBudget/WorkspaceBillingPolicy/
               WorkspaceBillingEntitlement/WorkspaceStorageSubscription/WorkspaceLifecycleCleanupJob
- RenameField: 所有模型的 workspace_id → workteam_id
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0006_add_budget_limit_credits"),
    ]

    operations = [
        # ── Step 1: RenameModel ──────────────────────────────────────────────
        migrations.RenameModel(
            old_name="WorkspaceStorageUsage",
            new_name="WorkteamStorageUsage",
        ),
        migrations.RenameModel(
            old_name="WorkspaceLlmMonthlyBudget",
            new_name="WorkteamLlmMonthlyBudget",
        ),
        migrations.RenameModel(
            old_name="WorkspaceBillingPolicy",
            new_name="WorkteamBillingPolicy",
        ),
        migrations.RenameModel(
            old_name="WorkspaceBillingEntitlement",
            new_name="WorkteamBillingEntitlement",
        ),
        migrations.RenameModel(
            old_name="WorkspaceStorageSubscription",
            new_name="WorkteamStorageSubscription",
        ),
        migrations.RenameModel(
            old_name="WorkspaceLifecycleCleanupJob",
            new_name="WorkteamLifecycleCleanupJob",
        ),
        # ── Step 2: RenameField workspace_id → workteam_id ──────────────────
        # 未重命名的模型
        migrations.RenameField(
            model_name="billinginvoice",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="billinginvoiceline",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="billingusageevent",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="billingusagedaily",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="meterpricing",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="billingbudgetpolicy",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="billingadminauditlog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="billingreconciliationreport",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="billinganomalyalert",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        # 已重命名的模型（使用新名）
        migrations.RenameField(
            model_name="workteamstorageusage",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="workteamllmmonthlybudget",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="workteambillingpolicy",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="workteambillingentitlement",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="workteamstoragesubscription",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="workteamlifecyclecleanupjob",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]
