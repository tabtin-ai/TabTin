from decimal import Decimal

import django.core.validators
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("membership", "0021_subscription_lifecycle_execution_fields"),
    ]

    operations = [
        migrations.AlterField(
            model_name="membershiptier",
            name="included_llm_credits_monthly",
            field=models.DecimalField(
                decimal_places=8,
                default=Decimal("0"),
                help_text="该等级每月赠送的LLMcredits额度，同步到 organization entitlement",
                max_digits=20,
                validators=[django.core.validators.MinValueValidator(Decimal("0"))],
                verbose_name="每月赠送LLM额度（credits）",
            ),
        ),
    ]
