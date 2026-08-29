"""自动补充默认：开启、每次 1 元、每月上限 0（不限额）。

回写出厂 10/100 以及误写入的 0.01/0；已改过金额或上限的行不动。
"""

from decimal import Decimal

from django.db import migrations, models
import django.core.validators


def _backfill_factory_auto_topup(apps, schema_editor):
    Policy = apps.get_model("billing", "OrganizationBillingPolicy")
    factory_pairs = (
        (Decimal("10"), Decimal("100")),
        (Decimal("0.01"), Decimal("0")),
    )
    for spend, cap in factory_pairs:
        Policy.objects.filter(
            auto_topup_spend_yuan=spend,
            auto_topup_monthly_cap_yuan=cap,
        ).update(
            auto_topup_enabled=True,
            auto_topup_spend_yuan=Decimal("1"),
            auto_topup_monthly_cap_yuan=Decimal("0"),
        )


def _noop_reverse(apps, schema_editor):
    return None


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0047_billingreservation_and_more"),
    ]

    operations = [
        migrations.AlterField(
            model_name="organizationbillingpolicy",
            name="auto_topup_enabled",
            field=models.BooleanField(default=True, verbose_name="LLM点券自动补充开关"),
        ),
        migrations.AlterField(
            model_name="organizationbillingpolicy",
            name="auto_topup_spend_yuan",
            field=models.DecimalField(
                decimal_places=8,
                default=Decimal("1"),
                max_digits=20,
                validators=[django.core.validators.MinValueValidator(Decimal("0"))],
                verbose_name="每次自动补充花费（元）",
            ),
        ),
        migrations.AlterField(
            model_name="organizationbillingpolicy",
            name="auto_topup_monthly_cap_yuan",
            field=models.DecimalField(
                decimal_places=8,
                default=Decimal("0"),
                max_digits=20,
                validators=[django.core.validators.MinValueValidator(Decimal("0"))],
                verbose_name="每月自动补充花费上限（元）",
            ),
        ),
        migrations.RunPython(_backfill_factory_auto_topup, _noop_reverse),
    ]
