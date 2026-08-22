from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("payment", "0009_alter_paymentorder_user"),
    ]

    operations = [
        migrations.AlterField(
            model_name="paymentorder",
            name="status",
            field=models.CharField(
                choices=[
                    ("pending", "待支付"),
                    ("paying", "支付中"),
                    ("paid", "已支付"),
                    ("cancelled", "已取消"),
                    ("expired", "已过期"),
                    ("failed", "支付失败"),
                    ("completed", "已完成"),
                    ("refunded", "已退款"),
                    ("partially_refunded", "部分退款"),
                ],
                db_index=True,
                default="pending",
                max_length=20,
                verbose_name="订单状态",
            ),
        ),
    ]
