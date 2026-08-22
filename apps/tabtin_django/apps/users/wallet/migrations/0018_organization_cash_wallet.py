from decimal import Decimal

import apps.users.wallet.models
import django.core.validators
from django.core.validators import MinValueValidator
from django.db import migrations, models
from django.db.models import Q
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0017_alter_organizationwallet_options_and_more"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="creditpackage",
            options={"ordering": ["sort_order", "-created_at"], "verbose_name": "credits 套餐", "verbose_name_plural": "credits 套餐"},
        ),
        migrations.AlterModelOptions(
            name="organizationwallet",
            options={"ordering": ["-created_at"], "verbose_name": "组织点券钱包", "verbose_name_plural": "组织点券钱包"},
        ),
        migrations.AlterModelOptions(
            name="wallettransaction",
            options={"ordering": ["-created_at"], "verbose_name": "点券钱包交易", "verbose_name_plural": "点券钱包交易"},
        ),
        migrations.CreateModel(
            name="OrganizationCashWallet",
            fields=[
                ("id", models.CharField(default=apps.users.wallet.models.generate_uuid, editable=False, max_length=36, primary_key=True, serialize=False)),
                ("organization_id", models.CharField(db_index=True, max_length=100, unique=True, verbose_name="组织ID")),
                ("balance_cny", models.DecimalField(decimal_places=2, default=Decimal("0.00"), max_digits=20, validators=[MinValueValidator(Decimal("0"))], verbose_name="人民币余额")),
                ("frozen_cny", models.DecimalField(decimal_places=2, default=Decimal("0.00"), max_digits=20, validators=[MinValueValidator(Decimal("0"))], verbose_name="冻结人民币余额")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
            ],
            options={
                "verbose_name": "组织人民币钱包",
                "verbose_name_plural": "组织人民币钱包",
                "db_table": "users_wallet_organization_cash_wallet",
                "ordering": ["-created_at"],
            },
        ),
        migrations.CreateModel(
            name="CashWalletTransaction",
            fields=[
                ("id", models.CharField(default=apps.users.wallet.models.generate_uuid, editable=False, max_length=36, primary_key=True, serialize=False)),
                ("organization_id", models.CharField(db_index=True, max_length=100, verbose_name="组织ID")),
                ("transaction_type", models.CharField(choices=[("recharge", "充值"), ("purchase_credit_package", "购买点券包"), ("purchase_addon_package", "购买权益扩容包"), ("refund", "退款"), ("freeze", "冻结"), ("unfreeze", "解冻"), ("manual_adjust", "人工调整")], db_index=True, max_length=40, verbose_name="交易类型")),
                ("amount_cny", models.DecimalField(decimal_places=2, max_digits=20, verbose_name="人民币变动金额")),
                ("balance_before_cny", models.DecimalField(decimal_places=2, max_digits=20, verbose_name="变动前余额")),
                ("balance_after_cny", models.DecimalField(decimal_places=2, max_digits=20, verbose_name="变动后余额")),
                ("operator_user_id", models.CharField(blank=True, db_index=True, default="", max_length=36, verbose_name="操作人用户ID")),
                ("related_order_id", models.CharField(blank=True, db_index=True, max_length=255, verbose_name="关联订单ID")),
                ("related_wallet_transaction_id", models.CharField(blank=True, default="", max_length=64, verbose_name="关联点券钱包流水ID")),
                ("related_addon_entitlement_id", models.CharField(blank=True, default="", max_length=64, verbose_name="关联扩容权益ID")),
                ("description", models.TextField(blank=True, default="", verbose_name="描述")),
                ("metadata", models.JSONField(blank=True, default=dict, verbose_name="扩展元数据")),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True, verbose_name="创建时间")),
                ("cash_wallet", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="transactions", to="wallet.organizationcashwallet", verbose_name="组织人民币钱包")),
            ],
            options={
                "verbose_name": "人民币钱包交易",
                "verbose_name_plural": "人民币钱包交易",
                "db_table": "users_wallet_cash_transaction",
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="cashwallettransaction",
            index=models.Index(fields=["cash_wallet", "created_at"], name="users_cash_wallet_time_idx"),
        ),
        migrations.AddIndex(
            model_name="cashwallettransaction",
            index=models.Index(fields=["organization_id", "created_at"], name="users_cash_org_time_idx"),
        ),
        migrations.AddIndex(
            model_name="cashwallettransaction",
            index=models.Index(fields=["transaction_type", "created_at"], name="users_cash_type_time_idx"),
        ),
        migrations.AddConstraint(
            model_name="cashwallettransaction",
            constraint=models.UniqueConstraint(condition=~Q(related_order_id=""), fields=("organization_id", "transaction_type", "related_order_id"), name="uniq_cash_tx_org_type_order"),
        ),
        migrations.AlterField(
            model_name="creditpackage",
            name="bonus_credits",
            field=models.IntegerField(default=0, validators=[django.core.validators.MinValueValidator(0)], verbose_name="赠送 credits 数"),
        ),
        migrations.AlterField(
            model_name="creditpackage",
            name="credits_amount",
            field=models.IntegerField(validators=[django.core.validators.MinValueValidator(1)], verbose_name="基础 credits 数"),
        ),
        migrations.AlterField(
            model_name="organizationwallet",
            name="credits",
            field=models.BigIntegerField(default=0, validators=[django.core.validators.MinValueValidator(0)], verbose_name="credits 余额"),
        ),
        migrations.AlterField(
            model_name="organizationwallet",
            name="credits_frozen",
            field=models.BigIntegerField(default=0, help_text="当前冻结中的 credits（整数近似值），由 sync_display_balances() 从精确值同步。", validators=[django.core.validators.MinValueValidator(0)], verbose_name="冻结 credits"),
        ),
        migrations.AlterField(
            model_name="organizationwallet",
            name="credits_frozen_precise",
            field=models.DecimalField(decimal_places=4, default=Decimal("0.0000"), help_text="当前冻结中的 credits 精确值，由 CreditsService 的 freeze/settle/release 方法维护。", max_digits=20, validators=[django.core.validators.MinValueValidator(Decimal("0"))], verbose_name="冻结 credits(精确)"),
        ),
        migrations.AlterField(
            model_name="organizationwallet",
            name="credits_precise",
            field=models.DecimalField(decimal_places=4, default=Decimal("0.0000"), max_digits=20, validators=[django.core.validators.MinValueValidator(Decimal("0"))], verbose_name="credits 余额(精确)"),
        ),
        migrations.AlterField(
            model_name="wallettransaction",
            name="amount",
            field=models.BigIntegerField(verbose_name="credits 数量"),
        ),
        migrations.AlterField(
            model_name="wallettransaction",
            name="amount_precise",
            field=models.DecimalField(decimal_places=4, default=Decimal("0.0000"), max_digits=20, verbose_name="credits 数量(精确)"),
        ),
    ]
