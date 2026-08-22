from django.db import migrations, models

import apps.services.billing.models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0013_add_media_audio_and_docparse_service_switches"),
    ]

    operations = [
        migrations.AlterField(
            model_name="billingusageevent",
            name="biz_id",
            field=models.CharField(blank=True, default="", max_length=255, verbose_name="业务ID"),
        ),
        migrations.AlterField(
            model_name="billingusageevent",
            name="idempotency_key",
            field=models.CharField(
                blank=True,
                db_index=True,
                default=apps.services.billing.models.generate_usage_event_idempotency_key,
                max_length=255,
                unique=True,
                verbose_name="幂等键",
            ),
        ),
    ]
