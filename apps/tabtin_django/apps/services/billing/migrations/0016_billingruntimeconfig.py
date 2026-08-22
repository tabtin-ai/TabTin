"""
创建 BillingRuntimeConfig 单例模型，集中管理计费运行时参数。
"""

from decimal import Decimal
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0015_alter_billinganomalyalert_alert_type_and_more"),
    ]

    operations = [
        migrations.CreateModel(
            name="BillingRuntimeConfig",
            fields=[
                ("id", models.AutoField(primary_key=True, serialize=False)),
                ("credits_per_yuan", models.IntegerField(
                    default=100, verbose_name="点券/元换算比例",
                    help_text="1 元 = N 点券",
                )),
                ("min_balance_threshold", models.DecimalField(
                    max_digits=10, decimal_places=4, default=Decimal("0.01"),
                    verbose_name="余额放行最低阈值（点券）",
                )),
                ("freeze_fallback_credits", models.DecimalField(
                    max_digits=10, decimal_places=4, default=Decimal("0.5"),
                    verbose_name="冻结保底金额（点券）",
                )),
                ("freeze_est_input_tokens", models.IntegerField(
                    default=2000, verbose_name="首轮冻结预估输入 tokens",
                )),
                ("freeze_est_output_tokens", models.IntegerField(
                    default=500, verbose_name="首轮冻结预估输出 tokens",
                )),
                ("precheck_fail_threshold", models.IntegerField(
                    default=10, verbose_name="Fail-open 连续异常阈值",
                )),
                ("failopen_max_credits", models.DecimalField(
                    max_digits=10, decimal_places=4, default=Decimal("10"),
                    verbose_name="Fail-open 累计金额上限（点券）",
                )),
                ("precheck_fail_window", models.IntegerField(
                    default=60, verbose_name="Fail-open 异常窗口（秒）",
                )),
                ("balance_recheck_interval", models.IntegerField(
                    default=1, verbose_name="余额复检间隔（每 N 轮）",
                )),
                ("stale_freeze_threshold_minutes", models.IntegerField(
                    default=120, verbose_name="冻结超时阈值（分钟）",
                )),
                ("pricing_cache_ttl", models.IntegerField(
                    default=60, verbose_name="定价缓存 TTL（秒）",
                )),
                ("cache_discount_config", models.JSONField(
                    default=dict, blank=True,
                    verbose_name="Provider 缓存折扣率配置",
                )),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                ("updated_by", models.CharField(
                    max_length=100, blank=True, default="",
                    verbose_name="更新人",
                )),
            ],
            options={
                "db_table": "services_billing_runtime_config",
                "verbose_name": "计费运行时配置",
                "verbose_name_plural": "计费运行时配置",
            },
        ),
    ]
