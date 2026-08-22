from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0042_provider_credit_provision_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="providercreditgrant",
            name="trigger_type",
            field=models.CharField(
                blank=True,
                choices=[
                    ("manual", "手动"),
                    ("new_org", "新组织"),
                    ("membership", "会员权益"),
                ],
                max_length=20,
                null=True,
                verbose_name="自动发放触发类型",
            ),
        ),
    ]
