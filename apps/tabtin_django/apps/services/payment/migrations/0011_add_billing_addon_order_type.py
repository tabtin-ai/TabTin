from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("payment", "0010_add_expired_payment_order_status"),
    ]

    operations = [
        migrations.AlterField(
            model_name="paymentorder",
            name="order_type",
            field=models.CharField(
                choices=[
                    ("membership", "会员购买"),
                    ("credits", "点券充值"),
                    ("storage_package", "存储套餐"),
                    ("billing_addon", "权益增值包"),
                ],
                db_index=True,
                max_length=20,
                verbose_name="订单类型",
            ),
        ),
    ]
