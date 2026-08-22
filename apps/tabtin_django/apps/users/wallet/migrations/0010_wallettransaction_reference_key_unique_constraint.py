"""
P1-02: WalletTransaction.reference_key 添加唯一约束（MySQL 8.0 兼容方案）

三步操作：
1. 将现有空字符串 '' 更新为 NULL（MySQL 允许 UNIQUE INDEX 中多个 NULL 共存）
2. 修改字段定义为 null=True, blank=True, default=None
3. 移除冗余非唯一索引，添加 (transaction_type, reference_key) 唯一约束

上线前注意：
- 先检查是否有重复的 (transaction_type, reference_key) 非空组合
  SELECT transaction_type, reference_key, COUNT(*)
  FROM users_wallet_transaction
  WHERE reference_key IS NOT NULL AND reference_key != ''
  GROUP BY transaction_type, reference_key HAVING COUNT(*) > 1;
- 若存在重复，需手动清理后再执行本 migration
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0009_alter_wallettransaction_reference_key_and_more"),
    ]

    operations = [
        # Step 1: 先修改字段定义，允许 NULL（否则 UPDATE SET NULL 会被 NOT NULL 约束拒绝）
        migrations.AlterField(
            model_name="wallettransaction",
            name="reference_key",
            field=models.CharField(
                max_length=255,
                null=True,
                blank=True,
                default=None,
                verbose_name="引用键",
                help_text="WAL-07: 用于冻结/解冻记录的幂等匹配。格式：freeze:{run_id}:{iteration}",
            ),
        ),
        # Step 2: 空字符串 → NULL
        migrations.RunSQL(
            sql="UPDATE users_wallet_transaction SET reference_key = NULL WHERE reference_key = ''",
            reverse_sql="UPDATE users_wallet_transaction SET reference_key = '' WHERE reference_key IS NULL",
        ),
        # Step 3: 移除冗余的非唯一索引（将被唯一约束取代）
        migrations.RemoveIndex(
            model_name="wallettransaction",
            name="users_walle_transac_241ae9_idx",
        ),
        # Step 4: 添加唯一约束
        migrations.AddConstraint(
            model_name="wallettransaction",
            constraint=models.UniqueConstraint(
                fields=["transaction_type", "reference_key"],
                name="uniq_tx_type_reference_key",
            ),
        ),
    ]
