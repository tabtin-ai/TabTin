# LLM 自动补充配置口径：由「点券数量」改为「账户余额花费（元）」。
# 存量数据按 CREDITS_PER_YUAN=100 反算为元（与 settings 默认一致）。

from decimal import Decimal

from django.db import migrations, models
import django.core.validators


CREDITS_PER_YUAN = Decimal("100")


def forwards_credits_to_yuan(apps, schema_editor):
    Policy = apps.get_model("billing", "OrganizationBillingPolicy")
    for row in Policy.objects.all().iterator():
        spend = Decimal(str(row.auto_topup_spend_yuan or 0)) / CREDITS_PER_YUAN
        cap = Decimal(str(row.auto_topup_monthly_cap_yuan or 0)) / CREDITS_PER_YUAN
        Policy.objects.filter(pk=row.pk).update(
            auto_topup_spend_yuan=spend,
            auto_topup_monthly_cap_yuan=cap,
        )


def backwards_yuan_to_credits(apps, schema_editor):
    Policy = apps.get_model("billing", "OrganizationBillingPolicy")
    for row in Policy.objects.all().iterator():
        spend = Decimal(str(row.auto_topup_spend_yuan or 0)) * CREDITS_PER_YUAN
        cap = Decimal(str(row.auto_topup_monthly_cap_yuan or 0)) * CREDITS_PER_YUAN
        Policy.objects.filter(pk=row.pk).update(
            auto_topup_spend_yuan=spend,
            auto_topup_monthly_cap_yuan=cap,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0037_llm_quota_only_auto_topup"),
    ]

    operations = [
        migrations.RenameField(
            model_name="organizationbillingpolicy",
            old_name="auto_topup_credits",
            new_name="auto_topup_spend_yuan",
        ),
        migrations.RenameField(
            model_name="organizationbillingpolicy",
            old_name="auto_topup_monthly_cap_credits",
            new_name="auto_topup_monthly_cap_yuan",
        ),
        migrations.RunPython(forwards_credits_to_yuan, backwards_yuan_to_credits),
        migrations.AlterField(
            model_name="organizationbillingpolicy",
            name="auto_topup_spend_yuan",
            field=models.DecimalField(
                decimal_places=8,
                default=Decimal("10"),
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
                default=Decimal("100"),
                max_digits=20,
                validators=[django.core.validators.MinValueValidator(Decimal("0"))],
                verbose_name="每月自动补充花费上限（元）",
            ),
        ),
    ]
