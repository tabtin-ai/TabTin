from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0013_wallettransaction_workteam_wallet_index"),
    ]

    operations = [
        migrations.AlterField(
            model_name="wallettransaction",
            name="related_order_id",
            field=models.CharField(
                blank=True,
                db_index=True,
                max_length=255,
                verbose_name="关联订单ID",
            ),
        ),
    ]
