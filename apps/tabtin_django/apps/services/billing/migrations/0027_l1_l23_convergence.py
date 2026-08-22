from decimal import Decimal

from django.db import migrations, models


DEFAULT_METER_PRICES = (
    ("notification.sms.count", "count", Decimal("5.0000")),
    ("notification.email.count", "count", Decimal("1.0000")),
    ("channel.message.count", "count", Decimal("1.0000")),
)


def seed_default_meter_pricing(apps, schema_editor):
    MeterPricing = apps.get_model("billing", "MeterPricing")
    for meter_key, unit, unit_price in DEFAULT_METER_PRICES:
        MeterPricing.objects.update_or_create(
            meter_key=meter_key,
            scope="global",
            provider_key="",
            model_name="",
            defaults={
                "workteam_id": None,
                "unit": unit,
                "unit_price": unit_price,
                "currency": "CREDITS",
                "precision": 4,
                "is_active": True,
                "priority": 0,
            },
        )


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0026_w5_billing_dispute_and_entitlement_fields"),
    ]

    operations = [
        migrations.AlterField(
            model_name="billinganomalyalert",
            name="alert_type",
            field=models.CharField(
                choices=[
                    ("spike", "消费突增"),
                    ("abuse", "疑似滥用"),
                    ("pattern", "异常模式"),
                    ("charge_failed", "计费失败"),
                    ("cleanup_failed", "清理失败"),
                    ("frozen_leak", "冻结泄漏"),
                    ("refund_inconsistency", "退款不一致"),
                    ("zero_price_model", "零价格模型"),
                    ("event_update_failed", "占位更新失败"),
                    ("storage_critical", "存储用量严重"),
                    ("storage_no_price", "存储无定价"),
                ],
                db_index=True,
                max_length=32,
                verbose_name="告警类型",
            ),
        ),
        migrations.AddField(
            model_name="billingruntimeconfig",
            name="degradation_window_seconds",
            field=models.IntegerField(
                default=3600,
                help_text="降级事件累计的时间窗口，默认 3600 秒（1 小时）",
                verbose_name="降级追踪窗口（秒）",
            ),
        ),
        migrations.AddField(
            model_name="billingruntimeconfig",
            name="degradation_alert_threshold",
            field=models.IntegerField(
                default=10,
                help_text="窗口内累计降级次数超过此值时触发告警，默认 10",
                verbose_name="降级告警阈值",
            ),
        ),
        migrations.AddConstraint(
            model_name="billingdispute",
            constraint=models.UniqueConstraint(
                fields=("transaction_id", "workteam_id"),
                name="uniq_billing_dispute_tx_workteam",
            ),
        ),
        migrations.RunPython(seed_default_meter_pricing, migrations.RunPython.noop),
    ]
