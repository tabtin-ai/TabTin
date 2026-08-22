from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("llm", "0058_reconcile_unpublished_runtime_control_history"),
    ]

    operations = [
        migrations.AddField(
            model_name="llmusagefact",
            name="invocation_id",
            field=models.CharField(blank=True, max_length=255, null=True, verbose_name="业务调用 ID"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="attempt_id",
            field=models.CharField(blank=True, max_length=255, null=True, verbose_name="Provider 尝试 ID"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="stable_invocation",
            field=models.BooleanField(blank=True, null=True, verbose_name="是否稳定业务调用身份"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="execution_key",
            field=models.CharField(blank=True, max_length=100, null=True, verbose_name="执行结算键"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="business_object_type",
            field=models.CharField(blank=True, max_length=64, null=True, verbose_name="业务对象类型"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="business_object_id",
            field=models.CharField(blank=True, max_length=255, null=True, verbose_name="业务对象 ID"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="run_id",
            field=models.CharField(blank=True, max_length=255, null=True, verbose_name="运行 ID"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="task_id",
            field=models.CharField(blank=True, max_length=255, null=True, verbose_name="任务 ID"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="parent_invocation_id",
            field=models.CharField(blank=True, max_length=255, null=True, verbose_name="父业务调用 ID"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="result_status",
            field=models.CharField(
                blank=True,
                choices=[("valid", "Valid"), ("invalid", "Invalid"), ("unknown", "Unknown")],
                max_length=20,
                null=True,
                verbose_name="结果状态",
            ),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="settlement_status",
            field=models.CharField(
                blank=True,
                choices=[
                    ("not_required", "Not Required"),
                    ("pending", "Pending"),
                    ("settled", "Settled"),
                    ("failed", "Failed"),
                    ("skipped", "Skipped"),
                ],
                max_length=20,
                null=True,
                verbose_name="结算状态",
            ),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="settlement_key_version",
            field=models.CharField(blank=True, max_length=32, null=True, verbose_name="结算键版本"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="retry_source",
            field=models.CharField(blank=True, max_length=64, null=True, verbose_name="重试来源"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="payer",
            field=models.CharField(blank=True, max_length=20, null=True, verbose_name="实际付款方"),
        ),
        migrations.AddField(
            model_name="llmusagefact",
            name="model_source",
            field=models.CharField(blank=True, max_length=20, null=True, verbose_name="实际模型来源"),
        ),
    ]
