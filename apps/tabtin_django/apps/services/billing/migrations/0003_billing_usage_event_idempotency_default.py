from django.db import migrations, models

import apps.services.billing.models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0002_storage_package_plan_and_subscription"),
    ]

    operations = [
        migrations.AlterField(
            model_name="billingusageevent",
            name="idempotency_key",
            field=models.CharField(
                blank=True,
                db_index=True,
                default=apps.services.billing.models.generate_usage_event_idempotency_key,
                max_length=160,
                unique=True,
                verbose_name="幂等键",
            ),
        ),
    ]
