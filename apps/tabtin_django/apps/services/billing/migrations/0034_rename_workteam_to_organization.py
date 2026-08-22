"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations, models


def _update_enum_values(apps, schema_editor, forward=True):
    """存量枚举值 'workteam' <-> 'organization'（prelaunch 一次到位，见 RENAME-SPEC §0.2）。"""
    old, new = ("workteam", "organization") if forward else ("organization", "workteam")
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            "UPDATE services_billing_meter_pricing SET scope = %s WHERE scope = %s", [new, old]
        )


def _forward_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=True)


def _reverse_enum_values(apps, schema_editor):
    _update_enum_values(apps, schema_editor, forward=False)


def _ensure_organization_credit_ledger_table(apps, schema_editor):
    """Create the target ledger table without altering the admin-owned legacy table."""
    if schema_editor.connection.vendor != "postgresql":
        return

    old_table = "services_billing_workteam_credit_ledger"
    new_table = "services_billing_organization_credit_ledger"
    columns = [
        "id",
        "organization_id",
        "user_id",
        "ledger_type",
        "amount_points",
        "balance_after_points",
        "related_usage_event_id",
        "related_billing_event_id",
        "related_wallet_transaction_id",
        "related_order_id",
        "related_invoice_id",
        "operator_admin_account_id",
        "operator_user_id",
        "reason",
        "ticket_id",
        "metadata_json",
        "created_at",
    ]
    old_select_columns = [
        "id",
        "workteam_id",
        "user_id",
        "ledger_type",
        "amount_points",
        "balance_after_points",
        "related_usage_event_id",
        "related_billing_event_id",
        "related_wallet_transaction_id",
        "related_order_id",
        "related_invoice_id",
        "operator_admin_account_id",
        "operator_user_id",
        "reason",
        "ticket_id",
        "metadata_json",
        "created_at",
    ]

    with schema_editor.connection.cursor() as cursor:
        cursor.execute("SELECT to_regclass(%s), to_regclass(%s)", [new_table, old_table])
        new_exists, old_exists = cursor.fetchone()
        if not old_exists:
            return

        qn = schema_editor.quote_name
        if not new_exists:
            cursor.execute(
                f"CREATE TABLE {qn(new_table)} "
                f"(LIKE {qn(old_table)} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)"
            )
            cursor.execute(
                f"ALTER TABLE {qn(new_table)} "
                f"RENAME COLUMN {qn('workteam_id')} TO {qn('organization_id')}"
            )
        cursor.execute(
            f"INSERT INTO {qn(new_table)} ({', '.join(qn(c) for c in columns)}) "
            f"SELECT {', '.join(qn(c) for c in old_select_columns)} FROM {qn(old_table)} "
            f"ON CONFLICT ({qn('id')}) DO NOTHING"
        )


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0033_rename_services_bi_worktea_5df6e4_idx_services_bi_worktea_e8831e_idx_and_more'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunPython(_ensure_organization_credit_ledger_table, migrations.RunPython.noop),
            ],
            state_operations=[
                migrations.RenameModel(old_name='WorkteamCreditLedger', new_name='OrganizationCreditLedger'),
            ],
        ),
        migrations.RenameModel(old_name='WorkteamStorageUsage', new_name='OrganizationStorageUsage'),
        migrations.RenameModel(old_name='WorkteamBillingPolicy', new_name='OrganizationBillingPolicy'),
        migrations.RenameModel(old_name='WorkteamBillingEntitlement', new_name='OrganizationBillingEntitlement'),
        migrations.RenameModel(old_name='WorkteamStorageSubscription', new_name='OrganizationStorageSubscription'),
        migrations.RenameModel(old_name='WorkteamAddonEntitlement', new_name='OrganizationAddonEntitlement'),
        migrations.RenameModel(old_name='WorkteamLlmMonthlyBudget', new_name='OrganizationLlmMonthlyBudget'),
        migrations.RenameModel(old_name='WorkteamLifecycleCleanupJob', new_name='OrganizationLifecycleCleanupJob'),
        migrations.RenameModel(old_name='WorkteamServicePolicy', new_name='OrganizationServicePolicy'),
        migrations.RemoveConstraint(model_name='billingdispute', name='uniq_billing_dispute_tx_workteam'),
        migrations.RenameField(model_name='meterpricing', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billingusageevent', old_name='workteam_id', new_name='organization_id'),
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.RenameField(
                    model_name='organizationcreditledger',
                    old_name='workteam_id',
                    new_name='organization_id',
                ),
            ],
        ),
        migrations.RenameField(model_name='organizationstorageusage', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='organizationbillingpolicy', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='organizationbillingentitlement', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='organizationstoragesubscription', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='organizationaddonentitlement', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='organizationllmmonthlybudget', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billingusagedaily', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billinginvoice', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billinginvoiceline', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billingbudgetpolicy', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billingadminauditlog', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='organizationlifecyclecleanupjob', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billingreconciliationreport', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='organizationservicepolicy', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billinganomalyalert', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='memberllmbudgetpolicy', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='memberllmusagecounter', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='billingdispute', old_name='workteam_id', new_name='organization_id'),
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterModelTable(
                    name='organizationcreditledger',
                    table='services_billing_organization_credit_ledger',
                ),
            ],
        ),
        migrations.AlterModelTable(name='organizationstorageusage', table='services_billing_organization_storage_usage'),
        migrations.AlterModelTable(name='organizationbillingpolicy', table='services_billing_organization_policy'),
        migrations.AlterModelTable(name='organizationbillingentitlement', table='services_billing_organization_entitlement'),
        migrations.AlterModelTable(name='organizationstoragesubscription', table='services_billing_organization_storage_subscription'),
        migrations.AlterModelTable(name='organizationaddonentitlement', table='services_billing_organization_addon_entitlement'),
        migrations.AlterModelTable(name='organizationllmmonthlybudget', table='services_billing_organization_llm_monthly_budget'),
        migrations.AlterModelTable(name='organizationlifecyclecleanupjob', table='services_billing_organization_lifecycle_cleanup_job'),
        migrations.AlterModelTable(name='organizationservicepolicy', table='services_billing_organization_service_policy'),
        migrations.AddConstraint(model_name='billingdispute', constraint=models.UniqueConstraint(fields=['transaction_id', 'organization_id'], name='uniq_billing_dispute_tx_organization')),
        migrations.RunPython(_forward_enum_values, _reverse_enum_values),
    ]
