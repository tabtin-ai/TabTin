"""#3832 钱包表 organization_id 软引用换真 FK（墓碑管线后半程）。

- OrganizationWallet：OneToOne PROTECT（操作数据，清理链负责删）。
- WalletTransaction：FK PROTECT，可空（无法归因的 legacy 流水原空串 → NULL）。

FK 化前清孤儿：孤儿钱包（组织已不存在）连同其流水删除——它们是历史清理
缺口的残渣；流水表自身的孤儿 organization_id 置 NULL 保留（资金流水不删，
挂靠钱包仍在的照常保留）。写法参照 users/membership/0018。
"""
from django.db import migrations, models
import django.db.models.deletion


_ORG_SUBQUERY = "SELECT id::text FROM tabtinspace_organization"

_DATA_FIX_SQL = f"""
DELETE FROM users_wallet_transaction
WHERE organization_wallet_id IN (
    SELECT id FROM users_wallet_organization_wallet
    WHERE organization_id = '' OR organization_id NOT IN ({_ORG_SUBQUERY})
);
DELETE FROM users_wallet_organization_wallet
WHERE organization_id = '' OR organization_id NOT IN ({_ORG_SUBQUERY});
UPDATE users_wallet_transaction SET organization_id = NULL
WHERE organization_id = ''
   OR (organization_id IS NOT NULL AND organization_id NOT IN ({_ORG_SUBQUERY}));
"""

_DROP_PATTERN_OPS_SQL = """
DO $$
DECLARE idx record;
BEGIN
    FOR idx IN
        SELECT indexname FROM pg_indexes
        WHERE tablename IN ('users_wallet_organization_wallet', 'users_wallet_transaction')
          AND indexname LIKE '%_like'
          AND indexdef LIKE '%(organization_id %'
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', idx.indexname);
    END LOOP;
END $$;
"""


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0019_cash_transaction_llm_auto_topup_type"),
        ("tabtinspace", "0093_organization_tombstone_fields_3832"),
    ]

    operations = [
        # WalletTransaction 同样需要保留无法归因的 legacy 流水。先把历史
        # CharField 改为可空，再将孤儿 organization_id 清成 NULL，避免在有
        # 孤儿数据的环境中被旧 NOT NULL 约束拦截。
        migrations.AlterField(
            model_name="wallettransaction",
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
        migrations.RunSQL(sql=_DATA_FIX_SQL, reverse_sql=migrations.RunSQL.noop),
        migrations.RunSQL(sql=_DROP_PATTERN_OPS_SQL, reverse_sql=migrations.RunSQL.noop),
        migrations.RenameField(model_name="organizationwallet", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="organizationwallet",
            name="organization",
            field=models.OneToOneField(
                db_column="organization_id",
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="tabtinspace.organization",
                verbose_name="组织",
            ),
        ),
        migrations.RenameField(model_name="wallettransaction", old_name="organization_id", new_name="organization"),
        migrations.AlterField(
            model_name="wallettransaction",
            name="organization",
            field=models.ForeignKey(
                blank=True,
                db_column="organization_id",
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="+",
                to="tabtinspace.organization",
                verbose_name="组织",
            ),
        ),
    ]
