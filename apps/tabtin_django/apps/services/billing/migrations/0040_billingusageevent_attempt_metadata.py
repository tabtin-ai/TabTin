from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0039_organization_fk_convergence_3832"),
    ]

    operations = [
        migrations.AddField(
            model_name="billingusageevent",
            name="logical_billing_key",
            field=models.CharField(
                blank=True,
                default="",
                help_text="同一次 Agent LLM 调用的稳定逻辑标识；provider retry attempt 共享。",
                max_length=255,
                verbose_name="逻辑计费键",
            ),
        ),
        migrations.AddField(
            model_name="billingusageevent",
            name="attempt_index",
            field=models.IntegerField(
                blank=True,
                help_text="同一逻辑计费键下的 provider 请求 attempt 序号；旧客户端为空。",
                null=True,
                verbose_name="Provider重试序号",
            ),
        ),
        migrations.AddField(
            model_name="billingusageevent",
            name="usage_source",
            field=models.CharField(
                blank=True,
                default="provider_final",
                help_text="provider_final 表示采用上游最终 usage 结算。",
                max_length=64,
                verbose_name="用量来源",
            ),
        ),
    ]
