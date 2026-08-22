"""#3832 billing 操作数据表 organization_id 软引用换真 FK（墓碑管线后半程）。

拍板口径：
- 操作数据（OrganizationLifecycleCleanupService 清理链负责删的表）换
  ``on_delete=PROTECT`` 真 FK——墓碑管线保证子行先于组织行消失，PROTECT
  仅作误删兜底；不用 CASCADE 避免大表级联删回同步事务。
- 审计/对账/清理作业记录类（BillingAdminAuditLog / BillingReconciliationReport /
  BillingAnomalyAlert / OrganizationLifecycleCleanupJob / OrganizationCreditLedger /
  BillingDispute）保持软引用，规范例外（组织删除后仍需查账），见 models.py 注释。

迁移写法参照 users/membership/0018（varchar→uuid 原地转换 + pattern-ops
索引动态清理）。FK 化前先清存量孤儿：
- 可空表（BillingUsageEvent）空串/孤儿 → NULL；
- 非空表孤儿行直接删除（组织已不存在，配置/快照/权益行无意义）；
- MeterPricing 特殊：scope=organization 的孤儿/空串行删除（置 NULL 会把
  组织专属定价误变全局定价），scope=global 的空串 → NULL。
"""
from django.db import migrations, models
import django.db.models.deletion


_ORG_SUBQUERY = "SELECT id::text FROM tabtinspace_organization"

# (table, mode)；mode: "null"=孤儿/空串置 NULL, "delete"=孤儿行删除
_DATA_FIX = [
    ("services_billing_usage_event", "null"),
    ("services_billing_organization_storage_usage", "delete"),
    ("services_billing_organization_policy", "delete"),
    ("services_billing_organization_entitlement", "delete"),
    ("services_billing_organization_storage_subscription", "delete"),
    ("services_billing_organization_addon_entitlement", "delete"),
    ("services_billing_organization_llm_monthly_budget", "delete"),
    ("services_billing_usage_daily", "delete"),
    ("services_billing_budget_policy", "delete"),
    ("services_billing_organization_service_policy", "delete"),
    ("services_billing_member_llm_budget_policy", "delete"),
    ("services_billing_member_usage_counter", "delete"),
]

_ALL_FK_TABLES = [
    "services_billing_meter_pricing",
    "services_billing_usage_event",
    "services_billing_organization_storage_usage",
    "services_billing_organization_policy",
    "services_billing_organization_entitlement",
    "services_billing_organization_storage_subscription",
    "services_billing_organization_addon_entitlement",
    "services_billing_organization_llm_monthly_budget",
    "services_billing_usage_daily",
    "services_billing_invoice",
    "services_billing_invoice_line",
    "services_billing_budget_policy",
    "services_billing_organization_service_policy",
    "services_billing_member_llm_budget_policy",
    "services_billing_member_usage_counter",
]


def _build_data_fix_sql() -> str:
    stmts = []
    # MeterPricing：organization 专属定价的孤儿/空串行删除；global 空串 → NULL。
    stmts.append(
        "DELETE FROM services_billing_meter_pricing "
        "WHERE scope = 'organization' AND (organization_id IS NULL "
        f"OR organization_id = '' OR organization_id NOT IN ({_ORG_SUBQUERY}));"
    )
    stmts.append(
        "UPDATE services_billing_meter_pricing SET organization_id = NULL "
        f"WHERE organization_id = '' OR (organization_id IS NOT NULL "
        f"AND organization_id NOT IN ({_ORG_SUBQUERY}));"
    )
    # 账单明细先于账单删除（invoice FK DB 级 NO ACTION 会拦截）。
    stmts.append(
        "DELETE FROM services_billing_invoice_line "
        f"WHERE (organization_id <> '' AND organization_id NOT IN ({_ORG_SUBQUERY})) "
        "OR organization_id = '' "
        "OR invoice_id IN (SELECT id FROM services_billing_invoice "
        f"WHERE organization_id = '' OR organization_id NOT IN ({_ORG_SUBQUERY}));"
    )
    stmts.append(
        "DELETE FROM services_billing_invoice "
        f"WHERE organization_id = '' OR organization_id NOT IN ({_ORG_SUBQUERY});"
    )
    for table, mode in _DATA_FIX:
        if mode == "null":
            stmts.append(
                f"UPDATE {table} SET organization_id = NULL "
                f"WHERE organization_id = '' "
                f"OR (organization_id IS NOT NULL AND organization_id NOT IN ({_ORG_SUBQUERY}));"
            )
        else:
            stmts.append(
                f"DELETE FROM {table} "
                f"WHERE organization_id = '' OR organization_id NOT IN ({_ORG_SUBQUERY});"
            )
    return "\n".join(stmts)


def _build_drop_pattern_ops_sql() -> str:
    """删除不接受 uuid 列的 varchar pattern-ops（*_like）辅助索引。"""
    tables_sql = ", ".join(f"'{table}'" for table in _ALL_FK_TABLES)
    return f"""
    DO $$
    DECLARE idx record;
    BEGIN
        FOR idx IN
            SELECT indexname FROM pg_indexes
            WHERE tablename IN ({tables_sql})
              AND indexname LIKE '%_like'
              AND indexdef LIKE '%(organization_id %'
        LOOP
            EXECUTE format('DROP INDEX IF EXISTS %I', idx.indexname);
        END LOOP;
    END $$;
    """


def _fk(*, null: bool = False, one_to_one: bool = False, help_text: str = ""):
    kwargs = dict(
        db_column="organization_id",
        on_delete=django.db.models.deletion.PROTECT,
        related_name="+",
        to="tabtinspace.organization",
        verbose_name="组织",
    )
    if null:
        kwargs.update(blank=True, null=True)
    if help_text:
        kwargs["help_text"] = help_text
    if one_to_one:
        return models.OneToOneField(**kwargs)
    return models.ForeignKey(**kwargs)


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0038_auto_topup_yuan_fields"),
        ("tabtinspace", "0093_organization_tombstone_fields_3832"),
    ]

    operations = [
        # BillingUsageEvent 的历史 CharField 是 NOT NULL。数据清理会把无法归因的
        # legacy 事件置为 NULL，因此必须先解除数据库约束，再执行 UPDATE；否则
        # PostgreSQL 会在字段转换为可空 FK 之前直接拒绝清理 SQL。
        migrations.AlterField(
            model_name="billingusageevent",
            name="organization_id",
            field=models.CharField(
                blank=True,
                db_index=True,
                default="",
                max_length=100,
                null=True,
                verbose_name="组织ID",
            ),
        ),
        migrations.RunSQL(sql=_build_data_fix_sql(), reverse_sql=migrations.RunSQL.noop),
        migrations.RunSQL(sql=_build_drop_pattern_ops_sql(), reverse_sql=migrations.RunSQL.noop),
        migrations.RemoveIndex(
            model_name="organizationstorageusage",
            name="services_bi_organiz_580fb6_idx",
        ),
        migrations.RenameField(model_name="meterpricing", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="meterpricing",
            name="organization",
            field=_fk(
                null=True,
                help_text="scope=organization 时的专属定价主体；global 定价为 NULL。",
            ),
        ),
        migrations.RenameField(model_name="billingusageevent", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="billingusageevent",
            name="organization",
            field=_fk(
                null=True,
                help_text="计费主体；极少数无法归因的 legacy 事件为 NULL（原空串语义）。",
            ),
        ),
        migrations.RenameField(model_name="organizationstorageusage", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationstorageusage",
            name="organization",
            field=_fk(one_to_one=True),
        ),
        migrations.RenameField(model_name="organizationbillingpolicy", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationbillingpolicy",
            name="organization",
            field=_fk(one_to_one=True),
        ),
        migrations.RenameField(model_name="organizationbillingentitlement", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationbillingentitlement",
            name="organization",
            field=_fk(one_to_one=True),
        ),
        migrations.RenameField(model_name="organizationstoragesubscription", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationstoragesubscription",
            name="organization",
            field=_fk(),
        ),
        migrations.RenameField(model_name="organizationaddonentitlement", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationaddonentitlement",
            name="organization",
            field=_fk(),
        ),
        migrations.RenameField(model_name="organizationllmmonthlybudget", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationllmmonthlybudget",
            name="organization",
            field=_fk(),
        ),
        migrations.RenameField(model_name="billingusagedaily", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="billingusagedaily",
            name="organization",
            field=_fk(),
        ),
        migrations.RenameField(model_name="billinginvoice", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="billinginvoice",
            name="organization",
            field=_fk(),
        ),
        migrations.RenameField(model_name="billinginvoiceline", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="billinginvoiceline",
            name="organization",
            field=_fk(),
        ),
        migrations.RenameField(model_name="billingbudgetpolicy", old_name="organization_id", new_name="organization"),
        migrations.AlterModelOptions(
            name="billingbudgetpolicy",
            options={
                "ordering": ["organization"],
                "verbose_name": "用量预算策略",
                "verbose_name_plural": "用量预算策略",
            },
        ),
        migrations.AlterField(
            model_name="billingbudgetpolicy",
            name="organization",
            field=_fk(one_to_one=True),
        ),
        migrations.RenameField(model_name="organizationservicepolicy", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationservicepolicy",
            name="organization",
            field=_fk(one_to_one=True),
        ),
        migrations.RenameField(model_name="memberllmbudgetpolicy", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="memberllmbudgetpolicy",
            name="organization",
            field=_fk(),
        ),
        migrations.RenameField(model_name="memberllmusagecounter", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="memberllmusagecounter",
            name="organization",
            field=_fk(),
        ),
    ]
