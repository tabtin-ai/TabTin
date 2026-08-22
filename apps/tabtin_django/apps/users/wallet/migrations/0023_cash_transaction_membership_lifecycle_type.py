from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('wallet', '0022_cash_transaction_membership_upgrade_type'),
    ]

    operations = [
        migrations.AlterField(
            model_name='cashwallettransaction',
            name='transaction_type',
            field=models.CharField(
                choices=[
                    ('recharge', '充值'),
                    ('purchase_credit_package', '购买点券包'),
                    ('purchase_addon_package', '购买权益扩容包'),
                    ('membership_upgrade_payment', '会员升级支付'),
                    ('membership_lifecycle_payment', '会员生命周期支付'),
                    ('llm_auto_topup', 'LLM点券自动补充'),
                    ('refund', '退款'),
                    ('freeze', '冻结'),
                    ('unfreeze', '解冻'),
                    ('manual_adjust', '人工调整'),
                ],
                db_index=True,
                max_length=40,
                verbose_name='交易类型',
            ),
        ),
    ]
