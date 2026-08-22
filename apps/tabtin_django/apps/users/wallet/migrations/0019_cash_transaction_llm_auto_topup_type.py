# CashWalletTransaction 交易类型增加 llm_auto_topup（LLM 点券自动补充）。
# choices 变更不改表结构，仅同步模型状态。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0018_organization_cash_wallet"),
    ]

    operations = [
        migrations.AlterField(
            model_name="cashwallettransaction",
            name="transaction_type",
            field=models.CharField(
                choices=[
                    ("recharge", "充值"),
                    ("purchase_credit_package", "购买点券包"),
                    ("purchase_addon_package", "购买权益扩容包"),
                    ("llm_auto_topup", "LLM点券自动补充"),
                    ("refund", "退款"),
                    ("freeze", "冻结"),
                    ("unfreeze", "解冻"),
                    ("manual_adjust", "人工调整"),
                ],
                db_index=True,
                max_length=40,
                verbose_name="交易类型",
            ),
        ),
    ]
