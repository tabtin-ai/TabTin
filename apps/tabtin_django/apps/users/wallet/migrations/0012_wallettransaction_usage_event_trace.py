from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("wallet", "0011_retire_user_wallet"),
    ]

    operations = [
        migrations.AddField(
            model_name="wallettransaction",
            name="usage_event_id",
            field=models.CharField(
                blank=True,
                db_index=True,
                default="",
                help_text="同步扣款时显式关联 BillingUsageEvent.id，避免流水详情按时间/金额猜测",
                max_length=36,
                verbose_name="关联用量事件ID",
            ),
        ),
        migrations.AddField(
            model_name="wallettransaction",
            name="billing_metadata",
            field=models.JSONField(blank=True, default=dict, verbose_name="计费元数据"),
        ),
    ]
