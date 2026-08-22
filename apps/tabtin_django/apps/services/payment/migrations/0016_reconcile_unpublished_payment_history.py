"""记录已由当前支付模型覆盖的临时支付迁移。"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [("payment", "0015_payment_currency_trade_no_unique")]

    dependencies = [("payment", "0015_membership_upgrade_wallet_payment")]

    operations = []
