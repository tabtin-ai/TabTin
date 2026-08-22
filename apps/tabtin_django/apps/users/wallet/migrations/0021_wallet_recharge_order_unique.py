from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("wallet", "0020_organization_fk_convergence_3832"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    sql=(
                        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "
                        "uniq_wallet_recharge_org_order "
                        "ON users_wallet_transaction "
                        "(organization_id, transaction_type, related_order_id) "
                        "WHERE transaction_type = 'recharge' "
                        "AND related_order_id <> '' "
                        "AND organization_id IS NOT NULL"
                    ),
                    reverse_sql=(
                        "DROP INDEX CONCURRENTLY IF EXISTS "
                        "uniq_wallet_recharge_org_order"
                    ),
                ),
            ],
            state_operations=[
                migrations.AddConstraint(
                    model_name="wallettransaction",
                    constraint=models.UniqueConstraint(
                        fields=("organization", "transaction_type", "related_order_id"),
                        condition=(
                            Q(transaction_type="recharge")
                            & ~Q(related_order_id="")
                            & Q(organization__isnull=False)
                        ),
                        name="uniq_wallet_recharge_org_order",
                    ),
                ),
            ],
        ),
    ]
